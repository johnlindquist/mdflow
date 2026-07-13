/**
 * md init — bootstrap a flow roster for the current project.
 *
 * The headline path is deliberately boring: create the starter roster without
 * an engine invocation, never overwrite existing files, then point people at
 * the bare `md` workbench. If a project already has a flow roster, plain init
 * is a no-op.
 *
 * The previous project-aware setup session remains available with --guided
 * (and, for backwards compatibility, whenever --engine is explicitly passed).
 * It explores the repo, proposes a project-specific roster, converses with the
 * user, writes flows/ + .mdflow.yaml, and verifies with --_dry-run only.
 *
 * The guide prompt is passed to the engine verbatim: it deliberately does NOT
 * go through the import/template pipeline, since it is full of `{{ _var }}`
 * and !`cmd` examples that must arrive as text, not be expanded.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { select, confirm } from "@inquirer/prompts";
import { getAdapter as getEngineAdapter, getRegisteredAdapters } from "./adapters";
import {
  DEFAULT_ENGINE,
  buildArgs,
  extractPositionalMappings,
  resolveEngine,
  runCommand,
} from "./command";
import { applyDefaults, applyInteractiveMode, getCommandDefaults, loadProjectConfig } from "./config";
import { parseFrontmatter } from "./parse";
import { inferEvalRecipes, renderEvalTemplate } from "./eval-convention";
import { stampCreatedVersion } from "./compat";
import type { AgentFrontmatter } from "./types";
import { ensureFlowIdentity } from "./evolution-core";
import { resolveProjectRoot } from "./project-root";

const ASSETS_DIR = join(import.meta.dir, "..", "assets", "init");
const PROJECT_CONFIG_FILE = ".mdflow.yaml";

interface InitOptions {
  engine?: string;
  yes: boolean;
  guided: boolean;
  help: boolean;
}

interface CatalogEntry {
  name: string;
  description: string;
  content: string;
  /** A REAL sibling eval suite shipped with the catalog flow, when one exists. */
  evalContent?: string;
}

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { yes: false, guided: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--engine" || arg === "-e") {
      options.engine = args[++i];
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--guided" || arg === "-g") {
      options.guided = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

/**
 * Engine CLIs that are both registered adapters and installed on PATH.
 */
export function detectInstalledEngines(): string[] {
  return getRegisteredAdapters().filter((name) => Bun.which(name) !== null);
}

export function loadCatalog(): CatalogEntry[] {
  const catalogDir = join(ASSETS_DIR, "catalog");
  if (!existsSync(catalogDir)) return [];
  return readdirSync(catalogDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const content = readFileSync(join(catalogDir, file), "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      const evalPath = join(catalogDir, file.replace(/\.md$/i, ".eval.ts"));
      return {
        name: file,
        description: String(frontmatter.description ?? ""),
        content,
        evalContent: existsSync(evalPath) ? readFileSync(evalPath, "utf-8") : undefined,
      };
    });
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * Assemble the guide prompt: bundled guide + catalog, placeholders filled.
 * Plain string replacement on purpose — no Liquid, no import expansion.
 */
export function buildGuidePrompt(engine: string, detected: string[], catalog: CatalogEntry[]): string {
  const guide = readFileSync(join(ASSETS_DIR, "guide.md"), "utf-8");
  const others = detected.filter((e) => e !== engine);
  const catalogText = catalog
    .map((entry) => `## ${entry.name} — ${entry.description}\n\n\`\`\`markdown\n${entry.content.trimEnd()}\n\`\`\``)
    .join("\n\n");
  return guide
    .replaceAll("__MDFLOW_VERSION__", packageVersion())
    .replaceAll("__ENGINE__", engine)
    .replaceAll("__ENGINES_DETECTED__", others.length > 0 ? others.join(", ") : "none — only " + engine)
    .replaceAll("__CATALOG__", catalogText);
}

/**
 * Launch the chosen engine interactively, pre-loaded with the guide prompt.
 * Reuses the adapter machinery (defaults → interactive transform → args) so
 * each engine gets its correct interactive invocation shape.
 */
export async function launchGuidedSession(
  engine: string,
  guidePrompt: string,
  cwd: string = process.cwd(),
): Promise<number> {
  const adapter = getEngineAdapter(engine);
  const userDefaults = (await getCommandDefaults(engine)) ?? {};
  let frontmatter = applyDefaults(userDefaults as AgentFrontmatter, adapter.getDefaults());
  frontmatter = applyInteractiveMode(frontmatter, engine, true);

  const positionalMappings = extractPositionalMappings(frontmatter);
  const args = buildArgs(frontmatter, new Set<string>(), engine);
  if (frontmatter._subcommand) {
    const subs = Array.isArray(frontmatter._subcommand)
      ? frontmatter._subcommand
      : [frontmatter._subcommand];
    args.unshift(...subs.map(String));
  }

  const result = await runCommand({
    command: engine,
    args,
    positionals: [guidePrompt],
    positionalMappings,
    captureOutput: false,
    cwd,
  });
  return result.exitCode;
}

/**
 * Deterministic post-flight over whatever the guided session (or scaffold)
 * wrote: parse every flow, resolve its engine, report the roster.
 */
export async function postFlightReport(cwd: string): Promise<string[]> {
  const lines: string[] = [];
  const flowsDir = join(cwd, "flows");
  if (!existsSync(flowsDir)) {
    lines.push("No flows/ directory was created.");
    return lines;
  }

  const projectConfig = await loadProjectConfig(cwd);
  const configEngine = typeof projectConfig.engine === "string" ? projectConfig.engine : undefined;

  const files = readdirSync(flowsDir).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  if (files.length === 0) {
    lines.push("flows/ exists but contains no flows.");
    return lines;
  }

  lines.push("Roster:");
  for (const file of files) {
    const path = join(flowsDir, file);
    try {
      // Version stamp: flows the guided session (or a scaffold) wrote carry
      // no `_mdflow_version` yet — record the mdflow that adopted them so
      // the compat system can track them from here on.
      const content = readFileSync(path, "utf-8");
      const stamped = ensureFlowIdentity(stampCreatedVersion(content));
      if (stamped !== content) writeFileSync(path, stamped);
      const { frontmatter } = parseFrontmatter(stamped);
      const resolved = resolveEngine(path, frontmatter, { configEngine });
      const description = frontmatter.description ? String(frontmatter.description) : "(no description)";
      const suite = join(flowsDir, file.replace(/\.md$/i, ".eval.ts"));
      const guardrail = existsSync(suite) ? "eval ready" : "no eval suite";
      lines.push(`  flows/${file} — ${description} → ${resolved.engine} (engine via ${resolved.source}; ${guardrail})`);
    } catch (err) {
      lines.push(`  flows/${file} — FAILED to parse: ${(err as Error).message}`);
    }
  }

  if (!existsSync(join(cwd, PROJECT_CONFIG_FILE))) {
    lines.push(`Note: no ${PROJECT_CONFIG_FILE} found — engine-neutral flows fall back to the ladder (default: ${DEFAULT_ENGINE}).`);
  }
  lines.push("Verify any flow for free: md flows/<name>.md --_dry-run");
  return lines;
}

/**
 * Zero-engine-turn fallback: scaffold the starter catalog. Never overwrites.
 */
export function scaffoldStarterFlows(cwd: string, engine: string): string[] {
  const lines: string[] = [];
  const flowsDir = join(cwd, "flows");
  const catalog = loadCatalog();

  if (!existsSync(flowsDir)) mkdirSync(flowsDir, { recursive: true });

  for (const entry of catalog) {
    const target = join(flowsDir, entry.name);
    const evalName = entry.name.replace(/\.md$/i, ".eval.ts");
    const evalTarget = join(flowsDir, evalName);
    const hooksName = entry.name.replace(/\.md$/i, ".hooks.ts");
    const hooksTarget = join(flowsDir, hooksName);

    let flowCreated = false;
    if (existsSync(target)) {
      lines.push(`  skipped flows/${entry.name} (already exists)`);
    } else if (existsSync(evalTarget) || existsSync(hooksTarget)) {
      // Orphaned sibling sidecars are executable TypeScript init did not
      // write. Creating the catalog flow would pair it with unknown code that
      // runs on its first `md eval` (suite) or first run (hooks) — refuse the
      // whole entry instead.
      const orphans = [evalTarget, hooksTarget].filter((path) => existsSync(path)).map((path) => `flows/${basename(path)}`);
      lines.push(
        `  refused flows/${entry.name} (orphan sidecar ${orphans.join(", ")} already exists — ` +
          `init never adopts executable files it did not write; remove the file(s) and re-run)`
      );
      continue;
    } else {
      // "wx" (O_EXCL) never follows symlinks; a dangling symlink at the
      // target fails loudly instead of writing through it.
      writeFileSync(target, ensureFlowIdentity(stampCreatedVersion(entry.content)), { flag: "wx" });
      flowCreated = true;
      lines.push(`  created flows/${entry.name} — ${entry.description}`);
    }

    if (!flowCreated) {
      // A pre-existing flow with this name is NOT the catalog flow — pairing
      // the shipped suite with unrelated content would assert guardrails the
      // flow never promised. Suites are only written in the same transaction
      // as their catalog flow.
      if (!existsSync(evalTarget)) {
        lines.push(`  skipped flows/${evalName} (flows/${entry.name} is not the catalog flow — add one with md eval add)`);
      }
      continue;
    }
    if (existsSync(evalTarget)) {
      // The orphan precheck above makes this a RACE (someone planted the
      // suite between the check and here) — roll the flow back rather than
      // pair it with executable code this run did not write.
      try { rmSync(target, { force: true }); } catch {}
      throw new Error(
        `flows/${evalName} appeared while flows/${entry.name} was being created; ` +
          `rolled back flows/${entry.name} — init never adopts executable files it did not write`
      );
    } else {
      try {
        if (entry.evalContent) {
          writeFileSync(evalTarget, entry.evalContent, { flag: "wx" });
          lines.push(`  created flows/${evalName} — behavioral guardrail suite`);
        } else {
          writeFileSync(evalTarget, renderEvalTemplate(inferEvalRecipes(entry.content)), { flag: "wx" });
          lines.push(`  created flows/${evalName} — draft guardrail (replace its assertions and delete draft: true before running)`);
        }
      } catch (error) {
        // All-or-nothing per catalog entry: a flow without its promised
        // suite would dodge the coverage ratchet.
        try { rmSync(target, { force: true }); } catch {}
        throw new Error(
          `failed to write flows/${evalName} (${error instanceof Error ? error.message : String(error)}); ` +
            `rolled back flows/${entry.name}`
        );
      }
    }
  }

  const readmePath = join(flowsDir, "README.md");
  if (!existsSync(readmePath)) {
    const rows = catalog
      .map((e) => `| ${e.name} | ${e.description} | \`md flows/${e.name}\` | \`md eval flows/${e.name} --plan\` |`)
      .join("\n");
    writeFileSync(
      readmePath,
      `# Flow roster

Flows are AI agents defined as markdown, run with [mdflow](https://mdflow.dev).
Open the Flow Workbench with \`md\` to browse, run, create, and improve them.
Create another flow with \`md create "describe what it should do"\`.

Each real run launches one paid flow invocation. Preview any flow for free with
\`md <name> --_dry-run\`.

| Flow | Description | Run | Verify plan |
| ---- | ----------- | --- | ----------- |
${rows}
`
    );
    lines.push("  created flows/README.md (roster index)");
  } else {
    lines.push("  skipped flows/README.md (already exists)");
  }

  const configPath = join(cwd, PROJECT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `# mdflow project config — https://mdflow.dev
# Default engine for engine-neutral flows in this repo.
engine: ${engine}

# Surface evidence after each run; proposals still require explicit review/apply.
evolve:
  mode: suggest
`
    );
    lines.push(`  created ${PROJECT_CONFIG_FILE} (engine: ${engine}; evolve: suggest)`);
  } else {
    lines.push(`  skipped ${PROJECT_CONFIG_FILE} (already exists)`);
  }

  return lines;
}

/**
 * True once a project has at least one canonical flow. Plain `md init` uses
 * this guard to stay idempotent: it does not inject starter flows into a roster
 * someone already owns. Explicit --yes and guided setup remain additive.
 */
export function hasFlowRoster(cwd: string): boolean {
  const flowsDir = join(cwd, "flows");
  if (!existsSync(flowsDir)) return false;
  return readdirSync(flowsDir).some((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md");
}

/** A compact, copy-pasteable handoff shared by every deterministic init path. */
export function buildInitReceipt(
  changes: string[],
  options: { alreadyInitialized?: boolean } = {},
): string[] {
  if (options.alreadyInitialized) {
    return [
      "mdflow is ready — found an existing flows/ roster; nothing changed.",
      "Next: md",
      'New flow: md create "describe what it should do"',
    ];
  }

  const created = changes.filter((line) => line.trimStart().startsWith("created ")).length;
  const preserved = changes.filter((line) => line.trimStart().startsWith("skipped ")).length;
  const summary = [`mdflow is ready — ${created} ${created === 1 ? "file" : "files"} created for this project.`];
  if (preserved > 0) {
    summary.push(`${preserved} existing ${preserved === 1 ? "file was" : "files were"} preserved.`);
  }
  summary.push("Next: md");
  summary.push('New flow: md create "describe what it should do"');
  return summary;
}

function printInitReceipt(changes: string[], alreadyInitialized = false): void {
  for (const line of buildInitReceipt(changes, { alreadyInitialized })) console.log(line);
}

async function printGuidedReceipt(cwd: string): Promise<void> {
  const report = await postFlightReport(cwd);
  const flowCount = report.filter((line) => line.trimStart().startsWith("flows/")).length;
  const failures = report.filter((line) => line.includes("FAILED") || line.startsWith("No flows/") || line.includes("contains no flows"));

  for (const failure of failures) console.log(failure);
  if (failures.length === 0) console.log(`mdflow is ready — ${flowCount} ${flowCount === 1 ? "flow" : "flows"} checked.`);
  console.log("Next: md");
  console.log('New flow: md create "describe what it should do"');
}

function printHelp(): void {
  console.log(`
Usage: md init [flags]

Initialize a flow roster for the current project.

By default, init safely scaffolds starter flows without launching an engine.
It never overwrites existing files, and is a no-op when flows/ already has a
roster. Then run bare \`md\` to browse, create, run, and improve flows.

Use --guided for the project-aware setup session. It launches an installed
engine CLI with the mdflow setup guide, proposes flows tailored to your repo,
and writes only after you approve. Passing --engine preserves the previous
guided behavior unless --yes is also present.

Flags:
  --engine, -e <name>   Engine CLI to guide the session (and project default)
  --guided, -g          Launch the project-aware guided setup session
  --yes, -y             Skip the guided session; scaffold starter flows directly
  --help, -h            Show this help

Examples:
  npx mdflow init                 # instant, deterministic starter roster
  md init --guided               # project-aware interactive setup
  md init --engine claude        # guided by claude
  md init --yes --engine claude  # non-interactive scaffold (agents use this)
`);
}

export async function runInit(args: string[]): Promise<number> {
  const options = parseInitArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }

  // Resolve the project boundary once so every init branch agrees on where
  // the roster lives and where a guided engine inspects the repository.
  const projectRoot = resolveProjectRoot(process.cwd()).projectRoot;
  const detected = detectInstalledEngines();
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // An explicit engine historically meant "guide setup with this engine".
  // Keep that contract while making plain `md init` deterministic.
  const guided = !options.yes && (options.guided || Boolean(options.engine));

  // Resolve the engine preference: flag > single detected > prompt > default.
  let engine = options.engine;
  if (engine && Bun.which(engine) === null) {
    console.error(`Engine '${engine}' is not on your PATH.`);
    if (detected.length > 0) console.error(`Detected engines: ${detected.join(", ")}`);
    return 1;
  }

  // Plain init, --yes, and every non-interactive context take the zero-engine
  // path. Plain init will not add catalog entries to an existing roster;
  // explicit --yes keeps its established additive behavior.
  if (!guided || !isTTY) {
    const scaffoldEngine = engine ?? DEFAULT_ENGINE;
    const alreadyInitialized = !options.yes && hasFlowRoster(projectRoot);
    const changes = alreadyInitialized ? [] : scaffoldStarterFlows(projectRoot, scaffoldEngine);
    printInitReceipt(changes, alreadyInitialized);
    return 0;
  }

  try {
    if (!engine) {
      if (detected.length === 1) {
        engine = detected[0];
      } else if (detected.length > 1) {
        engine = await select({
          message: "Which agent should guide your setup?",
          choices: detected.map((name) => ({ name, value: name })),
        });
      }
    }

    if (!engine) {
      console.log("No engine CLIs found on your PATH (looked for: " + getRegisteredAdapters().join(", ") + ").");
      const scaffold = await confirm({
        message: "Scaffold starter flows without a guided session?",
        default: true,
      });
      if (!scaffold) {
        console.log("Nothing written. Install an engine CLI and re-run `md init` for the guided setup.");
        return 0;
      }
      console.log(`Scaffolding starter flows (engine: ${DEFAULT_ENGINE}):`);
      const changes = scaffoldStarterFlows(projectRoot, DEFAULT_ENGINE);
      printInitReceipt(changes);
      return 0;
    }

    if (existsSync(join(projectRoot, "flows"))) {
      console.log("flows/ already exists — the guide will read it and propose additions.");
    }

    console.log(`This launches ${engine} interactively in this repo, pre-loaded with the`);
    console.log(`mdflow setup guide. It will read your project and converse with you about`);
    console.log(`which flows to create — this uses your ${engine} session.`);
    const consent = await confirm({ message: `Launch ${engine}?`, default: true });

    if (!consent) {
      const scaffold = await confirm({
        message: "Scaffold starter flows instead (no engine invocations)?",
        default: true,
      });
      if (!scaffold) {
        console.log("Nothing written.");
        return 0;
      }
      console.log(`Scaffolding starter flows (engine: ${engine}):`);
      const changes = scaffoldStarterFlows(projectRoot, engine);
      printInitReceipt(changes);
      return 0;
    }

    const guidePrompt = buildGuidePrompt(engine, detected, loadCatalog());
    const exitCode = await launchGuidedSession(engine, guidePrompt, projectRoot);

    console.log("");
    await printGuidedReceipt(projectRoot);
    return exitCode;
  } catch (err) {
    // Inquirer throws on Ctrl+C — treat as a clean cancel, not a crash.
    if (err instanceof Error && err.name === "ExitPromptError") {
      console.log("Cancelled. Nothing written.");
      return 130;
    }
    throw err;
  }
}
