import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  extractFlag,
  createFlagExtractionTests,
  spawnMd,
  createTempDir,
  createTestAgent,
} from "./test-utils";

/**
 * Tests for the --_dry-run flag:
 * - --_dry-run is consumed by md (not passed to command)
 * - Prints the resolved command with args
 * - Prints the final rendered prompt/body
 * - Prints estimated token count
 * - Exits with code 0 without running the command
 */

describe("--_dry-run flag consumption", () => {
  const FLAG = "--_dry-run";
  const testCases = createFlagExtractionTests(FLAG);

  test("--_dry-run flag is consumed and not passed to command", () => {
    const args = [...testCases.atStart.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.atStart.expected.flagFound);
    expect(args).toEqual(testCases.atStart.expected.remaining);
  });

  test("--_dry-run flag at end of args is consumed", () => {
    const args = [...testCases.atEnd.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.atEnd.expected.flagFound);
    expect(args).toEqual(testCases.atEnd.expected.remaining);
  });

  test("--_dry-run flag in middle of args is consumed", () => {
    const args = [...testCases.inMiddle.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.inMiddle.expected.flagFound);
    expect(args).toEqual(testCases.inMiddle.expected.remaining);
  });

  test("no --_dry-run flag means dryRun is false", () => {
    const args = [...testCases.notPresent.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.notPresent.expected.flagFound);
    expect(args).toEqual(testCases.notPresent.expected.remaining);
  });
});

describe("--_dry-run integration", () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const temp = await createTempDir("md-dry-run-test-");
    tempDir = temp.tempDir;
    cleanup = temp.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("dry-run shows command and prompt without executing", async () => {
    const testFile = await createTestAgent(
      tempDir,
      "test.claude.md",
      `---
model: opus
---
Hello, this is a test prompt.`
    );

    const result = await spawnMd([testFile, "--_dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("Command:");
    expect(result.stdout).toContain("claude");
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("opus");
    expect(result.stdout).toContain("Final Prompt:");
    expect(result.stdout).toContain("Hello, this is a test prompt.");
    expect(result.stdout).toContain("Estimated tokens:");
  });

  test("dry-run with template variables shows substituted values", async () => {
    const testFile = await createTestAgent(
      tempDir,
      "template.claude.md",
      `---
_name: ""
---
Hello, {{ _name }}! Welcome.`
    );

    const result = await spawnMd([testFile, "--_name", "Alice", "--_dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("Hello, Alice! Welcome.");
    expect(result.stdout).not.toContain("{{ _name }}"); // Template var should be replaced
  });

  test("dry-run with --_command flag shows correct command", async () => {
    const testFile = await createTestAgent(
      tempDir,
      "generic.md",
      `---
model: gpt-4
---
Test prompt for generic file.`
    );

    const result = await spawnMd([testFile, "--_command", "gemini", "--_dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("Command:");
    expect(result.stdout).toContain("gemini"); // Should use --_command value
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("gpt-4");
  });

  test("dry-run shows estimated token count", async () => {
    // With real tokenization, repeated "A" characters get tokenized efficiently
    const promptText = "A".repeat(400);
    const testFile = await createTestAgent(
      tempDir,
      "tokens.claude.md",
      `---
model: opus
---
${promptText}`
    );

    const result = await spawnMd([testFile, "--_dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Estimated tokens: ~\d+/);
  });

  test("dry-run does NOT execute the command", async () => {
    // Create a file that would fail if actually executed (bad command)
    const testFile = await createTestAgent(
      tempDir,
      "norun.nonexistent-command.md",
      `---
---
This should not run.`
    );

    const result = await spawnMd([testFile, "--_dry-run"]);

    // Should exit 0 because dry-run prevents execution
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("nonexistent-command");
  });

  test("dry-run with additional passthrough flags shows them in command", async () => {
    const testFile = await createTestAgent(
      tempDir,
      "passthrough.claude.md",
      `---
model: opus
---
Test prompt.`
    );

    const result = await spawnMd([testFile, "--_dry-run", "--verbose", "--debug"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("--verbose");
    expect(result.stdout).toContain("--debug");
    expect(result.stdout).not.toContain("--_dry-run"); // Should be consumed, not shown
  });
});
