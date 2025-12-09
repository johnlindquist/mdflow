import { Glob } from "bun";
import { basename, join } from "path";
import { realpathSync } from "fs";
import { homedir } from "os";
import { EarlyExitRequest, UserCancelledError } from "./errors";
import { showFileSelectorWithPreview } from "./file-selector";

export interface CliArgs {
  filePath: string;
  passthroughArgs: string[];
  // Only help flag remains - setup/logs are now subcommands
  help: boolean;
}

/** Result of handling md commands - can include a selected file from interactive picker */
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
 * When a markdown file or subcommand is provided: ALL flags pass through
 * When no file is provided: md's own flags are processed (--help)
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  // First, find if there's a file/subcommand (first non-flag argument)
  const fileIndex = args.findIndex(arg => !arg.startsWith("-"));
  const filePath = fileIndex >= 0 ? args[fileIndex] : "";

  // If we have a file/subcommand, everything else passes through
  if (filePath) {
    const passthroughArgs = [
      ...args.slice(0, fileIndex),
      ...args.slice(fileIndex + 1)
    ];
    return {
      filePath,
      passthroughArgs,
      help: false,
    };
  }

  // No file - check for --help flag
  let help = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") help = true;
  }

  return {
    filePath: "",
    passthroughArgs: args,
    help,
  };
}

function printHelp() {
  console.log(`
Usage: md <file.md> [flags for the command]
       md <command> [options]

Commands:
  md create [name] [flags]      Create a new agent file
  md setup                      Configure shell (PATH, aliases)
  md logs                       Show agent log directory
  md help                       Show this help

Create options:
  md create                     Interactive agent creator
  md create task.claude.md      Create with name (auto-detects command)
  md create -n task -p          Create in project .mdflow/ folder
  md create -g --model gpt-4    Create globally with frontmatter

Command resolution:
  1. --command flag (e.g., md task.md --command claude)
  2. Filename pattern (e.g., task.claude.md → claude)

Agent file discovery (in priority order):
  1. Explicit path:      md ./path/to/agent.md
  2. Current directory:  ./
  3. Project agents:     ./.mdflow/
  4. User agents:        ~/.mdflow/
  5. $PATH directories

All frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.mdflow/config.yaml

Remote execution:
  md supports running agents from URLs (npx-style).
  On first use, you'll be prompted to trust the domain.
  Trusted domains are stored in ~/.mdflow/known_hosts

Examples:
  md task.claude.md -p "print mode"
  md task.claude.md --model opus --verbose
  md commit.gemini.md
  md task.md --command claude
  md task.md -c gemini
  md task.claude.md --dry-run    # Preview without executing
  md https://example.com/agent.claude.md          # Remote execution
  md https://example.com/agent.claude.md --trust  # Skip trust prompt

Config file example (~/.mdflow/config.yaml):
  commands:
    copilot:
      $1: prompt    # Map body to --prompt flag

md-specific flags (consumed, not passed to command):
  --command, -c   Specify command to run
  --dry-run       Show resolved command and prompt without executing
  --trust         Skip trust prompt for remote URLs (TOFU bypass)
  --no-cache      Force fresh fetch for remote URLs (bypass cache)

Without arguments:
  md              Interactive agent picker (from ./.mdflow/, ~/.mdflow/, etc.)
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

/** Project-level agent directory */
const PROJECT_AGENTS_DIR = ".mdflow";

/** User-level agent directory */
const USER_AGENTS_DIR = join(homedir(), ".mdflow");

/**
 * Find agent markdown files with priority order:
 * 1. Current directory (cwd)
 * 2. Project-level: ./.mdflow/
 * 3. User-level: ~/.mdflow/
 * 4. $PATH directories
 *
 * Returns files sorted by source priority (earlier sources take precedence)
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

  // 2. Project-level: ./.mdflow/
  const projectAgentsPath = join(process.cwd(), PROJECT_AGENTS_DIR);
  try {
    for await (const file of glob.scan({ cwd: projectAgentsPath, absolute: true })) {
      const normalizedPath = normalizePath(file);
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        files.push({ name: basename(file), path: normalizedPath, source: ".mdflow" });
      }
    }
  } catch {
    // Skip if .mdflow/ doesn't exist
  }

  // 3. User-level: ~/.mdflow/
  try {
    for await (const file of glob.scan({ cwd: USER_AGENTS_DIR, absolute: true })) {
      const normalizedPath = normalizePath(file);
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        files.push({ name: basename(file), path: normalizedPath, source: "~/.mdflow" });
      }
    }
  } catch {
    // Skip if ~/.mdflow/ doesn't exist
  }

  // 4. $PATH directories
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
 * Get the project agents directory path
 */
export function getProjectAgentsDir(): string {
  return join(process.cwd(), PROJECT_AGENTS_DIR);
}

/**
 * Get the user agents directory path
 */
export function getUserAgentsDir(): string {
  return USER_AGENTS_DIR;
}

/**
 * Show interactive file picker with preview and return selected file path
 */
export async function showInteractiveSelector(files: AgentFile[]): Promise<string | undefined> {
  return showFileSelectorWithPreview(files);
}

/**
 * Handle md's own commands (when no file provided)
 * Returns result indicating if command was handled and optionally a selected file
 */
export async function handleMaCommands(args: CliArgs): Promise<HandleMaCommandsResult> {
  if (args.help) {
    printHelp();
    throw new EarlyExitRequest();
  }

  // No file and no flags - show interactive picker if TTY
  if (!args.filePath && !args.help) {
    if (process.stdin.isTTY) {
      const mdFiles = await findAgentFiles();
      if (mdFiles.length > 0) {
        const selected = await showInteractiveSelector(mdFiles);
        if (selected) {
          return { handled: true, selectedFile: selected };
        }
        // User cancelled - throw error for clean exit
        throw new UserCancelledError("No agent selected");
      }
    }
  }

  return { handled: false };
}
