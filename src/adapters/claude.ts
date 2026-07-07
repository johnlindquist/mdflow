/**
 * Claude CLI adapter
 *
 * Print mode: --print flag for non-interactive output
 * Interactive mode: Remove --print flag (interactive is the default)
 *
 * Isolation (`_isolated: true`): --safe-mode disables CLAUDE.md, skills,
 * plugins, hooks, MCP servers, custom commands/agents, output styles, and
 * workflows while auth, model selection, built-in tools, and permissions
 * keep working (verified against claude --help; --bare is NOT used here
 * because it restricts auth to ANTHROPIC_API_KEY only, which would break
 * subscription/OAuth users). --no-session-persistence skips writing the
 * session to disk; it only works with --print, so interactive mode strips
 * it.
 *
 * System prompt: --system-prompt replaces, --append-system-prompt appends.
 */

import type {
  ToolAdapter,
  CommandDefaults,
  AgentFrontmatter,
  SystemPromptSpec,
  SystemPromptTranslation,
} from "../types";

export const claudeAdapter: ToolAdapter = {
  name: "claude",

  getDefaults(): CommandDefaults {
    return {
      print: true, // --print flag for non-interactive mode
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Remove --print flag (interactive is default without it)
    delete result.print;
    // --no-session-persistence only works with --print
    delete result["no-session-persistence"];
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return {
      "safe-mode": true,
      "no-session-persistence": true,
    };
  },

  applySystemPrompt(spec: SystemPromptSpec): SystemPromptTranslation {
    const frontmatter: Record<string, string> = {};
    if (spec.replace !== undefined) frontmatter["system-prompt"] = spec.replace;
    if (spec.append && spec.append.length > 0) {
      // claude takes a single --append-system-prompt value; join segments.
      frontmatter["append-system-prompt"] = spec.append.join("\n\n");
    }
    return { frontmatter };
  },
};

export default claudeAdapter;
