import { expect, test, describe } from "bun:test";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import type { CopilotFrontmatter } from "./types";

describe("parseCliArgs", () => {
  test("extracts file path", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides).toEqual({});
    expect(result.appendText).toBe("");
    expect(result.templateVars).toEqual({});
    expect(result.noCache).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  test("extracts positional text after file path", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "focus on errors"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.appendText).toBe("focus on errors");
  });

  test("joins multiple positional args", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "be", "concise"]);
    expect(result.appendText).toBe("be concise");
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

  test("combines text with flags", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--model", "gpt-5", "be concise"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides.model).toBe("gpt-5");
    expect(result.appendText).toBe("be concise");
  });

  test("extracts template variables from unknown flags", () => {
    const result = parseCliArgs([
      "node", "script", "DEMO.md",
      "--model", "gpt-5",
      "--target", "src/utils.ts",
      "--reference", "src/main.ts"
    ]);
    expect(result.overrides.model).toBe("gpt-5");
    expect(result.templateVars).toEqual({
      target: "src/utils.ts",
      reference: "src/main.ts"
    });
  });

  test("parses --no-cache flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--no-cache"]);
    expect(result.noCache).toBe(true);
  });

  test("parses --dry-run flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  test("parses --runner flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--runner", "claude"]);
    expect(result.runner).toBe("claude");
  });

  test("parses -r short flag", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "-r", "codex"]);
    expect(result.runner).toBe("codex");
  });

  test("runner defaults to undefined", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md"]);
    expect(result.runner).toBeUndefined();
  });

  test("collects passthrough args after --", () => {
    const result = parseCliArgs([
      "node", "script", "DEMO.md",
      "--model", "gpt-5",
      "--", "--verbose", "--debug"
    ]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.overrides.model).toBe("gpt-5");
    expect(result.passthroughArgs).toEqual(["--verbose", "--debug"]);
  });

  test("passthrough args default to empty array", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md"]);
    expect(result.passthroughArgs).toEqual([]);
  });

  test("all args after -- are passthrough even if they look like known flags", () => {
    const result = parseCliArgs([
      "node", "script", "DEMO.md",
      "--", "--model", "ignored"
    ]);
    expect(result.overrides.model).toBeUndefined();
    expect(result.passthroughArgs).toEqual(["--model", "ignored"]);
  });

  test("parses --agent into copilot config", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--agent", "my-agent"]);
    expect(result.overrides.copilot).toEqual({ agent: "my-agent" });
  });
});

describe("mergeFrontmatter", () => {
  test("applies silent: true as default", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5" };
    const result = mergeFrontmatter(frontmatter, {});
    expect(result.model).toBe("claude-haiku-4.5");
    expect(result.silent).toBe(true);
  });

  test("frontmatter can override default silent", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5", silent: false };
    const result = mergeFrontmatter(frontmatter, {});
    expect(result.silent).toBe(false);
  });

  test("overrides model", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5" };
    const result = mergeFrontmatter(frontmatter, { model: "gpt-5" });
    expect(result.model).toBe("gpt-5");
    expect(result.silent).toBe(true);
  });

  test("CLI overrides silent from frontmatter", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5", silent: true };
    const result = mergeFrontmatter(frontmatter, { silent: false });
    expect(result.silent).toBe(false);
  });

  test("adds new fields from overrides", () => {
    const frontmatter: CopilotFrontmatter = { model: "claude-haiku-4.5" };
    const result = mergeFrontmatter(frontmatter, { "allow-all-tools": true });
    expect(result.model).toBe("claude-haiku-4.5");
    expect(result["allow-all-tools"]).toBe(true);
  });

  test("merges claude config", () => {
    const frontmatter: CopilotFrontmatter = {
      model: "sonnet",
      claude: { "mcp-config": "./mcp.json" }
    };
    const result = mergeFrontmatter(frontmatter, {
      claude: { "dangerously-skip-permissions": true }
    });
    expect(result.claude).toEqual({
      "mcp-config": "./mcp.json",
      "dangerously-skip-permissions": true
    });
  });

  test("merges codex config", () => {
    const frontmatter: CopilotFrontmatter = {
      model: "gpt-5",
      codex: { sandbox: "workspace-write" }
    };
    const result = mergeFrontmatter(frontmatter, {
      codex: { "full-auto": true }
    });
    expect(result.codex).toEqual({
      sandbox: "workspace-write",
      "full-auto": true
    });
  });

  test("merges copilot config", () => {
    const frontmatter: CopilotFrontmatter = {
      model: "gpt-5",
      copilot: { agent: "my-agent" }
    };
    const result = mergeFrontmatter(frontmatter, {
      copilot: { agent: "new-agent" }
    });
    expect(result.copilot?.agent).toBe("new-agent");
  });
});
