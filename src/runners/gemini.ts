/**
 * Google Gemini CLI runner
 * Maps universal frontmatter to gemini CLI flags
 */

import { BaseRunner, type RunContext, type RunResult, type RunnerName } from "./types";

export class GeminiRunner extends BaseRunner {
  readonly name: RunnerName = "gemini";

  getCommand(): string {
    return "gemini";
  }

  buildArgs(ctx: RunContext): string[] {
    const { frontmatter } = ctx;
    const args: string[] = [];
    const geminiConfig = frontmatter.gemini || {};

    // Model
    if (frontmatter.model) {
      args.push("--model", this.mapModel(frontmatter.model));
    }

    // Directory access (include-directories)
    const addDir = frontmatter["add-dir"];
    if (addDir) {
      const dirs = Array.isArray(addDir) ? addDir : [addDir];
      for (const dir of dirs) {
        args.push("--include-directories", dir);
      }
    }

    // Sandbox mode
    if (geminiConfig.sandbox) {
      args.push("--sandbox");
    }

    // YOLO mode (allow-all-tools maps to this)
    if (frontmatter["allow-all-tools"] || geminiConfig.yolo) {
      args.push("--yolo");
    }

    // Approval mode
    if (geminiConfig["approval-mode"]) {
      args.push("--approval-mode", String(geminiConfig["approval-mode"]));
    }

    // Allowed tools (array)
    if (geminiConfig["allowed-tools"]) {
      const tools = Array.isArray(geminiConfig["allowed-tools"])
        ? geminiConfig["allowed-tools"]
        : [geminiConfig["allowed-tools"]];
      for (const tool of tools) {
        args.push("--allowed-tools", String(tool));
      }
    }

    // Extensions
    if (geminiConfig.extensions) {
      const exts = Array.isArray(geminiConfig.extensions)
        ? geminiConfig.extensions
        : [geminiConfig.extensions];
      for (const ext of exts) {
        args.push("--extensions", String(ext));
      }
    }

    // Resume session
    if (geminiConfig.resume) {
      args.push("--resume", String(geminiConfig.resume));
    }

    // MCP servers
    if (geminiConfig["allowed-mcp-server-names"]) {
      const servers = Array.isArray(geminiConfig["allowed-mcp-server-names"])
        ? geminiConfig["allowed-mcp-server-names"]
        : [geminiConfig["allowed-mcp-server-names"]];
      for (const server of servers) {
        args.push("--allowed-mcp-server-names", String(server));
      }
    }

    // Output format for silent/script mode
    if (frontmatter.silent && !frontmatter.interactive) {
      args.push("--output-format", "text");
    }

    // Passthrough any gemini-specific args from config
    const handledKeys = new Set([
      "sandbox", "yolo", "approval-mode", "allowed-tools",
      "extensions", "resume", "allowed-mcp-server-names"
    ]);
    for (const [key, value] of Object.entries(geminiConfig)) {
      if (handledKeys.has(key)) continue;
      if (typeof value === "boolean" && value) {
        args.push(`--${key}`);
      } else if (typeof value === "string" || typeof value === "number") {
        args.push(`--${key}`, String(value));
      }
    }

    // Passthrough args from CLI
    args.push(...ctx.passthroughArgs);

    return args;
  }

  /**
   * Gemini uses positional prompt, not a flag
   */
  async run(ctx: RunContext): Promise<RunResult> {
    const { frontmatter } = ctx;
    const command = this.getCommand();
    const args = this.buildArgs(ctx);

    // For interactive mode, use --prompt-interactive
    // Otherwise, use positional prompt (one-shot mode)
    let finalArgs: string[];
    if (frontmatter.interactive) {
      finalArgs = ["--prompt-interactive", ctx.prompt, ...args];
    } else {
      // Positional prompt comes at the end
      finalArgs = [...args, ctx.prompt];
    }

    const proc = Bun.spawn([command, ...finalArgs], {
      stdout: ctx.captureOutput ? "pipe" : "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    let output = "";
    if (ctx.captureOutput && proc.stdout) {
      output = await new Response(proc.stdout).text();
      console.log(output);
    }

    const exitCode = await proc.exited;
    return { exitCode, output };
  }

  /**
   * Map generic model names to Gemini-specific models
   */
  private mapModel(model: string): string {
    const modelMap: Record<string, string> = {
      "gemini": "gemini-2.5-pro",
      "gemini-pro": "gemini-2.5-pro",
      "gemini-flash": "gemini-2.5-flash",
      "gemini-2.5-pro": "gemini-2.5-pro",
      "gemini-2.5-flash": "gemini-2.5-flash",
      "gemini-3-pro-preview": "gemini-3-pro-preview",
    };
    return modelMap[model] || model;
  }
}
