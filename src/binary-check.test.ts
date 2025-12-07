import { expect, test, describe, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { runCommand, type RunContext } from "./command";

describe("runCommand binary check", () => {
  // Store original console.error
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let errorMessages: string[] = [];

  beforeEach(() => {
    errorMessages = [];
    consoleErrorSpy = spyOn(console, "error").mockImplementation((msg: string) => {
      errorMessages.push(msg);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test("returns exit code 127 when command not found", async () => {
    const ctx: RunContext = {
      command: "nonexistent-command-xyz-123",
      args: [],
      positionals: [],
      positionalMappings: new Map(),
      captureOutput: false,
    };

    const result = await runCommand(ctx);

    expect(result.exitCode).toBe(127);
    expect(result.output).toBe("");
  });

  test("prints helpful error message when command not found", async () => {
    const ctx: RunContext = {
      command: "fake-missing-binary",
      args: [],
      positionals: [],
      positionalMappings: new Map(),
      captureOutput: false,
    };

    await runCommand(ctx);

    expect(errorMessages.length).toBe(3);
    expect(errorMessages[0]).toContain("Command not found: 'fake-missing-binary'");
    expect(errorMessages[1]).toContain("fake-missing-binary");
    expect(errorMessages[1]).toContain("installed");
    expect(errorMessages[2]).toContain("install");
  });

  test("executes successfully when command exists", async () => {
    const ctx: RunContext = {
      command: "echo",
      args: ["hello"],
      positionals: [],
      positionalMappings: new Map(),
      captureOutput: true,
    };

    const result = await runCommand(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("hello");
  });

  test("passes positionals correctly when command exists", async () => {
    const ctx: RunContext = {
      command: "echo",
      args: [],
      positionals: ["world"],
      positionalMappings: new Map(),
      captureOutput: true,
    };

    const result = await runCommand(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("world");
  });

  test("maps positionals to flags when command exists", async () => {
    const ctx: RunContext = {
      command: "echo",
      args: [],
      positionals: ["test-value"],
      positionalMappings: new Map([[1, "n"]]),  // echo -n suppresses newline
      captureOutput: true,
    };

    const result = await runCommand(ctx);

    // echo -n test-value should output without newline
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("test-value");
  });

  test("handles environment variables when command exists", async () => {
    const ctx: RunContext = {
      command: "sh",
      args: ["-c", "echo $TEST_VAR"],
      positionals: [],
      positionalMappings: new Map(),
      captureOutput: true,
      env: { TEST_VAR: "hello-env" },
    };

    const result = await runCommand(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("hello-env");
  });
});
