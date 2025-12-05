/**
 * GitHub Copilot CLI runner (legacy default)
 */

import { BaseRunner, type RunContext, type RunnerName } from "./types";

export class CopilotRunner extends BaseRunner {
  readonly name: RunnerName = "copilot";

  getCommand(): string {
    return "copilot";
  }

  buildArgs(ctx: RunContext): string[] {
    const { frontmatter } = ctx;
    const args: string[] = [];

    // Model
    if (frontmatter.model) {
      args.push("--model", frontmatter.model);
    }

    // Agent (copilot-specific or from copilot config)
    const agent = frontmatter.copilot?.agent;
    if (agent) {
      args.push("--agent", String(agent));
    }

    // Directory access
    const addDir = frontmatter["add-dir"];
    if (addDir) {
      const dirs = Array.isArray(addDir) ? addDir : [addDir];
      for (const dir of dirs) {
        args.push("--add-dir", dir);
      }
    }

    // Tool permissions
    if (frontmatter["allow-tool"]) {
      args.push("--allow-tool", frontmatter["allow-tool"]);
    }
    if (frontmatter["deny-tool"]) {
      args.push("--deny-tool", frontmatter["deny-tool"]);
    }
    if (frontmatter.silent) {
      args.push("--silent");
    }
    if (frontmatter["allow-all-tools"]) {
      args.push("--allow-all-tools");
    }
    if (frontmatter["allow-all-paths"]) {
      args.push("--allow-all-paths");
    }

    // Mode: interactive vs print
    if (frontmatter.interactive) {
      args.push("--interactive");
    } else {
      args.push("-p");
    }

    // Passthrough args
    args.push(...ctx.passthroughArgs);

    return args;
  }
}
