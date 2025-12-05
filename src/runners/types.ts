import type { AgentFrontmatter, CommandResult } from "../types";
import type { ContextFile } from "../context";

/** Supported runner backends */
export type RunnerName = "claude" | "codex" | "copilot" | "gemini";

/** Context passed to runners for execution */
export interface RunContext {
  /** The final compiled prompt (with before output, context, stdin) */
  prompt: string;
  /** Parsed and merged frontmatter */
  frontmatter: AgentFrontmatter;
  /** Extra CLI args to pass through */
  passthroughArgs: string[];
  /** Whether to capture output (for after commands, extract, caching) */
  captureOutput: boolean;
}

/** Result from runner execution */
export interface RunResult {
  exitCode: number;
  output: string;
}

/** Runner interface - all backends implement this */
export interface Runner {
  /** Runner identifier */
  readonly name: RunnerName;

  /** Build command arguments from context */
  buildArgs(ctx: RunContext): string[];

  /** Get the command/binary name to execute */
  getCommand(): string;

  /** Execute the runner and return result */
  run(ctx: RunContext): Promise<RunResult>;
}

/** Base runner with shared implementation */
export abstract class BaseRunner implements Runner {
  abstract readonly name: RunnerName;
  abstract buildArgs(ctx: RunContext): string[];
  abstract getCommand(): string;

  async run(ctx: RunContext): Promise<RunResult> {
    const command = this.getCommand();
    const args = this.buildArgs(ctx);

    const proc = Bun.spawn([command, ...args, ctx.prompt], {
      stdout: ctx.captureOutput ? "pipe" : "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    let output = "";
    if (ctx.captureOutput && proc.stdout) {
      output = await new Response(proc.stdout).text();
      // Still print to console so user sees it
      console.log(output);
    }

    const exitCode = await proc.exited;
    return { exitCode, output };
  }
}
