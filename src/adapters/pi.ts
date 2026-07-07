/**
 * pi (pi.dev) CLI adapter — the v3 default engine.
 *
 * Print mode: --print/-p processes the prompt and exits; the prompt itself is
 * positional. pi runs HERMETIC like every engine: the default-on isolation
 * layer (src/isolation.ts) supplies --no-extensions --no-skills
 * --no-prompt-templates --no-context-files --no-session, so the flow file is
 * the entire behavior — a run on one machine proves the same flow on
 * another. Re-enable a single layer per flow (`no-context-files: false`) or
 * drop the whole set with `_isolated: false`.
 *
 * Interactive mode: drop --print; isolation stays on.
 *
 * Provider/model intentionally have no defaults — pin them per flow
 * (`model:`) or per machine (~/.mdflow/config.yaml `commands.pi`).
 *
 * System prompt: --system-prompt replaces, --append-system-prompt appends
 * (repeatable).
 */

import type {
  ToolAdapter,
  CommandDefaults,
  AgentFrontmatter,
  SystemPromptSpec,
  SystemPromptTranslation,
} from "../types";
import { ensureBridgedPiAgentDir } from "./pi-auth";

/** pi's hermetic flag set — applied by the default-on isolation layer. */
const PI_HERMETIC_FLAGS: CommandDefaults = {
  "no-extensions": true,
  "no-skills": true,
  "no-prompt-templates": true,
  "no-context-files": true,
  "no-session": true,
};

export const piAdapter: ToolAdapter = {
  name: "pi",

  getDefaults(): CommandDefaults {
    return {
      print: true,
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Remove --print (interactive is default without it); keep isolation.
    delete result.print;
    return result;
  },

  getIsolationDefaults(): CommandDefaults {
    return { ...PI_HERMETIC_FLAGS };
  },

  applySystemPrompt(spec: SystemPromptSpec): SystemPromptTranslation {
    const frontmatter: Record<string, string | string[]> = {};
    if (spec.replace !== undefined) frontmatter["system-prompt"] = spec.replace;
    if (spec.append && spec.append.length > 0) {
      // pi's --append-system-prompt is repeatable; arrays become repeats.
      frontmatter["append-system-prompt"] = spec.append;
    }
    return { frontmatter };
  },

  prepareEnv(): Record<string, string> | undefined {
    // Respect an explicit user override of the agent dir.
    if (process.env.PI_CODING_AGENT_DIR) return undefined;
    return { PI_CODING_AGENT_DIR: ensureBridgedPiAgentDir() };
  },
};

export default piAdapter;
