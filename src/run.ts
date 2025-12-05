import type { AgentFrontmatter, CommandResult } from "./types";

/**
 * Convert a command string to a valid XML tag name
 */
export function slugify(command: string): string {
  return command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, "")     // Trim leading/trailing dashes
    .replace(/^(\d)/, "_$1");    // Prefix with underscore if starts with number
}

/**
 * Run commands and collect output
 */
export async function runCommands(
  commands: string | string[] | undefined,
  label: string = "Running"
): Promise<CommandResult[]> {
  if (!commands) return [];

  const cmdList = Array.isArray(commands) ? commands : [commands];
  const results: CommandResult[] = [];

  for (const command of cmdList) {
    console.log(`${label}: ${command}`);
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const output = (stdout + stderr).trim();
    console.log(output);
    console.log("---");

    results.push({ command, output, exitCode });
  }

  return results;
}

/**
 * Run before-commands and collect output
 */
export async function runBeforeCommands(
  before: string | string[] | undefined
): Promise<CommandResult[]> {
  return runCommands(before, "Before");
}

/**
 * Run after-commands when agent completes
 * First command receives pipedInput via stdin if provided
 */
export async function runAfterCommands(
  after: string | string[] | undefined,
  pipedInput?: string
): Promise<CommandResult[]> {
  if (!after) return [];

  const cmdList = Array.isArray(after) ? after : [after];
  const results: CommandResult[] = [];

  for (let i = 0; i < cmdList.length; i++) {
    const command = cmdList[i];
    const isFirst = i === 0;

    console.log(`After: ${command}`);

    // First command gets piped input
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: isFirst && pipedInput ? new Response(pipedInput).body : undefined,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const output = (stdout + stderr).trim();
    console.log(output);
    console.log("---");

    results.push({ command, output, exitCode });
  }

  return results;
}

/** @deprecated Use runBeforeCommands */
export const runPreCommands = runBeforeCommands;

/**
 * Build the final prompt from before-command output and body
 */
export function buildPrompt(
  beforeResults: CommandResult[],
  body: string
): string {
  if (beforeResults.length === 0) {
    return body;
  }

  const beforeOutput = beforeResults
    .map(r => {
      const tag = slugify(r.command);
      return `<${tag}>\n${r.output}\n</${tag}>`;
    })
    .join("\n\n");

  return `${beforeOutput}\n\n${body}`;
}

// Legacy exports for backward compatibility
// These are now handled by runners

/** @deprecated Use runner.buildArgs() instead */
export function buildCopilotArgs(frontmatter: AgentFrontmatter): string[] {
  const args: string[] = [];

  if (frontmatter.model) {
    args.push("--model", frontmatter.model);
  }
  const agent = frontmatter.copilot?.agent;
  if (agent) {
    args.push("--agent", String(agent));
  }
  const addDir = frontmatter["add-dir"];
  if (addDir) {
    const dirs = Array.isArray(addDir) ? addDir : [addDir];
    for (const dir of dirs) {
      args.push("--add-dir", dir);
    }
  }
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
  if (frontmatter.interactive) {
    args.push("--interactive");
  } else {
    args.push("-p");
  }

  return args;
}

export interface CopilotResult {
  exitCode: number;
  output: string;
}

/** @deprecated Use runner.run() instead */
export async function runCopilot(
  args: string[],
  prompt: string,
  captureOutput: boolean = false
): Promise<CopilotResult> {
  const proc = Bun.spawn(["copilot", ...args, prompt], {
    stdout: captureOutput ? "pipe" : "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  let output = "";
  if (captureOutput && proc.stdout) {
    output = await new Response(proc.stdout).text();
    // Still print to console so user sees it
    console.log(output);
  }

  const exitCode = await proc.exited;
  return { exitCode, output };
}
