import { Glob } from "bun";
import { basename, join, delimiter } from "path";
import { realpathSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { EarlyExitRequest, UserCancelledError } from "./errors";
import { LRUCache } from "./cache";
// Lazy-load heavy UI dependencies only when interactive picker is needed
import type { FileSelectorSelection } from "./file-selector";

// Deferred imports for cold start optimization
let _showFileSelectorWithPreview: typeof import("./file-selector").showFileSelectorWithPreview | null = null;
let _loadHistory: typeof import("./history").loadHistory | null = null;
let _getFrecencyScore: typeof import("./history").getFrecencyScore | null = null;

// LRU cache for agent descriptions (avoids re-parsing frontmatter on every scan)
const descriptionCache = new LRUCache<string, string | null>(200);

async function getFileSelector() {
  if (!_showFileSelectorWithPreview) {
    const mod = await import("./file-selector");
    _showFileSelectorWithPreview = mod.showFileSelectorWithPreview;
  }
  return _showFileSelectorWithPreview;
}

async function getHistory() {
  if (!_loadHistory || !_getFrecencyScore) {
    const mod = await import("./history");
    _loadHistory = mod.loadHistory;
    _getFrecencyScore = mod.getFrecencyScore;
  }
  return { loadHistory: _loadHistory, getFrecencyScore: _getFrecencyScore };
}

/**
 * Extract description from markdown frontmatter (cached, synchronous)
 *
 * Performs lightweight YAML parsing to extract only the description field.
 * Returns null if no description is found or file cannot be read.
 */
function extractDescription(filePath: string): string | null {
  // Check cache first
  const cached = descriptionCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    if (!existsSync(filePath)) {
      descriptionCache.set(filePath, null);
      return null;
    }

    const content = readFileSync(filePath, "utf8");

    // Fast path: skip files without frontmatter
    const lines = content.split("\n");
    let startIdx = 0;

    // Skip shebang if present
    if (lines[0]?.startsWith("#!")) {
      startIdx = 1;
    }

    // Check for frontmatter delimiter
    if (lines[startIdx]?.trim() !== "---") {
      descriptionCache.set(filePath, null);
      return null;
    }

    // Find end of frontmatter
    let endIdx = -1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        endIdx = i;
        break;
      }
    }

    if (endIdx === -1) {
      descriptionCache.set(filePath, null);
      return null;
    }

    // Extract description line from frontmatter (simple regex, avoids full YAML parse)
    for (let i = startIdx + 1; i < endIdx; i++) {
      const line = lines[i];
      // Match: description: "value" or description: 'value' or description: value
      const match = line?.match(/^description:\s*["']?([^"'\n]+?)["']?\s*$/);
      if (match && match[1]) {
        const description = match[1].trim();
        descriptionCache.set(filePath, description);
        return description;
      }
    }

    descriptionCache.set(filePath, null);
    return null;
  } catch {
    descriptionCache.set(filePath, null);
    return null;
  }
}

/**
 * Clear the description cache (for testing)
 */
export function clearDescriptionCache(): void {
  descriptionCache.clear();
}

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
  /** Whether the user selected dry-run mode (Shift+Enter) */
  dryRun?: boolean;
}

/** Agent file discovered by the file finder */
export interface AgentFile {
  name: string;
  path: string;
  source: string;
  /** Frecency score for sorting (higher = more frequently/recently used) */
  frecency?: number;
  /** Description from frontmatter (for semantic agent picker) */
  description?: string;
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
  md explain <agent.md>         Show resolved config without executing
  md setup                      Configure shell (PATH, aliases)
  md logs                       Show agent log directory
  md help                       Show this help

Create options:
  md create                     Interactive agent creator
  md create task.claude.md      Create with name (auto-detects command)
  md create -n task -p          Create in project .mdflow/ folder
  md create -g --model gpt-4    Create globally with frontmatter

Command resolution:
  1. --_command flag (e.g., md task.md --_command claude)
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
  md task.md --_command claude
  md task.md -_c gemini
  md task.claude.md --_dry-run    # Preview without executing
  md https://example.com/agent.claude.md            # Remote execution
  md https://example.com/agent.claude.md --_trust   # Skip trust prompt

Config file example (~/.mdflow/config.yaml):
  commands:
    copilot:
      $1: prompt    # Map body to --prompt flag

md-specific flags (consumed, not passed to command):
  --_command, -_c   Specify command to run
  --_dry-run        Show resolved command and prompt without executing
  --_edit           Open resolved prompt in $EDITOR before execution
  --_trust          Skip trust prompt for remote URLs (TOFU bypass)
  --_no-cache       Force fresh fetch for remote URLs (bypass cache)
  --raw             Output raw markdown without rendering (for piping)
  --_context        Show context tree and exit (no execution)
  --_quiet          Skip context dashboard display before execution

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
 * Returns files sorted by frecency (most frequently/recently used first)
 */
export async function findAgentFiles(): Promise<AgentFile[]> {
  const files: AgentFile[] = [];
  const seenPaths = new Set<string>();

  const glob = new Glob("*.md");

  // Lazy-load history for frecency scoring
  const { loadHistory, getFrecencyScore } = await getHistory();
  await loadHistory();

  // 1. Current directory
  try {
    for await (const file of glob.scan({ cwd: process.cwd(), absolute: true })) {
      const normalizedPath = normalizePath(file);
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        const description = extractDescription(normalizedPath);
        files.push({
          name: basename(file),
          path: normalizedPath,
          source: "cwd",
          frecency: getFrecencyScore(normalizedPath),
          ...(description && { description }),
        });
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
        const description = extractDescription(normalizedPath);
        files.push({
          name: basename(file),
          path: normalizedPath,
          source: ".mdflow",
          frecency: getFrecencyScore(normalizedPath),
          ...(description && { description }),
        });
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
        const description = extractDescription(normalizedPath);
        files.push({
          name: basename(file),
          path: normalizedPath,
          source: "~/.mdflow",
          frecency: getFrecencyScore(normalizedPath),
          ...(description && { description }),
        });
      }
    }
  } catch {
    // Skip if ~/.mdflow/ doesn't exist
  }

  // 4. $PATH directories
  // Use path.delimiter for cross-platform support (: on Unix, ; on Windows)
  const pathDirs = (process.env.PATH || "").split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    try {
      for await (const file of glob.scan({ cwd: dir, absolute: true })) {
        const normalizedPath = normalizePath(file);
        if (!seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          const description = extractDescription(normalizedPath);
          files.push({
            name: basename(file),
            path: normalizedPath,
            source: dir,
            frecency: getFrecencyScore(normalizedPath),
            ...(description && { description }),
          });
        }
      }
    } catch {
      // Skip directories that don't exist or can't be read
    }
  }

  // Sort by frecency (highest first), then by name as tiebreaker
  files.sort((a, b) => {
    const frecencyDiff = (b.frecency ?? 0) - (a.frecency ?? 0);
    if (frecencyDiff !== 0) return frecencyDiff;
    return a.name.localeCompare(b.name);
  });

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
 * Show interactive file picker with preview and return selection (path + dryRun flag)
 * Lazy-loads the file-selector module only when actually needed
 */
export async function showInteractiveSelector(files: AgentFile[]): Promise<FileSelectorSelection | undefined> {
  const showFileSelectorWithPreview = await getFileSelector();
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
        const selection = await showInteractiveSelector(mdFiles);
        if (selection) {
          // Spinner will be started in cli-runner.ts with command preview
          return { handled: true, selectedFile: selection.path, dryRun: selection.dryRun };
        }
        // User cancelled - throw error for clean exit
        throw new UserCancelledError("No agent selected");
      }
    }
  }

  return { handled: false };
}
