import { expect, test, describe } from "bun:test";
import { parseCommandFromFilename, resolveCommand, buildArgs } from "./command";

describe("parseCommandFromFilename", () => {
  test("extracts command from filename pattern", () => {
    expect(parseCommandFromFilename("task.claude.md")).toBe("claude");
    expect(parseCommandFromFilename("commit.gemini.md")).toBe("gemini");
    expect(parseCommandFromFilename("review.codex.md")).toBe("codex");
  });

  test("handles paths with directories", () => {
    expect(parseCommandFromFilename("/path/to/task.claude.md")).toBe("claude");
    expect(parseCommandFromFilename("./agents/task.gemini.md")).toBe("gemini");
  });

  test("returns undefined for files without command pattern", () => {
    expect(parseCommandFromFilename("task.md")).toBeUndefined();
    expect(parseCommandFromFilename("README.md")).toBeUndefined();
  });

  test("handles case insensitivity", () => {
    expect(parseCommandFromFilename("task.CLAUDE.md")).toBe("CLAUDE");
    expect(parseCommandFromFilename("task.Claude.MD")).toBe("Claude");
  });
});

describe("resolveCommand", () => {
  test("frontmatter command takes priority over filename", () => {
    const result = resolveCommand({
      frontmatter: { command: "gemini" },
      filePath: "task.claude.md",
    });
    expect(result).toBe("gemini");
  });

  test("filename inference works when no command specified", () => {
    const result = resolveCommand({
      frontmatter: {},
      filePath: "task.claude.md",
    });
    expect(result).toBe("claude");
  });

  test("throws when no command can be resolved", () => {
    expect(() => resolveCommand({
      frontmatter: {},
      filePath: "task.md",
    })).toThrow("No command specified");
  });
});

describe("buildArgs", () => {
  test("converts string values to flags", () => {
    const result = buildArgs({ model: "opus" }, new Set());
    expect(result).toEqual(["--model", "opus"]);
  });

  test("converts boolean true to flag only", () => {
    const result = buildArgs({ "dangerously-skip-permissions": true }, new Set());
    expect(result).toEqual(["--dangerously-skip-permissions"]);
  });

  test("omits boolean false values", () => {
    const result = buildArgs({ debug: false }, new Set());
    expect(result).toEqual([]);
  });

  test("handles arrays by repeating flags", () => {
    const result = buildArgs({ "add-dir": ["./src", "./tests"] }, new Set());
    expect(result).toEqual(["--add-dir", "./src", "--add-dir", "./tests"]);
  });

  test("skips system keys", () => {
    const result = buildArgs({
      command: "claude",
      inputs: [],
      requires: { bin: ["git"] },
      cache: true,
      "$1": "prompt",  // $1 is a system key
      model: "opus",
    }, new Set());
    expect(result).toEqual(["--model", "opus"]);
  });

  test("skips template variables", () => {
    const result = buildArgs({
      model: "opus",
      target: "src/main.ts",
    }, new Set(["target"]));
    expect(result).toEqual(["--model", "opus"]);
  });

  test("handles single-char flags", () => {
    const result = buildArgs({ p: true, c: true }, new Set());
    expect(result).toEqual(["-p", "-c"]);
  });
});
