import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  parseCliArgs,
  findAgentFiles,
  getProjectAgentsDir,
  getProjectFlowsDir,
  getUserAgentsDir,
  clearDescriptionCache,
} from "./cli";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, realpathSync, symlinkSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

describe("parseCliArgs", () => {
  test("extracts file path", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.passthroughArgs).toEqual([]);
  });

  test("all flags pass through when file is provided", () => {
    const result = parseCliArgs([
      "node", "script", "DEMO.md",
      "-p", "print mode",
      "--model", "opus",
      "--verbose"
    ]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.passthroughArgs).toEqual(["-p", "print mode", "--model", "opus", "--verbose"]);
  });

  test("--help works when no file provided", () => {
    const result = parseCliArgs(["node", "script", "--help"]);
    expect(result.filePath).toBe("");
    expect(result.help).toBe(true);
  });

  test("subcommands are treated as filePath (handled by index.ts)", () => {
    // setup, logs, create are subcommands - they appear as filePath
    // and are intercepted by index.ts before being treated as files
    const setupResult = parseCliArgs(["node", "script", "setup"]);
    expect(setupResult.filePath).toBe("setup");

    const logsResult = parseCliArgs(["node", "script", "logs"]);
    expect(logsResult.filePath).toBe("logs");

    const createResult = parseCliArgs(["node", "script", "create", "-g"]);
    expect(createResult.filePath).toBe("create");
    expect(createResult.passthroughArgs).toEqual(["-g"]);
  });

  test("md flags pass through when file is provided", () => {
    const result = parseCliArgs(["node", "script", "DEMO.md", "--help", "--model", "opus"]);
    expect(result.filePath).toBe("DEMO.md");
    expect(result.help).toBe(false);
    expect(result.passthroughArgs).toEqual(["--help", "--model", "opus"]);
  });

  test("handles malformed argv shape without throwing", () => {
    const result = parseCliArgs([]);
    expect(result.filePath).toBe("");
    expect(result.help).toBe(false);
    expect(result.passthroughArgs).toEqual([]);
  });

  test("treats missing file paths as positional arguments", () => {
    const result = parseCliArgs(["node", "script", "does-not-exist.md", "--verbose"]);
    expect(result.filePath).toBe("does-not-exist.md");
    expect(result.passthroughArgs).toEqual(["--verbose"]);
    expect(result.help).toBe(false);
  });
});

describe("agent directory paths", () => {
  test("getProjectAgentsDir returns .mdflow in cwd", () => {
    const dir = getProjectAgentsDir();
    expect(dir).toBe(join(process.cwd(), ".mdflow"));
  });

  test("getProjectFlowsDir returns the canonical flows directory", () => {
    expect(getProjectFlowsDir()).toBe(join(process.cwd(), "flows"));
  });

  test("getUserAgentsDir returns ~/.mdflow", () => {
    const dir = getUserAgentsDir();
    expect(dir).toBe(join(homedir(), ".mdflow"));
  });
});

describe("findAgentFiles", () => {
  const testProjectDir = join(process.cwd(), ".mdflow-test");
  const testUserDir = join(homedir(), ".mdflow-test-user");

  beforeEach(() => {
    // Create test directories
    if (!existsSync(testProjectDir)) {
      mkdirSync(testProjectDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Cleanup test directories
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  test("finds files from current directory", async () => {
    const files = await findAgentFiles();
    // Should find .md files in cwd (like CLAUDE.md, README.md, etc.)
    const cwdFiles = files.filter(f => f.source === "cwd");
    expect(cwdFiles.length).toBeGreaterThan(0);
  });

  test("finds files from .mdflow/ directory when present", async () => {
    // Create a test .mdflow directory with a file
    const mdflowDir = join(process.cwd(), ".mdflow");
    const testFile = join(mdflowDir, "test-agent.claude.md");

    try {
      mkdirSync(mdflowDir, { recursive: true });
      writeFileSync(testFile, "---\nmodel: opus\n---\nTest agent");

      const files = await findAgentFiles();
      const mdflowFiles = files.filter(f => f.source === ".mdflow");

      expect(mdflowFiles.length).toBeGreaterThan(0);
      expect(mdflowFiles.some(f => f.name === "test-agent.claude.md")).toBe(true);
    } finally {
      // Cleanup
      if (existsSync(testFile)) rmSync(testFile);
      if (existsSync(mdflowDir)) rmSync(mdflowDir, { recursive: true, force: true });
    }
  });

  test("finds canonical project flows and skips the roster README", async () => {
    const flowsDir = join(process.cwd(), "flows");
    const testName = `workbench-${Date.now()}.md`;
    const testFile = join(flowsDir, testName);
    const readmePath = join(flowsDir, "README.md");
    const hadFlowsDir = existsSync(flowsDir);
    const hadReadme = existsSync(readmePath);

    try {
      mkdirSync(flowsDir, { recursive: true });
      writeFileSync(testFile, "---\ndescription: workbench flow\n---\nRun it");
      if (!existsSync(readmePath)) writeFileSync(readmePath, "# Flow roster\n");

      const files = await findAgentFiles();
      const projectFlows = files.filter((file) => file.source === "flows");
      expect(projectFlows.some((file) => file.name === testName)).toBe(true);
      expect(projectFlows.some((file) => file.name.toLowerCase() === "readme.md")).toBe(false);
    } finally {
      if (existsSync(testFile)) rmSync(testFile);
      if (!hadReadme && existsSync(readmePath)) rmSync(readmePath);
      if (!hadFlowsDir && existsSync(flowsDir)) rmSync(flowsDir, { recursive: true, force: true });
    }
  });

  test("deduplicates files by normalized path", async () => {
    const files = await findAgentFiles();
    const paths = files.map(f => f.path);
    const uniquePaths = new Set(paths);
    expect(paths.length).toBe(uniquePaths.size);
  });

  test("returns files with correct structure", async () => {
    const files = await findAgentFiles();
    if (files.length > 0) {
      const file = files[0]!;
      expect(file).toHaveProperty("name");
      expect(file).toHaveProperty("path");
      expect(file).toHaveProperty("source");
      expect(typeof file.name).toBe("string");
      expect(typeof file.path).toBe("string");
      expect(typeof file.source).toBe("string");
    }
  });
});

describe("findAgentFiles edge cases", () => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  let isolatedDir = "";

  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "mdflow-cli-edge-"));
    process.chdir(isolatedDir);
    process.env.PATH = "";
    mkdirSync(join(isolatedDir, ".mdflow"), { recursive: true });
    clearDescriptionCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    clearDescriptionCache();

    if (existsSync(isolatedDir)) {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  test("handles invalid frontmatter and empty files without crashing", async () => {
    const invalidName = `edge-invalid-${Date.now()}.md`;
    const emptyName = `edge-empty-${Date.now()}.md`;
    const validName = `edge-valid-${Date.now()}.md`;

    writeFileSync(
      join(isolatedDir, ".mdflow", invalidName),
      "---\ndescription: broken\nmodel: [unterminated\nBody without closing delimiter"
    );
    writeFileSync(join(isolatedDir, ".mdflow", emptyName), "");
    writeFileSync(
      join(isolatedDir, ".mdflow", validName),
      "---\ndescription: usable agent\n---\nBody"
    );

    const files = await findAgentFiles();
    expect(files.some((file) => file.name === invalidName)).toBe(true);
    expect(files.some((file) => file.name === emptyName)).toBe(true);
    expect(files.find((file) => file.name === invalidName)?.description).toBeUndefined();
    expect(files.find((file) => file.name === emptyName)?.description).toBeUndefined();
    expect(files.find((file) => file.name === validName)?.description).toBe("usable agent");
  });

  test("continues scanning when a discovered path points to a missing target", async () => {
    const presentName = `edge-present-${Date.now()}.md`;
    writeFileSync(join(isolatedDir, ".mdflow", presentName), "---\ndescription: present\n---\nBody");

    // Best-effort broken symlink test (may fail on restricted environments)
    try {
      symlinkSync(
        join(isolatedDir, ".mdflow", "missing-target.md"),
        join(isolatedDir, ".mdflow", "broken-link.md")
      );
    } catch {
      // Continue without the symlink if the environment disallows it.
    }

    const files = await findAgentFiles();
    expect(files.some((file) => file.name === presentName)).toBe(true);
  });

  test("discovers the nearest project roster from a nested working directory", async () => {
    const flowName = "nested-project-review.md";
    const flowPath = join(isolatedDir, "flows", flowName);
    const nested = join(isolatedDir, "packages", "app", "src");
    mkdirSync(join(isolatedDir, ".git"));
    mkdirSync(join(isolatedDir, "flows"));
    mkdirSync(nested, { recursive: true });
    writeFileSync(flowPath, "---\ndescription: root flow\n---\nReview it");
    process.chdir(nested);

    const resolvedRoot = realpathSync(isolatedDir);
    expect(getProjectFlowsDir()).toBe(join(resolvedRoot, "flows"));
    const files = await findAgentFiles();
    expect(files.find((file) => file.name === flowName)).toMatchObject({
      path: join(resolvedRoot, "flows", flowName),
      source: "flows",
      description: "root flow",
    });
  });
});
