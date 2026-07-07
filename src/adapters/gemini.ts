/**
 * Google Gemini CLI adapter
 *
 * Print mode: One-shot mode (no special flags needed - default behavior)
 * Interactive mode: Add --prompt-interactive flag
 *
 * Isolation (`_isolated: true`): --extensions none disables all extensions
 * ("none" is special-cased in gemini's ExtensionEnablementManager — verified
 * in the shipped bundle). Limitations: GEMINI.md memory discovery and
 * settings.json MCP servers have no CLI kill-switch, so they still load.
 *
 * System prompt: GEMINI_SYSTEM_MD=<file> env var replaces the system prompt
 * (read in getCoreSystemPrompt — verified in the shipped bundle). There is
 * no append mechanism; _append-system-prompt fails rather than degrading.
 */

import { CommandError } from "../errors";
import type {
  ToolAdapter,
  CommandDefaults,
  AgentFrontmatter,
  SystemPromptSpec,
  SystemPromptTranslation,
} from "../types";

export const geminiAdapter: ToolAdapter = {
  name: "gemini",

  getDefaults(): CommandDefaults {
    // Gemini defaults to one-shot mode (no special flags needed)
    return {};
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Add --prompt-interactive flag for interactive mode
    result.$1 = "prompt-interactive";
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return {
      extensions: "none",
    };
  },

  applySystemPrompt(
    spec: SystemPromptSpec,
    writeTempFile: (content: string) => string
  ): SystemPromptTranslation {
    if (spec.append && spec.append.length > 0) {
      throw new CommandError(
        `gemini can only replace its system prompt (GEMINI_SYSTEM_MD), not ` +
          `append to it; use _system-prompt instead of _append-system-prompt.`,
        { errorCode: "SYSTEM_PROMPT_UNSUPPORTED", context: { command: "gemini" } }
      );
    }
    return {
      env: { GEMINI_SYSTEM_MD: writeTempFile(spec.replace ?? "") },
    };
  },
};

export default geminiAdapter;
