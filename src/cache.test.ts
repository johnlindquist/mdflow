import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  generateCacheKey,
  readCache,
  writeCache,
  clearCache,
  getCacheStats,
} from "./cache";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cache-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true });
});

describe("generateCacheKey", () => {
  test("generates consistent hash for same inputs", () => {
    const key1 = generateCacheKey({
      frontmatter: { model: "gpt-5" },
      body: "Hello world",
    });
    const key2 = generateCacheKey({
      frontmatter: { model: "gpt-5" },
      body: "Hello world",
    });
    expect(key1).toBe(key2);
  });

  test("generates different hash for different body", () => {
    const key1 = generateCacheKey({
      frontmatter: { model: "gpt-5" },
      body: "Hello world",
    });
    const key2 = generateCacheKey({
      frontmatter: { model: "gpt-5" },
      body: "Goodbye world",
    });
    expect(key1).not.toBe(key2);
  });

  test("generates different hash for different frontmatter", () => {
    const key1 = generateCacheKey({
      frontmatter: { model: "gpt-5" },
      body: "Hello",
    });
    const key2 = generateCacheKey({
      frontmatter: { model: "claude-opus-4.5" },
      body: "Hello",
    });
    expect(key1).not.toBe(key2);
  });

  test("includes context files in hash", () => {
    const key1 = generateCacheKey({
      frontmatter: {},
      body: "Hello",
      contextFiles: [{ path: "a.ts", content: "const x = 1;" }],
    });
    const key2 = generateCacheKey({
      frontmatter: {},
      body: "Hello",
      contextFiles: [{ path: "a.ts", content: "const x = 2;" }],
    });
    expect(key1).not.toBe(key2);
  });

  test("returns 16 character hex string", () => {
    const key = generateCacheKey({ frontmatter: {}, body: "test" });
    expect(key).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("writeCache and readCache", () => {
  test("writes and reads cache entry", async () => {
    const hash = "test123456789abc";
    const output = "This is the cached output";

    await writeCache(hash, output, testDir);
    const cached = await readCache(hash, testDir);

    expect(cached).toBe(output);
  });

  test("returns null for missing cache", async () => {
    const cached = await readCache("nonexistent12345", testDir);
    expect(cached).toBeNull();
  });

  test("handles multiline output", async () => {
    const hash = "multiline1234567";
    const output = "Line 1\nLine 2\nLine 3\n";

    await writeCache(hash, output, testDir);
    const cached = await readCache(hash, testDir);

    expect(cached).toBe(output);
  });
});

describe("clearCache", () => {
  test("clears all cache entries", async () => {
    await writeCache("hash1234567890ab", "output1", testDir);
    await writeCache("hash2345678901bc", "output2", testDir);

    const cleared = await clearCache(testDir);
    expect(cleared).toBe(2);

    const cached1 = await readCache("hash1234567890ab", testDir);
    const cached2 = await readCache("hash2345678901bc", testDir);
    expect(cached1).toBeNull();
    expect(cached2).toBeNull();
  });

  test("returns 0 for empty cache", async () => {
    const cleared = await clearCache(testDir);
    expect(cleared).toBe(0);
  });
});

describe("getCacheStats", () => {
  test("returns stats for cache entries", async () => {
    await writeCache("stat123456789ab0", "output1", testDir);
    await writeCache("stat234567890bc1", "output2", testDir);

    const stats = await getCacheStats(testDir);
    expect(stats.entries).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  test("returns zero stats for empty cache", async () => {
    const stats = await getCacheStats(testDir);
    expect(stats.entries).toBe(0);
    expect(stats.totalBytes).toBe(0);
  });
});
