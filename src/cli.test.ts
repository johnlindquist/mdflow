import { expect, test, describe } from "bun:test";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import type { AgentFrontmatter } from "./types";

describe("parseCliArgs", () => {
  test("extracts file path", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.passthroughArgs).toEqual([]);
  });

  test("all flags pass through when file is provided", () => {
    const result = parseCliArgs([
      "node", "script", "DEMO.md",
      "-p", "print mode",
      "--model", "opus",
      "--verbose"
    ]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.passthroughArgs).toEqual(["-p", "print mode", "--model", "opus", "--verbose"]);
  });

  test("--help works when no file provided", () => {
    const result = parseCliArgs(["node", "script", "--help"]);
    expect(result.filePath).toBe("");
    expect(result.help).toBe(true);
  });

  test("--setup works when no file provided", () => {
    const result = parseCliArgs(["node", "script", "--setup"]);
    expect(result.filePath).toBe("");
    expect(result.setup).toBe(true);
  });

  test("--logs works when no file provided", () => {
    const result = parseCliArgs(["node", "script", "--logs"]);
    expect(result.filePath).toBe("");
    expect(result.logs).toBe(true);
  });

  test("ma flags ignored when file is provided", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--help", "--setup"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.help).toBe(false);
    expect(result.setup).toBe(false);
    expect(result.passthroughArgs).toEqual(["--help", "--setup"]);
  });
});

describe("mergeFrontmatter", () => {
  test("merges frontmatter with empty overrides", () => {
    const frontmatter: AgentFrontmatter = { command: "claude" };
    const result = mergeFrontmatter(frontmatter, {});
    expect(result.command).toBe("claude");
  });

  test("overrides command", () => {
    const frontmatter: AgentFrontmatter = { command: "claude" };
    const result = mergeFrontmatter(frontmatter, { command: "gemini" });
    expect(result.command).toBe("gemini");
  });

  test("adds new fields from overrides", () => {
    const frontmatter: AgentFrontmatter = { command: "claude" };
    const result = mergeFrontmatter(frontmatter, { model: "opus" } as any);
    expect(result.command).toBe("claude");
    expect((result as any).model).toBe("opus");
  });

  test("preserves all frontmatter keys", () => {
    const frontmatter: AgentFrontmatter = {
      command: "claude",
      model: "opus",
      "dangerously-skip-permissions": true
    } as any;
    const result = mergeFrontmatter(frontmatter, {});
    expect(result.command).toBe("claude");
    expect((result as any).model).toBe("opus");
    expect((result as any)["dangerously-skip-permissions"]).toBe(true);
  });
});
