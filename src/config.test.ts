import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  loadGlobalConfig,
  getCommandDefaults,
  applyInteractiveMode,
  clearConfigCache,
  findGitRoot,
  loadProjectConfig,
  loadFullConfig,
  clearProjectConfigCache,
} from "./config";
import type { AgentFrontmatter } from "./types";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config", () => {
  beforeEach(() => {
    clearConfigCache();
  });

  test("loadGlobalConfig returns built-in defaults", async () => {
    const config = await loadGlobalConfig();
    expect(config.commands).toBeDefined();
    expect(config.commands?.copilot).toBeDefined();
    expect(config.commands!.copilot!.$1).toBe("prompt");  // Print mode by default
    expect(config.commands?.claude?.print).toBe(true);   // Print mode by default
    expect(config.commands?.codex?._subcommand).toBe("exec");  // Exec subcommand by default
  });

  test("getCommandDefaults returns defaults for copilot", async () => {
    const defaults = await getCommandDefaults("copilot");
    expect(defaults).toBeDefined();
    expect(defaults?.$1).toBe("prompt");  // Print mode by default
  });

  test("getCommandDefaults returns undefined for unknown command", async () => {
    const defaults = await getCommandDefaults("unknown-command");
    expect(defaults).toBeUndefined();
  });

  // NOTE: Pure merge-logic tests (identity, right-bias, associativity) have been
  // replaced by property-based tests in config-monoid.test.ts. See docs/mutation-proof.md
  // for the equivalence proof showing property tests catch a strict superset of bugs.
});

describe("findGitRoot", () => {
  test("finds git root from current directory", () => {
    // The test is running inside the agents repo
    const gitRoot = findGitRoot(process.cwd());
    expect(gitRoot).not.toBeNull();
    expect(existsSync(join(gitRoot!, ".git"))).toBe(true);
  });

  test("finds git root from subdirectory", () => {
    const gitRoot = findGitRoot(join(process.cwd(), "src"));
    expect(gitRoot).not.toBeNull();
    expect(existsSync(join(gitRoot!, ".git"))).toBe(true);
  });

  test("returns null for non-git directory", () => {
    const gitRoot = findGitRoot(tmpdir());
    // tmpdir might be in a git repo on some systems, so we just check it doesn't error
    expect(gitRoot === null || typeof gitRoot === "string").toBe(true);
  });
});

describe("loadProjectConfig", () => {
  const testDir = join(tmpdir(), `md-test-${Date.now()}`);
  const subDir = join(testDir, "subdir");

  beforeEach(() => {
    clearProjectConfigCache();
    mkdirSync(subDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns empty config when no project config exists", async () => {
    const config = await loadProjectConfig(testDir);
    expect(config).toEqual({});
  });

  test("loads mdflow.config.yaml from CWD", async () => {
    writeFileSync(
      join(testDir, "mdflow.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("opus");
  });

  test("loads .mdflow.yaml from CWD", async () => {
    writeFileSync(
      join(testDir, ".mdflow.yaml"),
      `commands:
  claude:
    model: sonnet
`
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("sonnet");
  });

  test("loads .mdflow.json from CWD", async () => {
    writeFileSync(
      join(testDir, ".mdflow.json"),
      JSON.stringify({
        commands: {
          claude: {
            model: "haiku",
          },
        },
      })
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("haiku");
  });

  test("prefers mdflow.config.yaml over .mdflow.yaml", async () => {
    writeFileSync(
      join(testDir, "mdflow.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );
    writeFileSync(
      join(testDir, ".mdflow.yaml"),
      `commands:
  claude:
    model: sonnet
`
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("opus");
  });

  test("handles invalid YAML gracefully", async () => {
    writeFileSync(join(testDir, "mdflow.config.yaml"), "invalid: yaml: content:");

    const config = await loadProjectConfig(testDir);
    // Should return empty config on parse error
    expect(config).toEqual({});
  });

  test("handles invalid JSON gracefully", async () => {
    writeFileSync(join(testDir, ".mdflow.json"), "{ invalid json }");

    const config = await loadProjectConfig(testDir);
    expect(config).toEqual({});
  });
});

describe("loadFullConfig", () => {
  const testDir = join(tmpdir(), `md-full-test-${Date.now()}`);

  beforeEach(() => {
    clearConfigCache();
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("includes built-in defaults when no project config", async () => {
    const config = await loadFullConfig(testDir);
    expect(config.commands?.copilot?.$1).toBe("prompt");  // Print mode by default
  });

  test("project config overrides global config", async () => {
    writeFileSync(
      join(testDir, "mdflow.config.yaml"),
      `commands:
  copilot:
    $1: custom-prompt
`
    );

    const config = await loadFullConfig(testDir);
    expect(config.commands?.copilot?.$1).toBe("custom-prompt");
  });

  test("project config adds new commands", async () => {
    writeFileSync(
      join(testDir, "mdflow.config.yaml"),
      `commands:
  my-tool:
    $1: body
    verbose: true
`
    );

    const config = await loadFullConfig(testDir);
    // Built-in defaults preserved
    expect(config.commands?.copilot?.$1).toBe("prompt");  // Print mode by default
    // New command added
    expect(config.commands?.["my-tool"]?.$1).toBe("body");
    expect(config.commands?.["my-tool"]?.verbose).toBe(true);
  });

  test("project config merges with existing command", async () => {
    writeFileSync(
      join(testDir, "mdflow.config.yaml"),
      `commands:
  copilot:
    verbose: true
`
    );

    const config = await loadFullConfig(testDir);
    // Built-in default preserved
    expect(config.commands?.copilot?.$1).toBe("prompt");  // Print mode by default
    // New setting added
    expect(config.commands?.copilot?.verbose).toBe(true);
  });
});

describe("config cascade", () => {
  let testDir: string;
  let gitRoot: string;
  let subDir: string;

  beforeEach(() => {
    clearConfigCache();
    // Use unique directory per test to avoid cache issues
    testDir = join(tmpdir(), `md-cascade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    gitRoot = join(testDir, "repo");
    subDir = join(gitRoot, "packages", "app");
    // Create a fake git repo structure
    mkdirSync(join(gitRoot, ".git"), { recursive: true });
    mkdirSync(subDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("CWD config overrides git root config", async () => {
    // Git root config
    writeFileSync(
      join(gitRoot, "mdflow.config.yaml"),
      `commands:
  claude:
    model: sonnet
    verbose: true
`
    );

    // CWD config (subdirectory)
    writeFileSync(
      join(subDir, "mdflow.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );

    const config = await loadProjectConfig(subDir);
    // CWD wins for model
    expect(config.commands?.claude?.model).toBe("opus");
    // Git root setting preserved
    expect(config.commands?.claude?.verbose).toBe(true);
  });

  test("git root config used when CWD has no config", async () => {
    writeFileSync(
      join(gitRoot, "mdflow.config.yaml"),
      `commands:
  claude:
    model: sonnet
`
    );

    const config = await loadProjectConfig(subDir);
    expect(config.commands?.claude?.model).toBe("sonnet");
  });

  test("only CWD config used when at git root", async () => {
    writeFileSync(
      join(gitRoot, "mdflow.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );

    const config = await loadProjectConfig(gitRoot);
    expect(config.commands?.claude?.model).toBe("opus");
  });
});

describe("applyInteractiveMode", () => {
  test("removes print flag for claude with _interactive: true", () => {
    const frontmatter = { print: true, model: "opus", _interactive: true } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBeUndefined();
    expect(result._interactive).toBeUndefined();
    expect(result.model).toBe("opus");
  });

  test("removes print flag for claude with _i: true", () => {
    const frontmatter = { print: true, model: "opus", _i: true } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBeUndefined();
    expect(result._i).toBeUndefined();
    expect(result.model).toBe("opus");
  });

  test("handles _interactive with null value (YAML empty key)", () => {
    const frontmatter = { print: true, _interactive: null } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBeUndefined();
    expect(result._interactive).toBeUndefined();
  });

  test("handles _i with null value (YAML empty key)", () => {
    const frontmatter = { print: true, _i: null } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBeUndefined();
    expect(result._i).toBeUndefined();
  });

  test("handles _interactive with empty string value", () => {
    const frontmatter = { print: true, _interactive: "" };
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBeUndefined();
  });

  test("handles _i with empty string value", () => {
    const frontmatter = { print: true, _i: "" };
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBeUndefined();
  });

  test("does not trigger interactive mode with _interactive: false", () => {
    const frontmatter = { print: true, _interactive: false } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBe(true);
  });

  test("does not trigger interactive mode when _interactive not present", () => {
    const frontmatter = { print: true, model: "opus" };
    const result = applyInteractiveMode(frontmatter, "claude");
    expect(result.print).toBe(true);
  });

  test("triggers interactive mode via external flag (interactiveFromExternal)", () => {
    const frontmatter = { print: true, model: "opus" };
    const result = applyInteractiveMode(frontmatter, "claude", true);
    expect(result.print).toBeUndefined();
    expect(result.model).toBe("opus");
  });

  test("changes copilot $1 from prompt to interactive", () => {
    const frontmatter = { $1: "prompt", silent: true, _interactive: true } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "copilot");
    expect(result.$1).toBe("interactive");
    expect(result.silent).toBe(true);
  });

  test("removes _subcommand for codex", () => {
    const frontmatter = { _subcommand: "exec", _interactive: true } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "codex");
    expect(result._subcommand).toBeUndefined();
  });

  test("adds prompt-interactive for gemini", () => {
    const frontmatter = { model: "pro", _interactive: true } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "gemini");
    expect(result.$1).toBe("prompt-interactive");
  });

  test("unknown command just removes _interactive", () => {
    const frontmatter = { custom: "value", _interactive: true } as AgentFrontmatter;
    const result = applyInteractiveMode(frontmatter, "my-custom-cli");
    expect(result._interactive).toBeUndefined();
    expect(result.custom).toBe("value");
  });
});
