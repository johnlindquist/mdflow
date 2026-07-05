/**
 * Command execution - simple, direct, unix-style
 * No abstraction layers, just frontmatter → CLI args → spawn
 *
 * Integrates with ProcessManager for centralized process lifecycle management
 */

import type { AgentFrontmatter, Adapter } from "./types";
import { basename } from "path";
import { teeToStdoutAndCollect, teeToStderrAndCollect, teeToStdoutWithMarkdownAndCollect } from "./stream";
import { stopSpinner, isSpinnerRunning } from "./spinner";
import { getProcessManager } from "./process-manager";
import { createStreamingRenderer, type StreamingMarkdownRenderer } from "./markdown-renderer";
import { getRegisteredAdapters, getPortableAdapter, getAdapter as getEngineAdapter, hasAdapter } from "./adapters";
import { CommandError } from "./errors";
import { escapeShellArg as escapeShellArgShared } from "./security";

/**
 * Module-level reference to the current child process
 * Used for graceful signal handling (SIGINT/SIGTERM cleanup)
 * @deprecated Use ProcessManager.getInstance() instead for new code
 */
let currentChildProcess: ReturnType<typeof Bun.spawn> | null = null;

/**
 * Get the current child process reference
 * Returns null if no process is running
 * @deprecated Use ProcessManager.getInstance().getActiveProcesses() instead
 */
export function getCurrentChildProcess(): ReturnType<typeof Bun.spawn> | null {
  return currentChildProcess;
}

/**
 * Kill the current child process if running
 * Returns true if a process was killed, false otherwise
 * @deprecated Use ProcessManager.getInstance().killAll() instead
 */
export function killCurrentChildProcess(): boolean {
  // First try ProcessManager (which handles process groups)
  const pm = getProcessManager();
  if (pm.activeCount > 0) {
    pm.killAll();
    currentChildProcess = null;
    return true;
  }

  // Fallback for legacy code
  if (currentChildProcess) {
    try {
      currentChildProcess.kill("SIGTERM");
      return true;
    } catch {
      // Process may have already exited
      return false;
    }
  }
  return false;
}

/**
 * Keys strictly reserved for mdflow internal logic.
 * These are NEVER passed as flags to the command.
 *
 * Note: Keys starting with '_' are already filtered in buildArgs,
 * but we list them here for documentation and explicit filtering.
 */
const SYSTEM_KEYS = new Set([
  // Template variable mapping
  "_inputs", // Named positional arguments

  // Environment configuration
  "_env", // Sets process.env

  // Internal config (prevents context_window from leaking as --context_window)
  "context_window",
  "_context_window",

  // Mode control
  "_interactive",
  "_i",

  // Execution control
  "_subcommand",
  "_cwd",
  "_dry-run",
  "_edit",
  "_trust",
  "_no-cache",
  "_no-menu", // Disable post-run action menu

  // Engine selection (v3 key + deprecated v2 aliases)
  "engine",
  "_command",
  "_c",
  "tool",
  "_tool",

  // Flow metadata (v3): human/roster-facing, never CLI flags. `description`
  // is what marks a minimal file as a flow; `route` is reserved for keyword
  // routing.
  "description",
  "route",
]);

/**
 * Check if a key is a positional mapping ($1, $2, etc.)
 */
function isPositionalKey(key: string): boolean {
  return /^\$\d+$/.test(key);
}

/**
 * Variadic flags that consume all following positional arguments.
 * These must use --flag=value syntax to avoid eating the prompt.
 */
const VARIADIC_FLAGS = new Set([
  "allowed-tools",
  "allowedTools",
  "disallowed-tools",
  "disallowedTools",
  "tools",
  "add-dir",
  "betas",
  "mcp-config",
  "plugin-dir",
]);

/**
 * Extract command from filename
 * e.g., "commit.claude.md" → "claude"
 * e.g., "task.gemini.md" → "gemini"
 * e.g., "fix.i.claude.md" → "claude" (with interactive mode)
 */
export function parseCommandFromFilename(filePath: string): string | undefined {
  const name = basename(filePath);
  // Match pattern: name.command.md or name.i.command.md
  const match = name.match(/\.([^.]+)\.md$/i);
  return match?.[1];
}

/**
 * Check if filename has .i. marker for interactive mode
 * e.g., "fix.i.claude.md" → true
 * e.g., "fix.claude.md" → false
 */
export function hasInteractiveMarker(filePath: string): boolean {
  const name = basename(filePath);
  // Match pattern: name.i.command.md
  return /\.i\.[^.]+\.md$/i.test(name);
}

function validateResolvedCommand(
  candidate: string,
  source: "filename" | "frontmatter" | "env" | "config",
  filePath: string
): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new CommandError(
      `Unable to resolve command from "${source}" in "${filePath}". The command value is empty.`,
      {
        errorCode: "COMMAND_INVALID",
        context: { filePath, source, suggestion: "Set --_command/--tool, rename to task.<tool>.md, or add frontmatter tool: <tool>." },
      }
    );
  }

  if (!isValidCommandToken(trimmed)) {
    const didYouMean = formatDidYouMean(trimmed);
    throw new CommandError(
      `Invalid command "${trimmed}" from ${source} in "${filePath}".${didYouMean} ` +
      "Use a command token with letters, numbers, dots, underscores, or hyphens.",
      {
        errorCode: "COMMAND_INVALID",
        context: { filePath, command: trimmed, source },
      }
    );
  }

  return trimmed;
}

/**
 * The engine used when nothing else names one. pi is the flagship learnable
 * engine (full event telemetry, subscription auth bridge), so it is the v3
 * default; every other engine is one `engine:` line away.
 */
export const DEFAULT_ENGINE = "pi";

/** Which rung of the resolution ladder produced the engine. */
export type EngineSource = "cli" | "env" | "filename" | "frontmatter" | "config" | "default";

export interface ResolvedEngine {
  engine: string;
  source: EngineSource;
  /** Set when the engine came from a deprecated frontmatter key. */
  deprecatedKey?: "tool" | "_tool";
  /**
   * Set when the filename had an engine-shaped segment that names no known
   * engine (no registered adapter, no binary on PATH) — e.g. report.final.md.
   * The ladder fell through; callers should surface this so a typo like
   * task.claud.md doesn't silently run on the default engine.
   */
  skippedFilenameEngine?: string;
}

/**
 * A filename segment only claims the engine rung when it names something
 * that can actually run: a registered adapter or a binary on PATH. This keeps
 * v3's bare dotted filenames (report.final.md) from being misread as engines
 * while .echo.md-style custom engines keep working.
 */
function filenameEngineExists(candidate: string): boolean {
  if (hasAdapter(candidate)) return true;
  try {
    return Bun.which(candidate) !== null;
  } catch {
    return false;
  }
}

/**
 * Extract the engine from frontmatter. `engine:` is the v3 key; `tool:` and
 * `_tool:` are deprecated v2 aliases (in that precedence order).
 */
export function parseEngineFromFrontmatter(
  frontmatter: AgentFrontmatter
): { engine: string; key: "engine" | "tool" | "_tool" } | undefined {
  const engine = frontmatter.engine;
  if (typeof engine === "string") return { engine, key: "engine" };

  const tool = frontmatter.tool;
  if (typeof tool === "string") return { engine: tool, key: "tool" };

  const underscoreTool = frontmatter._tool;
  if (typeof underscoreTool === "string") return { engine: underscoreTool, key: "_tool" };

  return undefined;
}

/**
 * @deprecated v3: use `parseEngineFromFrontmatter` (this reads only the
 * legacy `tool:`/`_tool:` keys).
 */
export function parseCommandFromFrontmatter(frontmatter: AgentFrontmatter): string | undefined {
  const tool = frontmatter.tool;
  if (typeof tool === "string") return tool;

  const underscoreTool = frontmatter._tool;
  if (typeof underscoreTool === "string") return underscoreTool;

  return undefined;
}

/**
 * Resolve the engine for a flow file. The ladder, most explicit first:
 *
 * 1) `--engine` CLI flag        (handled upstream in cli-runner)
 * 2) MDFLOW_ENGINE env var      ("run everything on X" override)
 * 3) filename suffix            (`task.claude.md`)
 * 4) frontmatter `engine:`      (aliases: deprecated `tool:`/`_tool:`)
 * 5) config `engine:`           (project config beats ~/.mdflow/config.yaml)
 * 6) built-in default           (DEFAULT_ENGINE)
 *
 * Resolution never fails for a missing engine — the default always applies.
 * Callers decide what implicit resolution means (e.g. a frontmatter-less file
 * resolved implicitly is a document, not a flow) and surface `source` to the
 * user so defaults stay inspectable, never magic.
 */
export function resolveEngine(
  filePath: string,
  frontmatter?: AgentFrontmatter,
  opts: { configEngine?: string; env?: Record<string, string | undefined> } = {}
): ResolvedEngine {
  const env = opts.env ?? process.env;

  const fromEnv = env.MDFLOW_ENGINE;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { engine: validateResolvedCommand(fromEnv, "env", filePath), source: "env" };
  }

  const fromFilename = parseCommandFromFilename(filePath);
  let skippedFilenameEngine: string | undefined;
  if (fromFilename) {
    // Filenames are names, not declarations — the segment only wins when it
    // names a runnable engine; otherwise fall through (and report the skip so
    // callers can warn about likely typos like task.claud.md).
    if (isValidCommandToken(fromFilename.trim()) && filenameEngineExists(fromFilename.trim())) {
      return { engine: fromFilename.trim(), source: "filename" };
    }
    skippedFilenameEngine = fromFilename;
  }

  const withSkip = (resolved: ResolvedEngine): ResolvedEngine =>
    skippedFilenameEngine ? { ...resolved, skippedFilenameEngine } : resolved;

  if (frontmatter) {
    const fromFrontmatter = parseEngineFromFrontmatter(frontmatter);
    if (fromFrontmatter) {
      return withSkip({
        engine: validateResolvedCommand(fromFrontmatter.engine, "frontmatter", filePath),
        source: "frontmatter",
        ...(fromFrontmatter.key === "engine" ? {} : { deprecatedKey: fromFrontmatter.key }),
      });
    }
  }

  if (typeof opts.configEngine === "string" && opts.configEngine.trim()) {
    return withSkip({ engine: validateResolvedCommand(opts.configEngine, "config", filePath), source: "config" });
  }

  return withSkip({ engine: DEFAULT_ENGINE, source: "default" });
}

/**
 * @deprecated v3: use `resolveEngine`, which also reports the resolution
 * source. This wrapper keeps the engine-only signature and, unlike v2, never
 * throws for a missing command — the default engine applies instead.
 */
export function resolveCommand(filePath: string, frontmatter?: AgentFrontmatter): string {
  return resolveEngine(filePath, frontmatter).engine;
}

const VALID_COMMAND_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isValidCommandToken(command: string): boolean {
  return VALID_COMMAND_TOKEN.test(command);
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }

  return dp[rows - 1]![cols - 1]!;
}

function getCommandSuggestions(command: string, max: number = 3): string[] {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return [];

  const candidates = Array.from(new Set(getRegisteredAdapters().map((c) => c.toLowerCase())));
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: levenshteinDistance(normalized, candidate) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));

  const threshold = Math.max(2, Math.ceil(normalized.length * 0.4));
  return ranked
    .filter(({ candidate, distance }) =>
      candidate.startsWith(normalized) ||
      normalized.startsWith(candidate) ||
      distance <= threshold
    )
    .slice(0, max)
    .map(({ candidate }) => candidate);
}

function formatDidYouMean(command: string): string {
  const suggestions = getCommandSuggestions(command);
  if (suggestions.length === 0) return "";
  if (suggestions.length === 1) return `Did you mean '${suggestions[0]}'?`;
  return `Did you mean one of: ${suggestions.map((s) => `'${s}'`).join(", ")}?`;
}

/**
 * Convert frontmatter key to CLI flag
 * e.g., "model" → "--model"
 * e.g., "p" → "-p"
 */
function toFlag(key: string): string {
  if (key.startsWith("-")) return key;
  if (key.length === 1) return `-${key}`;
  return `--${key}`;
}

/**
 * Build CLI args from frontmatter
 * Each key becomes a flag, values become arguments
 */
function buildGenericArgs(
  frontmatter: AgentFrontmatter,
  templateVars: Set<string>
): string[] {
  const args: string[] = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    // Skip system keys
    if (SYSTEM_KEYS.has(key)) continue;

    // Skip positional mappings ($1, $2, etc.) - handled separately
    if (isPositionalKey(key)) continue;

    // Skip named template variable fields ($varname) - consumed for template substitution
    if (key.startsWith("$")) continue;

    // Skip internal md keys (_interactive, _subcommand, etc.)
    if (key.startsWith("_")) continue;

    // Skip template variables (used for substitution, not passed to command)
    if (templateVars.has(key)) continue;

    // Skip undefined/null/false
    if (value === undefined || value === null || value === false) continue;

    // Boolean true → just the flag
    if (value === true) {
      args.push(toFlag(key));
      continue;
    }

    // Array → repeat flag for each value
    if (Array.isArray(value)) {
      for (const v of value) {
        // Variadic flags need --flag=value syntax to not eat following args
        if (VARIADIC_FLAGS.has(key)) {
          args.push(`${toFlag(key)}=${String(v)}`);
        } else {
          args.push(toFlag(key), String(v));
        }
      }
      continue;
    }

    // String/number → flag with value
    // Variadic flags need --flag=value syntax to not eat following args
    if (VARIADIC_FLAGS.has(key)) {
      const strValue = String(value);
      // Split comma-separated values for variadic flags
      // Handle both "Read,Edit" and "Bash(git commit:*), Bash(git add:*)"
      const parts = strValue.includes(", ")
        ? strValue.split(", ")  // Split on ", " (comma + space)
        : strValue.includes(",")
          ? strValue.split(",")  // Split on just ","
          : [strValue];          // No commas, single value
      for (const part of parts) {
        args.push(`${toFlag(key)}=${part.trim()}`);
      }
    } else {
      args.push(toFlag(key), String(value));
    }
  }

  return args;
}

/**
 * Resolve portable adapter for a command/provider.
 */
export function getAdapter(command: string): Adapter | undefined {
  if (!command) return undefined;
  return getPortableAdapter(command);
}

export function buildArgs(
  frontmatter: AgentFrontmatter,
  templateVars: Set<string>,
  command?: string
): string[] {
  const adapter = command ? getAdapter(command) : undefined;
  if (!adapter) {
    return buildGenericArgs(frontmatter, templateVars);
  }

  const normalized = adapter.normalizeFrontmatter(frontmatter);
  return adapter.buildArgs(normalized, templateVars, buildGenericArgs);
}

/**
 * Extract positional mappings from frontmatter ($1, $2, etc.)
 * Returns a map of position number to flag name
 */
export function extractPositionalMappings(frontmatter: AgentFrontmatter): Map<number, string> {
  const mappings = new Map<number, string>();

  for (const [key, value] of Object.entries(frontmatter)) {
    if (isPositionalKey(key) && typeof value === "string") {
      const pos = parseInt(key.slice(1), 10);
      mappings.set(pos, value);
    }
  }

  return mappings;
}

/**
 * Extract environment variables to set (from _env key)
 *
 * Uses the `_env` key which follows the underscore-prefix convention
 * for system keys that are consumed by mdflow and not passed to the command.
 */
export function extractEnvVars(frontmatter: AgentFrontmatter): Record<string, string> | undefined {
  // Use _env key
  const env = frontmatter._env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return env as Record<string, string>;
  }
  return undefined;
}

/**
 * Output capture mode for runCommand
 * - "none": Inherit stdout/stderr, no capture (streaming to terminal)
 * - "capture": Pipe and buffer output, print after completion
 * - "tee": Tee streams - simultaneous display and capture (best of both)
 */
export type CaptureMode = "none" | "capture" | "tee";

export interface RunContext {
  /** The command to execute */
  command: string;
  /** CLI args built from frontmatter */
  args: string[];
  /** Positional arguments (body is $1, additional CLI args are $2, $3, etc.) */
  positionals: string[];
  /** Positional mappings ($1 → flag name) */
  positionalMappings: Map<number, string>;
  /**
   * Whether to capture output (legacy boolean) or capture mode
   * - false / "none": inherit stdout, no capture
   * - true / "capture": pipe and buffer, print after completion
   * - "tee": stream to stdout while capturing (simultaneous display + capture)
   */
  captureOutput: boolean | CaptureMode;
  /** Environment variables to add */
  env?: Record<string, string>;
  /**
   * Whether to also capture stderr (only applies when captureOutput is enabled)
   * Default: false (stderr goes to inherit)
   */
  captureStderr?: boolean;
  /**
   * Whether to output raw markdown without rendering (--raw flag)
   * Default: false (render markdown with syntax highlighting)
   */
  rawOutput?: boolean;
}

export interface RunResult {
  exitCode: number;
  /** Captured stdout content (empty string if not capturing) */
  stdout: string;
  /** Captured stderr content (empty string if not capturing stderr) */
  stderr: string;
  /**
   * @deprecated Use `stdout` instead. Kept for backward compatibility.
   */
  output: string;
  /** The subprocess reference for signal handling */
  process: ReturnType<typeof Bun.spawn>;
}

/**
 * Normalize capture mode from boolean or string to CaptureMode
 */
function normalizeCaptureMode(mode: boolean | CaptureMode): CaptureMode {
  if (mode === true) return "capture";
  if (mode === false) return "none";
  return mode;
}

function hasNullByte(value: string): boolean {
  return value.includes("\0");
}

/**
 * Escape a CLI argument for shell-safe display in logs/previews.
 * This is display-only; process execution always uses argv arrays.
 */
export function escapeShellArg(arg: string): string {
  return escapeShellArgShared(arg, process.platform === "win32" ? "win32" : "posix");
}

function formatSpawnPreview(command: string, args: string[]): string {
  return [command, ...args]
    .map((arg) => escapeShellArg(arg))
    .join(" ");
}

/**
 * Execute command with positional arguments
 * Positionals are either passed as-is or mapped to flags via $N mappings
 *
 * Capture modes:
 * - "none": Inherit stdout/stderr (streaming to terminal, no capture)
 * - "capture": Pipe and buffer output, print after completion
 * - "tee": Stream to stdout/stderr while capturing (simultaneous display + capture)
 *
 * Markdown rendering:
 * - By default, stdout is rendered as markdown with syntax highlighting
 * - Use rawOutput: true (--raw flag) to bypass rendering for piping
 */
export async function runCommand(ctx: RunContext): Promise<RunResult> {
  const { command, args, positionals, positionalMappings, captureOutput, env, captureStderr = false, rawOutput = false } = ctx;

  const mode = normalizeCaptureMode(captureOutput);
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    console.error("Command not found: empty command value.");
    console.error("Use --_command <tool> or name your file like task.<tool>.md.");
    return { exitCode: 127, stdout: "", stderr: "", output: "", process: null as unknown as ReturnType<typeof Bun.spawn> };
  }

  if (!isValidCommandToken(normalizedCommand)) {
    const didYouMean = formatDidYouMean(normalizedCommand);
    console.error(`Invalid command token: '${normalizedCommand}'.`);
    if (didYouMean) {
      console.error(didYouMean);
    }
    console.error("Use a command/binary name without spaces. Example: --_command claude");
    return { exitCode: 127, stdout: "", stderr: "", output: "", process: null as unknown as ReturnType<typeof Bun.spawn> };
  }

  // Pre-flight check: verify the command exists
  const binaryPath = Bun.which(normalizedCommand);
  if (!binaryPath) {
    const didYouMean = formatDidYouMean(normalizedCommand);
    console.error(`Command not found: '${normalizedCommand}'`);
    if (didYouMean) {
      console.error(didYouMean);
    }
    console.error(`This agent requires '${normalizedCommand}' to be installed and available in your PATH.`);
    console.error("Install it, or override with --_command <installed-binary>.");
    // Return empty process-like object for backward compatibility
    return { exitCode: 127, stdout: "", stderr: "", output: "", process: null as unknown as ReturnType<typeof Bun.spawn> };
  }

  // Build final command args
  const finalArgs = [...args];

  // Process positional arguments
  for (let i = 0; i < positionals.length; i++) {
    const pos = i + 1; // $1 is first positional
    const value = positionals[i];
    if (value === undefined) continue;

    if (positionalMappings.has(pos)) {
      // Map to flag: $1: prompt → --prompt <value>
      const flagName = positionalMappings.get(pos)!;
      finalArgs.push(toFlag(flagName), value);
    } else {
      // Pass as positional argument
      finalArgs.push(value);
    }
  }

  const invalidArgIndex = finalArgs.findIndex(hasNullByte);
  if (invalidArgIndex !== -1) {
    console.error(
      `Rejected command argument at index ${invalidArgIndex}: null bytes are not allowed in spawned process arguments.`
    );
    return { exitCode: 127, stdout: "", stderr: "", output: "", process: null as unknown as ReturnType<typeof Bun.spawn> };
  }

  // Engine adapters may contribute env vars (e.g. pi's bridged auth dir).
  // Precedence: adapter vars < process.env < explicit ctx.env — an adapter
  // never overrides something the user already set.
  let adapterEnv: Record<string, string> | undefined;
  // NOTE: command.ts exports its own getAdapter (the portable-key layer), so
  // the registry lookup is imported under a distinct name.
  const engineAdapter = getEngineAdapter(normalizedCommand);
  if (engineAdapter.prepareEnv) {
    try {
      adapterEnv = engineAdapter.prepareEnv();
    } catch (err) {
      console.error(`Warning [ADAPTER_ENV]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Merge process.env with provided env
  const runEnv = env || adapterEnv
    ? { ...adapterEnv, ...process.env, ...env }
    : undefined;

  // Determine stdout/stderr pipe config based on mode
  // When spinner is running, we need to pipe stdout to detect first output
  const spinnerActive = isSpinnerRunning();
  const shouldPipeStdout = mode === "capture" || mode === "tee" || spinnerActive;
  const shouldPipeStderr = (mode === "capture" || mode === "tee") && captureStderr;

  const proc = Bun.spawn([normalizedCommand, ...finalArgs], {
    stdout: shouldPipeStdout ? "pipe" : "inherit",
    stderr: shouldPipeStderr ? "pipe" : "inherit",
    stdin: "inherit",
    env: runEnv,
  });

  // Register with ProcessManager for centralized lifecycle management
  const pm = getProcessManager();
  pm.register(proc, formatSpawnPreview(normalizedCommand, finalArgs));

  // Store reference for legacy signal handling (deprecated)
  currentChildProcess = proc;

  let stdout = "";
  let stderr = "";

  // Create markdown renderer for streaming output (respects rawOutput and TTY detection)
  const markdownRenderer = createStreamingRenderer(rawOutput);

  // Handle output based on mode
  if (mode === "tee") {
    // Stop spinner before streaming output starts
    stopSpinner();

    // Tee mode: stream to console while capturing (with markdown rendering)
    const promises: Promise<void>[] = [];

    if (proc.stdout) {
      promises.push(
        teeToStdoutWithMarkdownAndCollect(proc.stdout, markdownRenderer).then((content) => {
          stdout = content;
        })
      );
    }

    if (proc.stderr && shouldPipeStderr) {
      promises.push(
        teeToStderrAndCollect(proc.stderr).then((content) => {
          stderr = content;
        })
      );
    }

    await Promise.all(promises);
  } else if (mode === "capture") {
    // Stop spinner before reading output
    stopSpinner();

    // Capture mode: buffer then print (with markdown rendering)
    if (proc.stdout) {
      stdout = await new Response(proc.stdout).text();
      // Render and print to console so user sees it
      const rendered = markdownRenderer.processChunk(stdout);
      const final = markdownRenderer.flush();
      console.log(rendered + final);
    }

    if (proc.stderr && shouldPipeStderr) {
      stderr = await new Response(proc.stderr).text();
      // Print stderr to console (no markdown rendering for stderr)
      console.error(stderr);
    }
  } else if (spinnerActive && proc.stdout) {
    // Spinner mode: stream to stdout with markdown rendering, stop spinner on first output
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (firstChunk) {
        stopSpinner();
        firstChunk = false;
      }

      // Process chunk through markdown renderer
      const chunk = decoder.decode(value, { stream: true });
      const rendered = markdownRenderer.processChunk(chunk);
      if (rendered) {
        process.stdout.write(rendered);
      }
    }

    // Flush any remaining content
    const remaining = markdownRenderer.flush();
    if (remaining) {
      process.stdout.write(remaining + "\n");
    }
  }
  // mode === "none" without spinner: stdout/stderr are inherited, nothing to capture

  const exitCode = await proc.exited;

  // Ensure spinner is stopped (in case process exited without output)
  stopSpinner();

  // Clear reference after process exits
  currentChildProcess = null;

  return {
    exitCode,
    stdout,
    stderr,
    output: stdout, // backward compatibility
    process: proc,
  };
}
