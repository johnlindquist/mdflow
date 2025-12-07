import type { AgentFrontmatter } from "./types";
import { parseTemplateArgs, type TemplateVars } from "./template";

export interface CliArgs {
  filePath: string;
  overrides: Partial<AgentFrontmatter>;
  appendText: string;
  templateVars: TemplateVars;
  noCache: boolean;
  dryRun: boolean;
  verbose: boolean;
  command?: string;
  passthroughArgs: string[];
  check: boolean;
  json: boolean;
  setup: boolean;
}

/** Known CLI flags that shouldn't be treated as template variables */
export const KNOWN_FLAGS = new Set([
  "--command", "-c",
  "--help", "-h",
  "--dry-run",
  "--no-cache",
  "--verbose", "-v",
  "--check",
  "--json",
  "--setup",
  "--",  // Passthrough separator
]);

/**
 * Parse CLI arguments
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let filePath = "";
  const overrides: Partial<AgentFrontmatter> = {};
  const positionalArgs: string[] = [];
  const passthroughArgs: string[] = [];
  let noCache = false;
  let dryRun = false;
  let verbose = false;
  let command: string | undefined;
  let inPassthrough = false;
  let check = false;
  let json = false;
  let setup = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    // After --, everything is passthrough
    if (arg === "--") {
      inPassthrough = true;
      continue;
    }

    if (inPassthrough) {
      passthroughArgs.push(arg);
      continue;
    }

    // Non-flag argument
    if (!arg.startsWith("-")) {
      if (!filePath) {
        filePath = arg;
      } else {
        positionalArgs.push(arg);
      }
      continue;
    }

    switch (arg) {
      case "--command":
      case "-c":
        if (nextArg) {
          command = nextArg;
          i++;
        }
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--no-cache":
        noCache = true;
        break;

      case "--dry-run":
        dryRun = true;
        break;

      case "--verbose":
      case "-v":
        verbose = true;
        break;

      case "--check":
        check = true;
        break;

      case "--json":
        json = true;
        break;

      case "--setup":
        setup = true;
        break;
    }
  }

  // Parse template variables from remaining args
  const templateVars = parseTemplateArgs(args, KNOWN_FLAGS);

  return {
    filePath,
    overrides,
    appendText: positionalArgs.join(" "),
    templateVars,
    noCache,
    dryRun,
    verbose,
    command,
    passthroughArgs,
    check,
    json,
    setup,
  };
}

/**
 * Merge frontmatter with CLI overrides (CLI wins)
 */
export function mergeFrontmatter(
  frontmatter: AgentFrontmatter,
  overrides: Partial<AgentFrontmatter>
): AgentFrontmatter {
  return { ...frontmatter, ...overrides };
}

function printHelp() {
  console.log(`
Usage: ma <file.md> [text] [options] [-- passthrough-args]
       ma --setup

Arguments:
  file.md                 Markdown file to execute
  text                    Additional text appended to the prompt body

Options:
  --command, -c <cmd>     Command to execute (e.g., claude, codex, gemini)
  --no-cache              Skip cache and force fresh execution
  --dry-run               Show what would be executed without running
  --check                 Validate frontmatter without executing
  --json                  Output validation results as JSON (with --check)
  --verbose, -v           Show debug info
  --setup                 Configure shell to run .md files directly
  --help, -h              Show this help

Passthrough:
  --                      Everything after -- is passed to the command

Command Resolution (in priority order):
  1. --command flag
  2. command: in frontmatter
  3. Inferred from filename (e.g., task.claude.md → claude)

Frontmatter:
  All frontmatter keys are passed as CLI flags to the command.
  - Strings: --key value
  - Booleans: --key (true) or omitted (false)
  - Arrays: --key val1 --key val2

Examples:
  ma task.claude.md "focus on error handling"
  ma task.md --command claude
  ma commit.gemini.md --verbose
  ma task.md -- --model opus
`);
}
