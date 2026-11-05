/** Atomic replacement and cooperative locking for mdflow-owned state. */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWriteFile(path: string, content: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", mode ?? 0o600);
  try {
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  try {
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Some filesystems do not support fsync on directories.
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function acquireStateFileLock(targetPath: string, staleAfterMs: number, contendMs: number): () => void {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const acquire = () => openSync(lockPath, "wx", 0o600);

  // Whether the current holder's lock is old enough (and its process gone)
  // to forcibly take over. Only age proves staleness — a fresh lock whose
  // metadata hasn't landed yet is busy, never stale.
  const isStale = (): boolean => {
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // Inaccessible or ambiguous is not proof that we own it.
      return false;
    }
    try {
      const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; createdAt?: string };
      const claimedCreatedAt = value.createdAt ? Date.parse(value.createdAt) : Number.NaN;
      const claimedAge = Number.isFinite(claimedCreatedAt) ? Date.now() - claimedCreatedAt : age;
      let alive = false;
      if (value.pid) {
        try { process.kill(value.pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code !== "ESRCH"; }
      }
      return !alive && Math.min(age, claimedAge) > staleAfterMs;
    } catch {
      // Unreadable metadata: trust the file's own age only.
      return age > staleAfterMs;
    }
  };

  // The critical section here is a fast small-file write (a receipt append,
  // a ledger update). Brief contention is normal when parallel eval runs
  // record results, so busy-losers wait and retry within a bounded window
  // rather than discarding an already-completed — possibly PAID — run.
  // Synchronous sleep via Atomics.wait keeps this function synchronous.
  const sleep = (ms: number) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      // Environments without SharedArrayBuffer: fall back to a short spin.
      const until = Date.now() + ms;
      while (Date.now() < until) { /* spin */ }
    }
  };

  const deadline = Date.now() + contendMs;
  let fd: number;
  let backoff = 15;
  for (;;) {
    try {
      fd = acquire();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isStale()) {
        // Serialize stale takeovers, then re-check. Two waiters cannot both
        // unlink after observing the same dead owner.
        const guard = lockPath + ".recover";
        let recovery: number | undefined;
        try { recovery = openSync(guard, "wx", 0o600); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        }
        if (recovery !== undefined) {
          try { if (isStale()) rmSync(lockPath, { force: true }); }
          finally { closeSync(recovery); rmSync(guard, { force: true }); }
          try { fd = acquire(); break; } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`State file is busy: ${targetPath}`);
      }
      sleep(Math.min(backoff, Math.max(1, deadline - Date.now())));
      backoff = Math.min(backoff * 2, 200);
    }
  }
  const token = randomUUID();
  let closed = false;
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), targetPath })}\n`);
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
  } catch (err) {
    if (!closed) try { closeSync(fd); } catch {}
    rmSync(lockPath, { force: true });
    throw err;
  }
  return () => {
    let owner: { token?: string };
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch { return; }
    if (owner.token === token) rmSync(lockPath, { force: true });
  };
}

export function withAtomicFileLock<T>(target: string, fn: () => T, staleAfterMs = 60_000, contendMs = 5_000): T {
  const release = acquireStateFileLock(target, staleAfterMs, contendMs);
  try { return fn(); } finally { release(); }
}
