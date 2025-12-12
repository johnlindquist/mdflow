import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { CliRunner, createCliRunner } from "./cli-runner";
import { createTestEnvironment, InMemorySystemEnvironment } from "./system-environment";
import { clearConfigCache } from "./config";

/**
 * CliRunner Tests
 *
 * These tests verify the orchestration logic of CliRunner using
 * the InMemorySystemEnvironment for file system operations.
 *
 * Note: Command execution (runCommand) still uses Bun.spawn directly,
 * so tests that would execute commands are limited to checking:
 * - File reading via SystemEnvironment
 * - Error handling for missing files
 * - Dry-run mode (no command execution)
 * - Template variable processing
 * - CLI flag parsing
 */

describe("CliRunner", () => {
  let env: InMemorySystemEnvironment;

  beforeEach(() => {
    env = createTestEnvironment();
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
  });

  describe("subcommands", () => {
    it("handles 'logs' subcommand", async () => {
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
      });

      const result = await runner.run(["node", "md", "logs"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("file operations", () => {
    it("returns error for non-existent file", async () => {
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
      });

      const result = await runner.run(["node", "md", "/nonexistent/file.claude.md"]);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("File not found");
    });

    it("reads file content from SystemEnvironment", async () => {
      env.addFile("/test/read.echo.md", `---
---
Test content from file`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      // This will fail on command execution (echo not in PATH in test),
      // but the file read happens first - we verify the file was read
      const result = await runner.run(["node", "md", "/test/read.echo.md", "--_dry-run"]);
      // Dry run should succeed, proving file was read
      expect(result.exitCode).toBe(0);
    });

    it("throws error for missing command in filename", async () => {
      env.addFile("/test/nocommand.md", `---
---
Just some content`);

      const runner = new CliRunner({
        env,
        isStdinTTY: false,
        stdinContent: "", // Provide empty stdin to avoid "Premature close" error
      });

      const result = await runner.run(["node", "md", "/test/nocommand.md"]);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("No command specified");
    });
  });

  describe("--_dry-run flag", () => {
    it("exits cleanly without executing command", async () => {
      env.addFile("/test/dryrun.echo.md", `---
model: opus
---
Test prompt for dry run`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/dryrun.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("processes frontmatter in dry-run mode", async () => {
      env.addFile("/test/dryrun-fm.echo.md", `---
verbose: true
model: gpt-4
custom-flag: value
---
Test with frontmatter`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/dryrun-fm.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("processes array values in frontmatter", async () => {
      env.addFile("/test/dryrun-array.echo.md", `---
add-dir:
  - ./src
  - ./tests
---
Test with array`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/dryrun-array.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("--_command flag", () => {
    it("accepts --_command flag with dry-run", async () => {
      env.addFile("/test/generic.md", `---
---
Test prompt`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/generic.md", "--_command", "customcmd", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("stdin handling", () => {
    it("includes stdin content in prompt with dry-run", async () => {
      env.addFile("/test/stdin.echo.md", `---
---
Process this input`);

      const runner = new CliRunner({
        env,
        isStdinTTY: false,
        stdinContent: "piped input content",
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/stdin.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("template variables", () => {
    it("processes _varname frontmatter for template vars", async () => {
      env.addFile("/test/template.echo.md", `---
_name: ""
---
Hello {{ _name }}`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      // Provide the template variable via CLI flag, verify with dry-run
      const result = await runner.run(["node", "md", "/test/template.echo.md", "--_name", "World", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("throws error for missing template vars in non-interactive mode", async () => {
      env.addFile("/test/missing.echo.md", `---
---
Hello {{ missing_var }}`);

      const runner = new CliRunner({
        env,
        isStdinTTY: false,
        stdinContent: "", // Provide empty stdin to avoid "Premature close" error
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/missing.echo.md"]);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("Missing template variables");
    });

    it("handles _varname fields from frontmatter", async () => {
      env.addFile("/test/namedvar.echo.md", `---
_feature_name: default-feature
---
Implement {{ _feature_name }}`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      // Use default value with dry-run
      const result = await runner.run(["node", "md", "/test/namedvar.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("overrides _varname with CLI flag", async () => {
      env.addFile("/test/override.echo.md", `---
_feature_name: default
---
Implement {{ _feature_name }}`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      // Override with CLI flag
      const result = await runner.run([
        "node", "md", "/test/override.echo.md",
        "--_feature_name", "custom-value",
        "--_dry-run"
      ]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("interactive mode detection", () => {
    it("detects .i. marker in filename with dry-run", async () => {
      env.addFile("/test/task.i.echo.md", `---
---
Interactive task`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/task.i.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("handles --_interactive flag with dry-run", async () => {
      env.addFile("/test/task.echo.md", `---
---
Made interactive via flag`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run([
        "node", "md", "/test/task.echo.md",
        "--_interactive",
        "--_dry-run"
      ]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("createCliRunner helper", () => {
    it("creates a CliRunner with given environment", async () => {
      env.addFile("/test/helper.echo.md", `---
---
Test content`);

      const runner = createCliRunner(env, {
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/helper.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("returns structured error for file not found", async () => {
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
      });

      const result = await runner.run(["node", "md", "/does/not/exist.claude.md"]);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBeDefined();
      expect(result.errorMessage).toContain("File not found");
    });

    it("returns structured error for command resolution failure", async () => {
      env.addFile("/test/no-cmd.md", `---
---
Content without command`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/no-cmd.md"]);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("No command specified");
    });
  });
});
