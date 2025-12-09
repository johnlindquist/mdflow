/**
 * Tests for parallel configuration loading
 *
 * These tests verify that configuration loading is truly stateless and
 * multiple parallel operations don't interfere with each other.
 * This was the main motivation for eliminating module-level caching.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadFullConfig,
  getCommandDefaultsFromConfig,
  BUILTIN_DEFAULTS,
} from "./config";
import { createTestRunContext } from "./context";

describe("Parallel Configuration Loading", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(dir => rm(dir, { recursive: true, force: true }))
    );
  });

  async function createTempDir(suffix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `parallel-config-${suffix}-`));
    tempDirs.push(dir);
    return dir;
  }

  it("loads different project configs in parallel without interference", async () => {
    // Create three different project directories with different configs
    const [dir1, dir2, dir3] = await Promise.all([
      createTempDir("project1"),
      createTempDir("project2"),
      createTempDir("project3"),
    ]);

    // Write different configs to each directory
    await Promise.all([
      writeFile(
        join(dir1, "mdflow.config.yaml"),
        `commands:\n  claude:\n    model: opus-1\n`
      ),
      writeFile(
        join(dir2, "mdflow.config.yaml"),
        `commands:\n  claude:\n    model: sonnet-2\n`
      ),
      writeFile(
        join(dir3, "mdflow.config.yaml"),
        `commands:\n  claude:\n    model: haiku-3\n`
      ),
    ]);

    // Load all configs in parallel
    const [config1, config2, config3] = await Promise.all([
      loadProjectConfig(dir1),
      loadProjectConfig(dir2),
      loadProjectConfig(dir3),
    ]);

    // Each config should have its own values
    expect(config1.commands?.claude?.model).toBe("opus-1");
    expect(config2.commands?.claude?.model).toBe("sonnet-2");
    expect(config3.commands?.claude?.model).toBe("haiku-3");
  });

  it("loads full configs in parallel without interference", async () => {
    // Create different project directories
    const [dir1, dir2] = await Promise.all([
      createTempDir("full1"),
      createTempDir("full2"),
    ]);

    // Write different configs
    await Promise.all([
      writeFile(
        join(dir1, "mdflow.config.yaml"),
        `commands:\n  myTool:\n    verbose: true\n`
      ),
      writeFile(
        join(dir2, "mdflow.config.yaml"),
        `commands:\n  myTool:\n    debug: true\n`
      ),
    ]);

    // Load full configs in parallel (includes built-in defaults)
    const [config1, config2] = await Promise.all([
      loadFullConfig(dir1),
      loadFullConfig(dir2),
    ]);

    // Each should have its own project settings
    expect(config1.commands?.myTool?.verbose).toBe(true);
    expect(config1.commands?.myTool?.debug).toBeUndefined();
    expect(config2.commands?.myTool?.debug).toBe(true);
    expect(config2.commands?.myTool?.verbose).toBeUndefined();

    // Both should have built-in defaults
    expect(config1.commands?.copilot?.$1).toBe("prompt");
    expect(config2.commands?.copilot?.$1).toBe("prompt");
  });

  it("multiple calls to loadGlobalConfig return independent instances", async () => {
    // Load global config multiple times in parallel
    const [config1, config2, config3] = await Promise.all([
      loadGlobalConfig(),
      loadGlobalConfig(),
      loadGlobalConfig(),
    ]);

    // All should have the same values (built-in defaults)
    expect(config1.commands?.copilot?.$1).toBe("prompt");
    expect(config2.commands?.copilot?.$1).toBe("prompt");
    expect(config3.commands?.copilot?.$1).toBe("prompt");

    // Modifying one should not affect others (they are independent copies)
    if (config1.commands) {
      config1.commands.copilot = { $1: "modified" };
    }

    expect(config2.commands?.copilot?.$1).toBe("prompt");
    expect(config3.commands?.copilot?.$1).toBe("prompt");
  });

  it("interleaved config operations don't interfere", async () => {
    const dir1 = await createTempDir("interleaved1");
    const dir2 = await createTempDir("interleaved2");

    await writeFile(
      join(dir1, "mdflow.config.yaml"),
      `commands:\n  test:\n    value: one\n`
    );
    await writeFile(
      join(dir2, "mdflow.config.yaml"),
      `commands:\n  test:\n    value: two\n`
    );

    // Interleave operations
    const configA1 = await loadProjectConfig(dir1);
    const configB1 = await loadProjectConfig(dir2);
    const configA2 = await loadProjectConfig(dir1);
    const configB2 = await loadProjectConfig(dir2);

    // All should return correct values regardless of order
    expect(configA1.commands?.test?.value).toBe("one");
    expect(configA2.commands?.test?.value).toBe("one");
    expect(configB1.commands?.test?.value).toBe("two");
    expect(configB2.commands?.test?.value).toBe("two");
  });

  it("RunContext instances are truly isolated", async () => {
    // Create contexts with different configurations
    const ctx1 = createTestRunContext({
      config: {
        commands: {
          claude: { model: "opus", temperature: 0.5 },
        },
      },
    });

    const ctx2 = createTestRunContext({
      config: {
        commands: {
          claude: { model: "sonnet", temperature: 0.9 },
        },
      },
    });

    // Verify isolation
    expect(ctx1.config.commands?.claude?.model).toBe("opus");
    expect(ctx1.config.commands?.claude?.temperature).toBe(0.5);
    expect(ctx2.config.commands?.claude?.model).toBe("sonnet");
    expect(ctx2.config.commands?.claude?.temperature).toBe(0.9);

    // Modify ctx1's config
    if (ctx1.config.commands?.claude) {
      ctx1.config.commands.claude.model = "modified";
    }

    // ctx2 should be unaffected
    expect(ctx2.config.commands?.claude?.model).toBe("sonnet");
  });

  it("getCommandDefaultsFromConfig is pure", () => {
    const config1 = {
      commands: {
        claude: { model: "opus" },
        gemini: { model: "pro" },
      },
    };

    const config2 = {
      commands: {
        claude: { model: "haiku" },
      },
    };

    // Same function call with different configs returns different results
    const defaults1 = getCommandDefaultsFromConfig(config1, "claude");
    const defaults2 = getCommandDefaultsFromConfig(config2, "claude");

    expect(defaults1?.model).toBe("opus");
    expect(defaults2?.model).toBe("haiku");

    // Multiple calls with same config return same values
    const defaults1Again = getCommandDefaultsFromConfig(config1, "claude");
    expect(defaults1Again?.model).toBe("opus");
  });

  it("simulates parallel test execution scenario", async () => {
    // This simulates what happens when multiple tests run in parallel
    const results: string[] = [];

    const test1 = async () => {
      const dir = await createTempDir("test1");
      await writeFile(
        join(dir, "mdflow.config.yaml"),
        `commands:\n  tool:\n    id: test1\n`
      );
      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      const config = await loadProjectConfig(dir);
      results.push(`test1:${config.commands?.tool?.id}`);
    };

    const test2 = async () => {
      const dir = await createTempDir("test2");
      await writeFile(
        join(dir, "mdflow.config.yaml"),
        `commands:\n  tool:\n    id: test2\n`
      );
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      const config = await loadProjectConfig(dir);
      results.push(`test2:${config.commands?.tool?.id}`);
    };

    const test3 = async () => {
      const dir = await createTempDir("test3");
      await writeFile(
        join(dir, "mdflow.config.yaml"),
        `commands:\n  tool:\n    id: test3\n`
      );
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      const config = await loadProjectConfig(dir);
      results.push(`test3:${config.commands?.tool?.id}`);
    };

    // Run all "tests" in parallel
    await Promise.all([test1(), test2(), test3()]);

    // Each test should have gotten its own config value
    expect(results).toContain("test1:test1");
    expect(results).toContain("test2:test2");
    expect(results).toContain("test3:test3");
  });

  it("config changes on disk are immediately visible", async () => {
    const dir = await createTempDir("immediate");

    // Write initial config
    await writeFile(
      join(dir, "mdflow.config.yaml"),
      `commands:\n  test:\n    version: 1\n`
    );

    // Load config
    const config1 = await loadProjectConfig(dir);
    expect(config1.commands?.test?.version).toBe(1);

    // Update config on disk
    await writeFile(
      join(dir, "mdflow.config.yaml"),
      `commands:\n  test:\n    version: 2\n`
    );

    // Load again - should see new value immediately (no stale cache)
    const config2 = await loadProjectConfig(dir);
    expect(config2.commands?.test?.version).toBe(2);

    // Original config object is unchanged (immutable)
    expect(config1.commands?.test?.version).toBe(1);
  });
});

describe("BUILTIN_DEFAULTS immutability", () => {
  it("BUILTIN_DEFAULTS are not modified by loadGlobalConfig", async () => {
    // Save original values
    const originalCopilot = BUILTIN_DEFAULTS.commands?.copilot?.$1;

    // Load global config multiple times
    await loadGlobalConfig();
    await loadGlobalConfig();

    // BUILTIN_DEFAULTS should be unchanged
    expect(BUILTIN_DEFAULTS.commands?.copilot?.$1).toBe(originalCopilot);
  });

  it("BUILTIN_DEFAULTS are not modified by createTestRunContext", () => {
    const originalCopilot = BUILTIN_DEFAULTS.commands?.copilot?.$1;

    // Create context and modify its config
    const ctx = createTestRunContext();
    if (ctx.config.commands?.copilot) {
      ctx.config.commands.copilot.$1 = "modified";
    }

    // BUILTIN_DEFAULTS should still have original value
    expect(BUILTIN_DEFAULTS.commands?.copilot?.$1).toBe(originalCopilot);
  });
});
