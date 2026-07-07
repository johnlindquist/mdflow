/**
 * OpenAI Codex CLI adapter
 *
 * Print mode: Use 'exec' subcommand for non-interactive execution
 * Interactive mode: Remove subcommand (interactive is the default)
 *
 * Isolation (`_isolated: true`), all keys verified against codex exec --help
 * and the config schema (wrong-typed values fail config load):
 *   --ignore-user-config        don't load ~/.codex/config.toml (drops user
 *                               MCP servers/profiles; auth still works)
 *   --ephemeral                 no session persistence
 *   --config project_doc_max_bytes=0   disables AGENTS.md ingestion
 * --ignore-user-config and --ephemeral exist ONLY under `codex exec`, so
 * interactive mode strips them and keeps only the -c override.
 *
 * System prompt (verified config keys):
 *   replace → model_instructions_file=<temp file>
 *   append  → developer_instructions=<text>
 * Values pass through -c/--config; non-TOML strings are used as literals by
 * codex, so no extra quoting is needed.
 */

import type {
  ToolAdapter,
  CommandDefaults,
  AgentFrontmatter,
  SystemPromptSpec,
  SystemPromptTranslation,
} from "../types";

/** Flags that only exist on `codex exec`, not top-level codex. */
const EXEC_ONLY_ISOLATION_FLAGS = ["ignore-user-config", "ephemeral"] as const;

export const codexAdapter: ToolAdapter = {
  name: "codex",

  getDefaults(): CommandDefaults {
    return {
      _subcommand: "exec", // Use 'exec' subcommand for non-interactive mode
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Remove _subcommand (interactive is default without exec subcommand)
    delete result._subcommand;
    // These isolation flags are exec-only; top-level codex rejects them.
    for (const flag of EXEC_ONLY_ISOLATION_FLAGS) {
      delete result[flag];
    }
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return {
      "ignore-user-config": true,
      ephemeral: true,
      config: ["project_doc_max_bytes=0"],
    };
  },

  applySystemPrompt(
    spec: SystemPromptSpec,
    writeTempFile: (content: string) => string
  ): SystemPromptTranslation {
    const configEntries: string[] = [];
    if (spec.replace !== undefined) {
      configEntries.push(`model_instructions_file=${writeTempFile(spec.replace)}`);
    }
    if (spec.append && spec.append.length > 0) {
      configEntries.push(`developer_instructions=${spec.append.join("\n\n")}`);
    }
    return { frontmatter: { config: configEntries } };
  },
};

export default codexAdapter;
