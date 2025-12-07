/**
 * Command execution - simple, direct, unix-style
 * No abstraction layers, just frontmatter → CLI args → spawn
 */

import type { AgentFrontmatter } from "./types";
import { basename } from "path";

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
 */
export function parseCommandFromFilename(filePath: string): string | undefined {
  const name = basename(filePath);
  // Match pattern: name.command.md
  const match = name.match(/\.([^.]+)\.md$/i);
  return match?.[1];
}

/**
 * Resolve command from filename pattern
 * Note: --command flag is handled in index.ts before this is called
 */
export function resolveCommand(filePath: string): string {
  const fromFilename = parseCommandFromFilename(filePath);
  if (fromFilename) {
    return fromFilename;
  }

  throw new Error(
    "No command specified. Use --command flag, " +
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

export interface RunContext {
  /** The command to execute */
  command: string;
  /** CLI args built from frontmatter */
  args: string[];
  /** Positional arguments (body is $1, additional CLI args are $2, $3, etc.) */
  positionals: string[];
  /** Positional mappings ($1 → flag name) */
  positionalMappings: Map<number, string>;
  /** Whether to capture output */
  captureOutput: boolean;
  /** Environment variables to add */
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  output: string;
}

/**
 * Execute command with positional arguments
 * Positionals are either passed as-is or mapped to flags via $N mappings
 */
export async function runCommand(ctx: RunContext): Promise<RunResult> {
  const { command, args, positionals, positionalMappings, captureOutput, env } = ctx;

  // Pre-flight check: verify the command exists
  const binaryPath = Bun.which(command);
  if (!binaryPath) {
    console.error(`Command not found: '${command}'`);
    console.error(`This agent requires '${command}' to be installed and available in your PATH.`);
    console.error(`Please install it and try again.`);
    return { exitCode: 127, output: "" };  // 127 = command not found
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

  const proc = Bun.spawn([command, ...finalArgs], {
    stdout: captureOutput ? "pipe" : "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: runEnv,
  });

  let output = "";
  if (captureOutput && proc.stdout) {
    output = await new Response(proc.stdout).text();
    // Still print to console so user sees it
    console.log(output);
  }

  const exitCode = await proc.exited;
  return { exitCode, output };
}
