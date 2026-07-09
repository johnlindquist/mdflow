import { Glob } from "bun";
import { basename, join, delimiter } from "path";
import { realpathSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { EarlyExitRequest } from "./errors";
import { LRUCache } from "./cache";
import { resolveProjectRoot } from "./project-root";
// Lazy-load heavy UI dependencies only when interactive picker is needed
import type { FileSelectorSelection } from "./file-selector";

// Deferred imports for cold start optimization
let _loadHistory: typeof import("./history").loadHistory | null = null;
let _getFrecencyScore: typeof import("./history").getFrecencyScore | null = null;

// LRU cache for agent descriptions (avoids re-parsing frontmatter on every scan)
const descriptionCache = new LRUCache<string, string | null>(200);

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
       md                              # Open the Flow Workbench
       md <command> [options]
       md.COMMAND "prompt" [flags]      # Ad-hoc execution (no file needed)

Commands:
  md init [--guided] [-y]       Safely scaffold a starter flow roster
                                (--guided tailors it with an installed agent CLI)
  md create "<intent>"          Create a project flow (--global for a personal flow)
  md explain <agent.md>         Show resolved config without executing
  md eval <flow.md> [--plan]    Run or cost-preview the executable eval suite
  md feedback <flow.md> "msg"   Record feedback with a durable ID (free)
  md complain <flow.md> "msg"   Alias for md feedback
  md evolve plan <flow.md>      Show evidence, verification, cost, and writes (free)
  md evolve propose <flow.md>   Create + verify an off-path proposal; source unchanged
  md evolve show <run-id>       Inspect a proposal and verification receipt
  md evolve apply <run-id>      Atomically apply a reviewed proposal
  md evolve rollback <run-id>   Restore the proposal's captured current flow
  md evolve history [flow.md]   List proposal history (use evolve --help for more)
  md install <url|gh:...@ref>   Install a flow into the registry (--global for user scope)
  md remove <name>              Remove an installed registry flow
  md list                       List installed registry flows
  md setup                      Configure shell (PATH, aliases)
  md logs                       Show agent log directory
  md help                       Show this help

Ad-hoc execution (one-shot mode):
  md.claude "What is 2+2?"                    # Quick prompt to Claude
  md.gemini "Explain quantum computing"       # Quick prompt to Gemini
  md.codex "Write a function"                 # Quick prompt to Codex
  md.copilot "Help me debug"                  # Quick prompt to Copilot
  md.droid "Build an app"                     # Quick prompt to Droid
  md.opencode "Refactor this"                 # Quick prompt to OpenCode
  md.i.claude "Start a chat"                  # Interactive mode
  md.claude "Explain: @error.log" --model opus  # With @imports and flags

Create flows:
  md create "Review staged changes for correctness"        # project: ./flows/
  md create "Turn notes into an action plan" --global       # personal: ~/.mdflow/
  md                              Then browse, run, edit, or improve them

Engine resolution (most explicit wins):
  1. --engine flag (deprecated aliases: --_command/-_c, --tool)
  2. MDFLOW_ENGINE environment variable
  3. Filename pattern (e.g., task.claude.md → claude; must name a real engine)
  4. Frontmatter key (engine: claude; deprecated: tool:/_tool:)
  5. Config engine: (project .mdflow.yaml beats ~/.mdflow/config.yaml)
  6. Built-in default: pi
  A file with no frontmatter and no explicit engine is printed as a document.

Agent file discovery (in priority order):
  1. Explicit path:      md ./path/to/agent.md
  2. Project flows:      ./flows/
  3. Legacy project:     ./.mdflow/
  4. Personal flows:     ~/.mdflow/
  5. $PATH directories
  6. Current directory:  ./

All non-system frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.mdflow/config.yaml

Remote execution:
  md supports running agents from URLs (npx-style).
  On first use, you'll be prompted to trust the domain.
  Trusted domains are stored in ~/.mdflow/known_hosts

Examples:
  md task.claude.md -p "print mode"
  md task.claude.md --model opus --verbose
  md commit.agy.md
  md task.md                      # engine via the ladder (default: pi)
  md task.md --engine claude
  md eval task.md                 # run the flow's eval suite
  md task.claude.md --_dry-run    # Preview without executing
  md https://example.com/agent.claude.md            # Remote execution
  md https://example.com/agent.claude.md --_trust   # Skip trust prompt

Config file example (~/.mdflow/config.yaml):
  commands:
    copilot:
      $1: prompt    # Map body to --prompt flag

md-specific flags (consumed, not passed to command):
  --engine          Specify the engine to run (deprecated aliases: --_command/-_c, --tool)
  --_dry-run        Show command/prompt plan; skip engine and inline commands
  --_edit           Open resolved prompt in $EDITOR before execution
  --_trust          Skip trust prompt for remote URLs (TOFU bypass)
  --_no-cache       Force fresh fetch for remote URLs (bypass cache)
  --raw             Output raw markdown without rendering (for piping)
  --_context        Show context tree and exit (no execution)
  --_quiet          Skip context dashboard display before execution
  --_no-menu        Disable post-run action menu (for scripting/piping)
  --json            Emit a single JSON result object and disable interactive UI
  --no-evolve       Disable post-run evolution handling for this run

Without arguments:
  md              Open the Flow Workbench: browse, create, run, and improve flows
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

/** Canonical project flow roster directory. */
const PROJECT_FLOWS_DIR = "flows";

/** User-level agent directory */
const USER_AGENTS_DIR = join(homedir(), ".mdflow");

/**
 * Find agent markdown files with priority order:
 * 1. Nearest project flow roster: <project>/flows/
 * 2. Legacy project-level: <project>/.mdflow/
 * 3. User-level: ~/.mdflow/
 * 4. $PATH directories
 * 5. Current directory (cwd)
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

  const projectRoot = resolveProjectRoot(process.cwd()).projectRoot;

  // 1. Canonical roster at the same nearest project root used by `md create`.
  const projectFlowsPath = join(projectRoot, PROJECT_FLOWS_DIR);
  try {
    for await (const file of glob.scan({ cwd: projectFlowsPath, absolute: true })) {
      // flows/README.md documents the roster; it is not itself executable.
      if (basename(file).toLowerCase() === "readme.md") continue;
      const normalizedPath = normalizePath(file);
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        const description = extractDescription(normalizedPath);
        files.push({
          name: basename(file),
          path: normalizedPath,
          source: "flows",
          frecency: getFrecencyScore(normalizedPath),
          ...(description && { description }),
        });
      }
    }
  } catch {
    // Skip if flows/ doesn't exist
  }

  // 2. Legacy project-level agents at that same project root.
  const projectAgentsPath = join(projectRoot, PROJECT_AGENTS_DIR);
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

  // 5. Current directory
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

  // Source priority: flows > .mdflow > ~/.mdflow > $PATH > cwd
  const getSourcePriority = (source: string): number => {
    if (source === "flows") return 5;
    if (source === ".mdflow") return 4;
    if (source === "~/.mdflow") return 3;
    if (source === "cwd") return 1;
    return 2; // $PATH directories
  };

  // Sort by source priority first, then frecency, then name
  files.sort((a, b) => {
    const priorityDiff = getSourcePriority(b.source) - getSourcePriority(a.source);
    if (priorityDiff !== 0) return priorityDiff;
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
  return join(resolveProjectRoot(process.cwd()).projectRoot, PROJECT_AGENTS_DIR);
}

/** Get the canonical project flow roster directory. */
export function getProjectFlowsDir(): string {
  return join(resolveProjectRoot(process.cwd()).projectRoot, PROJECT_FLOWS_DIR);
}

/**
 * Get the user agents directory path
 */
export function getUserAgentsDir(): string {
  return USER_AGENTS_DIR;
}

/**
 * Show the interactive Flow Workbench and execute its local management actions.
 * Engine-backed run selections are returned to CliRunner so they still travel
 * through the exact same execution path as `md <flow>`.
 */
export async function showInteractiveSelector(files: AgentFile[]): Promise<FileSelectorSelection | undefined> {
  const { clearWorkbenchPreviewCache, showWorkbench } = await import("./workbench");
  let currentFiles = files;

  const promote = (preferredPath: string) => {
    const normalized = normalizePath(preferredPath);
    const index = currentFiles.findIndex((file) => file.path === normalized);
    if (index > 0) {
      const [preferred] = currentFiles.splice(index, 1);
      if (preferred) currentFiles.unshift(preferred);
    }
  };

  const refreshFiles = async (preferredPath?: string) => {
    currentFiles = await findAgentFiles();
    if (preferredPath) promote(preferredPath);
  };

  const returnToWorkbench = async () => {
    try {
      const { input } = await import("@inquirer/prompts");
      await input({ message: "Press Enter to return to the Flow Workbench" });
    } catch {
      // Ctrl+C exits the current action without turning it into a CLI failure.
    }
  };

  while (true) {
    const { buildWorkbenchStatusMap } = await import("./workbench-status");
    const statuses = await buildWorkbenchStatusMap(currentFiles);
    const projectRoot = resolveProjectRoot(process.cwd()).projectRoot;
    const result = await showWorkbench(currentFiles, {
      projectRoot,
      statuses,
    });

    if (result.action === "cancel") return undefined;
    if ((result.action === "run" || result.action === "dry-run") && result.path) {
      process.stdout.write("\x1b[2J\x1b[H");
      return { path: result.path, dryRun: result.action === "dry-run" };
    }

    if (result.action === "edit" && result.path) {
      const [{ openInEditor }, { recordTouch }] = await Promise.all([
        import("./file-selector"),
        import("./history"),
      ]);
      await recordTouch(result.path);
      openInEditor(result.path);
      clearWorkbenchPreviewCache();
      await refreshFiles(result.path);
      continue;
    }

    if (result.action === "create" && result.draft) {
      const { applyFlowDraft } = await import("./workbench-model");
      const created = applyFlowDraft(result.draft, { startPath: process.cwd() });
      if (created.status === "conflict") {
        console.error(`Flow already exists: ${created.flowPath}`);
      } else {
        console.log(`Created ${created.flowPath}`);
        const { contextualFlowTip } = await import("./tips");
        const tip = contextualFlowTip({ cwd: process.cwd(), flowPath: created.flowPath, created: true });
        if (tip) console.log(`Tip: ${tip}`);
      }
      clearWorkbenchPreviewCache();
      await refreshFiles(created.status === "created" ? created.flowPath : undefined);
      continue;
    }

    if (result.action === "feedback" && result.path && result.feedback) {
      const { recordEvidence } = await import("./evolution-store");
      const feedback = recordEvidence({
        flowPath: result.path,
        type: "explicit_feedback",
        confidence: "high",
        message: result.feedback,
      });
      console.log(`Feedback ${feedback.id} saved. Next: md evolve plan ${result.path}`);
      promote(result.path);
      continue;
    }

    if (
      (result.action === "evolve-plan" || result.action === "evolve-propose")
      && result.path
    ) {
      const { runEvolveCli } = await import("./evolve");
      const action = result.action === "evolve-plan" ? "plan" : "propose";
      await runEvolveCli([action, result.path]);
      await returnToWorkbench();
      await refreshFiles(result.path);
      continue;
    }

    if (
      (result.action === "evolve-apply" || result.action === "evolve-rollback")
      && result.runId
    ) {
      const { runEvolveCli } = await import("./evolve");
      const action = result.action === "evolve-apply" ? "apply" : "rollback";
      await runEvolveCli([action, result.runId]);
      await returnToWorkbench();
      clearWorkbenchPreviewCache();
      await refreshFiles(result.path);
    }
  }
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

  // No file and no flags - show the Flow Workbench if both streams are interactive.
  if (!args.filePath && !args.help) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const mdFiles = await findAgentFiles();
      const selection = await showInteractiveSelector(mdFiles);
      if (selection) {
        // Spinner will be started in cli-runner.ts with command preview.
        return { handled: true, selectedFile: selection.path, dryRun: selection.dryRun };
      }
      throw new EarlyExitRequest();
    }
  }

  return { handled: false };
}
