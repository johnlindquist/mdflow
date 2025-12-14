/**
 * Ad-hoc command execution support
 *
 * Allows CLI to accept raw prompts without a file using md.COMMAND aliases.
 * E.g., `md.claude "What is 2+2?"` or `md.gemini "Explain this: @error.log"`
 *
 * When invoked as `md.COMMAND`:
 * 1. Extract COMMAND from the executable name (e.g., md.claude -> claude)
 * 2. Treat the first non-flag argument as the prompt body
 * 3. Create a virtual agent with the prompt as body content
 * 4. Pass through the normal execution flow
 */

import { basename } from "path";

/** Supported command aliases */
export const SUPPORTED_COMMANDS = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "droid",
  "opencode",
] as const;

export type SupportedCommand = typeof SUPPORTED_COMMANDS[number];

/**
 * Result of parsing an ad-hoc command invocation
 */
export interface AdhocCommandResult {
  /** Whether this was an ad-hoc invocation (md.COMMAND) */
  isAdhoc: boolean;
  /** The extracted command name (e.g., "claude") */
  command?: SupportedCommand;
  /** The prompt body (first non-flag argument) */
  body?: string;
  /** Remaining arguments (flags to pass through) */
  passthroughArgs?: string[];
  /** Whether interactive mode was requested (.i. in alias) */
  interactive?: boolean;
}

/**
 * Detect if the current invocation is an ad-hoc command (md.COMMAND)
 *
 * Checks the executable name from argv[0] or argv[1] (for bun run scenarios)
 *
 * @param argv - The process.argv array
 * @returns The parsed ad-hoc command result
 */
export function detectAdhocCommand(argv: string[]): AdhocCommandResult {
  // argv[0] is the runtime (node/bun), argv[1] is the script/command
  // For symlinks: argv[1] might be "md.claude"
  // For bun run: argv[1] might be the full path to index.ts

  // Check argv[1] first (the command/script name)
  const scriptName = argv[1] ? basename(argv[1]) : "";

  const result = parseAdhocFromName(scriptName);
  if (result.isAdhoc) {
    return parseAdhocArgs(result.command!, result.interactive ?? false, argv.slice(2));
  }

  // Also check argv[0] in case the runtime itself is the symlink
  const runtimeName = argv[0] ? basename(argv[0]) : "";
  const runtimeResult = parseAdhocFromName(runtimeName);
  if (runtimeResult.isAdhoc) {
    return parseAdhocArgs(runtimeResult.command!, runtimeResult.interactive ?? false, argv.slice(2));
  }

  return { isAdhoc: false };
}

/**
 * Parse command from an executable/script name
 *
 * Patterns:
 * - md.claude -> claude (print mode)
 * - md.i.claude -> claude (interactive mode)
 * - md.claude.ts -> claude (for bun run scenarios)
 */
function parseAdhocFromName(name: string): { isAdhoc: boolean; command?: SupportedCommand; interactive?: boolean } {
  // Remove common extensions
  const cleanName = name.replace(/\.(ts|js|mjs|cjs)$/, "");

  // Pattern: md.i.COMMAND (interactive mode)
  const interactiveMatch = cleanName.match(/^md\.i\.([a-z]+)$/i);
  if (interactiveMatch) {
    const cmd = interactiveMatch[1]?.toLowerCase() as SupportedCommand;
    if (SUPPORTED_COMMANDS.includes(cmd)) {
      return { isAdhoc: true, command: cmd, interactive: true };
    }
  }

  // Pattern: md.COMMAND
  const match = cleanName.match(/^md\.([a-z]+)$/i);
  if (match) {
    const cmd = match[1]?.toLowerCase() as SupportedCommand;
    if (SUPPORTED_COMMANDS.includes(cmd)) {
      return { isAdhoc: true, command: cmd, interactive: false };
    }
  }

  return { isAdhoc: false };
}

/**
 * Known flags that take a value (non-boolean flags)
 * This helps distinguish between `--model opus "prompt"` and `--verbose "prompt"`
 */
const FLAGS_WITH_VALUES = new Set([
  "--model", "-m",
  "--max-tokens",
  "--temperature",
  "--system",
  "--add-dir",
  "--provider",
  "--output", "-o",
  "--config",
  "--prompt", "-p",
  "--timeout",
  "--api-key",
  "--_command", "-_c",
  "--_cwd",
  "--_name", "--_value", // Common template var patterns
]);

/**
 * Check if a flag typically takes a value
 */
function flagTakesValue(flag: string): boolean {
  // Check exact match
  if (FLAGS_WITH_VALUES.has(flag)) return true;

  // Check if it's a --_varname pattern (template variables)
  if (flag.startsWith("--_") && !flag.includes("=")) return true;

  // Check for = syntax (flag already has value)
  if (flag.includes("=")) return false;

  return false;
}

/**
 * Parse arguments for an ad-hoc command
 *
 * Strategy: Find the first argument that looks like a prompt (not a flag, not a flag value).
 * Everything else goes to passthrough.
 *
 * A prompt is typically:
 * - Not starting with "-"
 * - Contains spaces, @imports, {{ templates }}, or other prompt-like content
 * - OR is the first non-flag arg after processing known flag/value pairs
 */
function parseAdhocArgs(
  command: SupportedCommand,
  interactive: boolean,
  args: string[]
): AdhocCommandResult {
  const passthroughArgs: string[] = [];
  let body: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("-")) {
      // It's a flag - add to passthrough
      passthroughArgs.push(arg);

      // Check if this flag takes a value
      if (flagTakesValue(arg)) {
        const nextArg = args[i + 1];
        if (nextArg !== undefined && !nextArg.startsWith("-")) {
          passthroughArgs.push(nextArg);
          i++;
        }
      }
    } else if (body === undefined) {
      // First non-flag, non-flag-value arg is the body
      body = arg;
    } else {
      // Additional non-flag args go to passthrough as positional args
      passthroughArgs.push(arg);
    }
  }

  return {
    isAdhoc: true,
    command,
    body,
    passthroughArgs,
    interactive,
  };
}

/**
 * Create virtual agent file content from an ad-hoc command
 *
 * Generates markdown content that can be processed by the normal flow
 */
export function createVirtualAgentContent(
  command: SupportedCommand,
  body: string,
  interactive: boolean = false
): string {
  const frontmatter = interactive ? "_interactive: true" : "";

  if (frontmatter) {
    return `---\n${frontmatter}\n---\n${body}`;
  }

  return `---\n---\n${body}`;
}

/**
 * Create a virtual filename for command resolution
 *
 * Returns a filename pattern that will resolve to the correct command
 */
export function createVirtualFilename(command: SupportedCommand, interactive: boolean = false): string {
  if (interactive) {
    return `adhoc.i.${command}.md`;
  }
  return `adhoc.${command}.md`;
}
