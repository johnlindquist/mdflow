import type { CopilotFrontmatter, PreCommandResult } from "./types";

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
 * Run pre-commands and collect output
 */
export async function runPreCommands(
  pre: string | string[] | undefined
): Promise<PreCommandResult[]> {
  if (!pre) return [];

  const commands = Array.isArray(pre) ? pre : [pre];
  const results: PreCommandResult[] = [];

  for (const command of commands) {
    console.log(`Running: ${command}`);
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
 * Build copilot command arguments from frontmatter
 */
export function buildCopilotArgs(frontmatter: CopilotFrontmatter): string[] {
  const args: string[] = [];

  if (frontmatter.model) {
    args.push("--model", frontmatter.model);
  }
  if (frontmatter.agent) {
    args.push("--agent", frontmatter.agent);
  }
  if (frontmatter["add-dir"]) {
    args.push("--add-dir", frontmatter["add-dir"]);
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

/**
 * Build the final prompt from pre-command output and body
 */
export function buildPrompt(
  preResults: PreCommandResult[],
  body: string
): string {
  if (preResults.length === 0) {
    return body;
  }

  const preOutput = preResults
    .map(r => {
      const tag = slugify(r.command);
      return `<${tag}>\n${r.output}\n</${tag}>`;
    })
    .join("\n\n");

  return `${preOutput}\n\n${body}`;
}

/**
 * Execute copilot with the given args and prompt
 */
export async function runCopilot(
  args: string[],
  prompt: string
): Promise<number> {
  const proc = Bun.spawn(["copilot", ...args, prompt], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  return await proc.exited;
}
