/**
 * System prompt override — `_system-prompt` / `_append-system-prompt`.
 *
 * The flow BODY is always the user prompt; these system keys control the
 * engine's system prompt, translated per engine by the adapter's
 * applySystemPrompt() hook. Verified mechanisms only:
 *
 *   claude   --system-prompt / --append-system-prompt
 *   pi       --system-prompt / --append-system-prompt (repeatable)
 *   codex    -c model_instructions_file=<file> / -c developer_instructions=…
 *   gemini   GEMINI_SYSTEM_MD=<file> env var (replace only — no append)
 *
 * copilot, droid, opencode, cursor-agent, and agy have no supported
 * mechanism. That is a hard error, not a warning: a flow that declares its
 * system prompt and runs without it is a different flow.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CommandError } from "./errors";
import type {
  AgentFrontmatter,
  FrontmatterValue,
  SystemPromptSpec,
  ToolAdapter,
} from "./types";

/**
 * Extract the canonical system prompt spec. CLI values (already parsed by
 * cli-runner) win over frontmatter; frontmatter `_append-system-prompt`
 * accepts a string or a list of strings.
 */
export function extractSystemPromptSpec(
  frontmatter: AgentFrontmatter,
  cli: { replace?: string; append?: string[] } = {}
): SystemPromptSpec | undefined {
  const fmReplace = frontmatter["_system-prompt"];
  const fmAppendRaw = frontmatter["_append-system-prompt"];

  if (fmReplace !== undefined && typeof fmReplace !== "string") {
    throw new CommandError(`_system-prompt must be a string.`, {
      errorCode: "SYSTEM_PROMPT_INVALID",
      context: { received: typeof fmReplace },
    });
  }

  let fmAppend: string[] | undefined;
  if (fmAppendRaw !== undefined) {
    if (typeof fmAppendRaw === "string") {
      fmAppend = [fmAppendRaw];
    } else if (
      Array.isArray(fmAppendRaw) &&
      fmAppendRaw.every((v) => typeof v === "string")
    ) {
      fmAppend = fmAppendRaw as string[];
    } else {
      throw new CommandError(
        `_append-system-prompt must be a string or a list of strings.`,
        { errorCode: "SYSTEM_PROMPT_INVALID", context: { received: typeof fmAppendRaw } }
      );
    }
  }

  const replace = cli.replace ?? fmReplace;
  const append = cli.append && cli.append.length > 0 ? cli.append : fmAppend;

  if (replace === undefined && (!append || append.length === 0)) return undefined;
  return {
    ...(replace !== undefined ? { replace } : {}),
    ...(append && append.length > 0 ? { append } : {}),
  };
}

export interface AppliedSystemPrompt {
  /** Frontmatter with the translation merged in and the system keys removed. */
  frontmatter: AgentFrontmatter;
  /** Cleanup for any temp files the translation wrote (no-op when none). */
  cleanup: () => void;
}

/**
 * Merge one translation fragment key into frontmatter. Arrays concat (codex
 * needs `config: [...]` to stack with user-provided -c overrides); scalars
 * from the translation win — `_system-prompt` is the canonical intent, an
 * engine-native duplicate in the same flow is a conflict resolved in its
 * favor deliberately.
 */
function mergeFragmentKey(
  frontmatter: AgentFrontmatter,
  key: string,
  value: FrontmatterValue
): void {
  const existing = frontmatter[key];
  if (Array.isArray(value)) {
    const base = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    frontmatter[key] = [...base, ...value];
    return;
  }
  frontmatter[key] = value;
}

/**
 * Apply the system prompt spec via the engine adapter. Throws for engines
 * with no supported mechanism. Returns updated frontmatter plus a cleanup
 * callback for temp files (register it with ProcessManager.onCleanup).
 */
export function applySystemPromptToFrontmatter(
  adapter: ToolAdapter,
  command: string,
  frontmatter: AgentFrontmatter,
  spec: SystemPromptSpec,
  writeTempFile?: (content: string) => string
): AppliedSystemPrompt {
  if (!adapter.applySystemPrompt) {
    throw new CommandError(
      `${command} has no supported system prompt mechanism; remove ` +
        `_system-prompt/_append-system-prompt or switch the flow to an engine ` +
        `that supports it (claude, codex, gemini, pi).`,
      { errorCode: "SYSTEM_PROMPT_UNSUPPORTED", context: { command } }
    );
  }

  let tempDir: string | undefined;
  const writer =
    writeTempFile ??
    ((content: string): string => {
      if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "mdflow-sysprompt-"));
      const path = join(tempDir, `system-prompt-${Date.now()}.md`);
      writeFileSync(path, content, { mode: 0o600 });
      return path;
    });

  const translation = adapter.applySystemPrompt(spec, writer);

  const result: AgentFrontmatter = { ...frontmatter };
  delete result["_system-prompt"];
  delete result["_append-system-prompt"];

  for (const [key, value] of Object.entries(translation.frontmatter ?? {})) {
    mergeFragmentKey(result, key, value);
  }

  if (translation.env && Object.keys(translation.env).length > 0) {
    const existingEnv =
      typeof result._env === "object" && result._env !== null && !Array.isArray(result._env)
        ? (result._env as Record<string, string>)
        : {};
    // Translation env wins: the flow declared _system-prompt, which is more
    // specific than a hand-set _env entry for the same variable.
    result._env = { ...existingEnv, ...translation.env };
  }

  return {
    frontmatter: result,
    cleanup: () => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
