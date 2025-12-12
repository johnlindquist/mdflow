import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, writeFile, rm } from "fs/promises";

/**
 * Smoke tests for piping between .md agent files.
 * Uses MA_COMMAND=echo to simulate LLM responses without actual API calls.
 * These tests verify the stdin/stdout piping mechanism works correctly.
 */

describe("smoke: pipe between agents", () => {
  const testDir = join(tmpdir(), `md-smoke-pipe-${Date.now()}`);
  const indexPath = join(process.cwd(), "src/index.ts");

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("stdin is passed to agent via _stdin variable", async () => {
    // Agent that uses _stdin template variable
    const agentFile = join(testDir, "echo-stdin.echo.md");
    await writeFile(agentFile, `---
---
Input: {{ _stdin }}
Process this input:
`);

    const proc = spawn({
      cmd: ["bash", "-c", `echo "hello world" | bun run ${indexPath} ${agentFile}`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("Process this input:");
    expect(output).toContain("hello world");
  });

  test("pipe: agent1 | agent2 (two-stage pipeline)", async () => {
    // Stage 1: Transforms input to structured output
    const agent1 = join(testDir, "stage1.echo.md");
    await writeFile(agent1, `---
---
STAGE1_OUTPUT: processed
`);

    // Stage 2: Receives stage 1 output via _stdin
    const agent2 = join(testDir, "stage2.echo.md");
    await writeFile(agent2, `---
---
STAGE2_RECEIVED: {{ _stdin }}
`);

    const proc = spawn({
      cmd: ["bash", "-c", `echo "initial" | bun run ${indexPath} ${agent1} | bun run ${indexPath} ${agent2}`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    // Stage 2 output should contain its body with stdin substituted
    expect(output).toContain("STAGE2_RECEIVED:");
    // Stage 2 should have received Stage 1's output
    expect(output).toContain("STAGE1_OUTPUT: processed");
  });

  test("pipe: agent1 | agent2 | agent3 (three-stage pipeline)", async () => {
    const agent1 = join(testDir, "three-stage1.echo.md");
    await writeFile(agent1, `---
---
[STEP1]
`);

    const agent2 = join(testDir, "three-stage2.echo.md");
    await writeFile(agent2, `---
---
{{ _stdin }}
[STEP2]
`);

    const agent3 = join(testDir, "three-stage3.echo.md");
    await writeFile(agent3, `---
---
{{ _stdin }}
[STEP3_FINAL]
`);

    const proc = spawn({
      cmd: ["bash", "-c", `echo "start" | bun run ${indexPath} ${agent1} | bun run ${indexPath} ${agent2} | bun run ${indexPath} ${agent3}`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    // Final output is from stage 3
    expect(output).toContain("[STEP3_FINAL]");
    // Stage 3 received stage 2's output (which included stage 1's output)
    expect(output).toContain("[STEP2]");
    // The chain preserved earlier outputs in stdin
    expect(output).toContain("[STEP1]");
  });

  test("template vars work in piped context", async () => {
    const agent = join(testDir, "template-pipe.echo.md");
    await writeFile(agent, `---
_name: ""
---
Hello {{ _name }}! Input: {{ _stdin }}
`);

    const proc = spawn({
      cmd: ["bash", "-c", `echo "context" | bun run ${indexPath} ${agent} --_name "World"`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("Hello World!");
    expect(output).toContain("context");
  });

  test("frontmatter flags are passed correctly in pipe", async () => {
    const agent = join(testDir, "flags-pipe.echo.md");
    await writeFile(agent, `---
model: test-model
verbose: true
---
Body content
`);

    // Use a wrapper to capture what args echo receives
    const proc = spawn({
      cmd: ["bash", "-c", `echo "input" | bun run ${indexPath} ${agent} --_dry-run 2>&1`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    // Dry run shows the command that would be executed
    expect(output).toContain("--model");
    expect(output).toContain("test-model");
  });

  test("empty stdin is handled gracefully", async () => {
    const agent = join(testDir, "empty-stdin.echo.md");
    await writeFile(agent, `---
---
No stdin expected
`);

    const proc = spawn({
      cmd: ["bash", "-c", `bun run ${indexPath} ${agent}`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MA_COMMAND: "echo" },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("No stdin expected");
    // No stdin tags when there's no stdin
    expect(output).not.toContain("<stdin>");
  });

  test("multiline stdin is preserved through pipe", async () => {
    const agent = join(testDir, "multiline.echo.md");
    await writeFile(agent, `---
---
Received: {{ _stdin }}
`);

    const multilineInput = "line1\nline2\nline3";

    const proc = spawn({
      cmd: ["bash", "-c", `printf "${multilineInput}" | bun run ${indexPath} ${agent}`],
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
