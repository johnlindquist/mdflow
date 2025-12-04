import { expect, test, describe } from "bun:test";
import { buildCopilotArgs, buildPrompt, slugify } from "./run";
import type { CopilotFrontmatter, CommandResult } from "./types";

describe("slugify", () => {
  test("converts command to lowercase kebab-case", () => {
    expect(slugify("gh run list")).toBe("gh-run-list");
  });

  test("handles flags and arguments", () => {
    expect(slugify("gh run list --limit 5")).toBe("gh-run-list-limit-5");
  });

  test("removes special characters", () => {
    expect(slugify("git status --short")).toBe("git-status-short");
  });

  test("prefixes with underscore if starts with number", () => {
    expect(slugify("5 commands")).toBe("_5-commands");
  });

  test("trims leading and trailing dashes", () => {
    expect(slugify("--verbose")).toBe("verbose");
  });
});

describe("buildCopilotArgs", () => {
  test("returns -p flag for non-interactive", () => {
    const args = buildCopilotArgs({});
    expect(args).toContain("-p");
  });

  test("adds model flag", () => {
    const args = buildCopilotArgs({ model: "claude-haiku-4.5" });
    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-4.5");
  });

  test("adds all boolean flags", () => {
    const args = buildCopilotArgs({
      silent: true,
      "allow-all-tools": true,
      "allow-all-paths": true,
    });
    expect(args).toContain("--silent");
    expect(args).toContain("--allow-all-tools");
    expect(args).toContain("--allow-all-paths");
  });

  test("adds interactive flag instead of -p", () => {
    const args = buildCopilotArgs({ interactive: true });
    expect(args).toContain("--interactive");
    expect(args).not.toContain("-p");
  });

  test("adds tool permissions", () => {
    const args = buildCopilotArgs({
      "allow-tool": "shell(git:*)",
      "deny-tool": "shell(rm)",
    });
    expect(args).toContain("--allow-tool");
    expect(args).toContain("shell(git:*)");
    expect(args).toContain("--deny-tool");
    expect(args).toContain("shell(rm)");
  });
});

describe("buildPrompt", () => {
  test("returns body when no before results", () => {
    const prompt = buildPrompt([], "Do something");
    expect(prompt).toBe("Do something");
  });

  test("wraps before output in XML tags", () => {
    const beforeResults: CommandResult[] = [
      { command: "echo hello", output: "hello", exitCode: 0 },
    ];
    const prompt = buildPrompt(beforeResults, "Analyze this");
    expect(prompt).toContain("<echo-hello>");
    expect(prompt).toContain("hello");
    expect(prompt).toContain("</echo-hello>");
    expect(prompt).toContain("Analyze this");
  });

  test("wraps multiple before commands in separate XML tags", () => {
    const beforeResults: CommandResult[] = [
      { command: "gh run list", output: "run1\nrun2", exitCode: 0 },
      { command: "git status", output: "clean", exitCode: 0 },
    ];
    const prompt = buildPrompt(beforeResults, "Body");
    expect(prompt).toContain("<gh-run-list>");
    expect(prompt).toContain("run1\nrun2");
    expect(prompt).toContain("</gh-run-list>");
    expect(prompt).toContain("<git-status>");
    expect(prompt).toContain("clean");
    expect(prompt).toContain("</git-status>");
  });

  test("places body after XML tags", () => {
    const beforeResults: CommandResult[] = [
      { command: "cmd", output: "out", exitCode: 0 },
    ];
    const prompt = buildPrompt(beforeResults, "Instructions here");
    const tagEnd = prompt.indexOf("</cmd>");
    const bodyStart = prompt.indexOf("Instructions here");
    expect(bodyStart).toBeGreaterThan(tagEnd);
  });
});
