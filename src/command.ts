/**
 * Command execution - simple, direct, unix-style
 * No abstraction layers, just frontmatter → CLI args → spawn
 */

import type { AgentFrontmatter } from "./types";
import { basename } from "path";

/** Keys handled by the system, not passed to the command */
const SYSTEM_KEYS = new Set([
  "command",
  "inputs",
  "requires",
  "cache",
  "$1",  // Map first positional (body) to a flag
]);

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
 * Resolve which command to use
 * Priority: frontmatter command > filename inference
 */
export function resolveCommand(options: {
  frontmatter: AgentFrontmatter;
  filePath: string;
}): string {
  const { frontmatter, filePath } = options;

  // 1. Frontmatter explicit command
  if (frontmatter.command) {
    return frontmatter.command;
  }

  // 2. Infer from filename
  const fromFilename = parseCommandFromFilename(filePath);
  if (fromFilename) {
    return fromFilename;
  }

  // 3. No command specified - error will be handled by caller
  throw new Error(
    "No command specified. Add 'command:' to frontmatter, " +
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

export interface RunContext {
  /** The command to execute */
  command: string;
  /** CLI args built from frontmatter */
  args: string[];
  /** The prompt (markdown body) */
  prompt: string;
  /** Whether to capture output */
  captureOutput: boolean;
  /** Map $1 (body) to a flag instead of positional (e.g., "prompt" → --prompt <body>) */
  positionalMap?: string;
}

export interface RunResult {
  exitCode: number;
  output: string;
}

/**
 * Execute command with prompt as argument
 */
export async function runCommand(ctx: RunContext): Promise<RunResult> {
  const { command, args, prompt, captureOutput, positionalMap } = ctx;

  // Build final command args
  let finalArgs: string[];
  if (positionalMap) {
    // $1: prompt → --prompt <body>
    finalArgs = [...args, toFlag(positionalMap), prompt];
  } else {
    // Pass prompt as final positional argument
    finalArgs = [...args, prompt];
  }

  const proc = Bun.spawn([command, ...finalArgs], {
    stdout: captureOutput ? "pipe" : "inherit",
    stderr: "inherit",
    stdin: "inherit",
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
