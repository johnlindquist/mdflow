import { describe, it, expect, mock, beforeEach, afterEach, test } from "bun:test";

// Skip network-dependent tests in CI environments to avoid flakiness
const isCI = process.env.CI === "true";
const describeNetwork = isCI ? describe.skip : describe;
import {
  fetchWithTimeout,
  fetchWithRetry,
  resilientFetch,
  isRetryableError,
  isRetryableStatus,
  calculateBackoffDelay,
  FetchTimeoutError,
  FetchRetryError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRY_CONFIG,
} from "./fetch";

describe("fetch utilities", () => {
  describe("isRetryableError", () => {
    it("returns true for FetchTimeoutError", () => {
      const error = new FetchTimeoutError("http://example.com", 1000);
      expect(isRetryableError(error)).toBe(true);
    });

    it("returns true for network-related error messages", () => {
      const networkErrors = [
        new Error("Network error"),
        new Error("ECONNRESET"),
        new Error("ECONNREFUSED: Connection refused"),
        new Error("ETIMEDOUT"),
        new Error("ENOTFOUND: getaddrinfo"),
        new Error("Socket closed"),
        new Error("Request aborted"),
      ];

      for (const error of networkErrors) {
        expect(isRetryableError(error)).toBe(true);
      }
    });

    it("returns false for non-retryable errors", () => {
      const nonRetryableErrors = [
        new Error("Not found"),
        new Error("Unauthorized"),
        new Error("Bad request"),
        new SyntaxError("Unexpected token"),
      ];

      for (const error of nonRetryableErrors) {
        expect(isRetryableError(error)).toBe(false);
      }
    });
  });

  describe("isRetryableStatus", () => {
    it("returns true for 5xx status codes", () => {
      expect(isRetryableStatus(500)).toBe(true);
      expect(isRetryableStatus(502)).toBe(true);
      expect(isRetryableStatus(503)).toBe(true);
      expect(isRetryableStatus(504)).toBe(true);
      expect(isRetryableStatus(599)).toBe(true);
    });

    it("returns true for 429 Too Many Requests", () => {
      expect(isRetryableStatus(429)).toBe(true);
    });

    it("returns false for other status codes", () => {
      expect(isRetryableStatus(200)).toBe(false);
      expect(isRetryableStatus(201)).toBe(false);
      expect(isRetryableStatus(301)).toBe(false);
      expect(isRetryableStatus(400)).toBe(false);
      expect(isRetryableStatus(401)).toBe(false);
      expect(isRetryableStatus(403)).toBe(false);
      expect(isRetryableStatus(404)).toBe(false);
    });
  });

  describe("calculateBackoffDelay", () => {
    it("calculates exponential backoff correctly", () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        backoffMultiplier: 2,
        maxRetries: 3,
      };

      // First retry: ~1000ms (with jitter)
      const delay0 = calculateBackoffDelay(0, config);
      expect(delay0).toBeGreaterThanOrEqual(900);
      expect(delay0).toBeLessThanOrEqual(1100);

      // Second retry: ~2000ms (with jitter)
      const delay1 = calculateBackoffDelay(1, config);
      expect(delay1).toBeGreaterThanOrEqual(1800);
      expect(delay1).toBeLessThanOrEqual(2200);

      // Third retry: ~4000ms (with jitter)
      const delay2 = calculateBackoffDelay(2, config);
      expect(delay2).toBeGreaterThanOrEqual(3600);
      expect(delay2).toBeLessThanOrEqual(4400);
    });

    it("respects maxDelayMs", () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 3000,
        backoffMultiplier: 2,
        maxRetries: 5,
      };

      // 5th retry would be 16000ms but capped at 3000ms
      const delay = calculateBackoffDelay(4, config);
      expect(delay).toBeLessThanOrEqual(3300); // 3000 + 10% jitter
    });
  });

  describe("FetchTimeoutError", () => {
    it("has correct name and message", () => {
      const error = new FetchTimeoutError("http://example.com/api", 5000);
      expect(error.name).toBe("FetchTimeoutError");
      expect(error.message).toBe("Request to http://example.com/api timed out after 5000ms");
      expect(error instanceof Error).toBe(true);
    });
  });

  describe("FetchRetryError", () => {
    it("has correct name, message, and properties", () => {
      const lastError = new Error("Connection refused");
      const error = new FetchRetryError("http://example.com/api", 3, lastError);
      expect(error.name).toBe("FetchRetryError");
      expect(error.message).toBe(
        "Request to http://example.com/api failed after 3 attempts: Connection refused"
      );
      expect(error.attempts).toBe(3);
      expect(error.lastError).toBe(lastError);
      expect(error instanceof Error).toBe(true);
    });
  });

  describeNetwork("fetchWithTimeout", () => {
    it("successfully fetches when request completes before timeout", async () => {
      // Use jsonplaceholder - reliable and fast
      const response = await fetchWithTimeout("https://jsonplaceholder.typicode.com/posts/1", {
        timeoutMs: 10000,
      });
      expect(response.ok).toBe(true);
    });

    it("throws FetchTimeoutError when request exceeds timeout", async () => {
      // Use an unreachable IP to trigger timeout (10.255.255.1 is non-routable)
      try {
        await fetchWithTimeout("http://10.255.255.1:12345/", {
          timeoutMs: 100,
        });
        expect.unreachable("Should have thrown FetchTimeoutError");
      } catch (error) {
        expect(error instanceof FetchTimeoutError).toBe(true);
        expect((error as FetchTimeoutError).message).toContain("timed out after 100ms");
      }
    });
  });

  describe("fetchWithTimeout constants", () => {
    it("uses default timeout when not specified", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(10000);
    });
  });

  describeNetwork("fetchWithRetry", () => {
    it("succeeds on first attempt for successful requests", async () => {
      const response = await fetchWithRetry("https://jsonplaceholder.typicode.com/posts/1", {
        retry: { maxRetries: 3 },
      });
      expect(response.ok).toBe(true);
    });

    it("returns response for non-retryable 4xx errors without retrying", async () => {
      // jsonplaceholder returns 404 for non-existent posts
      const response = await fetchWithRetry("https://jsonplaceholder.typicode.com/posts/99999999", {
        retry: { maxRetries: 3 },
      });
      expect(response.status).toBe(404);
    });

    it("can disable retries with retry: false", async () => {
      const response = await fetchWithRetry("https://jsonplaceholder.typicode.com/posts/1", {
        retry: false,
      });
      expect(response.ok).toBe(true);
    });
  });

  describe("fetchWithRetry constants", () => {
    it("uses default retry config when not specified", () => {
      expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(1000);
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(10000);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    });
  });

  describeNetwork("resilientFetch", () => {
    it("successfully fetches with both timeout and retry protection", async () => {
      const response = await resilientFetch("https://jsonplaceholder.typicode.com/posts/1", {
        timeoutMs: 10000,
        retry: { maxRetries: 2 },
      });
      expect(response.ok).toBe(true);
    });

    it("handles 404 response (non-retryable)", async () => {
      const response = await resilientFetch("https://jsonplaceholder.typicode.com/posts/99999999");
      expect(response.status).toBe(404);
      expect(response.ok).toBe(false);
    });

    it("can disable retries with retry: false", async () => {
      const response = await resilientFetch("https://jsonplaceholder.typicode.com/posts/1", {
        retry: false,
      });
      expect(response.ok).toBe(true);
    });

    it("throws FetchTimeoutError on timeout", async () => {
      try {
        // Use unreachable IP to trigger timeout
        await resilientFetch("http://10.255.255.1:12345/", {
          timeoutMs: 100,
          retry: false, // Disable retries to speed up test
        });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error instanceof FetchTimeoutError).toBe(true);
      }
    });

    it("throws FetchRetryError after exhausting retries on timeout", async () => {
      try {
        // Use unreachable IP to trigger timeout
        await resilientFetch("http://10.255.255.1:12345/", {
          timeoutMs: 100,
          retry: { maxRetries: 1, initialDelayMs: 50 },
        });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error instanceof FetchRetryError).toBe(true);
        const retryError = error as FetchRetryError;
        expect(retryError.attempts).toBe(2); // Initial + 1 retry
        expect(retryError.lastError instanceof FetchTimeoutError).toBe(true);
      }
    });
  });

  describeNetwork("integration with mdflow use cases", () => {
    it("fetches GitHub raw content", async () => {
      // Test fetching a well-known, stable GitHub file
      const response = await resilientFetch(
        "https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore",
        {
          headers: {
            "User-Agent": "mdflow/1.0",
            "Accept": "text/plain, text/markdown, */*",
          },
        }
      );
      expect(response.ok).toBe(true);
      const content = await response.text();
      expect(content).toContain("node_modules");
    });

    it("handles JSON response", async () => {
      const response = await resilientFetch("https://jsonplaceholder.typicode.com/posts/1", {
        headers: {
          Accept: "application/json",
        },
      });
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toBeDefined();
      expect(data.id).toBe(1);
    });
  });
});
