/**
 * Shared flag utilities for harnesses
 * Handles passthrough flags and universal key mapping
 */

import type { AgentFrontmatter } from "../types";

/**
 * Keys that are handled specially by the markdown-agent system
 * and should NOT be passed through to harnesses as CLI flags
 */
const SYSTEM_KEYS = new Set([
  // Harness selection
  "harness",
  // Harness-specific configs (handled separately)
  "claude", "codex", "copilot", "gemini",
  // markdown-agent specific features
  "inputs", "context", "extract", "cache", "requires",
]);

/**
 * Universal keys that map to harness-specific flags
 * These are handled explicitly by each harness, not passed through
 */
const UNIVERSAL_KEYS = new Set([
  "model",
  "interactive",
  // Session (new)
  "session",
  // Session (deprecated)
  "resume",
  "continue",
  // Approval (new)
  "approval",
  // Approval (deprecated)
  "allow-all-tools",
  "allow-all-paths",
  // Tools (new)
  "tools",
  // Tools (deprecated)
  "allow-tool",
  "deny-tool",
  // Dirs (new)
  "dirs",
  // Dirs (deprecated)
  "add-dir",
  // MCP
  "mcp-config",
  // Output (new)
  "output",
  // Output (deprecated)
  "output-format",
  // Debug
  "debug",
]);

/**
 * Convert a frontmatter key to a CLI flag
 * e.g., "my-flag" -> "--my-flag"
 */
function toFlag(key: string): string {
  // Already has dashes prefix
  if (key.startsWith("-")) return key;
  // Single char -> short flag
  if (key.length === 1) return `-${key}`;
  // Otherwise -> long flag
  return `--${key}`;
}

/**
 * Convert a value to CLI argument(s)
 */
function valueToArgs(key: string, value: unknown): string[] {
  if (value === true) {
    return [toFlag(key)];
  }
  if (value === false || value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    // Repeat the flag for each value
    return value.flatMap(v => [toFlag(key), String(v)]);
  }
  return [toFlag(key), String(value)];
}

export interface PassthroughOptions {
  /** Keys that this harness handles explicitly (don't passthrough) */
  handledKeys?: Set<string>;
  /** Additional keys to skip */
  skipKeys?: string[];
}

/**
 * Extract passthrough flags from frontmatter
 * Returns CLI args for any keys not explicitly handled
 */
export function getPassthroughArgs(
  frontmatter: AgentFrontmatter,
  options: PassthroughOptions = {}
): string[] {
  const { handledKeys = new Set(), skipKeys = [] } = options;
  const skip = new Set([...SYSTEM_KEYS, ...UNIVERSAL_KEYS, ...handledKeys, ...skipKeys]);

  const args: string[] = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    // Skip system keys, universal keys, and explicitly handled keys
    if (skip.has(key)) continue;
    // Skip undefined/null values
    if (value === undefined || value === null) continue;

    args.push(...valueToArgs(key, value));
  }

  return args;
}

/**
 * Extract passthrough flags from a harness-specific config object
 * e.g., frontmatter.claude, frontmatter.codex, etc.
 */
export function getHarnessPassthroughArgs(
  config: Record<string, unknown> | undefined,
  handledKeys: Set<string>
): string[] {
  if (!config) return [];

  const args: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    if (handledKeys.has(key)) continue;
    if (value === undefined || value === null) continue;

    args.push(...valueToArgs(key, value));
  }

  return args;
}

/**
 * Helper to get array value from string or string[]
 */
export function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
