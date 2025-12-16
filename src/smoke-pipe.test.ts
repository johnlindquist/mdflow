import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import {
  spawnMdWithPipe,
  spawnMd,
  createTempDir,
  createTestAgent,
  createTestFiles,
  CLI_PATH,
} from "./test-utils";
import { spawn } from "bun";

/**
 * Smoke tests for piping between .md agent files.
 * Uses MA_COMMAND=echo to simulate LLM responses without actual API calls.
 * These tests verify the stdin/stdout piping mechanism works correctly.
 */

describe("smoke: pipe between agents", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const temp = await createTempDir("md-smoke-pipe-");
    testDir = temp.tempDir;
    cleanup = temp.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("stdin is passed to agent via _stdin variable", async () => {
    const agentFile = await createTestAgent(
      testDir,
      "echo-stdin.echo.md",
      `---
---
Input: {{ _stdin }}
Process this input:
`
    );

    const result = await spawnMdWithPipe(agentFile, "hello world", [], {
      env: { MA_COMMAND: "echo" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Process this input:");
    expect(result.stdout).toContain("hello world");
  });

  test("pipe: agent1 | agent2 (two-stage pipeline)", async () => {
    const paths = await createTestFiles(testDir, {
      "stage1.echo.md": `---
---
STAGE1_OUTPUT: processed
`,
      "stage2.echo.md": `---
---
STAGE2_RECEIVED: {{ _stdin }}
`,
    });

    // Multi-stage pipeline requires custom bash command
    const proc = spawn({
      cmd: [
        "bash",
        "-c",
        `echo "initial" | bun run ${CLI_PATH} ${paths["stage1.echo.md"]} | bun run ${CLI_PATH} ${paths["stage2.echo.md"]}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("STAGE2_RECEIVED:");
    expect(output).toContain("STAGE1_OUTPUT: processed");
  });

  test("pipe: agent1 | agent2 | agent3 (three-stage pipeline)", async () => {
    const paths = await createTestFiles(testDir, {
      "three-stage1.echo.md": `---
---
[STEP1]
`,
      "three-stage2.echo.md": `---
---
{{ _stdin }}
[STEP2]
`,
      "three-stage3.echo.md": `---
---
{{ _stdin }}
[STEP3_FINAL]
`,
    });

    const proc = spawn({
      cmd: [
        "bash",
        "-c",
        `echo "start" | bun run ${CLI_PATH} ${paths["three-stage1.echo.md"]} | bun run ${CLI_PATH} ${paths["three-stage2.echo.md"]} | bun run ${CLI_PATH} ${paths["three-stage3.echo.md"]}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("[STEP3_FINAL]");
    expect(output).toContain("[STEP2]");
    expect(output).toContain("[STEP1]");
  });

  test("template vars work in piped context", async () => {
    const agent = await createTestAgent(
      testDir,
      "template-pipe.echo.md",
      `---
_name: ""
---
Hello {{ _name }}! Input: {{ _stdin }}
`
    );

    const result = await spawnMdWithPipe(agent, "context", ["--_name", "World"], {
      env: { MA_COMMAND: "echo" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello World!");
    expect(result.stdout).toContain("context");
  });

  test("frontmatter flags are passed correctly in pipe", async () => {
    const agent = await createTestAgent(
      testDir,
      "flags-pipe.echo.md",
      `---
model: test-model
verbose: true
---
Body content
`
    );

    const result = await spawnMdWithPipe(agent, "input", ["--_dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("test-model");
  });

  test("empty stdin is handled gracefully", async () => {
    const agent = await createTestAgent(
      testDir,
      "empty-stdin.echo.md",
      `---
---
No stdin expected
`
    );

    const result = await spawnMd([agent], { env: { MA_COMMAND: "echo" } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No stdin expected");
    expect(result.stdout).not.toContain("<stdin>");
  });

  test("multiline stdin is preserved through pipe", async () => {
    const agent = await createTestAgent(
      testDir,
      "multiline.echo.md",
      `---
---
Received: {{ _stdin }}
`
    );

    // Use printf for multiline
    const proc = spawn({
      cmd: ["bash", "-c", `printf "line1\\nline2\\nline3" | bun run ${CLI_PATH} ${agent}`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("line1");
    expect(output).toContain("line2");
    expect(output).toContain("line3");
  });
});
