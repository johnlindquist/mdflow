import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAtomicFileLock } from "./evolution-store";

describe("withAtomicFileLock hardening (F9)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mdflow-lock-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("invalid lock timestamps fall back to lock file mtime", () => {
    const target = join(tempDir, "state.json");
    const lockPath = `${target}.lock`;
    // Malformed metadata: dead pid + unparseable createdAt. Date.parse yields
    // NaN, which must not poison the staleness math — the file's own mtime
    // says this lock is ancient.
    writeFileSync(lockPath, `${JSON.stringify({ pid: 99_999_999, createdAt: "not-a-date" })}\n`);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath, past, past);
    expect(withAtomicFileLock(target, () => "ran", 60_000)).toBe("ran");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a lock owner never removes a replacement lock", () => {
    const target = join(tempDir, "state.json");
    const lockPath = `${target}.lock`;
    const replacement = `${JSON.stringify({
      pid: process.pid,
      token: "someone-elses-token",
      createdAt: new Date().toISOString(),
      targetPath: target,
    })}\n`;
    withAtomicFileLock(target, () => {
      // A hostile/racy actor deletes the held lock and installs its own.
      unlinkSync(lockPath);
      writeFileSync(lockPath, replacement);
    });
    // The original owner must not unlink a lock it no longer owns.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
  });

  test("the owner still releases its own lock on the normal path", () => {
    const target = join(tempDir, "state.json");
    const lockPath = `${target}.lock`;
    expect(withAtomicFileLock(target, () => "first")).toBe("first");
    expect(existsSync(lockPath)).toBe(false);
    // The lock is genuinely free: an immediate second acquisition succeeds.
    expect(withAtomicFileLock(target, () => "second")).toBe("second");
    expect(existsSync(lockPath)).toBe(false);
  });
});
