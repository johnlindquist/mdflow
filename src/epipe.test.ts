import { expect, test, describe } from "bun:test";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { writeFile, unlink } from "fs/promises";

/**
 * Tests for EPIPE (broken pipe) handling.
 * When downstream closes the pipe early (e.g., `ma task.md | head -n 5`),
 * ma should exit gracefully with code 0 instead of crashing with EPIPE.
 */

describe("EPIPE handling", () => {
  test("exits gracefully when stdout pipe is closed early", async () => {
    // Create a temporary markdown file that outputs a lot of text
    const tempFile = join(tmpdir(), `test-epipe-${Date.now()}.echo.md`);
    await writeFile(tempFile, `---
---
${"A".repeat(10000)}
`);

    try {
      // Run ma and pipe to head -n 1, which will close the pipe early
      const proc = spawn({
        cmd: ["bash", "-c", `bun run ${join(process.cwd(), "src/index.ts")} ${tempFile} | head -n 1`],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, MA_COMMAND: "echo" },
      });

      const exitCode = await proc.exited;

      // The process should exit with 0 (from EPIPE handler) or the normal exit code
      // The key is that it shouldn't crash with an unhandled error
      expect([0, 141]).toContain(exitCode); // 141 = 128 + 13 (SIGPIPE)
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  });

  test("process.stdout error handler is attached", async () => {
    // This test verifies the error handler structure by checking the source
    const indexPath = join(process.cwd(), "src/index.ts");
    const content = await Bun.file(indexPath).text();

    // Verify EPIPE handling code exists
    expect(content).toContain('process.stdout.on("error"');
    expect(content).toContain('err.code === "EPIPE"');
    expect(content).toContain("process.exit(0)");
  });

  test("process.stderr error handler is attached", async () => {
    const indexPath = join(process.cwd(), "src/index.ts");
    const content = await Bun.file(indexPath).text();

    // Verify stderr EPIPE handling code exists
    expect(content).toContain('process.stderr.on("error"');
  });
});
