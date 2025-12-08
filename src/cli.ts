import { select } from "@inquirer/prompts";
import { Glob } from "bun";
import { basename } from "path";
import { realpathSync } from "fs";

export interface CliArgs {
  filePath: string;
  passthroughArgs: string[];
  // These only apply when NO file is provided
  help: boolean;
  setup: boolean;
  logs: boolean;
}

/** Result of handling ma commands - can include a selected file from interactive picker */
export interface HandleMaCommandsResult {
  handled: boolean;
  selectedFile?: string;
}

/** Agent file discovered by the file finder */
export interface AgentFile {
  name: string;
  path: string;
  source: string;
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
       ma <url> [--trust]
       ma --setup
       ma --logs
       ma --help

Command resolution:
  1. --command flag (e.g., ma task.md --command claude)
  2. Filename pattern (e.g., task.claude.md → claude)

All frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.markdown-agent/config.yaml

Remote execution:
  ma supports running agents from URLs (npx-style).
  On first use, you'll be prompted to trust the domain.
  Trusted domains are stored in ~/.markdown-agent/known_hosts

Examples:
  ma task.claude.md -p "print mode"
  ma task.claude.md --model opus --verbose
  ma commit.gemini.md
  ma task.md --command claude
  ma task.md -c gemini
  ma task.claude.md --dry-run    # Preview without executing
  ma https://example.com/agent.claude.md          # Remote execution
  ma https://example.com/agent.claude.md --trust  # Skip trust prompt

Config file example (~/.markdown-agent/config.yaml):
  commands:
    copilot:
      $1: prompt    # Map body to --prompt flag

ma-specific flags (consumed, not passed to command):
  --command, -c   Specify command to run
  --dry-run       Show resolved command and prompt without executing
  --trust         Skip trust prompt for remote URLs (TOFU bypass)

Without a file:
  ma --setup    Configure shell to run .md files directly
  ma --logs     Show log directory
  ma --help     Show this help
`);
}

/**
 * Normalize a path to its real (resolved symlinks) absolute form
 * Used to deduplicate files that may appear via different paths (e.g., /var vs /private/var on macOS)
 */
function normalizePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    // If realpath fails, fall back to the original path
    return filePath;
  }
}

/**
 * Find agent markdown files from current directory and $PATH
 * Returns files sorted by source (cwd first, then PATH directories)
 */
export async function findAgentFiles(): Promise<AgentFile[]> {
  const files: AgentFile[] = [];
  const seenPaths = new Set<string>();

  const glob = new Glob("*.md");

  // 1. Current directory
  try {
    for await (const file of glob.scan({ cwd: process.cwd(), absolute: true })) {
      const normalizedPath = normalizePath(file);
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        files.push({ name: basename(file), path: normalizedPath, source: "cwd" });
      }
    }
  } catch {
    // Skip if cwd is not accessible
  }

  // 2. $PATH directories
  const pathDirs = (process.env.PATH || "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    try {
      for await (const file of glob.scan({ cwd: dir, absolute: true })) {
        const normalizedPath = normalizePath(file);
        if (!seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          files.push({ name: basename(file), path: normalizedPath, source: dir });
        }
      }
    } catch {
      // Skip directories that don't exist or can't be read
    }
  }

  return files;
}

/**
 * Show interactive file picker and return selected file path
 */
export async function showInteractiveSelector(files: AgentFile[]): Promise<string | undefined> {
  if (files.length === 0) {
    return undefined;
  }

  try {
    const selected = await select({
      message: "Select an agent to run:",
      choices: files.map(f => ({
        name: f.name,
        value: f.path,
        description: f.source === "cwd" ? "(current directory)" : f.source,
      })),
    });
    return selected;
  } catch {
    // User cancelled (Ctrl+C) or other error
    return undefined;
  }
}

/**
 * Handle ma's own commands (when no file provided)
 * Returns result indicating if command was handled and optionally a selected file
 */
export async function handleMaCommands(args: CliArgs): Promise<HandleMaCommandsResult> {
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

  // No file and no flags - show interactive picker if TTY
  if (!args.filePath && !args.help && !args.setup && !args.logs) {
    if (process.stdin.isTTY) {
      const mdFiles = await findAgentFiles();
      if (mdFiles.length > 0) {
        const selected = await showInteractiveSelector(mdFiles);
        if (selected) {
          return { handled: true, selectedFile: selected };
        }
        // User cancelled - exit gracefully
        process.exit(0);
      }
    }
  }

  return { handled: false };
}
