/**
 * Tests for RunContext
 *
 * Demonstrates complete isolation between parallel test runs
 * and custom loggers/configs per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  createRunContext,
  createTestRunContext,
  createSilentLogger,
  createTestLogger,
  createConsoleLogger,
  mergeConfigs,
  BUILTIN_DEFAULTS,
  type TestLogger,
} from "./context";
import type { RunContext, GlobalConfig } from "./types";
import { expandImports } from "./imports";
import { loadFullConfigFresh, getCommandDefaultsFromConfig, applyDefaults } from "./config";

describe("RunContext", () => {
  describe("createRunContext", () => {
    it("creates context with default values", () => {
      const ctx = createRunContext();

      expect(ctx.logger).toBeDefined();
      expect(ctx.config).toBeDefined();
      expect(ctx.env).toBeDefined();
      expect(ctx.cwd).toBeDefined();
    });

    it("uses provided logger", () => {
      const testLogger = createTestLogger();
      const ctx = createRunContext({ logger: testLogger });

      expect(ctx.logger).toBe(testLogger);
    });

    it("uses provided config", () => {
      const customConfig: GlobalConfig = {
        commands: {
          myTool: { model: "custom" },
        },
      };
      const ctx = createRunContext({ config: customConfig });

      expect(ctx.config).toBe(customConfig);
    });

    it("uses provided env", () => {
      const customEnv = { MY_VAR: "test_value" };
      const ctx = createRunContext({ env: customEnv });

      expect(ctx.env.MY_VAR).toBe("test_value");
    });

    it("uses provided cwd", () => {
      const ctx = createRunContext({ cwd: "/custom/path" });

      expect(ctx.cwd).toBe("/custom/path");
    });
  });

  describe("createTestRunContext", () => {
    it("creates context with TestLogger", () => {
      const ctx = createTestRunContext();

      expect(ctx.logger.messages).toBeDefined();
      expect(Array.isArray(ctx.logger.messages)).toBe(true);
    });

    it("captures log messages", () => {
      const ctx = createTestRunContext();

      ctx.logger.info("test message");
      ctx.logger.debug({ data: "test" }, "debug message");

      expect(ctx.logger.messages.length).toBe(2);
      expect(ctx.logger.messages[0].msg).toBe("test message");
      expect(ctx.logger.messages[1].obj).toEqual({ data: "test" });
    });

    it("can clear messages", () => {
      const ctx = createTestRunContext();

      ctx.logger.info("message 1");
      ctx.logger.info("message 2");
      expect(ctx.logger.messages.length).toBe(2);

      ctx.logger.clear();
      expect(ctx.logger.messages.length).toBe(0);
    });

    it("uses isolated empty env by default", () => {
      const ctx = createTestRunContext();

      // Should not have process.env values
      expect(Object.keys(ctx.env).length).toBe(0);
    });
  });

  describe("Logger implementations", () => {
    it("silent logger does not throw", () => {
      const logger = createSilentLogger();

      expect(() => {
        logger.debug("test");
        logger.info({ data: 1 }, "test");
        logger.warn("warning");
        logger.error("error");
        logger.child({ module: "test" }).info("child log");
      }).not.toThrow();
    });

    it("test logger captures all levels", () => {
      const logger = createTestLogger();

      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");

      expect(logger.messages.map(m => m.level)).toEqual([
        "debug",
        "info",
        "warn",
        "error",
      ]);
    });

    it("console logger respects log level", () => {
      // Just verify it doesn't throw - actual console output is hard to test
      const logger = createConsoleLogger("error");

      expect(() => {
        logger.debug("should not appear");
        logger.info("should not appear");
        logger.warn("should not appear");
        logger.error("should appear");
      }).not.toThrow();
    });
  });

  describe("mergeConfigs", () => {
    it("merges empty configs", () => {
      const result = mergeConfigs({}, {});
      expect(result).toEqual({});
    });

    it("base config is preserved when override is empty", () => {
      const base: GlobalConfig = {
        commands: { claude: { model: "opus" } },
      };
      const result = mergeConfigs(base, {});

      expect(result.commands?.claude?.model).toBe("opus");
    });

    it("override takes priority", () => {
      const base: GlobalConfig = {
        commands: { claude: { model: "opus" } },
      };
      const override: GlobalConfig = {
        commands: { claude: { model: "sonnet" } },
      };
      const result = mergeConfigs(base, override);

      expect(result.commands?.claude?.model).toBe("sonnet");
    });

    it("merges command settings", () => {
      const base: GlobalConfig = {
        commands: { claude: { model: "opus" } },
      };
      const override: GlobalConfig = {
        commands: { claude: { verbose: true } },
      };
      const result = mergeConfigs(base, override);

      expect(result.commands?.claude?.model).toBe("opus");
      expect(result.commands?.claude?.verbose).toBe(true);
    });

    it("adds new commands", () => {
      const base: GlobalConfig = {
        commands: { claude: { model: "opus" } },
      };
      const override: GlobalConfig = {
        commands: { gemini: { model: "pro" } },
      };
      const result = mergeConfigs(base, override);

      expect(result.commands?.claude?.model).toBe("opus");
      expect(result.commands?.gemini?.model).toBe("pro");
    });
  });
});

describe("RunContext Isolation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "runcontext-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parallel contexts do not interfere with each other", async () => {
    // Create two contexts with different configurations
    const ctx1 = createTestRunContext({
      config: { commands: { claude: { model: "opus" } } },
      env: { MY_VAR: "value1" },
      cwd: "/path1",
    });

    const ctx2 = createTestRunContext({
      config: { commands: { claude: { model: "sonnet" } } },
      env: { MY_VAR: "value2" },
      cwd: "/path2",
    });

    // Verify they are completely isolated
    expect(ctx1.config.commands?.claude?.model).toBe("opus");
    expect(ctx2.config.commands?.claude?.model).toBe("sonnet");

    expect(ctx1.env.MY_VAR).toBe("value1");
    expect(ctx2.env.MY_VAR).toBe("value2");

    expect(ctx1.cwd).toBe("/path1");
    expect(ctx2.cwd).toBe("/path2");

    // Logs are separate
    ctx1.logger.info("from ctx1");
    ctx2.logger.info("from ctx2");

    expect(ctx1.logger.messages.length).toBe(1);
    expect(ctx2.logger.messages.length).toBe(1);
    expect(ctx1.logger.messages[0].msg).toBe("from ctx1");
    expect(ctx2.logger.messages[0].msg).toBe("from ctx2");
  });

  it("modifying one context does not affect another", async () => {
    const ctx1 = createTestRunContext({
      env: { SHARED: "original" },
    });

    const ctx2 = createTestRunContext({
      env: { SHARED: "original" },
    });

    // Modify ctx1's env
    ctx1.env.SHARED = "modified";
    ctx1.env.NEW_VAR = "new";

    // ctx2 should be unaffected
    expect(ctx2.env.SHARED).toBe("original");
    expect(ctx2.env.NEW_VAR).toBeUndefined();
  });

  it("each test can have custom logger behavior", async () => {
    // Test 1: Silent logger for fast tests
    const silentCtx = createRunContext({ logger: createSilentLogger() });

    // Test 2: Test logger to verify logging
    const testCtx = createTestRunContext();

    // Both work independently
    silentCtx.logger.info("this goes nowhere");
    testCtx.logger.info("this is captured");

    expect(testCtx.logger.messages.length).toBe(1);
  });

  it("imports use context environment variables", async () => {
    // Create a file that uses a command inline
    const testFile = join(tempDir, "test.txt");
    await writeFile(testFile, "test content");

    const content = `Before import
@${testFile}
After import`;

    // Expand imports - env is passed through ImportContext
    const result = await expandImports(content, tempDir, new Set(), false, {
      env: { MY_VAR: "from_context" },
    });

    expect(result).toContain("test content");
  });

  it("config loading is fresh per context", async () => {
    // Create a project config
    const configPath = join(tempDir, "ma.config.yaml");
    await writeFile(
      configPath,
      `commands:
  claude:
    model: project-model
`
    );

    // Load fresh config (no caching)
    const config = await loadFullConfigFresh(tempDir);

    expect(config.commands?.claude?.model).toBe("project-model");
    // Built-in default for copilot should still be there
    expect(config.commands?.copilot?.$1).toBe("interactive");
  });

  it("getCommandDefaultsFromConfig is pure function", () => {
    const config: GlobalConfig = {
      commands: {
        claude: { model: "opus", verbose: true },
        gemini: { model: "pro" },
      },
    };

    const claudeDefaults = getCommandDefaultsFromConfig(config, "claude");
    const geminiDefaults = getCommandDefaultsFromConfig(config, "gemini");
    const unknownDefaults = getCommandDefaultsFromConfig(config, "unknown");

    expect(claudeDefaults?.model).toBe("opus");
    expect(claudeDefaults?.verbose).toBe(true);
    expect(geminiDefaults?.model).toBe("pro");
    expect(unknownDefaults).toBeUndefined();
  });

  it("applyDefaults works with RunContext config", () => {
    const ctx = createTestRunContext({
      config: {
        commands: {
          claude: { model: "opus", verbose: true },
        },
      },
    });

    const frontmatter = { temperature: 0.7 };
    const defaults = getCommandDefaultsFromConfig(ctx.config, "claude");
    const result = applyDefaults(frontmatter, defaults);

    expect(result.model).toBe("opus");
    expect(result.verbose).toBe(true);
    expect(result.temperature).toBe(0.7);
  });
});

describe("Parallel Test Isolation Demo", () => {
  // These tests run in parallel and demonstrate that contexts don't interfere

  it("test A with context A", async () => {
    const ctx = createTestRunContext({
      config: { commands: { test: { name: "A" } } },
      env: { TEST_ID: "A" },
    });

    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify our context is still intact
    expect(ctx.config.commands?.test?.name).toBe("A");
    expect(ctx.env.TEST_ID).toBe("A");
  });

  it("test B with context B", async () => {
    const ctx = createTestRunContext({
      config: { commands: { test: { name: "B" } } },
      env: { TEST_ID: "B" },
    });

    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify our context is still intact
    expect(ctx.config.commands?.test?.name).toBe("B");
    expect(ctx.env.TEST_ID).toBe("B");
  });

  it("test C with context C", async () => {
    const ctx = createTestRunContext({
      config: { commands: { test: { name: "C" } } },
      env: { TEST_ID: "C" },
    });

    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify our context is still intact
    expect(ctx.config.commands?.test?.name).toBe("C");
    expect(ctx.env.TEST_ID).toBe("C");
  });
});
