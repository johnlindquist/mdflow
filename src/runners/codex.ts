/**
 * OpenAI Codex CLI runner
 * Maps universal frontmatter to codex CLI flags
 */

import { BaseRunner, type RunContext, type RunResult, type RunnerName } from "./types";

export class CodexRunner extends BaseRunner {
  readonly name: RunnerName = "codex";

  getCommand(): string {
    return "codex";
  }

  buildArgs(ctx: RunContext): string[] {
    const { frontmatter } = ctx;
    const args: string[] = [];
    const codexConfig = frontmatter.codex || {};

    // Model mapping
    if (frontmatter.model) {
      args.push("--model", this.mapModel(frontmatter.model));
    }

    // Directory (cd into workspace)
    if (codexConfig.cd) {
      args.push("--cd", String(codexConfig.cd));
    }

    // Sandbox mode
    if (codexConfig.sandbox) {
      args.push("--sandbox", String(codexConfig.sandbox));
    }

    // Approval policy
    if (codexConfig.approval) {
      args.push("--approval", String(codexConfig.approval));
    }

    // Full auto mode (allow-all-tools maps to this)
    if (frontmatter["allow-all-tools"] || codexConfig["full-auto"]) {
      args.push("--full-auto");
    }

    // OSS mode (local models via Ollama etc)
    if (codexConfig.oss) {
      args.push("--oss");
    }

    // Local provider
    if (codexConfig["local-provider"]) {
      args.push("--local-provider", String(codexConfig["local-provider"]));
    }

    // Passthrough any codex-specific args from config
    for (const [key, value] of Object.entries(codexConfig)) {
      // Skip already-handled keys
      if (["sandbox", "approval", "full-auto", "oss", "local-provider", "cd"].includes(key)) {
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
   * For Codex, silent mode uses the exec subcommand for non-interactive output
   */
  async run(ctx: RunContext): Promise<RunResult> {
    const { frontmatter } = ctx;
    const command = this.getCommand();
    const args = this.buildArgs(ctx);

    // Silent mode uses exec subcommand
    const finalArgs = frontmatter.silent && !frontmatter.interactive
      ? ["exec", ...args, ctx.prompt]
      : [...args, ctx.prompt];

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
   * Map generic model names to Codex-specific models
   */
  private mapModel(model: string): string {
    const modelMap: Record<string, string> = {
      "gpt-5": "gpt-5",
      "gpt-5.1": "gpt-5.1",
      "gpt-5.1-codex": "gpt-5.1-codex",
      "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
      "gpt-5-mini": "gpt-5-mini",
      "gpt-4.1": "gpt-4.1",
      "o1": "o1",
      "o3": "o3",
    };
    return modelMap[model] || model;
  }
}
