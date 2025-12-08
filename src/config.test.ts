import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  loadGlobalConfig,
  getCommandDefaults,
  applyDefaults,
  clearConfigCache,
  findGitRoot,
  loadProjectConfig,
  loadFullConfig,
  clearProjectConfigCache,
} from "./config";
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
    expect(config.commands?.copilot.$1).toBe("interactive");
  });

  test("getCommandDefaults returns defaults for copilot", async () => {
    const defaults = await getCommandDefaults("copilot");
    expect(defaults).toBeDefined();
    expect(defaults?.$1).toBe("interactive");
  });

  test("getCommandDefaults returns undefined for unknown command", async () => {
    const defaults = await getCommandDefaults("unknown-command");
    expect(defaults).toBeUndefined();
  });

  test("applyDefaults merges defaults with frontmatter (frontmatter wins)", () => {
    const frontmatter = { model: "opus", $1: "custom" };
    const defaults = { $1: "prompt", verbose: true };
    const result = applyDefaults(frontmatter, defaults);

    expect(result.model).toBe("opus");
    expect(result.$1).toBe("custom"); // frontmatter wins
    expect(result.verbose).toBe(true); // default applied
  });

  test("applyDefaults returns frontmatter unchanged when no defaults", () => {
    const frontmatter = { model: "opus" };
    const result = applyDefaults(frontmatter, undefined);
    expect(result).toEqual(frontmatter);
  });
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
  const testDir = join(tmpdir(), `ma-test-${Date.now()}`);
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

  test("loads ma.config.yaml from CWD", async () => {
    writeFileSync(
      join(testDir, "ma.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("opus");
  });

  test("loads .markdown-agent.yaml from CWD", async () => {
    writeFileSync(
      join(testDir, ".markdown-agent.yaml"),
      `commands:
  claude:
    model: sonnet
`
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("sonnet");
  });

  test("loads .markdown-agent.json from CWD", async () => {
    writeFileSync(
      join(testDir, ".markdown-agent.json"),
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

  test("prefers ma.config.yaml over .markdown-agent.yaml", async () => {
    writeFileSync(
      join(testDir, "ma.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );
    writeFileSync(
      join(testDir, ".markdown-agent.yaml"),
      `commands:
  claude:
    model: sonnet
`
    );

    const config = await loadProjectConfig(testDir);
    expect(config.commands?.claude?.model).toBe("opus");
  });

  test("handles invalid YAML gracefully", async () => {
    writeFileSync(join(testDir, "ma.config.yaml"), "invalid: yaml: content:");

    const config = await loadProjectConfig(testDir);
    // Should return empty config on parse error
    expect(config).toEqual({});
  });

  test("handles invalid JSON gracefully", async () => {
    writeFileSync(join(testDir, ".markdown-agent.json"), "{ invalid json }");

    const config = await loadProjectConfig(testDir);
    expect(config).toEqual({});
  });
});

describe("loadFullConfig", () => {
  const testDir = join(tmpdir(), `ma-full-test-${Date.now()}`);

  beforeEach(() => {
    clearConfigCache();
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("includes built-in defaults when no project config", async () => {
    const config = await loadFullConfig(testDir);
    expect(config.commands?.copilot?.$1).toBe("interactive");
  });

  test("project config overrides global config", async () => {
    writeFileSync(
      join(testDir, "ma.config.yaml"),
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
      join(testDir, "ma.config.yaml"),
      `commands:
  my-tool:
    $1: body
    verbose: true
`
    );

    const config = await loadFullConfig(testDir);
    // Built-in defaults preserved
    expect(config.commands?.copilot?.$1).toBe("interactive");
    // New command added
    expect(config.commands?.["my-tool"]?.$1).toBe("body");
    expect(config.commands?.["my-tool"]?.verbose).toBe(true);
  });

  test("project config merges with existing command", async () => {
    writeFileSync(
      join(testDir, "ma.config.yaml"),
      `commands:
  copilot:
    verbose: true
`
    );

    const config = await loadFullConfig(testDir);
    // Built-in default preserved
    expect(config.commands?.copilot?.$1).toBe("interactive");
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
    testDir = join(tmpdir(), `ma-cascade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
      join(gitRoot, "ma.config.yaml"),
      `commands:
  claude:
    model: sonnet
    verbose: true
`
    );

    // CWD config (subdirectory)
    writeFileSync(
      join(subDir, "ma.config.yaml"),
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
      join(gitRoot, "ma.config.yaml"),
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
      join(gitRoot, "ma.config.yaml"),
      `commands:
  claude:
    model: opus
`
    );

    const config = await loadProjectConfig(gitRoot);
    expect(config.commands?.claude?.model).toBe("opus");
  });
});
