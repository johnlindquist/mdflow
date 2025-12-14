import { expect, test, describe, afterAll, beforeAll } from "bun:test";
import { getLogDir, getAgentLogPath, listLogDirs, initLogger } from "./logger";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, unlinkSync, existsSync, rmdirSync } from "fs";

describe("logger", () => {
  test("getLogDir returns correct path", () => {
    expect(getLogDir()).toBe(join(homedir(), ".mdflow", "logs"));
  });

  test("getAgentLogPath generates path based on agent name", () => {
    const path = getAgentLogPath("task.claude.md");
    expect(path).toBe(join(homedir(), ".mdflow", "logs", "task-claude", "debug.log"));
  });

  test("getAgentLogPath handles simple filenames", () => {
    const path = getAgentLogPath("review.md");
    expect(path).toBe(join(homedir(), ".mdflow", "logs", "review", "debug.log"));
  });

  test("listLogDirs returns array", () => {
    const dirs = listLogDirs();
    expect(Array.isArray(dirs)).toBe(true);
  });
});

describe("logger secret redaction", () => {
  const testAgentFile = "secret-redaction-test.claude.md";
  const logPath = getAgentLogPath(testAgentFile);
  const logDir = join(homedir(), ".mdflow", "logs", "secret-redaction-test-claude");

  afterAll(() => {
    // Clean up test log file
    try {
      if (existsSync(logPath)) {
        unlinkSync(logPath);
      }
      if (existsSync(logDir)) {
        rmdirSync(logDir);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test("redacts sensitive values in log objects", async () => {
    const logger = initLogger(testAgentFile);

    // Log an object with sensitive keys
    logger.info({
      api_key: "sk-secret123",
      model: "opus",
      token: "ghp_mytoken",
    }, "Test log with secrets");

    // Force flush
    logger.flush();

    // Give pino time to write (it's async)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Read the log file
    const logContent = readFileSync(logPath, "utf-8");

    // Verify sensitive values are redacted
    expect(logContent).toContain("[REDACTED]");
    expect(logContent).not.toContain("sk-secret123");
    expect(logContent).not.toContain("ghp_mytoken");

    // Verify non-sensitive values are preserved
    expect(logContent).toContain("opus");
    expect(logContent).toContain("Test log with secrets");
  });
});
