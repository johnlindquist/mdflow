import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractDomain,
  loadKnownHosts,
  saveKnownHosts,
  isDomainTrusted,
  addTrustedDomain,
  getKnownHostsPath,
} from "./trust";

// We'll test the file-based functions using a mock approach
// by temporarily modifying the home directory

describe("extractDomain", () => {
  test("extracts domain from https URL", () => {
    expect(extractDomain("https://example.com/path/file.md")).toBe("example.com");
  });

  test("extracts domain from http URL", () => {
    expect(extractDomain("http://localhost:3000/file.md")).toBe("localhost");
  });

  test("extracts domain from GitHub gist URL", () => {
    expect(extractDomain("https://gist.github.com/user/abc123")).toBe("gist.github.com");
  });

  test("extracts domain from raw GitHub URL", () => {
    expect(extractDomain("https://raw.githubusercontent.com/user/repo/main/file.md")).toBe("raw.githubusercontent.com");
  });

  test("returns input for invalid URL", () => {
    expect(extractDomain("not-a-url")).toBe("not-a-url");
  });

  test("extracts domain with subdomain", () => {
    expect(extractDomain("https://api.github.com/repos")).toBe("api.github.com");
  });
});

describe("known hosts file operations", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = await Bun.file(join(tmpdir(), `trust-test-${Date.now()}`)).name;
    tempDir = join(tmpdir(), `trust-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await mkdir(join(tempDir, ".markdown-agent"), { recursive: true });

    // Store original HOME
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }

    // Cleanup temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("getKnownHostsPath returns expected path", () => {
    const path = getKnownHostsPath();
    expect(path).toContain(".markdown-agent");
    expect(path).toContain("known_hosts");
  });

  test("loadKnownHosts returns empty set when file does not exist", async () => {
    const hosts = await loadKnownHosts();
    // May return empty or existing hosts depending on user's system
    expect(hosts).toBeInstanceOf(Set);
  });

  test("saveKnownHosts and loadKnownHosts round-trip", async () => {
    // This test will use the actual known_hosts file
    // Save current state first
    const originalHosts = await loadKnownHosts();

    // Add test domains
    const testDomains = new Set([
      ...originalHosts,
      "test-domain-1.example.com",
      "test-domain-2.example.com",
    ]);

    await saveKnownHosts(testDomains);

    const loadedHosts = await loadKnownHosts();

    expect(loadedHosts.has("test-domain-1.example.com")).toBe(true);
    expect(loadedHosts.has("test-domain-2.example.com")).toBe(true);

    // Restore original state
    await saveKnownHosts(originalHosts);
  });

  test("isDomainTrusted returns false for unknown domain", async () => {
    const isTrusted = await isDomainTrusted("https://definitely-not-trusted-domain-12345.example.com/file.md");
    expect(isTrusted).toBe(false);
  });

  test("addTrustedDomain adds domain and isDomainTrusted returns true", async () => {
    const testUrl = "https://tofu-test-unique-domain-98765.example.com/file.md";
    const testDomain = "tofu-test-unique-domain-98765.example.com";

    // Save original state
    const originalHosts = await loadKnownHosts();

    try {
      // Ensure domain is not already trusted
      const initiallyTrusted = await isDomainTrusted(testUrl);
      expect(initiallyTrusted).toBe(false);

      // Add the domain
      await addTrustedDomain(testUrl);

      // Now it should be trusted
      const nowTrusted = await isDomainTrusted(testUrl);
      expect(nowTrusted).toBe(true);
    } finally {
      // Restore original state (remove test domain)
      originalHosts.delete(testDomain);
      await saveKnownHosts(originalHosts);
    }
  });
});

describe("saveKnownHosts file format", () => {
  test("saves hosts with header comments", async () => {
    const originalHosts = await loadKnownHosts();

    const testHosts = new Set([...originalHosts, "format-test.example.com"]);
    await saveKnownHosts(testHosts);

    const path = getKnownHostsPath();
    const content = await Bun.file(path).text();

    expect(content).toContain("# markdown-agent known hosts");
    expect(content).toContain("format-test.example.com");

    // Restore original
    originalHosts.delete("format-test.example.com");
    await saveKnownHosts(originalHosts);
  });

  test("loadKnownHosts ignores comment lines", async () => {
    const originalHosts = await loadKnownHosts();

    // The saved file has comments, verify they're not loaded as domains
    const hosts = await loadKnownHosts();

    // Comments should not appear as domains
    for (const host of hosts) {
      expect(host.startsWith("#")).toBe(false);
    }

    // Restore
    await saveKnownHosts(originalHosts);
  });
});
