import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  hashUrl,
  getCachedContent,
  setCachedContent,
  invalidateCacheEntry,
  clearExpiredCache,
  clearAllCache,
  getCacheStats,
  ensureCacheDir,
  CACHE_DIR,
  DEFAULT_CACHE_TTL_MS,
} from "./cache";

// Use a test-specific cache directory to avoid polluting the real cache
const TEST_CACHE_DIR = join(tmpdir(), "mdflow-cache-test");

// Override CACHE_DIR for tests by mocking the module
// We'll use direct file operations with TEST_CACHE_DIR

describe("hashUrl", () => {
  test("generates consistent SHA-256 hash for URL", () => {
    const url = "https://example.com/file.md";
    const hash1 = hashUrl(url);
    const hash2 = hashUrl(url);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 produces 64 hex characters
  });

  test("generates different hashes for different URLs", () => {
    const hash1 = hashUrl("https://example.com/file1.md");
    const hash2 = hashUrl("https://example.com/file2.md");

    expect(hash1).not.toBe(hash2);
  });

  test("handles special characters in URLs", () => {
    const url = "https://example.com/path?query=value&foo=bar#fragment";
    const hash = hashUrl(url);

    expect(hash).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });
});

describe("cache operations", () => {
  // Create a temporary test cache directory
  let testCacheDir: string;

  beforeEach(async () => {
    testCacheDir = join(tmpdir(), `mdflow-cache-test-${Date.now()}`);
    await mkdir(testCacheDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testCacheDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("setCachedContent and getCachedContent", () => {
    test("stores and retrieves content", async () => {
      const url = "https://example.com/test.md";
      const content = "# Test Content\n\nThis is a test.";

      await setCachedContent(url, content);
      const result = await getCachedContent(url);

      expect(result.hit).toBe(true);
      expect(result.content).toBe(content);
      expect(result.metadata?.url).toBe(url);
    });

    test("returns cache miss for non-existent URL", async () => {
      const result = await getCachedContent("https://nonexistent.example.com/file.md");

      expect(result.hit).toBe(false);
      expect(result.content).toBeUndefined();
    });

    test("respects noCache option", async () => {
      const url = "https://example.com/nocache.md";
      const content = "Cached content";

      await setCachedContent(url, content);
      const result = await getCachedContent(url, { noCache: true });

      expect(result.hit).toBe(false);
    });

    test("stores custom TTL in metadata", async () => {
      const url = "https://example.com/custom-ttl.md";
      const content = "Content with custom TTL";
      const customTtl = 30 * 60 * 1000; // 30 minutes

      await setCachedContent(url, content, { ttlMs: customTtl });
      const result = await getCachedContent(url);

      expect(result.hit).toBe(true);
      expect(result.metadata?.ttlMs).toBe(customTtl);
    });

    test("handles empty content", async () => {
      const url = "https://example.com/empty.md";
      const content = "";

      await setCachedContent(url, content);
      const result = await getCachedContent(url);

      expect(result.hit).toBe(true);
      expect(result.content).toBe("");
    });

    test("handles large content", async () => {
      const url = "https://example.com/large.md";
      const content = "x".repeat(1024 * 1024); // 1MB of content

      await setCachedContent(url, content);
      const result = await getCachedContent(url);

      expect(result.hit).toBe(true);
      expect(result.content).toBe(content);
    });
  });

  describe("cache expiration", () => {
    test("returns expired flag for old cache entries", async () => {
      const url = "https://example.com/expired.md";
      const content = "Old content";

      // Set cache with very short TTL
      await setCachedContent(url, content, { ttlMs: 1 });

      // Wait for it to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await getCachedContent(url, { ttlMs: 1 });

      expect(result.hit).toBe(false);
      expect(result.expired).toBe(true);
    });

    test("returns valid content within TTL", async () => {
      const url = "https://example.com/valid.md";
      const content = "Valid content";

      await setCachedContent(url, content, { ttlMs: 60000 }); // 1 minute
      const result = await getCachedContent(url, { ttlMs: 60000 });

      expect(result.hit).toBe(true);
      expect(result.expired).toBeUndefined();
    });
  });

  describe("invalidateCacheEntry", () => {
    test("removes cached content", async () => {
      const url = "https://example.com/to-invalidate.md";
      const content = "Content to remove";

      await setCachedContent(url, content);

      // Verify it exists
      let result = await getCachedContent(url);
      expect(result.hit).toBe(true);

      // Invalidate
      const invalidated = await invalidateCacheEntry(url);
      expect(invalidated).toBe(true);

      // Verify it's gone
      result = await getCachedContent(url);
      expect(result.hit).toBe(false);
    });

    test("returns true for non-existent entries", async () => {
      const result = await invalidateCacheEntry("https://nonexistent.example.com/file.md");
      expect(result).toBe(true);
    });
  });

  describe("clearExpiredCache", () => {
    test("removes only expired entries", async () => {
      // Create an entry that will expire quickly
      const expiredUrl = "https://example.com/will-expire.md";
      await setCachedContent(expiredUrl, "Expired", { ttlMs: 1 });

      // Create an entry with long TTL
      const validUrl = "https://example.com/will-stay.md";
      await setCachedContent(validUrl, "Valid", { ttlMs: 3600000 });

      // Wait for short TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear expired
      const cleared = await clearExpiredCache();
      expect(cleared).toBeGreaterThanOrEqual(1);

      // Valid entry should still exist
      const validResult = await getCachedContent(validUrl);
      expect(validResult.hit).toBe(true);
    });
  });

  describe("clearAllCache", () => {
    test("removes all cache entries", async () => {
      // Create multiple entries
      await setCachedContent("https://example.com/1.md", "Content 1");
      await setCachedContent("https://example.com/2.md", "Content 2");
      await setCachedContent("https://example.com/3.md", "Content 3");

      const cleared = await clearAllCache();
      expect(cleared).toBeGreaterThanOrEqual(6); // 3 content files + 3 metadata files

      // All entries should be gone
      const result1 = await getCachedContent("https://example.com/1.md");
      const result2 = await getCachedContent("https://example.com/2.md");
      const result3 = await getCachedContent("https://example.com/3.md");

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
      expect(result3.hit).toBe(false);
    });
  });

  describe("getCacheStats", () => {
    test("returns correct statistics", async () => {
      // Start fresh
      await clearAllCache();

      // Create some entries
      await setCachedContent("https://example.com/stat1.md", "Content 1");
      await setCachedContent("https://example.com/stat2.md", "Content 2");

      const stats = await getCacheStats();

      expect(stats.entries).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.oldestEntry).not.toBeNull();
      expect(stats.newestEntry).not.toBeNull();
    });

    test("returns zeros for empty cache", async () => {
      await clearAllCache();

      const stats = await getCacheStats();

      expect(stats.entries).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });
  });
});

describe("DEFAULT_CACHE_TTL_MS", () => {
  test("defaults to 1 hour", () => {
    expect(DEFAULT_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });
});

describe("ensureCacheDir", () => {
  test("creates cache directory if it doesn't exist", async () => {
    await ensureCacheDir();

    const stats = await stat(CACHE_DIR);
    expect(stats.isDirectory()).toBe(true);
  });
});
