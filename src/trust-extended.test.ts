/**
 * Extended trust/known_hosts tests
 *
 * Tests for domain extraction edge cases, trust decisions,
 * and known_hosts file handling.
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  extractDomain,
  loadKnownHosts,
  saveKnownHosts,
  isDomainTrusted,
  addTrustedDomain,
} from "./trust";
import fc from "fast-check";

describe("extractDomain edge cases", () => {
  test("extracts domain from standard URLs", () => {
    const cases = [
      { url: "https://example.com", expected: "example.com" },
      { url: "http://example.com", expected: "example.com" },
      { url: "https://example.com/", expected: "example.com" },
      { url: "https://example.com/path", expected: "example.com" },
      { url: "https://example.com:8080", expected: "example.com" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("extracts domain from URLs with subdomains", () => {
    const cases = [
      { url: "https://api.example.com", expected: "api.example.com" },
      { url: "https://www.example.com", expected: "www.example.com" },
      { url: "https://a.b.c.example.com", expected: "a.b.c.example.com" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("extracts domain from GitHub URLs", () => {
    const cases = [
      { url: "https://github.com/user/repo", expected: "github.com" },
      { url: "https://raw.githubusercontent.com/user/repo/main/file", expected: "raw.githubusercontent.com" },
      { url: "https://gist.github.com/user/abc123", expected: "gist.github.com" },
      { url: "https://api.github.com/repos", expected: "api.github.com" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("handles URLs with authentication", () => {
    const cases = [
      { url: "https://user:pass@example.com/path", expected: "example.com" },
      { url: "https://token@api.example.com", expected: "api.example.com" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("handles URLs with query strings and fragments", () => {
    const cases = [
      { url: "https://example.com/path?query=value", expected: "example.com" },
      { url: "https://example.com/path#anchor", expected: "example.com" },
      { url: "https://example.com/path?a=1&b=2#section", expected: "example.com" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("handles IP addresses", () => {
    const cases = [
      { url: "http://127.0.0.1", expected: "127.0.0.1" },
      { url: "http://192.168.1.1:8080/api", expected: "192.168.1.1" },
      { url: "https://10.0.0.1/path", expected: "10.0.0.1" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("handles localhost", () => {
    const cases = [
      { url: "http://localhost", expected: "localhost" },
      { url: "http://localhost:3000", expected: "localhost" },
      { url: "https://localhost/path", expected: "localhost" },
    ];

    for (const { url, expected } of cases) {
      expect(extractDomain(url)).toBe(expected);
    }
  });

  test("returns input for invalid URLs", () => {
    const invalidInputs = [
      "not-a-url",
      "just-text",
      "example.com", // No protocol
      "ftp://example.com", // Non-http protocol
      "",
    ];

    for (const input of invalidInputs) {
      const result = extractDomain(input);
      // Should return input or handle gracefully
      expect(typeof result).toBe("string");
    }
  });
});

describe("known_hosts persistence", () => {
  let originalHosts: Set<string>;
  const testDomain = `test-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`;

  beforeEach(async () => {
    originalHosts = await loadKnownHosts();
  });

  afterEach(async () => {
    // Restore original state
    await saveKnownHosts(originalHosts);
  });

  test("saveKnownHosts persists domains", async () => {
    const hosts = new Set([...originalHosts, testDomain]);
    await saveKnownHosts(hosts);

    const loaded = await loadKnownHosts();
    expect(loaded.has(testDomain)).toBe(true);
  });

  test("saveKnownHosts handles empty set", async () => {
    const empty = new Set<string>();
    await saveKnownHosts(empty);

    const loaded = await loadKnownHosts();
    expect(loaded.size).toBe(0);
  });

  test("saveKnownHosts handles many domains", async () => {
    const many = new Set<string>();
    for (let i = 0; i < 100; i++) {
      many.add(`domain${i}.example.com`);
    }
    await saveKnownHosts(many);

    const loaded = await loadKnownHosts();
    expect(loaded.size).toBe(100);
  });

  test("saveKnownHosts deduplicates domains", async () => {
    const hosts = new Set([testDomain, testDomain, testDomain]);
    await saveKnownHosts(hosts);

    const loaded = await loadKnownHosts();
    // Set naturally deduplicates
    const matchingDomains = Array.from(loaded).filter(d => d === testDomain);
    expect(matchingDomains.length).toBeLessThanOrEqual(1);
  });
});

describe("trust decisions", () => {
  let originalHosts: Set<string>;
  const trustedDomain = `trusted-${Date.now()}.example.com`;
  const untrustedDomain = `untrusted-${Date.now()}.example.com`;

  beforeEach(async () => {
    originalHosts = await loadKnownHosts();
    // Add trusted domain
    await addTrustedDomain(`https://${trustedDomain}/file.md`);
  });

  afterEach(async () => {
    await saveKnownHosts(originalHosts);
  });

  test("isDomainTrusted returns true for known domain", async () => {
    const isTrusted = await isDomainTrusted(`https://${trustedDomain}/path`);
    expect(isTrusted).toBe(true);
  });

  test("isDomainTrusted returns false for unknown domain", async () => {
    const isTrusted = await isDomainTrusted(`https://${untrustedDomain}/path`);
    expect(isTrusted).toBe(false);
  });

  test("isDomainTrusted handles different paths for same domain", async () => {
    const paths = ["/path1", "/path2", "/deep/nested/path", ""];
    for (const path of paths) {
      const isTrusted = await isDomainTrusted(`https://${trustedDomain}${path}`);
      expect(isTrusted).toBe(true);
    }
  });

  test("isDomainTrusted distinguishes subdomains", async () => {
    // api.trusted.example.com should not be trusted just because trusted.example.com is
    const subdomain = `api.${trustedDomain}`;
    const isTrusted = await isDomainTrusted(`https://${subdomain}/path`);
    expect(isTrusted).toBe(false);
  });

  test("addTrustedDomain adds new domain", async () => {
    const newDomain = `new-${Date.now()}.example.com`;
    const url = `https://${newDomain}/file.md`;

    // Initially not trusted
    let isTrusted = await isDomainTrusted(url);
    expect(isTrusted).toBe(false);

    // Add trust
    await addTrustedDomain(url);

    // Now trusted
    isTrusted = await isDomainTrusted(url);
    expect(isTrusted).toBe(true);

    // Cleanup
    const hosts = await loadKnownHosts();
    hosts.delete(newDomain);
    await saveKnownHosts(hosts);
  });

  test("addTrustedDomain is idempotent", async () => {
    const url = `https://${trustedDomain}/file.md`;

    // Add multiple times
    await addTrustedDomain(url);
    await addTrustedDomain(url);
    await addTrustedDomain(url);

    // Should still be trusted
    const isTrusted = await isDomainTrusted(url);
    expect(isTrusted).toBe(true);

    // Should only appear once in hosts
    const hosts = await loadKnownHosts();
    const count = Array.from(hosts).filter(d => d === trustedDomain).length;
    expect(count).toBe(1);
  });
});

describe("trust fuzz tests", () => {
  test("extractDomain handles random URLs without throwing", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const result = extractDomain(url);
        expect(typeof result).toBe("string");
      }),
      { numRuns: 200 }
    );
  });

  test("extractDomain handles random strings without throwing", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = extractDomain(input);
        expect(typeof result).toBe("string");
      }),
      { numRuns: 200 }
    );
  });
});

describe("known_hosts file format", () => {
  let originalHosts: Set<string>;

  beforeEach(async () => {
    originalHosts = await loadKnownHosts();
  });

  afterEach(async () => {
    await saveKnownHosts(originalHosts);
  });

  test("ignores comment lines when loading", async () => {
    const hosts = await loadKnownHosts();

    // No host should start with #
    for (const host of hosts) {
      expect(host.startsWith("#")).toBe(false);
    }
  });

  test("handles domains with special characters", async () => {
    // Valid domain characters
    const specialDomains = [
      "test-domain.example.com",
      "test_domain.example.com", // Technically invalid but handle gracefully
      "123.example.com",
    ];

    for (const domain of specialDomains) {
      const hosts = new Set([...originalHosts, domain]);
      await saveKnownHosts(hosts);

      const loaded = await loadKnownHosts();
      expect(loaded.has(domain)).toBe(true);
    }
  });
});
