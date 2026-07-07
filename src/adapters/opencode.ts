/**
 * OpenCode CLI adapter
 *
 * Print mode: Use 'run' subcommand for non-interactive execution
 * Interactive mode: Remove subcommand (TUI is the default)
 *
 * Isolation (`_isolated: true`): --pure runs without external plugins
 * (verified against opencode run --help; the flag exists on the top-level
 * TUI as well). Limitation: AGENTS.md and opencode.json config still load —
 * no CLI kill-switch exists. No system prompt mechanism (no
 * applySystemPrompt).
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

export const opencodeAdapter: ToolAdapter = {
  name: "opencode",

  getDefaults(): CommandDefaults {
    return {
      _subcommand: "run", // Use 'run' subcommand for non-interactive mode
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Remove _subcommand (TUI is default without run subcommand)
    delete result._subcommand;
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return {
      pure: true,
    };
  },
};

export default opencodeAdapter;
