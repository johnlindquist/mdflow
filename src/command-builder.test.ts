/**
 * Tests for CommandBuilder - Pure command construction functions
 *
 * These tests verify argument mapping without process spawning.
 * All tests use simple object comparisons - no mocks needed.
 */

import { describe, it, expect } from "bun:test";
import {
  buildArgsFromFrontmatter,
  extractPositionalMappings,
  extractEnvVars,
  applyPositionalArgs,
  buildCommand,
  buildCommandBase,
  extractSubcommands,
  getSpawnArgs,
  formatCommandForDisplay,
  type CommandSpec,
} from "./command-builder";
import type { AgentFrontmatter } from "./types";
import type { GlobalConfig } from "./config";

describe("buildArgsFromFrontmatter", () => {
  describe("string values", () => {
    it("converts string values to --flag value", () => {
      const result = buildArgsFromFrontmatter({ model: "opus" }, new Set());
      expect(result).toEqual(["--model", "opus"]);
    });

    it("handles multiple string values", () => {
      const result = buildArgsFromFrontmatter(
        { model: "opus", output: "json" },
        new Set()
      );
      expect(result).toContain("--model");
      expect(result).toContain("opus");
      expect(result).toContain("--output");
      expect(result).toContain("json");
    });

    it("converts numeric values to strings", () => {
      const result = buildArgsFromFrontmatter({ timeout: 30 }, new Set());
      expect(result).toEqual(["--timeout", "30"]);
    });
  });

  describe("boolean flags", () => {
    it("includes flag for boolean true", () => {
      const result = buildArgsFromFrontmatter({ verbose: true }, new Set());
      expect(result).toEqual(["--verbose"]);
    });

    it("omits flag for boolean false", () => {
      const result = buildArgsFromFrontmatter({ verbose: false }, new Set());
      expect(result).toEqual([]);
    });

    it("handles multiple boolean flags", () => {
      const result = buildArgsFromFrontmatter(
        { verbose: true, debug: false, quiet: true },
        new Set()
      );
      expect(result).toContain("--verbose");
      expect(result).toContain("--quiet");
      expect(result).not.toContain("--debug");
    });

    it("handles dangerously-skip-permissions style flags", () => {
      const result = buildArgsFromFrontmatter(
        { "dangerously-skip-permissions": true },
        new Set()
      );
      expect(result).toEqual(["--dangerously-skip-permissions"]);
    });
  });

  describe("array values", () => {
    it("repeats flag for each array element", () => {
      const result = buildArgsFromFrontmatter(
        { "add-dir": ["./src", "./tests"] },
        new Set()
      );
      expect(result).toEqual([
        "--add-dir", "./src",
        "--add-dir", "./tests",
      ]);
    });

    it("handles single-element arrays", () => {
      const result = buildArgsFromFrontmatter(
        { include: ["*.ts"] },
        new Set()
      );
      expect(result).toEqual(["--include", "*.ts"]);
    });

    it("handles empty arrays", () => {
      const result = buildArgsFromFrontmatter({ include: [] }, new Set());
      expect(result).toEqual([]);
    });

    it("converts array elements to strings", () => {
      const result = buildArgsFromFrontmatter({ ports: [3000, 8080] }, new Set());
      expect(result).toEqual(["--ports", "3000", "--ports", "8080"]);
    });
  });

  describe("single-character flags", () => {
    it("uses single dash for single-char flags", () => {
      const result = buildArgsFromFrontmatter({ p: true }, new Set());
      expect(result).toEqual(["-p"]);
    });

    it("handles multiple single-char flags", () => {
      const result = buildArgsFromFrontmatter(
        { p: true, c: true, v: false },
        new Set()
      );
      expect(result).toContain("-p");
      expect(result).toContain("-c");
      expect(result).not.toContain("-v");
    });

    it("handles single-char flags with values", () => {
      const result = buildArgsFromFrontmatter({ n: 5 }, new Set());
      expect(result).toEqual(["-n", "5"]);
    });
  });

  describe("system keys (skipped)", () => {
    it("skips args key", () => {
      const result = buildArgsFromFrontmatter(
        { args: ["message", "branch"], model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--args");
    });

    it("skips pre/before lifecycle hooks", () => {
      const result = buildArgsFromFrontmatter(
        { pre: "npm test", before: "lint", model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--pre");
      expect(result).not.toContain("--before");
    });

    it("skips post/after lifecycle hooks", () => {
      const result = buildArgsFromFrontmatter(
        { post: "cleanup", after: "notify", model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--post");
      expect(result).not.toContain("--after");
    });

    it("skips context_window", () => {
      const result = buildArgsFromFrontmatter(
        { context_window: 128000, model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--context_window");
    });

    it("skips _interactive key", () => {
      const result = buildArgsFromFrontmatter(
        { _interactive: true, model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--_interactive");
    });

    it("skips _subcommand key", () => {
      const result = buildArgsFromFrontmatter(
        { _subcommand: "exec", model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--_subcommand");
      expect(result).not.toContain("exec");
    });

    it("skips _cwd key", () => {
      const result = buildArgsFromFrontmatter(
        { _cwd: "/some/path", model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--_cwd");
    });

    it("skips all underscore-prefixed keys", () => {
      const result = buildArgsFromFrontmatter(
        { _custom: "value", _another: true, model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--_custom");
      expect(result).not.toContain("--_another");
    });
  });

  describe("positional mappings (skipped)", () => {
    it("skips $1 positional mapping", () => {
      const result = buildArgsFromFrontmatter(
        { $1: "prompt", model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
      expect(result).not.toContain("--$1");
      expect(result).not.toContain("prompt");
    });

    it("skips multiple positional mappings", () => {
      const result = buildArgsFromFrontmatter(
        { $1: "prompt", $2: "model", verbose: true },
        new Set()
      );
      expect(result).toEqual(["--verbose"]);
    });

    it("skips named template variable fields ($varname)", () => {
      const result = buildArgsFromFrontmatter(
        { $feature_name: "default", model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
    });
  });

  describe("template variables (skipped)", () => {
    it("skips keys that are template variables", () => {
      const result = buildArgsFromFrontmatter(
        { target: "src/main.ts", model: "opus" },
        new Set(["target"])
      );
      expect(result).toEqual(["--model", "opus"]);
    });

    it("skips multiple template variables", () => {
      const result = buildArgsFromFrontmatter(
        { target: "src/main.ts", message: "hello", model: "opus" },
        new Set(["target", "message"])
      );
      expect(result).toEqual(["--model", "opus"]);
    });
  });

  describe("env key handling", () => {
    it("skips env when it is an object (process.env config)", () => {
      const result = buildArgsFromFrontmatter(
        { env: { HOST: "localhost" }, model: "opus" },
        new Set()
      );
      expect(result).toEqual(["--model", "opus"]);
    });

    it("passes env as --env flags when it is an array", () => {
      const result = buildArgsFromFrontmatter(
        { env: ["HOST=localhost", "PORT=3000"] },
        new Set()
      );
      expect(result).toEqual([
        "--env", "HOST=localhost",
        "--env", "PORT=3000",
      ]);
    });

    it("passes env as --env flag when it is a string", () => {
      const result = buildArgsFromFrontmatter(
        { env: "HOST=localhost" },
        new Set()
      );
      expect(result).toEqual(["--env", "HOST=localhost"]);
    });
  });

  describe("null/undefined handling", () => {
    it("skips undefined values", () => {
      const result = buildArgsFromFrontmatter(
        { model: undefined, verbose: true },
        new Set()
      );
      expect(result).toEqual(["--verbose"]);
    });

    it("skips null values", () => {
      const result = buildArgsFromFrontmatter(
        { model: null, verbose: true },
        new Set()
      );
      expect(result).toEqual(["--verbose"]);
    });
  });

  describe("flags that already have dashes", () => {
    it("preserves flags that already start with --", () => {
      const result = buildArgsFromFrontmatter(
        { "--custom-flag": "value" },
        new Set()
      );
      expect(result).toEqual(["--custom-flag", "value"]);
    });

    it("preserves flags that already start with -", () => {
      const result = buildArgsFromFrontmatter(
        { "-x": true },
        new Set()
      );
      expect(result).toEqual(["-x"]);
    });
  });
});

describe("extractPositionalMappings", () => {
  it("extracts $1 mapping", () => {
    const mappings = extractPositionalMappings({ $1: "prompt" });
    expect(mappings.get(1)).toBe("prompt");
    expect(mappings.size).toBe(1);
  });

  it("extracts multiple mappings", () => {
    const mappings = extractPositionalMappings({
      $1: "prompt",
      $2: "model",
      $3: "output",
    });
    expect(mappings.get(1)).toBe("prompt");
    expect(mappings.get(2)).toBe("model");
    expect(mappings.get(3)).toBe("output");
    expect(mappings.size).toBe(3);
  });

  it("ignores non-positional keys", () => {
    const mappings = extractPositionalMappings({
      $1: "prompt",
      model: "opus",
      verbose: true,
    });
    expect(mappings.size).toBe(1);
    expect(mappings.get(1)).toBe("prompt");
  });

  it("ignores named variable fields ($varname)", () => {
    const mappings = extractPositionalMappings({
      $1: "prompt",
      $feature_name: "default",
    });
    expect(mappings.size).toBe(1);
    expect(mappings.get(1)).toBe("prompt");
  });

  it("returns empty map when no positional mappings", () => {
    const mappings = extractPositionalMappings({
      model: "opus",
      verbose: true,
    });
    expect(mappings.size).toBe(0);
  });

  it("ignores non-string positional values", () => {
    const mappings = extractPositionalMappings({
      $1: 123 as unknown as string,
      $2: "model",
    });
    expect(mappings.size).toBe(1);
    expect(mappings.get(2)).toBe("model");
  });
});

describe("extractEnvVars", () => {
  it("extracts object form of env", () => {
    const env = extractEnvVars({
      env: { HOST: "localhost", PORT: "3000" },
    });
    expect(env).toEqual({ HOST: "localhost", PORT: "3000" });
  });

  it("returns empty object for array form", () => {
    const env = extractEnvVars({
      env: ["HOST=localhost"],
    });
    expect(env).toEqual({});
  });

  it("returns empty object for string form", () => {
    const env = extractEnvVars({
      env: "HOST=localhost",
    });
    expect(env).toEqual({});
  });

  it("returns empty object when no env", () => {
    const env = extractEnvVars({
      model: "opus",
    });
    expect(env).toEqual({});
  });

  it("handles empty env object", () => {
    const env = extractEnvVars({ env: {} });
    expect(env).toEqual({});
  });
});

describe("applyPositionalArgs", () => {
  it("applies unmapped positional as raw argument", () => {
    const result = applyPositionalArgs(
      ["--model", "opus"],
      ["Hello world"],
      new Map()
    );
    expect(result).toEqual(["--model", "opus", "Hello world"]);
  });

  it("maps $1 to flag", () => {
    const mappings = new Map([[1, "prompt"]]);
    const result = applyPositionalArgs(
      ["--model", "opus"],
      ["Hello world"],
      mappings
    );
    expect(result).toEqual(["--model", "opus", "--prompt", "Hello world"]);
  });

  it("maps multiple positionals", () => {
    const mappings = new Map([
      [1, "prompt"],
      [2, "context"],
    ]);
    const result = applyPositionalArgs(
      ["--model", "opus"],
      ["Hello", "world"],
      mappings
    );
    expect(result).toEqual([
      "--model", "opus",
      "--prompt", "Hello",
      "--context", "world",
    ]);
  });

  it("handles mixed mapped and unmapped positionals", () => {
    const mappings = new Map([[1, "prompt"]]);
    const result = applyPositionalArgs(
      ["--model", "opus"],
      ["Hello", "extra"],
      mappings
    );
    expect(result).toEqual([
      "--model", "opus",
      "--prompt", "Hello",
      "extra",
    ]);
  });

  it("handles single-char positional flag mappings", () => {
    const mappings = new Map([[1, "p"]]);
    const result = applyPositionalArgs([], ["prompt text"], mappings);
    expect(result).toEqual(["-p", "prompt text"]);
  });

  it("handles empty positionals", () => {
    const result = applyPositionalArgs(
      ["--model", "opus"],
      [],
      new Map()
    );
    expect(result).toEqual(["--model", "opus"]);
  });

  it("handles empty base args", () => {
    const mappings = new Map([[1, "prompt"]]);
    const result = applyPositionalArgs([], ["Hello"], mappings);
    expect(result).toEqual(["--prompt", "Hello"]);
  });
});

describe("buildCommand", () => {
  const emptyConfig: GlobalConfig = {};
  const cwd = "/test/dir";

  it("builds basic command spec", () => {
    const result = buildCommand(
      "claude",
      { model: "opus" },
      "Hello world",
      [],
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.executable).toBe("claude");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("opus");
    expect(result.positionals).toContain("Hello world");
    expect(result.subcommands).toEqual([]);
    expect(result.cwd).toBe(cwd);
    expect(result.env).toEqual({});

    // getSpawnArgs should combine them correctly
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).toContain("--model");
    expect(spawnArgs).toContain("opus");
    expect(spawnArgs).toContain("Hello world");
  });

  it("applies $1 mapping to body", () => {
    const result = buildCommand(
      "copilot",
      { $1: "prompt", model: "gpt-4" },
      "Hello world",
      [],
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.args).toContain("--model");
    expect(result.args).toContain("gpt-4");
    // Body should be passed as --prompt in positionals
    expect(result.positionals).toContain("--prompt");
    expect(result.positionals).toContain("Hello world");
    const promptIndex = result.positionals.indexOf("--prompt");
    expect(result.positionals[promptIndex + 1]).toBe("Hello world");
  });

  it("includes additional positional args", () => {
    const result = buildCommand(
      "claude",
      {},
      "body",
      ["extra1", "extra2"],
      new Set(),
      emptyConfig,
      cwd
    );

    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).toContain("body");
    expect(spawnArgs).toContain("extra1");
    expect(spawnArgs).toContain("extra2");
  });

  it("maps additional positional args with $2, $3", () => {
    const result = buildCommand(
      "claude",
      { $1: "prompt", $2: "context" },
      "body",
      ["extra context"],
      new Set(),
      emptyConfig,
      cwd
    );

    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).toContain("--prompt");
    expect(spawnArgs).toContain("body");
    expect(spawnArgs).toContain("--context");
    expect(spawnArgs).toContain("extra context");
  });

  it("extracts env vars from frontmatter", () => {
    const result = buildCommand(
      "claude",
      { env: { API_KEY: "secret", DEBUG: "true" } },
      "body",
      [],
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.env).toEqual({ API_KEY: "secret", DEBUG: "true" });
  });

  it("applies command defaults from config", () => {
    const config: GlobalConfig = {
      commands: {
        copilot: {
          $1: "prompt",
        },
      },
    };

    const result = buildCommand(
      "copilot",
      {},
      "Hello",
      [],
      new Set(),
      config,
      cwd
    );

    // Default $1: prompt should be applied
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).toContain("--prompt");
    expect(spawnArgs).toContain("Hello");
  });

  it("frontmatter overrides config defaults", () => {
    const config: GlobalConfig = {
      commands: {
        claude: {
          model: "sonnet",
        },
      },
    };

    const result = buildCommand(
      "claude",
      { model: "opus" },
      "body",
      [],
      new Set(),
      config,
      cwd
    );

    expect(result.args).toContain("--model");
    expect(result.args).toContain("opus");
    expect(result.args).not.toContain("sonnet");
  });

  it("skips template variables in args", () => {
    const result = buildCommand(
      "claude",
      { target: "src/main.ts", model: "opus" },
      "Review {{ target }}",
      [],
      new Set(["target"]),
      emptyConfig,
      cwd
    );

    expect(result.args).toContain("--model");
    expect(result.args).toContain("opus");
    expect(result.args).not.toContain("--target");
    expect(result.args).not.toContain("src/main.ts");
  });

  it("handles complex frontmatter", () => {
    const frontmatter: AgentFrontmatter = {
      model: "opus",
      verbose: true,
      debug: false,
      "add-dir": ["./src", "./tests"],
      $1: "prompt",
      env: { NODE_ENV: "test" },
      args: ["message"],
    };

    const result = buildCommand(
      "claude",
      frontmatter,
      "Do the thing",
      [],
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.executable).toBe("claude");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("opus");
    expect(result.args).toContain("--verbose");
    expect(result.args).not.toContain("--debug");
    expect(result.args).toContain("--add-dir");
    expect(result.args).toContain("./src");
    expect(result.args).toContain("./tests");

    // Positional with mapping goes to positionals
    expect(result.positionals).toContain("--prompt");
    expect(result.positionals).toContain("Do the thing");

    expect(result.env).toEqual({ NODE_ENV: "test" });
    // System keys should not appear
    expect(result.args).not.toContain("--args");
    expect(result.args).not.toContain("--$1");
  });

  it("uses process.cwd() as default cwd", () => {
    const result = buildCommand(
      "claude",
      {},
      "body",
      [],
      new Set(),
      emptyConfig
    );

    expect(result.cwd).toBe(process.cwd());
  });

  it("handles _subcommand as string", () => {
    const result = buildCommand(
      "codex",
      { _subcommand: "exec" },
      "body",
      [],
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.subcommands).toEqual(["exec"]);
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs[0]).toBe("exec");
  });

  it("handles _subcommand as array", () => {
    const result = buildCommand(
      "codex",
      { _subcommand: ["sub1", "sub2"] },
      "body",
      [],
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.subcommands).toEqual(["sub1", "sub2"]);
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs[0]).toBe("sub1");
    expect(spawnArgs[1]).toBe("sub2");
  });
});

describe("buildCommandBase", () => {
  const emptyConfig: GlobalConfig = {};
  const cwd = "/test/dir";

  it("builds command without positionals", () => {
    const result = buildCommandBase(
      "claude",
      { model: "opus", verbose: true },
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.executable).toBe("claude");
    expect(result.args).toEqual(["--model", "opus", "--verbose"]);
    expect(result.positionals).toEqual([]);
    expect(result.subcommands).toEqual([]);
    expect(result.env).toEqual({});
    expect(result.cwd).toBe(cwd);
  });

  it("applies config defaults", () => {
    const config: GlobalConfig = {
      commands: {
        claude: {
          model: "sonnet",
        },
      },
    };

    const result = buildCommandBase(
      "claude",
      {},
      new Set(),
      config,
      cwd
    );

    expect(result.args).toContain("--model");
    expect(result.args).toContain("sonnet");
  });

  it("extracts env vars", () => {
    const result = buildCommandBase(
      "claude",
      { env: { KEY: "value" } },
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.env).toEqual({ KEY: "value" });
  });

  it("extracts subcommands", () => {
    const result = buildCommandBase(
      "codex",
      { _subcommand: "exec" },
      new Set(),
      emptyConfig,
      cwd
    );

    expect(result.subcommands).toEqual(["exec"]);
  });
});

describe("CommandSpec interface contract", () => {
  it("spec contains all required fields", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: [],
      args: ["--model", "opus"],
      positionals: ["body text"],
      env: { KEY: "value" },
      cwd: "/test/dir",
    };

    expect(spec).toHaveProperty("executable");
    expect(spec).toHaveProperty("subcommands");
    expect(spec).toHaveProperty("args");
    expect(spec).toHaveProperty("positionals");
    expect(spec).toHaveProperty("env");
    expect(spec).toHaveProperty("cwd");
  });

  it("args can be empty array", () => {
    const spec: CommandSpec = {
      executable: "echo",
      subcommands: [],
      args: [],
      positionals: [],
      env: {},
      cwd: "/",
    };

    expect(spec.args).toEqual([]);
  });

  it("env can be empty object", () => {
    const spec: CommandSpec = {
      executable: "echo",
      subcommands: [],
      args: [],
      positionals: [],
      env: {},
      cwd: "/",
    };

    expect(spec.env).toEqual({});
  });
});

describe("extractSubcommands", () => {
  it("returns empty array when no _subcommand", () => {
    const result = extractSubcommands({ model: "opus" });
    expect(result).toEqual([]);
  });

  it("returns array with single subcommand string", () => {
    const result = extractSubcommands({ _subcommand: "exec" });
    expect(result).toEqual(["exec"]);
  });

  it("returns array with multiple subcommands", () => {
    const result = extractSubcommands({ _subcommand: ["sub1", "sub2"] });
    expect(result).toEqual(["sub1", "sub2"]);
  });

  it("converts non-string values to strings", () => {
    const result = extractSubcommands({ _subcommand: 123 as unknown as string });
    expect(result).toEqual(["123"]);
  });
});

describe("getSpawnArgs", () => {
  it("combines subcommands, args, and positionals in order", () => {
    const spec: CommandSpec = {
      executable: "codex",
      subcommands: ["exec"],
      args: ["--model", "opus"],
      positionals: ["prompt text"],
      env: {},
      cwd: "/",
    };

    const result = getSpawnArgs(spec);
    expect(result).toEqual(["exec", "--model", "opus", "prompt text"]);
  });

  it("handles empty subcommands", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: [],
      args: ["--model", "opus"],
      positionals: ["prompt text"],
      env: {},
      cwd: "/",
    };

    const result = getSpawnArgs(spec);
    expect(result).toEqual(["--model", "opus", "prompt text"]);
  });

  it("handles multiple subcommands", () => {
    const spec: CommandSpec = {
      executable: "custom",
      subcommands: ["sub1", "sub2"],
      args: ["--flag"],
      positionals: [],
      env: {},
      cwd: "/",
    };

    const result = getSpawnArgs(spec);
    expect(result).toEqual(["sub1", "sub2", "--flag"]);
  });
});

describe("formatCommandForDisplay", () => {
  it("formats simple command", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: [],
      args: ["--model", "opus"],
      positionals: [],
      env: {},
      cwd: "/",
    };

    const result = formatCommandForDisplay(spec);
    expect(result).toBe("claude --model opus");
  });

  it("quotes args with spaces", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: [],
      args: [],
      positionals: ["hello world"],
      env: {},
      cwd: "/",
    };

    const result = formatCommandForDisplay(spec);
    expect(result).toBe('claude "hello world"');
  });

  it("escapes double quotes in args", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: [],
      args: [],
      positionals: ['say "hello"'],
      env: {},
      cwd: "/",
    };

    const result = formatCommandForDisplay(spec);
    expect(result).toBe('claude "say \\"hello\\""');
  });

  it("includes subcommands in output", () => {
    const spec: CommandSpec = {
      executable: "codex",
      subcommands: ["exec"],
      args: ["--model", "opus"],
      positionals: ["prompt"],
      env: {},
      cwd: "/",
    };

    const result = formatCommandForDisplay(spec);
    expect(result).toBe("codex exec --model opus prompt");
  });

  it("handles complex prompt with newlines", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: [],
      args: [],
      positionals: ["line1\nline2"],
      env: {},
      cwd: "/",
    };

    const result = formatCommandForDisplay(spec);
    expect(result).toBe('claude "line1\nline2"');
  });
});

describe("integration scenarios", () => {
  it("copilot with prompt mapping (common pattern)", () => {
    const config: GlobalConfig = {
      commands: {
        copilot: {
          $1: "prompt",
        },
      },
    };

    const result = buildCommand(
      "copilot",
      { model: "gpt-4" },
      "Explain this code",
      [],
      new Set(),
      config,
      "/project"
    );

    expect(result.executable).toBe("copilot");
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).toContain("--prompt");
    expect(spawnArgs).toContain("Explain this code");
    expect(spawnArgs).toContain("--model");
    expect(spawnArgs).toContain("gpt-4");
  });

  it("claude with multiple add-dir flags", () => {
    const result = buildCommand(
      "claude",
      {
        model: "opus",
        "add-dir": ["./src", "./lib", "./tests"],
        "dangerously-skip-permissions": true,
      },
      "Analyze the codebase",
      [],
      new Set(),
      {},
      "/workspace"
    );

    expect(result.args).toContain("--add-dir");
    const addDirCount = result.args.filter(a => a === "--add-dir").length;
    expect(addDirCount).toBe(3);
    expect(result.args).toContain("./src");
    expect(result.args).toContain("./lib");
    expect(result.args).toContain("./tests");
    expect(result.args).toContain("--dangerously-skip-permissions");
  });

  it("env vars set separately from command flags", () => {
    const result = buildCommand(
      "claude",
      {
        env: { ANTHROPIC_API_KEY: "sk-test", DEBUG: "1" },
        model: "opus",
      },
      "body",
      [],
      new Set(),
      {},
      "/project"
    );

    // Env should be in env object, not in args
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      DEBUG: "1",
    });
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).not.toContain("ANTHROPIC_API_KEY");
    expect(spawnArgs).not.toContain("sk-test");
  });

  it("template variable substitution workflow", () => {
    // Simulates: {{ target }} in body, target provided via args
    const templateVars = new Set(["target"]);

    const result = buildCommand(
      "claude",
      {
        args: ["target"],  // Declares template var (skipped)
        target: "src/app.ts",  // Template var value (skipped)
        model: "opus",
      },
      "Review {{ target }}",  // Body with template (already substituted upstream)
      [],
      templateVars,
      {},
      "/project"
    );

    // target should not appear as a flag
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs).not.toContain("--target");
    expect(spawnArgs).not.toContain("src/app.ts");
    // args system key should not appear
    expect(spawnArgs).not.toContain("--args");
    // model should appear
    expect(spawnArgs).toContain("--model");
    expect(spawnArgs).toContain("opus");
  });

  it("codex with _subcommand default from config", () => {
    const config: GlobalConfig = {
      commands: {
        codex: {
          _subcommand: "exec",
        },
      },
    };

    const result = buildCommand(
      "codex",
      {},
      "Run this code",
      [],
      new Set(),
      config,
      "/project"
    );

    expect(result.subcommands).toEqual(["exec"]);
    const spawnArgs = getSpawnArgs(result);
    expect(spawnArgs[0]).toBe("exec");
  });
});

describe("dry-run consistency guarantee", () => {
  /**
   * These tests verify that the same CommandSpec is used for both
   * dry-run display and actual execution, ensuring they never drift.
   */

  it("formatCommandForDisplay uses same args as getSpawnArgs", () => {
    const spec: CommandSpec = {
      executable: "claude",
      subcommands: ["exec"],
      args: ["--model", "opus", "--verbose"],
      positionals: ["Hello world prompt"],
      env: { KEY: "value" },
      cwd: "/test",
    };

    // Both dry-run display and execution should use the same args
    const spawnArgs = getSpawnArgs(spec);
    const displayCmd = formatCommandForDisplay(spec);

    // spawnArgs is what would be passed to spawn
    expect(spawnArgs).toEqual(["exec", "--model", "opus", "--verbose", "Hello world prompt"]);

    // displayCmd should represent the same command (with escaping)
    expect(displayCmd).toContain("claude");
    expect(displayCmd).toContain("exec");
    expect(displayCmd).toContain("--model");
    expect(displayCmd).toContain("opus");
    expect(displayCmd).toContain("--verbose");
    expect(displayCmd).toContain("Hello world prompt");
  });

  it("buildCommand produces consistent spec for both paths", () => {
    const config: GlobalConfig = {
      commands: {
        codex: {
          _subcommand: "exec",
        },
      },
    };

    // Build once - used for both dry-run and execution
    const spec = buildCommand(
      "codex",
      { model: "gpt-4" },
      "Run this task",
      [],
      new Set(),
      config,
      "/project"
    );

    // Dry-run would use formatCommandForDisplay(spec)
    const dryRunOutput = formatCommandForDisplay(spec);

    // Execution would use getSpawnArgs(spec)
    const executionArgs = getSpawnArgs(spec);

    // Both should represent the same command
    expect(dryRunOutput).toContain("codex");
    expect(dryRunOutput).toContain("exec");
    expect(executionArgs[0]).toBe("exec");

    // The display should contain all the execution args
    for (const arg of executionArgs) {
      // Args with spaces get quoted in display
      const expectedInDisplay = arg.includes(" ") ? `"${arg}"` : arg;
      expect(dryRunOutput).toContain(expectedInDisplay.replace(/\n/g, "\\n"));
    }
  });

  it("handles complex frontmatter identically in both paths", () => {
    const frontmatter: AgentFrontmatter = {
      model: "opus",
      "dangerously-skip-permissions": true,
      "add-dir": ["./src", "./tests"],
      $1: "prompt",
      _subcommand: "chat",
      env: { API_KEY: "secret" },
    };

    const spec = buildCommand(
      "custom-cli",
      frontmatter,
      "Complex prompt with\nnewlines",
      [],
      new Set(),
      {},
      "/workspace"
    );

    const spawnArgs = getSpawnArgs(spec);
    const display = formatCommandForDisplay(spec);

    // Verify subcommand handling is consistent
    expect(spawnArgs[0]).toBe("chat");
    expect(display).toContain("chat");

    // Verify positional mapping ($1: prompt) is consistent
    expect(spawnArgs).toContain("--prompt");
    expect(display).toContain("--prompt");

    // Verify array flags are handled consistently
    const addDirCount = spawnArgs.filter(a => a === "--add-dir").length;
    expect(addDirCount).toBe(2);
    expect(display.split("--add-dir").length - 1).toBe(2);

    // Verify env is separate (not in args)
    expect(spawnArgs).not.toContain("API_KEY");
    expect(display).not.toContain("API_KEY");
    expect(spec.env).toEqual({ API_KEY: "secret" });
  });
});
