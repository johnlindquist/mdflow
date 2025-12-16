import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import {
  spawnMd,
  spawnTestScript,
  createTempDir,
  createTestAgent,
  assertCleanStdout,
  PROJECT_ROOT,
} from "./test-utils";

/**
 * Tests for sanitized output streams
 *
 * Ensures all system/status messages go to stderr,
 * keeping stdout exclusively for agent output.
 * This enables clean piping like: git diff | md review.md > review.txt
 */

describe("Output Stream Separation", () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const temp = await createTempDir("md-streams-test-");
    tempDir = temp.tempDir;
    cleanup = temp.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("remote.ts status messages", () => {
    test("fetchRemote outputs status to stderr, not stdout", async () => {
      const testScript = `
        import { fetchRemote } from "${PROJECT_ROOT}/src/remote";
        const result = await fetchRemote("https://raw.githubusercontent.com/johnlindquist/kit/main/README.md");
        console.log(JSON.stringify({ success: result.success, isRemote: result.isRemote }));
      `;

      const result = await spawnTestScript(testScript, tempDir);

      // Stderr should contain status messages
      expect(result.stderr).toContain("Fetching:");
      expect(result.stderr).toContain("Saved to:");

      // Stdout should only contain our JSON result
      expect(result.stdout).not.toContain("Fetching:");
      expect(result.stdout).not.toContain("Saved to:");

      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.success).toBe(true);
      expect(parsed.isRemote).toBe(true);
    });

    test("local files produce no status output", async () => {
      const testScript = `
        import { fetchRemote } from "${PROJECT_ROOT}/src/remote";
        const result = await fetchRemote("./src/remote.ts");
        console.log(JSON.stringify({ success: result.success, isRemote: result.isRemote }));
      `;

      const result = await spawnTestScript(testScript, tempDir);

      // No status messages for local files
      expect(result.stderr).not.toContain("Fetching:");
      expect(result.stderr).not.toContain("Saved to:");

      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.success).toBe(true);
      expect(parsed.isRemote).toBe(false);
    });
  });

  describe("CLI commands output routing", () => {
    test("--help outputs to stdout (requested data)", async () => {
      const result = await spawnMd(["--help"]);
      expect(result.stdout).toContain("Usage: md");
      expect(result.stdout).toContain("Commands:");
    });

    test("'logs' subcommand outputs directory info to stdout", async () => {
      const result = await spawnMd(["logs"]);
      expect(result.stdout).toContain("Log directory:");
    });

    test("missing file error goes to stderr", async () => {
      const result = await spawnMd(["nonexistent-file.md"]);
      expect(result.stderr).toContain("File not found");
      expect(result.stdout.trim()).toBe("");
    });

    test("usage error goes to stderr", async () => {
      const result = await spawnMd([]);
      expect(result.stderr).toContain("Usage:");
      expect(result.stdout.trim()).toBe("");
    });
  });

  describe("Plain markdown file output", () => {
    test("plain markdown without command pattern outputs error to stderr", async () => {
      const mdPath = await createTestAgent(
        tempDir,
        "plain.md",
        "# Hello World\n\nThis is plain markdown."
      );

      const result = await spawnMd([mdPath]);

      expect(result.stderr).toContain("No command specified");
      expect(result.stdout.trim()).toBe("");
    });
  });

  describe("Piping scenarios", () => {
    test("output can be cleanly redirected without status noise", async () => {
      const agentPath = await createTestAgent(
        tempDir,
        "echo.md",
        `---
model: test
---
Echo test content`
      );

      const result = await spawnMd([agentPath]);

      // Key assertion: no status messages on stdout
      assertCleanStdout(result.stdout);
    });
  });
});
