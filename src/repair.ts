/**
 * Interactive repair handler for frontmatter validation errors
 * Catches errors and offers to fix them using available AI runners
 */

import { select, confirm } from "@inquirer/prompts";
import { dirname, resolve } from "path";

export interface RepairContext {
  filePath: string;
  content: string;
  errors: string[];
}

type RunnerChoice = "claude" | "codex" | "gemini" | "copilot" | "skip";

/**
 * Check which runners are available on the system
 */
async function getAvailableRunners(): Promise<RunnerChoice[]> {
  const runners: { name: RunnerChoice; cmd: string }[] = [
    { name: "claude", cmd: "claude" },
    { name: "codex", cmd: "codex" },
    { name: "gemini", cmd: "gemini" },
    { name: "copilot", cmd: "copilot" },
  ];

  const available: RunnerChoice[] = [];

  for (const { name, cmd } of runners) {
    try {
      const result = Bun.spawnSync(["which", cmd]);
      if (result.exitCode === 0) {
        available.push(name);
      }
    } catch {
      // Runner not available
    }
  }

  return available;
}

/**
 * Offer interactive repair when validation fails
 * Returns true if repair was successful and we should retry
 */
export async function offerRepair(ctx: RepairContext): Promise<boolean> {
  // Check if we're in a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    // Non-interactive mode, just show the error
    return false;
  }

  console.error("\n┌─────────────────────────────────────────────────────────┐");
  console.error("│  ❌ Frontmatter Validation Error                        │");
  console.error("└─────────────────────────────────────────────────────────┘\n");

  console.error("Errors detected:");
  for (const error of ctx.errors) {
    console.error(`  • ${error}`);
  }
  console.error("");

  // Get available runners
  const runners = await getAvailableRunners();

  if (runners.length === 0) {
    console.error("No AI runners found. Install claude, codex, gemini, or copilot to enable auto-repair.");
    return false;
  }

  // Ask if user wants to repair
  const shouldRepair = await confirm({
    message: "Would you like to auto-repair this file?",
    default: true,
  });

  if (!shouldRepair) {
    return false;
  }

  // Let user choose runner
  const runner = await select<RunnerChoice>({
    message: "Select an AI to fix the file:",
    choices: [
      ...runners.map((r) => ({
        value: r,
        name: getRunnerDisplay(r),
      })),
      { value: "skip" as const, name: "❌ Cancel" },
    ],
  });

  if (runner === "skip") {
    return false;
  }

  // Run repair with visual feedback
  console.log(`\n🔧 Repairing with ${runner}...`);
  console.log(`   (This may take 10-30 seconds)\n`);

  const success = await runRepair(ctx, runner);

  if (success) {
    console.log(`\n✅ File repaired: ${ctx.filePath}`);

    // Ask if user wants to retry
    const shouldRetry = await confirm({
      message: "Run the agent now?",
      default: true,
    });

    return shouldRetry;
  } else {
    console.error("\n❌ Repair failed. Please fix the file manually.");
    return false;
  }
}

function getRunnerDisplay(runner: RunnerChoice): string {
  switch (runner) {
    case "claude":
      return "🟣 Claude (Anthropic)";
    case "codex":
      return "🟢 Codex (OpenAI)";
    case "gemini":
      return "🔵 Gemini (Google)";
    case "copilot":
      return "⚫ Copilot (GitHub)";
    default:
      return runner;
  }
}

/**
 * Run the repair using inline prompt (no external DOCTOR.md dependency)
 * Uses the same flag patterns as our runner implementations
 */
async function runRepair(ctx: RepairContext, runner: RunnerChoice): Promise<boolean> {
  const repairPrompt = buildRepairPrompt(ctx);

  // Build command based on runner - match our runner implementations exactly
  const { command, args } = buildRepairCommand(runner, repairPrompt);

  try {
    // Use Bun.spawn with non-interactive settings
    // Don't inherit stdin - we're running non-interactively with -p flag
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe", // Capture stderr to show useful errors
      stdin: "ignore", // Don't wait for stdin - prompt is in args
      cwd: dirname(ctx.filePath),
    });

    // Collect output and stderr
    let output = "";
    let stderr = "";
    if (proc.stdout) {
      output = await new Response(proc.stdout).text();
    }
    if (proc.stderr) {
      stderr = await new Response(proc.stderr).text();
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      if (stderr) {
        console.error(`\nError from ${runner}:\n${stderr}`);
      }
      return false;
    }

    // Extract the fixed content from output
    const fixedContent = extractFixedContent(output);

    if (!fixedContent) {
      console.error("Could not extract fixed content from AI response");
      console.error("Raw output:", output.slice(0, 500));
      return false;
    }

    // Write the fixed file
    await Bun.write(ctx.filePath, fixedContent);
    return true;
  } catch (err) {
    console.error(`Failed to run ${runner}: ${(err as Error).message}`);
    return false;
  }
}

function buildRepairPrompt(ctx: RepairContext): string {
  return `You are fixing a markdown-agent frontmatter file.

ERRORS:
${ctx.errors.map((e) => `- ${e}`).join("\n")}

ORIGINAL FILE:
\`\`\`markdown
${ctx.content}
\`\`\`

VALID FRONTMATTER FIELDS:
- runner: "claude" | "codex" | "gemini" | "copilot" | "auto"
- model: string (any model name)
- silent: boolean
- interactive: boolean
- allow-all-tools: boolean
- allow-all-paths: boolean
- allow-tool: string (single tool pattern)
- deny-tool: string
- add-dir: string | string[]
- context: string | string[]
- extract: "json" | "code" | "markdown" | "raw"
- cache: boolean
- inputs: array of { name, type, message, default?, choices? }
  - type must be: "text" | "confirm" | "select" | "password"
  - select type requires choices array
- requires: { bin?: string[], env?: string[] }
- claude: { dangerously-skip-permissions?, mcp-config?, allowed-tools? }
- codex: { sandbox?, approval?, full-auto?, oss?, local-provider?, cd? }
- gemini: { sandbox?, yolo?, approval-mode?, allowed-tools?, extensions?, resume? }
- copilot: { agent? }

RULES:
1. Fix ONLY the errors listed above
2. Preserve all valid fields and the body content
3. If allow-tool is an array, convert to single string or use claude.allowed-tools
4. Output ONLY the complete fixed markdown file, no explanations

OUTPUT THE FIXED FILE:`;
}

/**
 * Build repair command matching our runner implementations
 * See: src/runners/claude.ts, codex.ts, gemini.ts, copilot.ts
 *
 * IMPORTANT: These flags must match what the actual CLI tools accept.
 * Run `bun test src/repair.test.ts` to validate against --help output.
 */
function buildRepairCommand(runner: RunnerChoice, prompt: string): { command: string; args: string[] } {
  switch (runner) {
    case "claude":
      // Claude: -p enables print/non-interactive mode, prompt is positional
      // See: src/runners/claude.ts line 75-77
      return { command: "claude", args: ["-p", prompt] };

    case "codex":
      // Codex: exec subcommand for non-interactive, prompt at end
      // See: src/runners/codex.ts line 84-86
      return { command: "codex", args: ["exec", prompt] };

    case "gemini":
      // Gemini: positional prompt, --output-format text for non-interactive
      // See: src/runners/gemini.ts line 85-87, 124
      return { command: "gemini", args: ["--output-format", "text", prompt] };

    case "copilot":
      // Copilot: -p for print mode, prompt is positional
      // See: src/runners/copilot.ts line 59
      return { command: "copilot", args: ["-p", prompt] };

    default:
      return { command: "claude", args: ["-p", prompt] };
  }
}

/**
 * Extract the fixed markdown content from AI response
 * Handles both raw output and code-fenced output
 */
function extractFixedContent(output: string): string | null {
  // Try to extract from markdown code fence first
  const fenceMatch = output.match(/```(?:markdown|md)?\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Check if output starts with frontmatter delimiter
  const trimmed = output.trim();
  if (trimmed.startsWith("---")) {
    return trimmed;
  }

  // Try to find frontmatter anywhere in output
  const frontmatterMatch = output.match(/(---[\s\S]*?---[\s\S]*)/);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim();
  }

  return null;
}
