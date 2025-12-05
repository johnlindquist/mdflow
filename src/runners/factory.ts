/**
 * Runner factory - detection and instantiation
 * Determines which runner to use based on:
 * 1. CLI flag (--runner)
 * 2. Frontmatter (runner:)
 * 3. Model heuristic
 * 4. Fallback (copilot for backward compatibility)
 */

import type { AgentFrontmatter } from "../types";
import type { Runner, RunnerName } from "./types";
import { CopilotRunner } from "./copilot";
import { ClaudeRunner } from "./claude";
import { CodexRunner } from "./codex";
import { GeminiRunner } from "./gemini";

/** Model patterns for auto-detection */
const CLAUDE_MODELS = [
  "claude",
  "sonnet",
  "opus",
  "haiku",
];

const CODEX_MODELS = [
  "o1",
  "o3",
  "gpt-",
  "codex",
];

const GEMINI_MODELS = [
  "gemini",
];

/**
 * Create a runner instance by name
 */
export function createRunner(name: RunnerName): Runner {
  switch (name) {
    case "claude":
      return new ClaudeRunner();
    case "codex":
      return new CodexRunner();
    case "copilot":
      return new CopilotRunner();
    case "gemini":
      return new GeminiRunner();
    default:
      throw new Error(`Unknown runner: ${name}`);
  }
}

/**
 * Detect runner from model name
 */
export function detectRunnerFromModel(model: string): RunnerName | null {
  const lowerModel = model.toLowerCase();

  // Check Claude models
  for (const pattern of CLAUDE_MODELS) {
    if (lowerModel.includes(pattern)) {
      return "claude";
    }
  }

  // Check Codex/GPT models
  for (const pattern of CODEX_MODELS) {
    if (lowerModel.includes(pattern)) {
      return "codex";
    }
  }

  // Check Gemini models
  for (const pattern of GEMINI_MODELS) {
    if (lowerModel.includes(pattern)) {
      return "gemini";
    }
  }

  return null;
}

/**
 * Check if a runner binary is available
 */
export async function isRunnerAvailable(name: RunnerName): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

export interface ResolveRunnerOptions {
  /** CLI override (highest priority) */
  cliRunner?: RunnerName;
  /** Parsed frontmatter */
  frontmatter: AgentFrontmatter;
}

/**
 * Resolve which runner to use based on priority:
 * 1. CLI flag
 * 2. Frontmatter runner field
 * 3. Model heuristic
 * 4. Fallback to copilot
 */
export async function resolveRunner(options: ResolveRunnerOptions): Promise<Runner> {
  const { cliRunner, frontmatter } = options;

  // 1. CLI flag takes highest priority
  if (cliRunner) {
    return createRunner(cliRunner);
  }

  // 2. Frontmatter explicit runner
  if (frontmatter.runner && frontmatter.runner !== "auto") {
    return createRunner(frontmatter.runner);
  }

  // 3. Model heuristic
  if (frontmatter.model) {
    const detected = detectRunnerFromModel(frontmatter.model);
    if (detected) {
      return createRunner(detected);
    }
  }

  // 4. Fallback to copilot for backward compatibility
  return createRunner("copilot");
}

/**
 * Get runner without async availability check (synchronous version)
 */
export function resolveRunnerSync(options: ResolveRunnerOptions): Runner {
  const { cliRunner, frontmatter } = options;

  if (cliRunner) {
    return createRunner(cliRunner);
  }

  if (frontmatter.runner && frontmatter.runner !== "auto") {
    return createRunner(frontmatter.runner);
  }

  if (frontmatter.model) {
    const detected = detectRunnerFromModel(frontmatter.model);
    if (detected) {
      return createRunner(detected);
    }
  }

  return createRunner("copilot");
}

/**
 * List all available runners with their availability status
 */
export async function listRunners(): Promise<Array<{ name: RunnerName; available: boolean }>> {
  const runners: RunnerName[] = ["copilot", "claude", "codex", "gemini"];
  const results = await Promise.all(
    runners.map(async (name) => ({
      name,
      available: await isRunnerAvailable(name),
    }))
  );
  return results;
}
