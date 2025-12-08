import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Tests for the --dry-run flag:
 * - --dry-run is consumed by ma (not passed to command)
 * - Prints the resolved command with args
 * - Prints the final rendered prompt/body
 * - Prints estimated token count
 * - Exits with code 0 without running the command
 */

describe("--dry-run flag consumption", () => {
  test("--dry-run flag is consumed and not passed to command", () => {
    // Simulate CLI: ma file.md --dry-run --model opus
    const cliArgs = ["--dry-run", "--model", "opus"];
    const remainingArgs = [...cliArgs];

    // Extract --dry-run flag (same logic as index.ts)
    let dryRun = false;
    const dryRunIndex = remainingArgs.indexOf("--dry-run");
    if (dryRunIndex !== -1) {
      dryRun = true;
      remainingArgs.splice(dryRunIndex, 1);
    }

    expect(dryRun).toBe(true);
    expect(remainingArgs).toEqual(["--model", "opus"]); // --dry-run consumed
  });

  test("--dry-run flag at end of args is consumed", () => {
    const cliArgs = ["--model", "opus", "--verbose", "--dry-run"];
    const remainingArgs = [...cliArgs];

    let dryRun = false;
    const dryRunIndex = remainingArgs.indexOf("--dry-run");
    if (dryRunIndex !== -1) {
      dryRun = true;
      remainingArgs.splice(dryRunIndex, 1);
    }

    expect(dryRun).toBe(true);
    expect(remainingArgs).toEqual(["--model", "opus", "--verbose"]);
  });

  test("--dry-run flag in middle of args is consumed", () => {
    const cliArgs = ["--model", "opus", "--dry-run", "--verbose"];
    const remainingArgs = [...cliArgs];

    let dryRun = false;
    const dryRunIndex = remainingArgs.indexOf("--dry-run");
    if (dryRunIndex !== -1) {
      dryRun = true;
      remainingArgs.splice(dryRunIndex, 1);
    }

    expect(dryRun).toBe(true);
    expect(remainingArgs).toEqual(["--model", "opus", "--verbose"]);
  });

  test("no --dry-run flag means dryRun is false", () => {
    const cliArgs = ["--model", "opus", "--verbose"];
    const remainingArgs = [...cliArgs];

    let dryRun = false;
    const dryRunIndex = remainingArgs.indexOf("--dry-run");
    if (dryRunIndex !== -1) {
      dryRun = true;
      remainingArgs.splice(dryRunIndex, 1);
    }

    expect(dryRun).toBe(false);
    expect(remainingArgs).toEqual(["--model", "opus", "--verbose"]);
  });
});

describe("--dry-run integration", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ma-dry-run-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("dry-run shows command and prompt without executing", async () => {
    const testFile = join(tempDir, "test.claude.md");
    await writeFile(
      testFile,
      `---
model: opus
---
Hello, this is a test prompt.`
    );

    const proc = Bun.spawn(["bun", "run", "src/index.ts", testFile, "--dry-run"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("Command:");
    expect(stdout).toContain("claude");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("opus");
    expect(stdout).toContain("Final Prompt:");
    expect(stdout).toContain("Hello, this is a test prompt.");
    expect(stdout).toContain("Estimated tokens:");
  });

  test("dry-run with template variables shows substituted values", async () => {
    const testFile = join(tempDir, "template.claude.md");
    await writeFile(
      testFile,
      `---
args: [name]
---
Hello, {{ name }}! Welcome.`
    );

    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", testFile, "Alice", "--dry-run"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("Hello, Alice! Welcome.");
    expect(stdout).not.toContain("{{ name }}"); // Template var should be replaced
  });

  test("dry-run with --command flag shows correct command", async () => {
    const testFile = join(tempDir, "generic.md");
    await writeFile(
      testFile,
      `---
model: gpt-4
---
Test prompt for generic file.`
    );

    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", testFile, "--command", "gemini", "--dry-run"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("Command:");
    expect(stdout).toContain("gemini"); // Should use --command value
    expect(stdout).toContain("--model");
    expect(stdout).toContain("gpt-4");
  });

  test("dry-run shows estimated token count", async () => {
    // Create a prompt with known length
    // With real tokenization, repeated "A" characters get tokenized efficiently
    // 400 "A"s = ~50 tokens (not 100 as with old length/4 heuristic)
    const promptText = "A".repeat(400);
    const testFile = join(tempDir, "tokens.claude.md");
    await writeFile(
      testFile,
      `---
model: opus
---
${promptText}`
    );

    const proc = Bun.spawn(["bun", "run", "src/index.ts", testFile, "--dry-run"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    // Check that token count is shown (exact count depends on tokenizer)
    expect(stdout).toMatch(/Estimated tokens: ~\d+/);
  });

  test("dry-run does NOT execute the command", async () => {
    // Create a file that would fail if actually executed (bad command)
    const testFile = join(tempDir, "norun.nonexistent-command.md");
    await writeFile(
      testFile,
      `---
---
This should not run.`
    );

    const proc = Bun.spawn(["bun", "run", "src/index.ts", testFile, "--dry-run"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    // Should exit 0 because dry-run prevents execution
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("nonexistent-command");
  });

  test("dry-run with additional passthrough flags shows them in command", async () => {
    const testFile = join(tempDir, "passthrough.claude.md");
    await writeFile(
      testFile,
      `---
model: opus
---
Test prompt.`
    );

    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", testFile, "--dry-run", "--verbose", "--debug"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("--verbose");
    expect(stdout).toContain("--debug");
    expect(stdout).not.toContain("--dry-run"); // Should be consumed, not shown
  });
});
