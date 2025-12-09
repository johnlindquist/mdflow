import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  isRemoteUrl,
  toRawUrl,
  fetchRemote,
  type FetchRemoteOptions,
} from "./remote";
import { clearAllCache, getCachedContent } from "./cache";

describe("isRemoteUrl", () => {
  test("returns true for http URL", () => {
    expect(isRemoteUrl("http://example.com/file.md")).toBe(true);
  });

  test("returns true for https URL", () => {
    expect(isRemoteUrl("https://example.com/file.md")).toBe(true);
  });

  test("returns false for local path", () => {
    expect(isRemoteUrl("./DEMO.md")).toBe(false);
  });

  test("returns false for absolute path", () => {
    expect(isRemoteUrl("/home/user/file.md")).toBe(false);
  });

  test("returns false for relative path", () => {
    expect(isRemoteUrl("instructions/DEMO.md")).toBe(false);
  });
});

describe("toRawUrl", () => {
  test("converts GitHub Gist URL to raw", () => {
    const url = "https://gist.github.com/user/abc123def456";
    const raw = toRawUrl(url);
    expect(raw).toBe("https://gist.githubusercontent.com/user/abc123def456/raw");
  });

  test("converts GitHub blob URL to raw", () => {
    const url = "https://github.com/user/repo/blob/main/scripts/deploy.md";
    const raw = toRawUrl(url);
    expect(raw).toBe("https://raw.githubusercontent.com/user/repo/main/scripts/deploy.md");
  });

  test("converts GitLab blob URL to raw", () => {
    const url = "https://gitlab.com/user/repo/-/blob/main/file.md";
    const raw = toRawUrl(url);
    expect(raw).toBe("https://gitlab.com/user/repo/-/raw/main/file.md");
  });

  test("returns unchanged URL for already raw content", () => {
    const url = "https://raw.githubusercontent.com/user/repo/main/file.md";
    const raw = toRawUrl(url);
    expect(raw).toBe(url);
  });

  test("returns unchanged URL for unknown sources", () => {
    const url = "https://example.com/file.md";
    const raw = toRawUrl(url);
    expect(raw).toBe(url);
  });
});

describe("fetchRemote", () => {
  test("returns isRemote: false for local paths", async () => {
    const result = await fetchRemote("./local/path.md");
    expect(result.isRemote).toBe(false);
    expect(result.success).toBe(true);
    expect(result.localPath).toBe("./local/path.md");
  });

  test("returns isRemote: true for http URLs", async () => {
    // Use a URL that will fail (no network call needed for this test)
    const result = await fetchRemote("http://nonexistent.invalid/file.md");
    expect(result.isRemote).toBe(true);
  });

  test("returns isRemote: true for https URLs", async () => {
    // Use a URL that will fail (no network call needed for this test)
    const result = await fetchRemote("https://nonexistent.invalid/file.md");
    expect(result.isRemote).toBe(true);
  });
});

describe("fetchRemote caching", () => {
  // Clean up cache before and after tests
  beforeEach(async () => {
    await clearAllCache();
  });

  afterEach(async () => {
    await clearAllCache();
  });

  test("caches fetched content", async () => {
    // Fetch a small public file
    const url = "https://jsonplaceholder.typicode.com/posts/1";
    const result = await fetchRemote(url);

    // Should succeed (might fail if network is down, but that's OK for this test)
    if (result.success) {
      expect(result.fromCache).toBe(false);

      // Check that content was cached
      const cached = await getCachedContent(toRawUrl(url));
      expect(cached.hit).toBe(true);
    }
  });

  test("returns cached content on second fetch", async () => {
    const url = "https://jsonplaceholder.typicode.com/posts/1";

    // First fetch - should not be from cache
    const result1 = await fetchRemote(url);
    if (!result1.success) {
      // Skip test if network is unavailable
      return;
    }
    expect(result1.fromCache).toBe(false);

    // Second fetch - should be from cache
    const result2 = await fetchRemote(url);
    expect(result2.success).toBe(true);
    expect(result2.fromCache).toBe(true);
  });

  test("bypasses cache with noCache option", async () => {
    const url = "https://jsonplaceholder.typicode.com/posts/1";

    // First fetch - populate cache
    const result1 = await fetchRemote(url);
    if (!result1.success) {
      // Skip test if network is unavailable
      return;
    }

    // Second fetch with noCache - should not use cache
    const result2 = await fetchRemote(url, { noCache: true });
    expect(result2.success).toBe(true);
    expect(result2.fromCache).toBe(false);
  });
});
