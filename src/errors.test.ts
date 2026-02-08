/**
 * Tests for typed error classes
 *
 * Verifies that:
 * - Error classes have correct inheritance
 * - Error codes are preserved
 * - Tests can assert on specific error types
 * - Error messages are preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  MdflowError,
  MarkdownAgentError,
  ConfigurationError,
  SecurityError,
  InputLimitError,
  FileNotFoundError,
  NetworkError,
  CommandError,
  CommandResolutionError,
  ImportError,
  TemplateError,
  HookError,
  UserCancelledError,
  EarlyExitRequest,
  getErrorMessage,
} from "./errors";
import { AgentRuntime, createRuntime } from "./runtime";
import { handleMaCommands, parseCliArgs } from "./cli";
import { clearConfigCache } from "./config";

describe("Error Classes", () => {
  describe("Base MarkdownAgentError", () => {
    it("has correct name property", () => {
      const error = new MarkdownAgentError("test error");
      expect(error.name).toBe("MarkdownAgentError");
    });

    it("preserves message", () => {
      const error = new MarkdownAgentError("test message");
      expect(error.message).toBe("test message");
    });

    it("defaults exit code to 1", () => {
      const error = new MarkdownAgentError("test");
      expect(error.code).toBe(1);
    });

    it("accepts custom exit code", () => {
      const error = new MarkdownAgentError("test", 42);
      expect(error.code).toBe(42);
    });

    it("is instance of Error", () => {
      const error = new MarkdownAgentError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("has stack trace", () => {
      const error = new MarkdownAgentError("test");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("MarkdownAgentError");
    });

    it("preserves explicit metadata options", () => {
      const cause = new Error("underlying");
      const error = new MarkdownAgentError("test", {
        exitCode: 9,
        errorCode: "HOOK_EXECUTION_FAILED",
        context: { phase: "hardening" },
        cause,
      });

      expect(error.code).toBe(9);
      expect(error.errorCode).toBe("HOOK_EXECUTION_FAILED");
      expect(error.context).toEqual({ phase: "hardening" });
      expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    });

    it("defaults context to empty object when omitted", () => {
      const error = new MarkdownAgentError("test", { exitCode: 2 });
      expect(error.context).toEqual({});
    });
  });

  describe("ConfigurationError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new ConfigurationError("config error");
      expect(error).toBeInstanceOf(MarkdownAgentError);
      expect(error).toBeInstanceOf(Error);
    });

    it("has correct name", () => {
      const error = new ConfigurationError("test");
      expect(error.name).toBe("ConfigurationError");
    });

    it("preserves message and code", () => {
      const error = new ConfigurationError("missing config", 2);
      expect(error.message).toBe("missing config");
      expect(error.code).toBe(2);
    });
  });

  describe("SecurityError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new SecurityError("untrusted domain");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new SecurityError("test");
      expect(error.name).toBe("SecurityError");
    });

    it("retains class default error code when numeric exit code is passed", () => {
      const error = new SecurityError("blocked", 7);
      expect(error.code).toBe(7);
      expect(error.errorCode).toBe("SECURITY_TRUST_FAILED");
    });
  });

  describe("InputLimitError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new InputLimitError("input too large");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new InputLimitError("test");
      expect(error.name).toBe("InputLimitError");
    });
  });

  describe("FileNotFoundError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new FileNotFoundError("file.md not found");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new FileNotFoundError("test");
      expect(error.name).toBe("FileNotFoundError");
    });
  });

  describe("NetworkError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new NetworkError("connection failed");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new NetworkError("test");
      expect(error.name).toBe("NetworkError");
    });
  });

  describe("CommandError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new CommandError("command not found");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new CommandError("test");
      expect(error.name).toBe("CommandError");
    });
  });

  describe("CommandResolutionError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new CommandResolutionError("cannot resolve command");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new CommandResolutionError("test");
      expect(error.name).toBe("CommandResolutionError");
    });
  });

  describe("ImportError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new ImportError("import failed");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new ImportError("test");
      expect(error.name).toBe("ImportError");
    });
  });

  describe("TemplateError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new TemplateError("missing variable");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new TemplateError("test");
      expect(error.name).toBe("TemplateError");
    });
  });

  describe("HookError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new HookError("hook failed");
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new HookError("test");
      expect(error.name).toBe("HookError");
    });
  });

  describe("UserCancelledError", () => {
    it("extends MarkdownAgentError", () => {
      const error = new UserCancelledError();
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new UserCancelledError();
      expect(error.name).toBe("UserCancelledError");
    });

    it("has default message", () => {
      const error = new UserCancelledError();
      expect(error.message).toBe("Operation cancelled by user");
    });

    it("accepts custom message", () => {
      const error = new UserCancelledError("user said no");
      expect(error.message).toBe("user said no");
    });
  });

  describe("EarlyExitRequest", () => {
    it("extends MarkdownAgentError", () => {
      const error = new EarlyExitRequest();
      expect(error).toBeInstanceOf(MarkdownAgentError);
    });

    it("has correct name", () => {
      const error = new EarlyExitRequest();
      expect(error.name).toBe("EarlyExitRequest");
    });

    it("defaults exit code to 0", () => {
      const error = new EarlyExitRequest();
      expect(error.code).toBe(0);
    });

    it("accepts custom exit code", () => {
      const error = new EarlyExitRequest("done", 0);
      expect(error.code).toBe(0);
    });
  });
});

describe("Error helpers", () => {
  it("test_getErrorMessage_returns_message_for_error_instances", () => {
    expect(getErrorMessage(new MdflowError("boom"))).toBe("boom");
  });

  it("test_getErrorMessage_stringifies_non_error_values", () => {
    expect(getErrorMessage({ reason: "bad-input" })).toBe("[object Object]");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage(123)).toBe("123");
  });
});

describe("Runtime Error Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "errors-test-"));
    clearConfigCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("FileNotFoundError", () => {
    it("is thrown when file does not exist", async () => {
      const runtime = createRuntime();
      const filePath = join(tempDir, "nonexistent.md");

      await expect(runtime.resolve(filePath)).rejects.toThrow(FileNotFoundError);
    });

    it("contains file path in message", async () => {
      const runtime = createRuntime();
      const filePath = join(tempDir, "missing-file.md");

      try {
        await runtime.resolve(filePath);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FileNotFoundError);
        expect((err as FileNotFoundError).message).toContain("missing-file.md");
      }
    });
  });

  describe("ImportError", () => {
    it("is thrown when import fails", async () => {
      const filePath = join(tempDir, "badimport.claude.md");
      await writeFile(filePath, `---\n---\n@./nonexistent.txt`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      await expect(runtime.buildContext(resolved)).rejects.toThrow(ImportError);
    });
  });

  describe("TemplateError", () => {
    it("is thrown for missing underscore-prefixed template variables", async () => {
      const filePath = join(tempDir, "missing-var.claude.md");
      await writeFile(filePath, `---\n---\nHello {{ _name }}!`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      await expect(runtime.processTemplate(context)).rejects.toThrow(TemplateError);
    });

    it("lists missing underscore-prefixed variables in message", async () => {
      const filePath = join(tempDir, "vars.claude.md");
      await writeFile(filePath, `---\n---\n{{ _foo }} and {{ _bar }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      try {
        await runtime.processTemplate(context);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateError);
        const message = (err as TemplateError).message;
        expect(message).toContain("_foo");
        expect(message).toContain("_bar");
      }
    });
  });

  describe("HookError", () => {
    it("is thrown when pre hook fails", async () => {
      const filePath = join(tempDir, "badhook.claude.md");
      await writeFile(filePath, `---
pre: exit 1
---
Body content`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      await expect(runtime.buildContext(resolved)).rejects.toThrow(HookError);
    });

    it("includes hook error message", async () => {
      const filePath = join(tempDir, "hookerr.claude.md");
      await writeFile(filePath, `---
pre: echo "hook error" >&2 && exit 1
---
Body content`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      try {
        await runtime.buildContext(resolved);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HookError);
        expect((err as HookError).message).toContain("hook error");
      }
    });
  });
});

describe("CLI Error Integration", () => {
  describe("EarlyExitRequest", () => {
    it("is thrown for --help flag", async () => {
      const args = parseCliArgs(["node", "script", "--help"]);
      await expect(handleMaCommands(args)).rejects.toThrow(EarlyExitRequest);
    });

    // Note: --logs and --setup are now subcommands (md logs, md setup)
    // handled in index.ts, not handleMaCommands

    it("has exit code 0 for --help", async () => {
      const args = parseCliArgs(["node", "script", "--help"]);
      try {
        await handleMaCommands(args);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EarlyExitRequest);
        expect((err as EarlyExitRequest).code).toBe(0);
      }
    });
  });
});

describe("Error Type Assertions in Tests", () => {
  it("can assert FileNotFoundError with rejects.toThrow", async () => {
    const runtime = createRuntime();
    await expect(runtime.resolve("/nonexistent/file.md"))
      .rejects.toThrow(FileNotFoundError);
  });

  it("can use try/catch with instanceof checks", async () => {
    const runtime = createRuntime();
    try {
      await runtime.resolve("/nonexistent/file.md");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FileNotFoundError);
      expect(err).toBeInstanceOf(MarkdownAgentError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("can check error code after catch", async () => {
    const runtime = createRuntime();
    try {
      await runtime.resolve("/nonexistent/file.md");
    } catch (err) {
      if (err instanceof MarkdownAgentError) {
        expect(err.code).toBe(1);
      }
    }
  });

  it("distinguishes between error types", async () => {
    let tempDir: string;
    tempDir = await mkdtemp(join(tmpdir(), "error-type-test-"));
    clearConfigCache();

    try {
      // FileNotFoundError
      const runtime1 = createRuntime();
      await expect(runtime1.resolve(join(tempDir, "missing.md")))
        .rejects.toThrow(FileNotFoundError);

      // ImportError
      const filePath = join(tempDir, "badimport.claude.md");
      await writeFile(filePath, `---\n---\n@./nonexistent.txt`);
      const runtime2 = createRuntime();
      const resolved = await runtime2.resolve(filePath);
      await expect(runtime2.buildContext(resolved))
        .rejects.toThrow(ImportError);

      // TemplateError
      const filePath2 = join(tempDir, "missingvar.claude.md");
      await writeFile(filePath2, `---\n---\nHello {{ _name }}`);
      const runtime3 = createRuntime();
      const resolved2 = await runtime3.resolve(filePath2);
      const context = await runtime3.buildContext(resolved2);
      await expect(runtime3.processTemplate(context))
        .rejects.toThrow(TemplateError);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
