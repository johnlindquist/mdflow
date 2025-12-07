export interface CliArgs {
  filePath: string;
  passthroughArgs: string[];
  // These only apply when NO file is provided
  help: boolean;
  setup: boolean;
  logs: boolean;
}

/**
 * Parse CLI arguments
 *
 * When a markdown file is provided: ALL flags pass through to the command
 * When no file is provided: ma's own flags are processed (--help, --setup, --logs)
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  // First, find if there's a markdown file
  const fileIndex = args.findIndex(arg => !arg.startsWith("-"));
  const filePath = fileIndex >= 0 ? args[fileIndex] : "";

  // If we have a file, everything else passes through
  if (filePath) {
    const passthroughArgs = [
      ...args.slice(0, fileIndex),
      ...args.slice(fileIndex + 1)
    ];
    return {
      filePath,
      passthroughArgs,
      help: false,
      setup: false,
      logs: false,
    };
  }

  // No file - check for ma's own commands
  let help = false;
  let setup = false;
  let logs = false;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") help = true;
    if (arg === "--setup") setup = true;
    if (arg === "--logs") logs = true;
  }

  return {
    filePath: "",
    passthroughArgs: [],
    help,
    setup,
    logs,
  };
}

function printHelp() {
  console.log(`
Usage: ma <file.md> [any flags for the command]
       ma <file.md> --command <cmd>
       ma <file.md> --dry-run
       ma --setup
       ma --logs
       ma --help

Command resolution:
  1. --command flag (e.g., ma task.md --command claude)
  2. Filename pattern (e.g., task.claude.md → claude)

All frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.markdown-agent/config.yaml

Examples:
  ma task.claude.md -p "print mode"
  ma task.claude.md --model opus --verbose
  ma commit.gemini.md
  ma task.md --command claude
  ma task.md -c gemini
  ma task.claude.md --dry-run    # Preview without executing

Config file example (~/.markdown-agent/config.yaml):
  commands:
    copilot:
      $1: prompt    # Map body to --prompt flag

ma-specific flags (consumed, not passed to command):
  --command, -c   Specify command to run
  --dry-run       Show resolved command and prompt without executing

Without a file:
  ma --setup    Configure shell to run .md files directly
  ma --logs     Show log directory
  ma --help     Show this help
`);
}

/**
 * Handle ma's own commands (when no file provided)
 */
export async function handleMaCommands(args: CliArgs): Promise<boolean> {
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.logs) {
    // Import dynamically to avoid circular deps
    const { getLogDir, listLogDirs } = await import("./logger");
    const logDir = getLogDir();
    console.log(`Log directory: ${logDir}\n`);
    const dirs = listLogDirs();
    if (dirs.length === 0) {
      console.log("No agent logs yet. Run an agent to generate logs.");
    } else {
      console.log("Agent logs:");
      for (const dir of dirs) {
        console.log(`  ${dir}/`);
      }
    }
    process.exit(0);
  }

  if (args.setup) {
    const { runSetup } = await import("./setup");
    await runSetup();
    process.exit(0);
  }

  return false;
}
