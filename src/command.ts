/**
 * Command execution - simple, direct, unix-style
 * No abstraction layers, just frontmatter → CLI args → spawn
 *
 * Integrates with ProcessManager for centralized process lifecycle management
 */

import type { AgentFrontmatter } from "./types";
import { basename } from "path";
import { teeToStdoutAndCollect, teeToStderrAndCollect, teeToStdoutWithMarkdownAndCollect } from "./stream";
import { stopSpinner, isSpinnerRunning } from "./spinner";
import { getProcessManager } from "./process-manager";
import { createStreamingRenderer, type StreamingMarkdownRenderer } from "./markdown-renderer";

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
  "_trust",
  "_no-cache",

  // Command override
  "_command",
  "_c",
]);

/**
 * Check if a key is a positional mapping ($1, $2, etc.)
 */
function isPositionalKey(key: string): boolean {
  return /^\$\d+$/.test(key);
}

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

/**
 * Resolve command from filename pattern
 * Note: --_command flag is handled in index.ts before this is called
 */
export function resolveCommand(filePath: string): string {
  const fromFilename = parseCommandFromFilename(filePath);
  if (fromFilename) {
    return fromFilename;
  }

  throw new Error(
    "No command specified. Use --_command flag, " +
    "or name your file like 'task.claude.md'"
  );
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
export function buildArgs(
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
        args.push(toFlag(key), String(v));
      }
      continue;
    }

    // String/number → flag with value
    args.push(toFlag(key), String(value));
  }

  return args;
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

  // Pre-flight check: verify the command exists
  const binaryPath = Bun.which(command);
  if (!binaryPath) {
    console.error(`Command not found: '${command}'`);
    console.error(`This agent requires '${command}' to be installed and available in your PATH.`);
    console.error(`Please install it and try again.`);
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

  // Merge process.env with provided env
  const runEnv = env
    ? { ...process.env, ...env }
    : undefined;

  // Determine stdout/stderr pipe config based on mode
  // When spinner is running, we need to pipe stdout to detect first output
  const spinnerActive = isSpinnerRunning();
  const shouldPipeStdout = mode === "capture" || mode === "tee" || spinnerActive;
  const shouldPipeStderr = (mode === "capture" || mode === "tee") && captureStderr;

  const proc = Bun.spawn([command, ...finalArgs], {
    stdout: shouldPipeStdout ? "pipe" : "inherit",
    stderr: shouldPipeStderr ? "pipe" : "inherit",
    stdin: "inherit",
    env: runEnv,
  });

  // Register with ProcessManager for centralized lifecycle management
  const pm = getProcessManager();
  pm.register(proc, command);

  // Store reference for legacy signal handling (deprecated)
  currentChildProcess = proc;

  let stdout = "";
  let stderr = "";

  // Create markdown renderer for streaming output (respects rawOutput and TTY detection)
  const markdownRenderer = createStreamingRenderer(rawOutput);

  // Handle output based on mode
  if (mode === "tee") {
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
