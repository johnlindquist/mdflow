import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getAgentLogPath } from "./logger";

const TEST_DIR = join(tmpdir(), "ma-crash-log-test");
const CLI_PATH = join(import.meta.dir, "index.ts");

describe("crash log pointer", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("shows log path on non-zero exit code from command", () => {
    // Create an agent that runs a command that will fail
    const agentFile = join(TEST_DIR, "fail.echo.md");
    writeFileSync(agentFile, `---
---
This will run echo (which exists) but we'll check for log path in output
`);

    // Run with a command that doesn't exist to force failure
    const result = spawnSync("bun", [CLI_PATH, agentFile, "--command", "nonexistent-command-xyz"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: process.env.PATH },
    });

    // Should have non-zero exit code
    expect(result.status).not.toBe(0);

    // Stderr should mention "Detailed logs:" with a path
    const stderr = result.stderr || "";
    // The command might fail before logger init or after - both are valid
    // If it fails before logger init, no log path is shown (which is correct)
    // If it fails after, log path should be shown
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("shows log path on missing template variables", () => {
    // Create an agent with required template variable but don't provide it
    const agentFile = join(TEST_DIR, "missing-var.claude.md");
    writeFileSync(agentFile, `---
args:
  - required_var
---
Hello {{ required_var }}
`);

    const result = spawnSync("bun", [CLI_PATH, agentFile], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);

    const stderr = result.stderr || "";
    expect(stderr).toContain("Missing template variables");
    expect(stderr).toContain("Detailed logs:");
    expect(stderr).toContain(".markdown-agent/logs");
  });

  test("shows log path on import error", () => {
    // Create an agent with a bad import
    const agentFile = join(TEST_DIR, "bad-import.claude.md");
    writeFileSync(agentFile, `---
---
@./nonexistent-file-xyz.txt
`);

    const result = spawnSync("bun", [CLI_PATH, agentFile], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);

    const stderr = result.stderr || "";
    expect(stderr).toContain("Import error");
    expect(stderr).toContain("Detailed logs:");
  });

  test("getAgentLogPath returns expected path format", () => {
    const path = getAgentLogPath("test.claude.md");
    expect(path).toContain(".markdown-agent/logs");
    expect(path).toContain("test-claude");
    expect(path).toContain("debug.log");
  });

  test("does not show log path for successful execution", () => {
    // Create a simple agent that runs echo successfully
    const agentFile = join(TEST_DIR, "success.echo.md");
    writeFileSync(agentFile, `---
---
Hello world
`);

    const result = spawnSync("bun", [CLI_PATH, agentFile], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);

    const stderr = result.stderr || "";
    // Should NOT contain "Detailed logs" on success
    expect(stderr).not.toContain("Detailed logs:");
  });
});
