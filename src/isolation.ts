/**
 * Isolation — flows run with the engine's ambient context stripped BY
 * DEFAULT, using each engine's own verified flags. The flow file is the
 * entire behavior: skills, MCP servers, memory/context files, and plugins a
 * flow needs must be referenced explicitly in its frontmatter (mcp-config,
 * plugin-dir, add-dir, extension paths, …) rather than inherited from
 * whatever happens to be installed on the machine. `_isolated: false` (or
 * `--_isolated false`, or config `commands.<engine>._isolated: false`) opts
 * a flow back into ambient behavior.
 *
 * Every flag below was verified against the engine's own --help or shipped
 * source — never guess a flag here:
 *
 *   claude    --safe-mode --no-session-persistence
 *   codex     --ignore-user-config --ephemeral -c project_doc_max_bytes=0
 *   gemini    --extensions none
 *   copilot   --no-custom-instructions --disable-builtin-mcps
 *   opencode  --pure
 *   pi        --no-extensions --no-skills --no-prompt-templates
 *             --no-context-files --no-session
 *
 * droid, cursor-agent, and agy expose no context-stripping flags at all;
 * they run ambient. That silent gap only warns when a flow EXPLICITLY sets
 * `_isolated: true` — the ambient default would otherwise warn on every run.
 *
 * Precedence: config defaults < isolation defaults < frontmatter — so an
 * isolated flow can still re-enable one layer (`safe-mode: false`).
 */

import type { AgentFrontmatter, CommandDefaults, ToolAdapter } from "./types";

export interface IsolationMode {
  /** Whether the isolation layer applies to this run. Defaults to true. */
  isolated: boolean;
  /** True when some source set `_isolated` explicitly (vs the default). */
  explicit: boolean;
}

/**
 * Resolve the isolation mode for a run. Most specific source wins:
 * CLI > frontmatter > config defaults > default (ON).
 */
export function resolveIsolationMode(opts: {
  frontmatter: AgentFrontmatter;
  /** Parsed `--_isolated [true|false]` CLI value, if given. */
  cliValue?: boolean;
  commandDefaults?: CommandDefaults;
}): IsolationMode {
  if (opts.cliValue !== undefined) {
    return { isolated: opts.cliValue, explicit: true };
  }
  const fm = opts.frontmatter._isolated;
  if (typeof fm === "boolean") {
    return { isolated: fm, explicit: true };
  }
  const cfg = opts.commandDefaults?._isolated;
  if (typeof cfg === "boolean") {
    return { isolated: cfg, explicit: true };
  }
  return { isolated: true, explicit: false };
}

export interface IsolationResult {
  /** Isolation flag defaults to merge under the frontmatter. */
  defaults: CommandDefaults;
  /** Set when the engine has no isolation controls (caller warns only for
   * explicit `_isolated: true`). */
  unsupportedWarning?: string;
}

/**
 * Resolve the isolation defaults for an engine. Pure: the caller merges
 * `defaults` between config defaults and frontmatter, and surfaces
 * `unsupportedWarning` on stderr when the flow asked for isolation
 * explicitly.
 */
export function resolveIsolationDefaults(
  adapter: ToolAdapter,
  command: string
): IsolationResult {
  if (!adapter.getIsolationDefaults) {
    return {
      defaults: {},
      unsupportedWarning:
        `Warning [ISOLATION_UNSUPPORTED]: ${command} exposes no context-isolation ` +
        `flags (no way to disable skills, MCP, or context files from the CLI); ` +
        `_isolated has no effect on this engine.`,
    };
  }
  return { defaults: adapter.getIsolationDefaults() };
}
