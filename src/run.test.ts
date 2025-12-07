import { expect, test, describe } from "bun:test";
import { buildCopilotArgs, slugify } from "./run";
import type { CopilotFrontmatter } from "./types";

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

