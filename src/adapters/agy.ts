/**
 * Google Antigravity CLI adapter (`agy`) — successor to the sunset gemini CLI.
 *
 * Print mode: --print/-p with a positional prompt (agy is a closed-source Go
 * rewrite, NOT flag-compatible with gemini: --yolo is gone, use
 * `dangerously-skip-permissions: true` or `headless: true` + `approve: all`
 * in frontmatter for unattended runs; --include-directories became --add-dir).
 *
 * Interactive mode: -i/--prompt-interactive takes the prompt as its value.
 *
 * Known caveat: agy -p under a non-TTY stdout has been reported to drop the
 * final response while exiting 0 — if a flow returns empty output with exit 0,
 * suspect this before blaming the model. Auth is Google OAuth only (run agy
 * once interactively); API-key env vars are not supported upstream.
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

export const agyAdapter: ToolAdapter = {
  name: "agy",

  getDefaults(): CommandDefaults {
    return {
      print: true,
    };
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    const result = { ...frontmatter };
    delete result.print;
    // --prompt-interactive <prompt> runs the prompt, then stays interactive
    result.$1 = "prompt-interactive";
    return result;
  },
};

export default agyAdapter;
