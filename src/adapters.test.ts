import { describe, expect, test } from "bun:test";
import { buildArgs, resolveCommand } from "./command";
import { getPortableAdapter } from "./adapters";
import { CliRunner } from "./cli-runner";
import { createTestEnvironment } from "./system-environment";

function expectFlagValue(args: string[], flag: string, value: string): void {
  const idx = args.indexOf(flag);
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).toBe(value);
}

describe("portable adapter translation", () => {
  test("translates canonical keys for claude", () => {
    const args = buildArgs(
      {
        model: "sonnet",
        temperature: 0.2,
        "max-tokens": 1024,
      },
      new Set(),
      "claude"
    );

    expectFlagValue(args, "--model", "sonnet");
    expectFlagValue(args, "--temperature", "0.2");
    expectFlagValue(args, "--max-tokens", "1024");
  });

  test("translates canonical max-tokens to codex-specific flag", () => {
    const args = buildArgs(
      {
        model: "o3",
        temperature: 0.4,
        "max-tokens": 2048,
      },
      new Set(),
      "codex"
    );

    expectFlagValue(args, "--model", "o3");
    expectFlagValue(args, "--temperature", "0.4");
    expectFlagValue(args, "--max-output-tokens", "2048");
    expect(args).not.toContain("--max-tokens");
  });

  test("translates canonical max-tokens to gemini-specific flag", () => {
    const args = buildArgs(
      {
        model: "gemini-3-pro-preview",
        temperature: 0.1,
        "max-tokens": 4096,
      },
      new Set(),
      "gemini"
    );

    expectFlagValue(args, "--model", "gemini-3-pro-preview");
    expectFlagValue(args, "--temperature", "0.1");
    expectFlagValue(args, "--max-output-tokens", "4096");
    expect(args).not.toContain("--max-tokens");
  });

  test("translates canonical max-tokens to copilot-specific flag", () => {
    const args = buildArgs(
      {
        model: "gpt-4.1",
        temperature: 0.3,
        "max-tokens": 1536,
      },
      new Set(),
      "copilot"
    );

    expectFlagValue(args, "--model", "gpt-4.1");
    expectFlagValue(args, "--temperature", "0.3");
    expectFlagValue(args, "--max-completion-tokens", "1536");
    expect(args).not.toContain("--max-tokens");
  });

  test("translates canonical keys for droid", () => {
    const args = buildArgs(
      {
        model: "claude-opus-4-5",
        temperature: 0.5,
        "max-tokens": 3072,
      },
      new Set(),
      "droid"
    );

    expectFlagValue(args, "--model", "claude-opus-4-5");
    expectFlagValue(args, "--temperature", "0.5");
    expectFlagValue(args, "--max-tokens", "3072");
  });

  test("translates canonical keys for opencode", () => {
    const args = buildArgs(
      {
        model: "anthropic/claude-sonnet",
        temperature: 0.6,
        "max-tokens": 1200,
      },
      new Set(),
      "opencode"
    );

    expectFlagValue(args, "--model", "anthropic/claude-sonnet");
    expectFlagValue(args, "--temperature", "0.6");
    expectFlagValue(args, "--max-tokens", "1200");
  });

  test("normalizes max token aliases before translation", () => {
    const codex = getPortableAdapter("codex");
    expect(codex).toBeDefined();

    const normalized = codex!.normalizeFrontmatter({
      model: "o3",
      max_tokens: 4000,
      maxTokens: 5000,
    });

    // max_tokens has precedence over maxTokens during normalization.
    expect(normalized["max-output-tokens"]).toBe(4000);
    expect(normalized.max_tokens).toBeUndefined();
    expect(normalized.maxTokens).toBeUndefined();
    expect(normalized["max-tokens"]).toBeUndefined();
  });

  test("resolveCommand falls back to frontmatter tool when filename has no suffix", () => {
    const command = resolveCommand("portable-agent.md", {
      tool: "gemini",
    });
    expect(command).toBe("gemini");
  });

  test("resolveCommand prefers filename suffix over frontmatter tool", () => {
    const command = resolveCommand("portable-agent.claude.md", {
      tool: "gemini",
    });
    expect(command).toBe("claude");
  });

  test("accepts --tool alias for command override", async () => {
    const env = createTestEnvironment();
    env.addFile("/test/portable.md", `---
tool: gemini
---
Portable alias test`);

    const runner = new CliRunner({
      env,
      isStdinTTY: true,
      cwd: "/test",
    });

    const result = await runner.run([
      "node",
      "md",
      "/test/portable.md",
      "--tool",
      "echo",
      "--_dry-run",
    ]);

    expect(result.exitCode).toBe(0);
  });
});

describe("portable adapter translation for v3 engines", () => {
  test("pi keeps --model, drops unsupported temperature/max-tokens", () => {
    const args = buildArgs(
      { model: "gpt-5.5", temperature: 0.3, "max-tokens": 2048 },
      new Set(),
      "pi"
    );

    expectFlagValue(args, "--model", "gpt-5.5");
    expect(args).not.toContain("--temperature");
    expect(args).not.toContain("--max-tokens");
  });

  test("cursor-agent keeps --model, drops unsupported canonical keys", () => {
    const args = buildArgs(
      { model: "sonnet-4-thinking", temperature: 0.5, "max-tokens": 1024 },
      new Set(),
      "cursor-agent"
    );

    expectFlagValue(args, "--model", "sonnet-4-thinking");
    expect(args).not.toContain("--temperature");
    expect(args).not.toContain("--max-tokens");
  });

  test("agy keeps --model, drops unconfirmed canonical keys", () => {
    const args = buildArgs(
      { model: "gemini-3.1-pro", temperature: 0.5, "max-tokens": 1024 },
      new Set(),
      "agy"
    );

    expectFlagValue(args, "--model", "gemini-3.1-pro");
    expect(args).not.toContain("--temperature");
    expect(args).not.toContain("--max-tokens");
  });
});
