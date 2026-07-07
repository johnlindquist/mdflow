/**
 * Tests for the system prompt override (`_system-prompt` /
 * `_append-system-prompt`) — per-engine translation via adapter hooks.
 */

import { describe, test, expect } from "bun:test";
import {
  extractSystemPromptSpec,
  applySystemPromptToFrontmatter,
} from "./system-prompt";
import { buildArgs } from "./command";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { geminiAdapter } from "./adapters/gemini";
import { copilotAdapter } from "./adapters/copilot";
import { droidAdapter } from "./adapters/droid";
import { piAdapter } from "./adapters/pi";
import { CommandError } from "./errors";
import type { AgentFrontmatter } from "./types";

/** Test writer: records content, returns a fake path. */
function fakeWriter(): { writer: (c: string) => string; written: string[] } {
  const written: string[] = [];
  return {
    written,
    writer: (content: string) => {
      written.push(content);
      return `/fake/system-prompt-${written.length}.md`;
    },
  };
}

describe("extractSystemPromptSpec", () => {
  test("absent keys -> undefined", () => {
    expect(extractSystemPromptSpec({})).toBeUndefined();
  });

  test("frontmatter _system-prompt string", () => {
    expect(extractSystemPromptSpec({ "_system-prompt": "be terse" })).toEqual({
      replace: "be terse",
    });
  });

  test("frontmatter _append-system-prompt string becomes one segment", () => {
    expect(extractSystemPromptSpec({ "_append-system-prompt": "extra" })).toEqual({
      append: ["extra"],
    });
  });

  test("frontmatter _append-system-prompt list keeps segments", () => {
    expect(
      extractSystemPromptSpec({ "_append-system-prompt": ["a", "b"] })
    ).toEqual({ append: ["a", "b"] });
  });

  test("CLI values win over frontmatter", () => {
    expect(
      extractSystemPromptSpec(
        { "_system-prompt": "fm", "_append-system-prompt": ["fm-append"] },
        { replace: "cli", append: ["cli-append"] }
      )
    ).toEqual({ replace: "cli", append: ["cli-append"] });
  });

  test("non-string _system-prompt throws", () => {
    expect(() => extractSystemPromptSpec({ "_system-prompt": 42 as never })).toThrow(
      CommandError
    );
  });

  test("mixed-type _append-system-prompt list throws", () => {
    expect(() =>
      extractSystemPromptSpec({ "_append-system-prompt": ["ok", 42] as never })
    ).toThrow(CommandError);
  });
});

describe("claude translation", () => {
  test("replace -> --system-prompt; system keys removed", () => {
    const fm: AgentFrontmatter = { print: true, "_system-prompt": "be terse" };
    const { frontmatter } = applySystemPromptToFrontmatter(
      claudeAdapter, "claude", fm, { replace: "be terse" }
    );
    expect(frontmatter["system-prompt"]).toBe("be terse");
    expect(frontmatter["_system-prompt"]).toBeUndefined();
    const args = buildArgs(frontmatter, new Set(), "claude");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("be terse");
  });

  test("append segments join into one --append-system-prompt", () => {
    const { frontmatter } = applySystemPromptToFrontmatter(
      claudeAdapter, "claude", {}, { append: ["a", "b"] }
    );
    expect(frontmatter["append-system-prompt"]).toBe("a\n\nb");
  });
});

describe("pi translation", () => {
  test("replace + repeatable append", () => {
    const { frontmatter } = applySystemPromptToFrontmatter(
      piAdapter, "pi", {}, { replace: "sys", append: ["a", "b"] }
    );
    expect(frontmatter["system-prompt"]).toBe("sys");
    expect(frontmatter["append-system-prompt"]).toEqual(["a", "b"]);
    const args = buildArgs(frontmatter, new Set(), "pi");
    // pi's --append-system-prompt can be used multiple times
    expect(args.filter((a) => a === "--append-system-prompt")).toHaveLength(2);
  });
});

describe("codex translation", () => {
  test("replace writes a temp file -> -c model_instructions_file", () => {
    const { writer, written } = fakeWriter();
    const { frontmatter } = applySystemPromptToFrontmatter(
      codexAdapter, "codex", {}, { replace: "you are codex-lite" }, writer
    );
    expect(written).toEqual(["you are codex-lite"]);
    expect(frontmatter.config).toEqual([
      "model_instructions_file=/fake/system-prompt-1.md",
    ]);
  });

  test("append -> -c developer_instructions", () => {
    const { writer } = fakeWriter();
    const { frontmatter } = applySystemPromptToFrontmatter(
      codexAdapter, "codex", {}, { append: ["a", "b"] }, writer
    );
    expect(frontmatter.config).toEqual(["developer_instructions=a\n\nb"]);
  });

  test("config entries CONCAT with user-provided -c overrides", () => {
    const { writer } = fakeWriter();
    const fm: AgentFrontmatter = { config: ["model=o3"] };
    const { frontmatter } = applySystemPromptToFrontmatter(
      codexAdapter, "codex", fm, { replace: "sys" }, writer
    );
    expect(frontmatter.config).toEqual([
      "model=o3",
      "model_instructions_file=/fake/system-prompt-1.md",
    ]);
  });
});

describe("gemini translation", () => {
  test("replace writes temp file -> GEMINI_SYSTEM_MD env in _env", () => {
    const { writer, written } = fakeWriter();
    const { frontmatter } = applySystemPromptToFrontmatter(
      geminiAdapter, "gemini", {}, { replace: "gem sys" }, writer
    );
    expect(written).toEqual(["gem sys"]);
    expect(frontmatter._env).toEqual({
      GEMINI_SYSTEM_MD: "/fake/system-prompt-1.md",
    });
  });

  test("translation env wins over an existing _env key, others kept", () => {
    const { writer } = fakeWriter();
    const fm: AgentFrontmatter = {
      _env: { GEMINI_SYSTEM_MD: "/stale/path.md", OTHER: "kept" },
    };
    const { frontmatter } = applySystemPromptToFrontmatter(
      geminiAdapter, "gemini", fm, { replace: "sys" }, writer
    );
    expect((frontmatter._env as Record<string, string>).GEMINI_SYSTEM_MD).toBe(
      "/fake/system-prompt-1.md"
    );
    expect((frontmatter._env as Record<string, string>).OTHER).toBe("kept");
  });

  test("append is unsupported and throws", () => {
    const { writer } = fakeWriter();
    expect(() =>
      applySystemPromptToFrontmatter(
        geminiAdapter, "gemini", {}, { append: ["x"] }, writer
      )
    ).toThrow(/replace its system prompt/);
  });
});

describe("unsupported engines fail loudly", () => {
  test("copilot has no system prompt mechanism", () => {
    expect(() =>
      applySystemPromptToFrontmatter(copilotAdapter, "copilot", {}, { replace: "x" })
    ).toThrow(/no supported system prompt mechanism/);
  });

  test("droid has no system prompt mechanism", () => {
    expect(() =>
      applySystemPromptToFrontmatter(droidAdapter, "droid", {}, { append: ["x"] })
    ).toThrow(CommandError);
  });
});
