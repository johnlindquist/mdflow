import type { CopilotFrontmatter } from "./types";
import { parseTemplateArgs, type TemplateVars } from "./template";

export interface CliArgs {
  filePath: string;
  overrides: Partial<CopilotFrontmatter>;
  appendText: string;
  templateVars: TemplateVars;
  noCache: boolean;
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
]);

/**
 * Parse CLI arguments and extract overrides for frontmatter
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // Skip node and script path
  let filePath = "";
  const overrides: Partial<CopilotFrontmatter> = {};
  const positionalArgs: string[] = [];
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

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
          overrides.model = nextArg as CopilotFrontmatter["model"];
          i++;
        }
        break;

      case "--agent":
        if (nextArg) {
          overrides.agent = nextArg;
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

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--no-cache":
        noCache = true;
        break;
    }
  }

  // Parse template variables from remaining args
  const templateVars = parseTemplateArgs(args, KNOWN_FLAGS);

  return { filePath, overrides, appendText: positionalArgs.join(" "), templateVars, noCache };
}

/**
 * Merge frontmatter with CLI overrides (CLI wins)
 * Applies defaults for unset values
 */
export function mergeFrontmatter(
  frontmatter: CopilotFrontmatter,
  overrides: Partial<CopilotFrontmatter>
): CopilotFrontmatter {
  const defaults: Partial<CopilotFrontmatter> = {
    silent: true,
  };
  return { ...defaults, ...frontmatter, ...overrides };
}

function printHelp() {
  console.log(`
Usage: <file.md> [text] [options]

Arguments:
  text                    Additional text appended to the prompt body

Options:
  --model, -m <model>     Override AI model (claude-haiku-4.5, gpt-5, etc.)
  --agent <agent>         Override custom agent
  --silent, -s            Enable silent mode (no stats)
  --no-silent             Disable silent mode
  --interactive, -i       Enable interactive mode
  --allow-all-tools       Allow all tools without confirmation
  --allow-all-paths       Allow access to any file path
  --allow-tool <pattern>  Allow specific tool
  --deny-tool <pattern>   Deny specific tool
  --add-dir <dir>         Add directory to allowed list
  --no-cache              Skip cache and force fresh execution
  --help, -h              Show this help

Examples:
  DEMO.md "focus on error handling"
  DEMO.md --model gpt-5 "be concise"
  CHECK_ACTIONS.md -m claude-opus-4.5
`);
}
