/**
 * Claude Code CLI runner
 * Maps universal frontmatter to claude CLI flags
 */

import { BaseRunner, type RunContext, type RunResult, type RunnerName } from "./types";

export class ClaudeRunner extends BaseRunner {
  readonly name: RunnerName = "claude";

  getCommand(): string {
    return "claude";
  }

  buildArgs(ctx: RunContext): string[] {
    const { frontmatter } = ctx;
    const args: string[] = [];
    const claudeConfig = frontmatter.claude || {};

    // Model mapping
    if (frontmatter.model) {
      args.push("--model", this.mapModel(frontmatter.model));
    }

    // Directory access
    const addDir = frontmatter["add-dir"];
    if (addDir) {
      const dirs = Array.isArray(addDir) ? addDir : [addDir];
      for (const dir of dirs) {
        args.push("--add-dir", dir);
      }
    }

    // Permissions
    if (frontmatter["allow-all-tools"] || claudeConfig["dangerously-skip-permissions"]) {
      args.push("--dangerously-skip-permissions");
    }
    if (claudeConfig["allowed-tools"]) {
      args.push("--allowed-tools", String(claudeConfig["allowed-tools"]));
    }

    // MCP config
    const mcpConfig = claudeConfig["mcp-config"];
    if (mcpConfig) {
      const configs = Array.isArray(mcpConfig) ? mcpConfig : [mcpConfig];
      for (const config of configs) {
        args.push("--mcp-config", String(config));
      }
    }

    // Mode: silent maps to -p (print mode), interactive is default TTY
    if (frontmatter.silent && !frontmatter.interactive) {
      args.push("-p");  // Print mode - non-interactive
    }

    // Passthrough any claude-specific args from config
    for (const [key, value] of Object.entries(claudeConfig)) {
      // Skip already-handled keys
      if (["dangerously-skip-permissions", "mcp-config", "allowed-tools"].includes(key)) {
        continue;
      }
      // Pass through other keys as flags
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
   * Map generic model names to Claude-specific models
   */
  private mapModel(model: string): string {
    const modelMap: Record<string, string> = {
      "sonnet": "sonnet",
      "opus": "opus",
      "haiku": "haiku",
      "claude-sonnet-4": "sonnet",
      "claude-sonnet-4.5": "sonnet",
      "claude-opus-4.5": "opus",
      "claude-haiku-4.5": "haiku",
    };
    return modelMap[model] || model;
  }
}
