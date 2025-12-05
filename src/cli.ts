import type { AgentFrontmatter, CopilotFrontmatter } from "./types";
import type { RunnerName } from "./runners/types";
import { parseTemplateArgs, type TemplateVars } from "./template";

export interface CliArgs {
  filePath: string;
  overrides: Partial<AgentFrontmatter>;
  appendText: string;
  templateVars: TemplateVars;
  noCache: boolean;
  dryRun: boolean;
  runner?: RunnerName;
  passthroughArgs: string[];
}

/** Known CLI flags that shouldn't be treated as template variables */
export const KNOWN_FLAGS = new Set([
  "--model", "-m",
  "--agent",
  "--silent", "-s", "--no-silent",
  "--interactive", "-i",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-tool",
  "--deny-tool",
  "--add-dir",
  "--help", "-h",
  "--dry-run",
  "--no-cache",
  "--runner", "-r",
  "--",  // Passthrough separator
]);

const VALID_RUNNERS = new Set(["claude", "codex", "copilot", "gemini"]);

/**
 * Parse CLI arguments and extract overrides for frontmatter
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // Skip node and script path
  let filePath = "";
  const overrides: Partial<AgentFrontmatter> = {};
  const positionalArgs: string[] = [];
  const passthroughArgs: string[] = [];
  let noCache = false;
  let dryRun = false;
  let runner: RunnerName | undefined;
  let inPassthrough = false;

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
        // Additional positional args after file path
        positionalArgs.push(arg);
      }
      continue;
    }

    switch (arg) {
      case "--model":
      case "-m":
        if (nextArg) {
          overrides.model = nextArg;
          i++;
        }
        break;

      case "--agent":
        if (nextArg) {
          // Agent goes to copilot config
          overrides.copilot = { ...overrides.copilot, agent: nextArg };
          i++;
        }
        break;

      case "--silent":
      case "-s":
        overrides.silent = true;
        break;

      case "--no-silent":
        overrides.silent = false;
        break;

      case "--interactive":
      case "-i":
        overrides.interactive = true;
        break;

      case "--allow-all-tools":
        overrides["allow-all-tools"] = true;
        break;

      case "--allow-all-paths":
        overrides["allow-all-paths"] = true;
        break;

      case "--allow-tool":
        if (nextArg) {
          overrides["allow-tool"] = nextArg;
          i++;
        }
        break;

      case "--deny-tool":
        if (nextArg) {
          overrides["deny-tool"] = nextArg;
          i++;
        }
        break;

      case "--add-dir":
        if (nextArg) {
          overrides["add-dir"] = nextArg;
          i++;
        }
        break;

      case "--runner":
      case "-r":
        if (nextArg && VALID_RUNNERS.has(nextArg)) {
          runner = nextArg as RunnerName;
          i++;
        } else if (nextArg) {
          console.error(`Invalid runner: ${nextArg}. Valid options: claude, codex, copilot, gemini`);
          process.exit(1);
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
    runner,
    passthroughArgs,
  };
}

/**
 * Merge frontmatter with CLI overrides (CLI wins)
 * Applies defaults for unset values
 */
export function mergeFrontmatter(
  frontmatter: AgentFrontmatter,
  overrides: Partial<AgentFrontmatter>
): AgentFrontmatter {
  const defaults: Partial<AgentFrontmatter> = {
    silent: true,
  };

  // Deep merge backend-specific configs
  const merged = { ...defaults, ...frontmatter, ...overrides };

  if (frontmatter.claude || overrides.claude) {
    merged.claude = { ...frontmatter.claude, ...overrides.claude };
  }
  if (frontmatter.codex || overrides.codex) {
    merged.codex = { ...frontmatter.codex, ...overrides.codex };
  }
  if (frontmatter.copilot || overrides.copilot) {
    merged.copilot = { ...frontmatter.copilot, ...overrides.copilot };
  }
  if (frontmatter.gemini || overrides.gemini) {
    merged.gemini = { ...frontmatter.gemini, ...overrides.gemini };
  }

  return merged;
}

function printHelp() {
  console.log(`
Usage: <file.md> [text] [options] [-- passthrough-args]

Arguments:
  text                    Additional text appended to the prompt body

Options:
  --runner, -r <runner>   Select backend: claude, codex, copilot, gemini (default: auto)
  --model, -m <model>     Override AI model
  --agent <agent>         Override custom agent (copilot)
  --silent, -s            Enable silent mode (non-interactive)
  --no-silent             Disable silent mode
  --interactive, -i       Enable interactive mode
  --allow-all-tools       Allow all tools without confirmation
  --allow-all-paths       Allow access to any file path
  --allow-tool <pattern>  Allow specific tool
  --deny-tool <pattern>   Deny specific tool
  --add-dir <dir>         Add directory to allowed list
  --no-cache              Skip cache and force fresh execution
  --dry-run               Show what would be executed without running
  --help, -h              Show this help

Passthrough:
  --                      Everything after -- is passed to the runner

Examples:
  DEMO.md "focus on error handling"
  DEMO.md --runner claude --model sonnet
  DEMO.md --runner codex --model gpt-5
  DEMO.md --runner gemini --model gemini-2.5-pro
  DEMO.md -- --verbose --debug
`);
}
