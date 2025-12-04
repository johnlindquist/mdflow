import type { CopilotFrontmatter } from "./types";

export interface CliArgs {
  filePath: string;
  overrides: Partial<CopilotFrontmatter>;
}

/**
 * Parse CLI arguments and extract overrides for frontmatter
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // Skip node and script path
  let filePath = "";
  const overrides: Partial<CopilotFrontmatter> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    // File path (first non-flag argument)
    if (!arg.startsWith("-") && !filePath) {
      filePath = arg;
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
    }
  }

  return { filePath, overrides };
}

/**
 * Merge frontmatter with CLI overrides (CLI wins)
 */
export function mergeFrontmatter(
  frontmatter: CopilotFrontmatter,
  overrides: Partial<CopilotFrontmatter>
): CopilotFrontmatter {
  return { ...frontmatter, ...overrides };
}

function printHelp() {
  console.log(`
Usage: <file.md> [options]

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
  --help, -h              Show this help

Examples:
  DEMO.md --model gpt-5
  DEMO.md --silent --allow-all-tools
  CHECK_ACTIONS.md -m claude-opus-4.5 -s
`);
}
