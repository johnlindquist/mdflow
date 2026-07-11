import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliRunner, createCliRunner, promptPositionals } from "./cli-runner";
import { createTestEnvironment, InMemorySystemEnvironment } from "./system-environment";
import { clearConfigCache } from "./config";
import type { RunContext, RunResult } from "./command";

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

    it("resolves extensionless names from the canonical flows roster", async () => {
      env.addFile("/test/flows/review.md", `---
description: review staged changes
engine: echo
---
Review the current change.`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "review", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("resolves extensionless roster names from a nested working directory", async () => {
      env.addFile("/test/flows/review.md", `---
description: review staged changes
engine: echo
---
Review the current change.`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test/packages/app/src",
      });

      const result = await runner.run(["node", "md", "review", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("prints a frontmatter-less file as a document instead of executing it (v3)", async () => {
      env.addFile("/test/nocommand.md", `---
---
Just some content`);

      const runner = new CliRunner({
        env,
        isStdinTTY: false,
        stdinContent: "", // Provide empty stdin to avoid "Premature close" error
      });

      const result = await runner.run(["node", "md", "/test/nocommand.md"]);
      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeUndefined();
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

  describe("interactive engine execution", () => {
    it("marks the command as interactive and disables capture for terminal UIs", async () => {
      env.addFile("/test/interactive.md", `---
description: Interactive Codex
engine: codex
---
Start an interactive session.`);

      let captured: RunContext | undefined;
      const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
        captured = ctx;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          output: "",
          process: null as unknown as ReturnType<typeof Bun.spawn>,
        };
      };
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        isStdoutTTY: true,
        cwd: "/test",
        runCommandFn,
      });

      const result = await runner.run([
        "node",
        "md",
        "/test/interactive.md",
        "--_interactive",
      ]);

      expect(result.exitCode).toBe(0);
      expect(captured?.interactive).toBe(true);
      expect(captured?.captureOutput).toBe(false);
      expect(captured?.captureStderr).toBe(false);
      expect(captured?.args).not.toContain("exec");
      expect(captured?.args).not.toContain("--ephemeral");
      expect(captured?.args).not.toContain("--ignore-user-config");
      expect(captured?.positionals).toEqual(["Start an interactive session."]);
    });

    it("opens a configured Codex TUI without submitting an empty prompt", async () => {
      env.addFile("/test/interactive-empty.md", `---
description: Interactive Codex without an initial task
engine: codex
_task: ""
_system-prompt: You are the configured specialist.
_append-system-prompt: Use only verified tool evidence.
---
{{ _task }}`);

      let captured: RunContext | undefined;
      const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
        captured = ctx;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          output: "",
          process: null as unknown as ReturnType<typeof Bun.spawn>,
        };
      };
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        isStdoutTTY: true,
        cwd: "/test",
        runCommandFn,
      });

      const result = await runner.run([
        "node",
        "md",
        "/test/interactive-empty.md",
        "--_interactive",
        "--_task",
        "",
      ]);

      expect(result.exitCode).toBe(0);
      expect(captured?.interactive).toBe(true);
      expect(captured?.positionals).toEqual([]);
      expect(captured?.args.some((arg) => arg.startsWith("model_instructions_file="))).toBe(true);
      expect(captured?.args).toContain("developer_instructions=Use only verified tool evidence.");
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
Hello {{ _missing_var }}`);

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

    it("treats an engine-less frontmatter-less file as a document, exit 0 (v3)", async () => {
      env.addFile("/test/no-cmd.md", `---
---
Content without command`);

      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/no-cmd.md"]);
      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeUndefined();
    });
  });

  describe("piping support (isStdoutTTY)", () => {
    it("accepts isStdoutTTY option", async () => {
      env.addFile("/test/pipe.echo.md", `---
---
Test piping`);

      // Simulates: md pipe.echo.md | other-command
      // When piping, stdout is not a TTY
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        isStdoutTTY: false, // stdout piped to another command
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/pipe.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("accepts both stdin and stdout as non-TTY (middle of pipeline)", async () => {
      env.addFile("/test/middle.echo.md", `---
---
Middle of pipeline`);

      // Simulates: first.md | md middle.echo.md | last.md
      const runner = new CliRunner({
        env,
        isStdinTTY: false, // stdin from pipe
        isStdoutTTY: false, // stdout to pipe
        stdinContent: "piped input",
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/middle.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });

    it("defaults isStdoutTTY when not provided", async () => {
      env.addFile("/test/default.echo.md", `---
---
Test default`);

      // When isStdoutTTY is not provided, it should default to process.stdout.isTTY
      const runner = new CliRunner({
        env,
        isStdinTTY: true,
        // isStdoutTTY not provided - should use process.stdout.isTTY
        cwd: "/test",
      });

      const result = await runner.run(["node", "md", "/test/default.echo.md", "--_dry-run"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("structured output", () => {
    it("saves extracted json when _output is configured and menu is disabled", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "mdflow-structured-output-"));
      const outputFile = join(tempDir, "result.json");

      try {
        env.addFile("/test/structured-output.echo.md", `---
_output:
  format: json
  save: result.json
---
{"status":"ok","count":1}`);

        const runner = new CliRunner({
          env,
          isStdinTTY: true,
          isStdoutTTY: true,
          cwd: tempDir,
        });

        const result = await runner.run([
          "node",
          "md",
          "/test/structured-output.echo.md",
          "--_no-menu",
        ]);

        expect(result.exitCode).toBe(0);
        const saved = JSON.parse(readFileSync(outputFile, "utf-8"));
        expect(saved).toEqual({ status: "ok", count: 1 });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("management subcommand --help contract", () => {
    // Every management command must print usage to stdout and exit 0 on
    // --help/-h without touching the filesystem, network, registry, or an
    // interactive prompt — even in a pipe. Agents probe capabilities this way.
    const HELP_COMMANDS = [
      "init",
      "create",
      "setup",
      "logs",
      "explain",
      "roster",
      "eval",
      "evolve",
      "feedback",
      "complain",
      "install",
      "remove",
      "list",
    ];

    for (const command of HELP_COMMANDS) {
      for (const flag of ["--help", "-h"]) {
        it(`'md ${command} ${flag}' exits 0 and prints usage`, async () => {
          const logSpy = spyOn(console, "log").mockImplementation(() => {});
          const errorSpy = spyOn(console, "error").mockImplementation(() => {});
          try {
            const runner = new CliRunner({
              env,
              isStdinTTY: false,
              isStdoutTTY: false,
            });
            const result = await runner.run(["node", "md", command, flag]);
            expect(result.exitCode).toBe(0);
            const stdout = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
            expect(stdout).toMatch(/Usage:/);
            const stderr = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
            expect(stderr).not.toContain("Agent failed");
            expect(stderr).not.toContain("ENOENT");
          } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
          }
        });
      }
    }
  });

  describe("non-TTY determinism", () => {
    it("setup without a TTY exits 1 with TTY_REQUIRED instead of prompting", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const runner = new CliRunner({
          env,
          isStdinTTY: false,
          isStdoutTTY: false,
        });
        const result = await runner.run(["node", "md", "setup"]);
        expect(result.exitCode).toBe(1);
        const stderr = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(stderr).toContain("TTY_REQUIRED");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("bare create without a TTY exits 1 with INTENT_REQUIRED instead of prompting", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const runner = new CliRunner({
          env,
          isStdinTTY: false,
          isStdoutTTY: false,
        });
        const result = await runner.run(["node", "md", "create"]);
        expect(result.exitCode).toBe(1);
        expect(result.errorMessage).toContain("INTENT_REQUIRED");
        expect(result.errorMessage).toContain("md create");
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("unknown token feedback", () => {
    it("suggests commands and the roster for a bare token that is not a flow", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const runner = new CliRunner({
          env,
          isStdinTTY: false,
          isStdoutTTY: false,
        });
        const result = await runner.run(["node", "md", "definitely-not-a-command"]);
        expect(result.exitCode).toBe(1);
        expect(result.errorMessage).toContain('No command or flow named "definitely-not-a-command"');
        expect(result.errorMessage).toContain("md roster --json");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("keeps the plain file-not-found message for explicit paths", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const runner = new CliRunner({
          env,
          isStdinTTY: false,
          isStdoutTTY: false,
        });
        const result = await runner.run(["node", "md", "/does/not/exist.claude.md"]);
        expect(result.exitCode).toBe(1);
        expect(result.errorMessage).toContain("File not found");
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describe("promptPositionals", () => {
  it("omits only blank interactive prompts", () => {
    expect(promptPositionals("", true)).toEqual([]);
    expect(promptPositionals("  \n", true)).toEqual([]);
    expect(promptPositionals("inspect the repo", true)).toEqual(["inspect the repo"]);
    expect(promptPositionals("", false)).toEqual([""]);
  });
});
