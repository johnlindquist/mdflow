import { test, expect, describe } from "bun:test";
import { CopilotRunner } from "./copilot";
import { ClaudeRunner } from "./claude";
import { CodexRunner } from "./codex";
import { GeminiRunner } from "./gemini";
import {
  createRunner,
  detectRunnerFromModel,
  resolveRunnerSync,
} from "./factory";
import type { RunContext } from "./types";
import type { AgentFrontmatter } from "../types";

// Helper to create a minimal RunContext
function makeContext(frontmatter: AgentFrontmatter = {}): RunContext {
  return {
    prompt: "test prompt",
    frontmatter,
    passthroughArgs: [],
    captureOutput: false,
  };
}

describe("CopilotRunner", () => {
  const runner = new CopilotRunner();

  test("has correct name", () => {
    expect(runner.name).toBe("copilot");
  });

  test("returns correct command", () => {
    expect(runner.getCommand()).toBe("copilot");
  });

  test("builds args with model", () => {
    const args = runner.buildArgs(makeContext({ model: "gpt-5" }));
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5");
  });

  test("builds args with agent from copilot config", () => {
    const args = runner.buildArgs(makeContext({
      copilot: { agent: "my-agent" }
    }));
    expect(args).toContain("--agent");
    expect(args).toContain("my-agent");
  });

  test("builds args with add-dir", () => {
    const args = runner.buildArgs(makeContext({ "add-dir": "/some/dir" }));
    expect(args).toContain("--add-dir");
    expect(args).toContain("/some/dir");
  });

  test("handles array of add-dir", () => {
    const args = runner.buildArgs(makeContext({
      "add-dir": ["/dir1", "/dir2"]
    }));
    expect(args.filter(a => a === "--add-dir")).toHaveLength(2);
    expect(args).toContain("/dir1");
    expect(args).toContain("/dir2");
  });

  test("builds args with allow-all-tools", () => {
    const args = runner.buildArgs(makeContext({ "allow-all-tools": true }));
    expect(args).toContain("--allow-all-tools");
  });

  test("builds args with silent mode", () => {
    const args = runner.buildArgs(makeContext({ silent: true }));
    expect(args).toContain("--silent");
  });

  test("builds args with interactive mode", () => {
    const args = runner.buildArgs(makeContext({ interactive: true }));
    expect(args).toContain("--interactive");
  });

  test("defaults to -p when not interactive", () => {
    const args = runner.buildArgs(makeContext({}));
    expect(args).toContain("-p");
    expect(args).not.toContain("--interactive");
  });

  test("includes passthrough args", () => {
    const ctx = makeContext({});
    ctx.passthroughArgs = ["--verbose", "--debug"];
    const args = runner.buildArgs(ctx);
    expect(args).toContain("--verbose");
    expect(args).toContain("--debug");
  });
});

describe("ClaudeRunner", () => {
  const runner = new ClaudeRunner();

  test("has correct name", () => {
    expect(runner.name).toBe("claude");
  });

  test("returns correct command", () => {
    expect(runner.getCommand()).toBe("claude");
  });

  test("builds args with model", () => {
    const args = runner.buildArgs(makeContext({ model: "opus" }));
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });

  test("maps claude model names", () => {
    const args = runner.buildArgs(makeContext({ model: "claude-sonnet-4" }));
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
  });

  test("builds args with add-dir", () => {
    const args = runner.buildArgs(makeContext({ "add-dir": "/some/dir" }));
    expect(args).toContain("--add-dir");
    expect(args).toContain("/some/dir");
  });

  test("builds args with allow-all-tools (maps to dangerously-skip-permissions)", () => {
    const args = runner.buildArgs(makeContext({ "allow-all-tools": true }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("builds args with claude-specific dangerously-skip-permissions", () => {
    const args = runner.buildArgs(makeContext({
      claude: { "dangerously-skip-permissions": true }
    }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("builds args with mcp-config", () => {
    const args = runner.buildArgs(makeContext({
      claude: { "mcp-config": "./my-mcp.json" }
    }));
    expect(args).toContain("--mcp-config");
    expect(args).toContain("./my-mcp.json");
  });

  test("handles array of mcp-config", () => {
    const args = runner.buildArgs(makeContext({
      claude: { "mcp-config": ["./mcp1.json", "./mcp2.json"] }
    }));
    expect(args.filter(a => a === "--mcp-config")).toHaveLength(2);
    expect(args).toContain("./mcp1.json");
    expect(args).toContain("./mcp2.json");
  });

  test("builds args with allowed-tools", () => {
    const args = runner.buildArgs(makeContext({
      claude: { "allowed-tools": "Read,Write" }
    }));
    expect(args).toContain("--allowed-tools");
    expect(args).toContain("Read,Write");
  });

  test("uses -p for silent mode", () => {
    const args = runner.buildArgs(makeContext({ silent: true }));
    expect(args).toContain("-p");
  });

  test("does not add -p for interactive mode", () => {
    const args = runner.buildArgs(makeContext({
      silent: true,
      interactive: true
    }));
    expect(args).not.toContain("-p");
  });

  test("includes passthrough args", () => {
    const ctx = makeContext({});
    ctx.passthroughArgs = ["--verbose"];
    const args = runner.buildArgs(ctx);
    expect(args).toContain("--verbose");
  });
});

describe("CodexRunner", () => {
  const runner = new CodexRunner();

  test("has correct name", () => {
    expect(runner.name).toBe("codex");
  });

  test("returns correct command", () => {
    expect(runner.getCommand()).toBe("codex");
  });

  test("builds args with model", () => {
    const args = runner.buildArgs(makeContext({ model: "gpt-5.1" }));
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.1");
  });

  test("builds args with codex sandbox", () => {
    const args = runner.buildArgs(makeContext({
      codex: { sandbox: "workspace-write" }
    }));
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
  });

  test("builds args with codex approval", () => {
    const args = runner.buildArgs(makeContext({
      codex: { approval: "on-failure" }
    }));
    expect(args).toContain("--approval");
    expect(args).toContain("on-failure");
  });

  test("builds args with allow-all-tools (maps to full-auto)", () => {
    const args = runner.buildArgs(makeContext({ "allow-all-tools": true }));
    expect(args).toContain("--full-auto");
  });

  test("builds args with codex full-auto", () => {
    const args = runner.buildArgs(makeContext({
      codex: { "full-auto": true }
    }));
    expect(args).toContain("--full-auto");
  });

  test("builds args with oss mode", () => {
    const args = runner.buildArgs(makeContext({
      codex: { oss: true }
    }));
    expect(args).toContain("--oss");
  });

  test("builds args with local-provider", () => {
    const args = runner.buildArgs(makeContext({
      codex: { "local-provider": "ollama" }
    }));
    expect(args).toContain("--local-provider");
    expect(args).toContain("ollama");
  });

  test("builds args with cd", () => {
    const args = runner.buildArgs(makeContext({
      codex: { cd: "./src" }
    }));
    expect(args).toContain("--cd");
    expect(args).toContain("./src");
  });
});

describe("GeminiRunner", () => {
  const runner = new GeminiRunner();

  test("has correct name", () => {
    expect(runner.name).toBe("gemini");
  });

  test("returns correct command", () => {
    expect(runner.getCommand()).toBe("gemini");
  });

  test("builds args with model", () => {
    const args = runner.buildArgs(makeContext({ model: "gemini-2.5-pro" }));
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
  });

  test("maps gemini model names", () => {
    const args = runner.buildArgs(makeContext({ model: "gemini-pro" }));
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
  });

  test("builds args with include-directories (add-dir)", () => {
    const args = runner.buildArgs(makeContext({ "add-dir": "/some/dir" }));
    expect(args).toContain("--include-directories");
    expect(args).toContain("/some/dir");
  });

  test("builds args with sandbox", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { sandbox: true }
    }));
    expect(args).toContain("--sandbox");
  });

  test("builds args with allow-all-tools (maps to yolo)", () => {
    const args = runner.buildArgs(makeContext({ "allow-all-tools": true }));
    expect(args).toContain("--yolo");
  });

  test("builds args with gemini-specific yolo", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { yolo: true }
    }));
    expect(args).toContain("--yolo");
  });

  test("builds args with approval-mode", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { "approval-mode": "auto_edit" }
    }));
    expect(args).toContain("--approval-mode");
    expect(args).toContain("auto_edit");
  });

  test("builds args with allowed-tools", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { "allowed-tools": ["tool1", "tool2"] }
    }));
    expect(args.filter(a => a === "--allowed-tools")).toHaveLength(2);
    expect(args).toContain("tool1");
    expect(args).toContain("tool2");
  });

  test("builds args with extensions", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { extensions: ["ext1", "ext2"] }
    }));
    expect(args.filter(a => a === "--extensions")).toHaveLength(2);
    expect(args).toContain("ext1");
    expect(args).toContain("ext2");
  });

  test("builds args with resume", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { resume: "latest" }
    }));
    expect(args).toContain("--resume");
    expect(args).toContain("latest");
  });

  test("builds args with mcp server names", () => {
    const args = runner.buildArgs(makeContext({
      gemini: { "allowed-mcp-server-names": ["server1"] }
    }));
    expect(args).toContain("--allowed-mcp-server-names");
    expect(args).toContain("server1");
  });

  test("adds output-format text for silent mode", () => {
    const args = runner.buildArgs(makeContext({ silent: true }));
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
  });

  test("does not add output-format for interactive mode", () => {
    const args = runner.buildArgs(makeContext({
      silent: true,
      interactive: true
    }));
    expect(args).not.toContain("--output-format");
  });
});

describe("detectRunnerFromModel", () => {
  test("detects claude models", () => {
    expect(detectRunnerFromModel("claude-sonnet-4")).toBe("claude");
    expect(detectRunnerFromModel("claude-opus-4.5")).toBe("claude");
    expect(detectRunnerFromModel("claude-haiku-4.5")).toBe("claude");
    expect(detectRunnerFromModel("sonnet")).toBe("claude");
    expect(detectRunnerFromModel("opus")).toBe("claude");
    expect(detectRunnerFromModel("haiku")).toBe("claude");
  });

  test("detects codex/gpt models", () => {
    expect(detectRunnerFromModel("gpt-5")).toBe("codex");
    expect(detectRunnerFromModel("gpt-5.1")).toBe("codex");
    expect(detectRunnerFromModel("gpt-5.1-codex")).toBe("codex");
    expect(detectRunnerFromModel("o1")).toBe("codex");
    expect(detectRunnerFromModel("o3")).toBe("codex");
    expect(detectRunnerFromModel("codex")).toBe("codex");
  });

  test("detects gemini models", () => {
    expect(detectRunnerFromModel("gemini-2.5-pro")).toBe("gemini");
    expect(detectRunnerFromModel("gemini-2.5-flash")).toBe("gemini");
    expect(detectRunnerFromModel("gemini-3-pro-preview")).toBe("gemini");
  });

  test("returns null for unknown models", () => {
    expect(detectRunnerFromModel("unknown-model")).toBeNull();
    expect(detectRunnerFromModel("llama-3")).toBeNull();
  });
});

describe("createRunner", () => {
  test("creates copilot runner", () => {
    const runner = createRunner("copilot");
    expect(runner.name).toBe("copilot");
  });

  test("creates claude runner", () => {
    const runner = createRunner("claude");
    expect(runner.name).toBe("claude");
  });

  test("creates codex runner", () => {
    const runner = createRunner("codex");
    expect(runner.name).toBe("codex");
  });

  test("creates gemini runner", () => {
    const runner = createRunner("gemini");
    expect(runner.name).toBe("gemini");
  });

  test("throws for unknown runner", () => {
    expect(() => createRunner("unknown" as any)).toThrow("Unknown runner");
  });
});

describe("resolveRunnerSync", () => {
  test("uses CLI runner when provided", () => {
    const runner = resolveRunnerSync({
      cliRunner: "claude",
      frontmatter: { runner: "copilot" }
    });
    expect(runner.name).toBe("claude");
  });

  test("uses frontmatter runner when no CLI runner", () => {
    const runner = resolveRunnerSync({
      frontmatter: { runner: "codex" }
    });
    expect(runner.name).toBe("codex");
  });

  test("ignores frontmatter runner:auto", () => {
    const runner = resolveRunnerSync({
      frontmatter: { runner: "auto", model: "sonnet" }
    });
    expect(runner.name).toBe("claude"); // Falls through to model detection
  });

  test("detects runner from model", () => {
    const runner = resolveRunnerSync({
      frontmatter: { model: "gpt-5" }
    });
    expect(runner.name).toBe("codex");
  });

  test("falls back to copilot", () => {
    const runner = resolveRunnerSync({
      frontmatter: {}
    });
    expect(runner.name).toBe("copilot");
  });

  test("falls back to copilot for unknown model", () => {
    const runner = resolveRunnerSync({
      frontmatter: { model: "unknown-model" }
    });
    expect(runner.name).toBe("copilot");
  });
});
