import { expect, test, describe } from "bun:test";
import { formatDryRun, type DryRunInfo } from "./dryrun";

describe("formatDryRun", () => {
  test("includes header", () => {
    const info: DryRunInfo = {
      frontmatter: {},
      prompt: "Test prompt",
      harnessArgs: ["-p"],
      harnessName: "claude",
      contextFiles: [],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("DRY RUN MODE");
  });

  test("includes prompt preview", () => {
    const info: DryRunInfo = {
      frontmatter: {},
      prompt: "My test prompt content",
      harnessArgs: ["-p"],
      harnessName: "claude",
      contextFiles: [],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("PROMPT PREVIEW");
    expect(output).toContain("My test prompt content");
  });

  test("includes template variables", () => {
    const info: DryRunInfo = {
      frontmatter: {},
      prompt: "Test",
      harnessArgs: [],
      harnessName: "claude",
      contextFiles: [],
      templateVars: { target: "src/main.ts", branch: "develop" },
    };
    const output = formatDryRun(info);
    expect(output).toContain("TEMPLATE VARIABLES");
    expect(output).toContain("{{ target }}");
    expect(output).toContain("src/main.ts");
    expect(output).toContain("{{ branch }}");
    expect(output).toContain("develop");
  });

  test("includes context files", () => {
    const info: DryRunInfo = {
      frontmatter: {},
      prompt: "Test",
      harnessArgs: [],
      harnessName: "claude",
      contextFiles: [
        { path: "/full/path/utils.ts", relativePath: "utils.ts", content: "const x = 1;\nconst y = 2;" }
      ],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("CONTEXT FILES");
    expect(output).toContain("utils.ts");
    expect(output).toContain("2 lines");
  });

  test("includes command", () => {
    const info: DryRunInfo = {
      frontmatter: { model: "opus" },
      prompt: "Test",
      harnessArgs: ["--model", "opus", "-p"],
      harnessName: "claude",
      contextFiles: [],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("COMMAND");
    expect(output).toContain("claude --model opus -p");
  });

  test("includes prerequisites", () => {
    const info: DryRunInfo = {
      frontmatter: {
        requires: { bin: ["docker", "kubectl"], env: ["API_KEY"] }
      },
      prompt: "Test",
      harnessArgs: [],
      harnessName: "claude",
      contextFiles: [],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("PREREQUISITES");
    expect(output).toContain("docker");
    expect(output).toContain("kubectl");
    expect(output).toContain("API_KEY");
  });

  test("includes configuration summary", () => {
    const info: DryRunInfo = {
      frontmatter: {
        model: "opus",
        cache: true,
      },
      prompt: "Test",
      harnessArgs: [],
      harnessName: "claude",
      contextFiles: [],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("CONFIGURATION");
    expect(output).toContain("Command: claude");
    expect(output).toContain("Cache: enabled");
  });

  test("truncates long prompts", () => {
    const longPrompt = Array(50).fill("Line of content").join("\n");
    const info: DryRunInfo = {
      frontmatter: {},
      prompt: longPrompt,
      harnessArgs: [],
      harnessName: "claude",
      contextFiles: [],
      templateVars: {},
    };
    const output = formatDryRun(info);
    expect(output).toContain("more lines");
  });
});
