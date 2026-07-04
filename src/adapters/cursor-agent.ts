/**
 * Cursor Agent CLI adapter (`cursor-agent`)
 *
 * Print mode: --print with --output-format text. NOTE: cursor-agent's print
 * mode still has access to ALL tools including write and shell — pin
 * `--mode plan` or `--mode ask` in frontmatter for read-only flows.
 *
 * Interactive mode: remove --print/--output-format (interactive is default).
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

export const cursorAgentAdapter: ToolAdapter = {
  name: "cursor-agent",

  getDefaults(): CommandDefaults {
    return {
      print: true,
      "output-format": "text",
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    delete result.print;
    // --output-format only works with --print
    delete result["output-format"];
    return result;
  },
};

export default cursorAgentAdapter;
