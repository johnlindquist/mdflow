import { Glob } from "bun";
import { basename, join, delimiter } from "path";
import { realpathSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { EarlyExitRequest } from "./errors";
import { LRUCache } from "./cache";
import { resolveProjectRoot } from "./project-root";
import { GLOBAL_HELP_TEXT } from "./help-text";
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
  console.log(GLOBAL_HELP_TEXT);
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
      const { tabSafePause } = await import("./workbench-input");
      await tabSafePause("Press Enter to return to the Flow Workbench");
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
      cwd: process.cwd(),
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

    if (result.action === "hooks-open" && result.path && result.hooksPath) {
      const [{ openInEditor }, { recordTouch }, { clearWorkbenchHooksStatusCache }] = await Promise.all([
        import("./file-selector"),
        import("./history"),
        import("./workbench-hooks"),
      ]);
      await recordTouch(result.path);
      openInEditor(result.hooksPath);
      clearWorkbenchHooksStatusCache(result.hooksPath);
      await refreshFiles(result.path);
      continue;
    }

    if (
      result.action === "hooks-add"
      && result.path
      && result.hooksPath
      && result.hookEvents?.length
    ) {
      const [hooks, hooksCli, selector, workbenchHooks] = await Promise.all([
        import("./hooks"),
        import("./hooks-cli"),
        import("./file-selector"),
        import("./workbench-hooks"),
      ]);
      // Re-check at the write boundary: if another process created the sibling
      // after the picker opened, edit that file instead of extending it behind
      // the user's back.
      const resolved = hooks.resolveHooksFile({ flowPath: result.path });
      if (resolved.kind === "file" && !resolved.missing) {
        selector.openInEditor(resolved.path);
      } else {
        await hooksCli.runHooksCli(
          ["add", result.path, ...result.hookEvents],
          { cwd: process.cwd(), isTTY: false },
        );
      }
      workbenchHooks.clearWorkbenchHooksStatusCache(result.hooksPath);
      await refreshFiles(result.path);
      continue;
    }

    if (result.action === "create" && result.createArgs) {
      const { runCreate } = await import("./create");
      const created = await runCreate(result.createArgs, { cwd: process.cwd() });
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
