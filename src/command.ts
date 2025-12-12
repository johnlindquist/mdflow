/**
 * Command execution - simple, direct, unix-style
 * No abstraction layers, just frontmatter → CLI args → spawn
 */

import type { AgentFrontmatter } from "./types";
import { basename } from "path";
import { teeToStdoutAndCollect, teeToStderrAndCollect } from "./stream";

/**
 * Module-level reference to the current child process
 * Used for graceful signal handling (SIGINT/SIGTERM cleanup)
 */
let currentChildProcess: ReturnType<typeof Bun.spawn> | null = null;

/**
 * Get the current child process reference
 * Returns null if no process is running
 */
export function getCurrentChildProcess(): ReturnType<typeof Bun.spawn> | null {
  return currentChildProcess;
}

/**
 * Kill the current child process if running
 * Returns true if a process was killed, false otherwise
 */
export function killCurrentChildProcess(): boolean {
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
 * Keys handled by the system, not passed to the command
 * - args: consumed for template variable mapping
 * - env (when object): sets process.env, not passed as flag
 * - $N patterns: positional mapping, handled specially
 */
const SYSTEM_KEYS = new Set([
  "args",
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

    // Handle polymorphic env key
    if (key === "env") {
      // Object form: sets process.env, skip here
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        continue;
      }
      // Array/string form: pass as --env flags (fall through)
    }

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
 * Extract environment variables to set (from object form of env)
 */
export function extractEnvVars(frontmatter: AgentFrontmatter): Record<string, string> | undefined {
  const env = frontmatter.env;
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
 */
export async function runCommand(ctx: RunContext): Promise<RunResult> {
  const { command, args, positionals, positionalMappings, captureOutput, env, captureStderr = false } = ctx;

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
  const shouldPipeStdout = mode === "capture" || mode === "tee";
  const shouldPipeStderr = (mode === "capture" || mode === "tee") && captureStderr;

  const proc = Bun.spawn([command, ...finalArgs], {
    stdout: shouldPipeStdout ? "pipe" : "inherit",
    stderr: shouldPipeStderr ? "pipe" : "inherit",
    stdin: "inherit",
    env: runEnv,
  });

  // Store reference for signal handling
  currentChildProcess = proc;

  let stdout = "";
  let stderr = "";

  // Handle output based on mode
  if (mode === "tee") {
    // Tee mode: stream to console while capturing
    const promises: Promise<void>[] = [];

    if (proc.stdout) {
      promises.push(
        teeToStdoutAndCollect(proc.stdout).then((content) => {
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
    // Capture mode: buffer then print
    if (proc.stdout) {
      stdout = await new Response(proc.stdout).text();
      // Still print to console so user sees it
      console.log(stdout);
    }

    if (proc.stderr && shouldPipeStderr) {
      stderr = await new Response(proc.stderr).text();
      // Print stderr to console
      console.error(stderr);
    }
  }
  // mode === "none": stdout/stderr are inherited, nothing to capture

  const exitCode = await proc.exited;

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
