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
  HooksSpec,
  HooksTranslation,
} from "../types";
import {
  buildCodexHooksConfig,
  buildCodexHooksOverride,
  type CanonicalHookEvent,
} from "../hooks";
import { prepareCodexHooksHome, preparedCodexHooksHome } from "./codex-hooks-home";
import { CommandError } from "../errors";

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

  /**
   * Hooks ride in as ONE inline `-c hooks={…}` override plus
   * `--dangerously-bypass-hook-trust` (top-level flag, valid in exec AND
   * interactive). Verified on codex-cli 0.144.1: no hooks.json is needed
   * and the override survives --ignore-user-config/--ephemeral.
   *
   * The bypass flag is invocation-wide and hook sources AGGREGATE — against
   * the user's real `$CODEX_HOME` it would also un-gate ambient
   * not-yet-reviewed hooks from hooks.json (probe Q6). Hooked runs
   * therefore execute against a prepared CODEX_HOME carrying auth +
   * workspace trust but NO ambient hooks (codex-hooks-home.ts), so the
   * bypass can only authorize what mdflow injected. Because that prepared
   * home replaces ambient context wholesale, hooks REQUIRE isolation: an
   * `_isolated: false` flow keeps the real home and must not run flow hooks.
   */
  applyHooks(spec: HooksSpec): HooksTranslation {
    if (!spec.isolated) {
      throw new CommandError(
        `Flow hooks on codex require isolation (the default). An ambient run ` +
          `(_isolated: false) would let the hook trust bypass authorize ` +
          `pending-review hooks from your real codex home. Remove ` +
          `\`_isolated: false\` or set \`_hooks: false\`.`,
        { errorCode: "HOOKS_REQUIRE_ISOLATION", context: { hooksFile: spec.hooksFile } }
      );
    }
    const config = buildCodexHooksConfig({
      hooksFile: spec.hooksFile,
      events: spec.events as CanonicalHookEvent[],
    });
    // Passive surfaces (explain, dry-run) show the same env a run would use
    // but must not write anything — the home is prepared only for real runs.
    const codexHome =
      spec.prepareEnvironment === false
        ? preparedCodexHooksHome()
        : prepareCodexHooksHome();
    return {
      frontmatter: {
        config: [buildCodexHooksOverride(config)],
        "dangerously-bypass-hook-trust": true,
      },
      env: { CODEX_HOME: codexHome },
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
