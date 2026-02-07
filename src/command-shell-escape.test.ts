import { describe, expect, spyOn, test } from "bun:test";
import { escapeShellArg, runCommand } from "./command";

describe("command shell safety", () => {
  test("test_escapeShellArg_does_display_safe_quoting", () => {
    expect(escapeShellArg("")).toBe(process.platform === "win32" ? "\"\"" : "''");

    if (process.platform === "win32") {
      expect(escapeShellArg("a&b\"c")).toBe("\"a^&b\"\"c\"");
      return;
    }

    expect(escapeShellArg("abc'def")).toBe("'abc'\"'\"'def'");
  });

  test("test_runCommand_passes_arguments_as_spawn_argv_array", async () => {
    const spawnSpy = spyOn(Bun, "spawn");

    try {
      const injectedArg = "safe;$(whoami)";
      const result = await runCommand({
        command: "echo",
        args: [injectedArg],
        positionals: [],
        positionalMappings: new Map(),
        captureOutput: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(injectedArg);

      const spawnCall = spawnSpy.mock.calls.at(-1);
      expect(spawnCall).toBeDefined();

      const spawnArgv = spawnCall?.[0] as string[];
      expect(Array.isArray(spawnArgv)).toBe(true);
      expect(spawnArgv[0]).toBe("echo");
      expect(spawnArgv[1]).toBe(injectedArg);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
