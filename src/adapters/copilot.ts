/**
 * GitHub Copilot CLI adapter
 *
 * Print mode: Map body to --prompt flag, silent mode for clean output
 * Interactive mode: Map body to --interactive flag instead
 *
 * Isolation (`_isolated: true`), verified against copilot --help:
 *   --no-custom-instructions  don't load custom instructions
 *   --disable-builtin-mcps    disable built-in MCP servers (github-mcp-server)
 * Limitation: user-configured MCP servers (~/.copilot/mcp-config.json) can
 * only be disabled by name (--disable-mcp-server), so they still load.
 * No system prompt mechanism exists (no applySystemPrompt).
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

export const copilotAdapter: ToolAdapter = {
  name: "copilot",

  getDefaults(): CommandDefaults {
    return {
      $1: "prompt", // Map body to --prompt for copilot (print mode)
      silent: true, // Output only the agent response (no stats)
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Change from --prompt to --interactive
    result.$1 = "interactive";
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return {
      "no-custom-instructions": true,
      "disable-builtin-mcps": true,
    };
  },
};

export default copilotAdapter;
