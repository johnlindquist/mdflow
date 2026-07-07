/**
 * generate-facts.ts — single source of truth for the factual copy shared by
 * the CLI docs and the website (site/src/facts.json).
 *
 * Derivations:
 * - engines + default engine: the live adapter registry (src/adapters) and
 *   DEFAULT_ENGINE (src/command.ts)
 * - subcommand names: scanned from src/cli-runner.ts (`subcommand === "x"`),
 *   so a new subcommand without a description entry here FAILS the build
 * - version: package.json
 *
 * Usage:
 *   bun run scripts/generate-facts.ts          # write site/src/facts.json
 *   bun run scripts/generate-facts.ts --check  # exit 1 if the file is stale
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { getRegisteredAdapters } from "../src/adapters";
import { DEFAULT_ENGINE } from "../src/command";

const ROOT = join(import.meta.dir, "..");
const FACTS_PATH = join(ROOT, "site", "src", "facts.json");

// --- version -----------------------------------------------------------
// Only the base version is embedded: semantic-release bumps the prerelease
// number on every release commit, and the site badge shouldn't churn (or
// fail facts:check) each time.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const versionBase = (pkg.version as string).split("-")[0]; // 3.0.0-next.4 → 3.0.0

// --- engines -----------------------------------------------------------
const ENGINE_LABELS: Record<string, string> = {
  agy: "agy (Antigravity)",
};
const engines = getRegisteredAdapters();
const enginesLabel = engines.map((e) => ENGINE_LABELS[e] ?? e).join(", ");

// --- subcommands (names derived from cli-runner.ts) ---------------------
const cliRunnerSource = readFileSync(join(ROOT, "src", "cli-runner.ts"), "utf-8");
const discovered = new Set<string>();
for (const match of cliRunnerSource.matchAll(/subcommand === "([a-z-]+)"/g)) {
  discovered.add(match[1]!);
}
discovered.add("help"); // handled as a flag in src/cli.ts

/** Display order + copy. Every discovered subcommand MUST appear here. */
const COMMAND_DOCS: Record<string, { usage: string; description: string }> = {
  init: { usage: "init [--engine <e>] [-y]", description: "bootstrap a flow roster (agent-guided; -y scaffolds deterministically)" },
  create: { usage: "create [name] [flags]", description: "create a new flow file" },
  explain: { usage: "explain <flow.md>", description: "show resolved config without executing (free)" },
  eval: { usage: "eval <flow.md>", description: "run the flow's eval suite — costs engine turns" },
  complain: { usage: 'complain <flow.md> "msg"', description: "record evolution evidence (free)" },
  evolve: { usage: "evolve <flow.md> [--check]", description: "evidence-gated prompt evolution; --check is free" },
  install: { usage: "install <url|gh:org/repo/path@ref>", description: "install a flow from a registry" },
  remove: { usage: "remove <name>", description: "remove an installed flow" },
  list: { usage: "list", description: "list installed registry flows" },
  setup: { usage: "setup", description: "configure shell (PATH, aliases)" },
  logs: { usage: "logs", description: "show the flow log directory" },
  help: { usage: "help", description: "full built-in help" },
};

const undocumented = [...discovered].filter((name) => !COMMAND_DOCS[name]);
if (undocumented.length > 0) {
  console.error(
    `generate-facts: subcommand(s) handled in cli-runner.ts but missing from COMMAND_DOCS: ${undocumented.join(", ")}`
  );
  process.exit(1);
}
const stale = Object.keys(COMMAND_DOCS).filter((name) => !discovered.has(name));
if (stale.length > 0) {
  console.error(
    `generate-facts: COMMAND_DOCS documents subcommand(s) no longer handled in cli-runner.ts: ${stale.join(", ")}`
  );
  process.exit(1);
}
const commands = Object.entries(COMMAND_DOCS).map(([name, doc]) => ({ name, ...doc }));

// --- static-but-centralized facts ---------------------------------------
const ladder = [
  { rung: "--engine flag", note: "deprecated aliases: --_command/-_c, --tool" },
  { rung: "MDFLOW_ENGINE env var", note: "" },
  { rung: "filename (task.claude.md)", note: "must name a real engine" },
  { rung: "frontmatter engine:", note: "deprecated aliases: tool:/_tool: (they warn)" },
  { rung: "config engine:", note: "project config beats ~/.mdflow/config.yaml" },
  { rung: `default: ${DEFAULT_ENGINE}`, note: "implicit picks are announced on stderr" },
];

const mdFlags = [
  { flag: "--engine", description: "specify the engine to run" },
  { flag: "--_dry-run", description: "preview without executing" },
  { flag: "--_edit", description: "edit prompt in $EDITOR" },
  { flag: "--_context", description: "show context tree" },
  { flag: "--raw", description: "raw output (for piping)" },
  { flag: "--json", description: "single JSON result object" },
];

const facts = {
  $generated: "by scripts/generate-facts.ts — DO NOT EDIT; run `bun run facts`",
  versionBase,
  defaultEngine: DEFAULT_ENGINE,
  engines,
  enginesLabel,
  install: "npx mdflow init",
  repo: "https://github.com/johnlindquist/mdflow",
  ladder,
  commands,
  mdFlags,
};

// --- write / check -------------------------------------------------------
const output = JSON.stringify(facts, null, 2) + "\n";
const checkMode = process.argv.includes("--check");

if (checkMode) {
  const current = existsSync(FACTS_PATH) ? readFileSync(FACTS_PATH, "utf-8") : "";
  if (current !== output) {
    console.error(
      "generate-facts: site/src/facts.json is stale. Run `bun run facts` and commit the result."
    );
    process.exit(1);
  }
  console.log("generate-facts: site/src/facts.json is up to date.");
} else {
  mkdirSync(dirname(FACTS_PATH), { recursive: true });
  writeFileSync(FACTS_PATH, output);
  console.log(`generate-facts: wrote ${FACTS_PATH}`);
}
