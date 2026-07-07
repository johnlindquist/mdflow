/**
 * md init — bootstrap a flow roster for the current project.
 *
 * The headline path launches an installed engine CLI *interactively*,
 * pre-loaded with the bundled setup guide (assets/init/guide.md). The agent
 * explores the repo, proposes a project-specific roster, converses with the
 * user, writes flows/ + .mdflow.yaml, and verifies with --_dry-run only.
 * Afterward init runs a deterministic post-flight check over whatever the
 * session wrote.
 *
 * The fallback (no engine CLI, no TTY, declined consent, or --yes) scaffolds
 * the starter catalog deterministically — zero engine turns.
 *
 * The guide prompt is passed to the engine verbatim: it deliberately does NOT
 * go through the import/template pipeline, since it is full of `{{ _var }}`
 * and !`cmd` examples that must arrive as text, not be expanded.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
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
import { stampCreatedVersion } from "./compat";
import type { AgentFrontmatter } from "./types";

const ASSETS_DIR = join(import.meta.dir, "..", "assets", "init");
const PROJECT_CONFIG_FILE = ".mdflow.yaml";

interface InitOptions {
  engine?: string;
  yes: boolean;
  help: boolean;
}

interface CatalogEntry {
  name: string;
  description: string;
  content: string;
}

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { yes: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--engine" || arg === "-e") {
      options.engine = args[++i];
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
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
      return {
        name: file,
        description: String(frontmatter.description ?? ""),
        content,
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
export async function launchGuidedSession(engine: string, guidePrompt: string): Promise<number> {
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
      const stamped = stampCreatedVersion(content);
      if (stamped !== content) writeFileSync(path, stamped);
      const { frontmatter } = parseFrontmatter(stamped);
      const resolved = resolveEngine(path, frontmatter, { configEngine });
      const description = frontmatter.description ? String(frontmatter.description) : "(no description)";
      lines.push(`  flows/${file} — ${description} → ${resolved.engine} (engine via ${resolved.source})`);
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
    if (existsSync(target)) {
      lines.push(`  skipped flows/${entry.name} (already exists)`);
      continue;
    }
    writeFileSync(target, stampCreatedVersion(entry.content));
    lines.push(`  created flows/${entry.name} — ${entry.description}`);
  }

  const readmePath = join(flowsDir, "README.md");
  if (!existsSync(readmePath)) {
    const rows = catalog
      .map((e) => `| ${e.name} | ${e.description} | \`md flows/${e.name}\` |`)
      .join("\n");
    writeFileSync(
      readmePath,
      `# Flow roster

Flows are AI agents defined as markdown, run with [mdflow](https://mdflow.dev).
Each real run costs one engine turn. Preview any flow for free with
\`md flows/<name>.md --_dry-run\`.

| Flow | Description | Run |
| ---- | ----------- | --- |
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
`
    );
    lines.push(`  created ${PROJECT_CONFIG_FILE} (engine: ${engine})`);
  } else {
    lines.push(`  skipped ${PROJECT_CONFIG_FILE} (already exists)`);
  }

  return lines;
}

function printHelp(): void {
  console.log(`
Usage: md init [flags]

Initialize a flow roster for the current project.

By default, init launches an installed engine CLI (claude, codex, copilot, ...)
interactively, pre-loaded with the mdflow setup guide. The agent reads your
repo, proposes flows tailored to it, and writes flows/ + .mdflow.yaml after
you approve — verifying with free dry runs only.

Flags:
  --engine, -e <name>   Engine CLI to guide the session (and project default)
  --yes, -y             Skip the guided session; scaffold starter flows directly
  --help, -h            Show this help

Examples:
  npx mdflow init                 # guided, interactive
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

  const cwd = process.cwd();
  const detected = detectInstalledEngines();
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // Resolve the engine preference: flag > single detected > prompt > default.
  let engine = options.engine;
  if (engine && Bun.which(engine) === null) {
    console.error(`Engine '${engine}' is not on your PATH.`);
    if (detected.length > 0) console.error(`Detected engines: ${detected.join(", ")}`);
    return 1;
  }

  // Non-interactive contexts (agents, CI, pipes) and --yes take the
  // deterministic path: no consent to give, no conversation to have.
  if (options.yes || !isTTY) {
    if (!options.yes) {
      console.error("No TTY detected — scaffolding starter flows (use `md init` in a terminal for the guided session).");
    }
    const scaffoldEngine = engine ?? detected[0] ?? DEFAULT_ENGINE;
    console.log(`Scaffolding starter flows (engine: ${scaffoldEngine}):`);
    for (const line of scaffoldStarterFlows(cwd, scaffoldEngine)) console.log(line);
    console.log("");
    for (const line of await postFlightReport(cwd)) console.log(line);
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
      for (const line of scaffoldStarterFlows(cwd, DEFAULT_ENGINE)) console.log(line);
      console.log("");
      for (const line of await postFlightReport(cwd)) console.log(line);
      return 0;
    }

    if (existsSync(join(cwd, "flows"))) {
      console.log("flows/ already exists — the guide will read it and propose additions.");
    }

    console.log(`This launches ${engine} interactively in this repo, pre-loaded with the`);
    console.log(`mdflow setup guide. It will read your project and converse with you about`);
    console.log(`which flows to create — this uses your ${engine} session.`);
    const consent = await confirm({ message: `Launch ${engine}?`, default: true });

    if (!consent) {
      const scaffold = await confirm({
        message: "Scaffold starter flows instead (no engine turns)?",
        default: true,
      });
      if (!scaffold) {
        console.log("Nothing written.");
        return 0;
      }
      console.log(`Scaffolding starter flows (engine: ${engine}):`);
      for (const line of scaffoldStarterFlows(cwd, engine)) console.log(line);
      console.log("");
      for (const line of await postFlightReport(cwd)) console.log(line);
      return 0;
    }

    const guidePrompt = buildGuidePrompt(engine, detected, loadCatalog());
    const exitCode = await launchGuidedSession(engine, guidePrompt);

    console.log("");
    for (const line of await postFlightReport(cwd)) console.log(line);
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
