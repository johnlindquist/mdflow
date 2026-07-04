/**
 * pi (pi.dev) CLI adapter — the v3 default engine.
 *
 * Print mode: --print/-p processes the prompt and exits; the prompt itself is
 * positional. pi runs HERMETIC by default here: extension/skill/prompt-template
 * /context-file discovery and session persistence are all disabled, so the
 * flow file is the entire behavior — a run on one machine proves the same flow
 * on another. Re-enable a layer per flow by setting its key to false in
 * frontmatter (e.g. `no-context-files: false`).
 *
 * Interactive mode: drop --print; isolation stays on.
 *
 * Provider/model intentionally have no defaults — pin them per flow
 * (`model:`) or per machine (~/.mdflow/config.yaml `commands.pi`).
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

export const piAdapter: ToolAdapter = {
  name: "pi",

  getDefaults(): CommandDefaults {
    return {
      print: true,
      "no-extensions": true,
      "no-skills": true,
      "no-prompt-templates": true,
      "no-context-files": true,
      "no-session": true,
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    // Remove --print (interactive is default without it); keep isolation.
    delete result.print;
    return result;
  },
};

export default piAdapter;
