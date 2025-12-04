import { expect, test, describe } from "bun:test";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import type { CopilotFrontmatter } from "./types";

describe("parseCliArgs", () => {
  test("extracts file path", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides).toEqual({});
  });

  test("parses --model flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--model", "gpt-5"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides.model).toBe("gpt-5");
  });

  test("parses -m short flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "-m", "claude-opus-4.5"]);
    expect(result.overrides.model).toBe("claude-opus-4.5");
  });

  test("parses --silent flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--silent"]);
    expect(result.overrides.silent).toBe(true);
  });

  test("parses --no-silent flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--no-silent"]);
    expect(result.overrides.silent).toBe(false);
  });

  test("parses --interactive flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--interactive"]);
    expect(result.overrides.interactive).toBe(true);
  });

  test("parses --allow-all-tools flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--allow-all-tools"]);
    expect(result.overrides["allow-all-tools"]).toBe(true);
  });

  test("parses --allow-tool with value", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--allow-tool", "shell(git:*)"]);
    expect(result.overrides["allow-tool"]).toBe("shell(git:*)");
  });

  test("parses multiple flags", () => {
    const result = parseCliArgs([
      "node", "script", "DEMO.md",
      "--model", "gpt-5",
      "--silent",
      "--allow-all-tools"
    ]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides.model).toBe("gpt-5");
    expect(result.overrides.silent).toBe(true);
    expect(result.overrides["allow-all-tools"]).toBe(true);
  });

  test("handles flags before file path", () => {
    const result = parseCliArgs(["node", "script", "--model", "gpt-5", "DEMO.md"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides.model).toBe("gpt-5");
  });
});

describe("mergeFrontmatter", () => {
  test("returns frontmatter when no overrides", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5", silent: true };
    const result = mergeFrontmatter(frontmatter, {});
    expect(result).toEqual(frontmatter);
  });

  test("overrides model", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5", silent: true };
    const result = mergeFrontmatter(frontmatter, { model: "gpt-5" });
    expect(result.model).toBe("gpt-5");
    expect(result.silent).toBe(true);
  });

  test("overrides silent", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5", silent: true };
    const result = mergeFrontmatter(frontmatter, { silent: false });
    expect(result.model).toBe("claude-haiku-4.5");
    expect(result.silent).toBe(false);
  });

  test("adds new fields from overrides", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5" };
    const result = mergeFrontmatter(frontmatter, { "allow-all-tools": true });
    expect(result.model).toBe("claude-haiku-4.5");
    expect(result["allow-all-tools"]).toBe(true);
  });
});
