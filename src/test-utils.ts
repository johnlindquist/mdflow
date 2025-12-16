/**
 * Shared test utilities to eliminate duplicate code across test files.
 *
 * This module provides:
 * - Flag extraction helpers for CLI arg parsing tests
 * - Process spawning helpers for integration tests
 * - Environment save/restore utilities
 * - Temp directory management
 * - Console spy utilities
 */

import { spawn } from "bun";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spyOn } from "bun:test";

// Project root for imports
export const PROJECT_ROOT = resolve(import.meta.dir, "..");

// CLI entry point
export const CLI_PATH = join(PROJECT_ROOT, "src/index.ts");

// ============================================================================
// Flag Extraction Utilities
// ============================================================================

/**
 * Extract a flag from CLI args array (mutates the array).
 * Simulates how md consumes internal flags like --_dry-run, --_edit.
 *
 * @example
 * const args = ["--model", "opus", "--_dry-run"];
 * const isDryRun = extractFlag(args, "--_dry-run");
 * // isDryRun = true, args = ["--model", "opus"]
 */
export function extractFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index !== -1) {
    args.splice(index, 1);
    return true;
  }
  return false;
}

/**
 * Test flag extraction behavior at different positions.
 * Returns test cases for common flag extraction scenarios.
 */
export function createFlagExtractionTests(flagName: string) {
  return {
    atStart: {
      input: [flagName, "--model", "opus"],
      expected: { flagFound: true, remaining: ["--model", "opus"] },
    },
    atEnd: {
      input: ["--model", "opus", "--verbose", flagName],
      expected: { flagFound: true, remaining: ["--model", "opus", "--verbose"] },
    },
    inMiddle: {
      input: ["--model", "opus", flagName, "--verbose"],
      expected: { flagFound: true, remaining: ["--model", "opus", "--verbose"] },
    },
    notPresent: {
      input: ["--model", "opus", "--verbose"],
      expected: { flagFound: false, remaining: ["--model", "opus", "--verbose"] },
    },
  };
}

// ============================================================================
// Process Spawning Utilities
// ============================================================================

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

/**
 * Spawn the md CLI with given arguments and return captured output.
 *
 * @example
 * const result = await spawnMd(["test.md", "--_dry-run"]);
 * expect(result.exitCode).toBe(0);
 * expect(result.stdout).toContain("DRY RUN");
 */
export async function spawnMd(
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  const { cwd = process.cwd(), env = {}, stdin } = options;

  const cmd = stdin
    ? ["bash", "-c", `echo "${stdin.replace(/"/g, '\\"')}" | bun run ${CLI_PATH} ${args.join(" ")}`]
    : ["bun", "run", CLI_PATH, ...args];

  const proc = spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

/**
 * Spawn md with piped input using bash pipe syntax.
 * More reliable for complex stdin scenarios.
 */
export async function spawnMdWithPipe(
  agentPath: string,
  pipeInput: string,
  extraArgs: string[] = [],
  options: { env?: Record<string, string> } = {}
): Promise<SpawnResult> {
  const args = [agentPath, ...extraArgs].join(" ");
  const cmd = `echo "${pipeInput.replace(/"/g, '\\"')}" | bun run ${CLI_PATH} ${args}`;

  const proc = spawn({
    cmd: ["bash", "-c", cmd],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

/**
 * Spawn a test script that imports project modules.
 * Useful for testing module behavior in isolation.
 */
export async function spawnTestScript(
  script: string,
  tempDir: string
): Promise<SpawnResult> {
  const scriptPath = join(tempDir, `test-script-${Date.now()}.ts`);
  await writeFile(scriptPath, script);

  const proc = spawn({
    cmd: ["bun", "run", scriptPath],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

// ============================================================================
// Temp Directory Utilities
// ============================================================================

/**
 * Create a temporary test directory with automatic cleanup.
 *
 * @example
 * const { tempDir, cleanup } = await createTempDir("my-test-");
 * // Use tempDir...
 * await cleanup();
 */
export async function createTempDir(prefix: string = "md-test-"): Promise<{
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  return {
    tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

/**
 * Create a test agent file in a temp directory.
 */
export async function createTestAgent(
  tempDir: string,
  filename: string,
  content: string
): Promise<string> {
  const filePath = join(tempDir, filename);
  await writeFile(filePath, content);
  return filePath;
}

/**
 * Create multiple test files at once.
 */
export async function createTestFiles(
  tempDir: string,
  files: Record<string, string>
): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = await createTestAgent(tempDir, name, content);
  }
  return paths;
}

// ============================================================================
// Environment Utilities
// ============================================================================

export interface EnvSnapshot {
  restore: () => void;
}

/**
 * Save current environment variables and return a restore function.
 *
 * @example
 * const { restore } = saveEnv(["EDITOR", "VISUAL"]);
 * process.env.EDITOR = "mock-editor";
 * // ... test ...
 * restore(); // Restores original values
 */
export function saveEnv(keys: string[]): EnvSnapshot {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }

  return {
    restore: () => {
      for (const key of keys) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

/**
 * Temporarily set environment variables for a test.
 * Returns restore function.
 */
export function withEnv(
  vars: Record<string, string | undefined>
): EnvSnapshot {
  const keys = Object.keys(vars);
  const snapshot = saveEnv(keys);

  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  return snapshot;
}

/**
 * Save and restore process.cwd() and PATH.
 * Used by tests that change working directory.
 */
export function saveCwdAndPath(): {
  originalCwd: string;
  originalPath: string;
  restore: () => void;
} {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH || "";

  return {
    originalCwd,
    originalPath,
    restore: () => {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    },
  };
}

// ============================================================================
// Console Spy Utilities
// ============================================================================

export interface ConsoleSpy {
  output: string[];
  restore: () => void;
  clear: () => void;
  hasMessage: (substring: string) => boolean;
  getMessages: () => string[];
}

/**
 * Create a spy for console.error that captures all output.
 *
 * @example
 * const spy = createStderrSpy();
 * console.error("test message");
 * expect(spy.hasMessage("test")).toBe(true);
 * spy.restore();
 */
export function createStderrSpy(): ConsoleSpy {
  const output: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });

  return {
    output,
    restore: () => spy.mockRestore(),
    clear: () => {
      output.length = 0;
    },
    hasMessage: (substring: string) => output.some((line) => line.includes(substring)),
    getMessages: () => [...output],
  };
}

/**
 * Create a spy for console.log.
 */
export function createStdoutSpy(): ConsoleSpy {
  const output: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });

  return {
    output,
    restore: () => spy.mockRestore(),
    clear: () => {
      output.length = 0;
    },
    hasMessage: (substring: string) => output.some((line) => line.includes(substring)),
    getMessages: () => [...output],
  };
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert that stdout doesn't contain status/logging messages
 * (they should go to stderr).
 */
export function assertCleanStdout(stdout: string): void {
  const statusPatterns = ["Fetching:", "Saved to:", "Resolving:", "[imports]"];
  for (const pattern of statusPatterns) {
    if (stdout.includes(pattern)) {
      throw new Error(`stdout should not contain status message: "${pattern}"`);
    }
  }
}

/**
 * Assert process exited successfully.
 */
export function assertSuccess(result: SpawnResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `Expected exit code 0, got ${result.exitCode}\nstderr: ${result.stderr}`
    );
  }
}

/**
 * Assert process failed with specific exit code.
 */
export function assertFailure(result: SpawnResult, expectedCode?: number): void {
  if (result.exitCode === 0) {
    throw new Error(`Expected non-zero exit code, got 0\nstdout: ${result.stdout}`);
  }
  if (expectedCode !== undefined && result.exitCode !== expectedCode) {
    throw new Error(
      `Expected exit code ${expectedCode}, got ${result.exitCode}`
    );
  }
}
