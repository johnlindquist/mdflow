/**
 * Fetch utilities with timeout and retry support
 *
 * Provides resilient fetch operations with:
 * - AbortController-based timeouts (default: 10 seconds)
 * - Exponential backoff retry for transient failures (default: 3 retries, starting at 1s)
 */

import { setTimeout as delay } from "node:timers/promises";
import { MAX_INPUT_SIZE } from "./limits";
import { getTimeoutConfig } from "./process-manager";
import { validateUrl, type ValidateUrlOptions } from "./security";

/** Default timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
};

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay between retries in ms (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay between retries in ms (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
}

export interface FetchOptions extends RequestInit {
  fetchFn?: typeof fetch;
  /** Timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Retry configuration */
  retry?: RetryConfig | false;
}

/**
 * Custom error class for timeout errors
 */
export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
  }
}

/**
 * Custom error class for retry exhaustion
 */
export class FetchRetryError extends Error {
  public readonly attempts: number;
  public readonly lastError: Error;

  constructor(url: string, attempts: number, lastError: Error) {
    super(`Request to ${url} failed after ${attempts} attempts: ${lastError.message}`);
    this.name = "FetchRetryError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Determine if an error is retryable
 *
 * Retryable conditions:
 * - Network errors (fetch throws)
 * - Timeout errors
 * - 5xx server errors
 * - 429 Too Many Requests
 */
export function isRetryableError(error: unknown): boolean {
  // Network/timeout errors are retryable
  if (error instanceof FetchTimeoutError) {
    return true;
  }

  // Type errors from fetch (network issues) are retryable
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }

  // Generic network errors
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("network") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("enotfound") ||
      message.includes("socket") ||
      message.includes("abort")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an HTTP response status is retryable
 */
export function isRetryableStatus(status: number): boolean {
  // 5xx server errors
  if (status >= 500 && status < 600) {
    return true;
  }
  // 429 Too Many Requests
  if (status === 429) {
    return true;
  }
  return false;
}

/**
 * Calculate delay for a given retry attempt with exponential backoff
 */
export function calculateBackoffDelay(
  attempt: number,
  config: Required<RetryConfig>
): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  // Add jitter (±10%) to prevent thundering herd
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, config.maxDelayMs);
}

/**
 * Fetch with timeout support using AbortController
 *
 * @param url - URL to fetch
 * @param options - Fetch options including timeoutMs
 * @returns Response object
 * @throws FetchTimeoutError if the request times out
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch, signal: caller, retry: _retry, ...init } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  try {
    return await fetchFn(url, { ...init, signal });
  } catch (cause) {
    if (caller?.aborted) throw caller.reason;
    if (timeout.aborted) throw new FetchTimeoutError(url, timeoutMs);
    throw cause;
  }
}

/**
 * Fetch with retry support using exponential backoff
 *
 * @param url - URL to fetch
 * @param options - Fetch options including retry configuration
 * @returns Response object
 * @throws FetchRetryError if all retry attempts are exhausted
 */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  return resilientFetch(url, options);
}

/**
 * Resilient fetch with both timeout and retry support
 *
 * This is the recommended function for network requests in mdflow.
 * It combines timeout protection (to prevent hanging on tarpits) with
 * exponential backoff retry (to handle transient failures).
 *
 * @param url - URL to fetch
 * @param options - Fetch options including timeoutMs and retry configuration
 * @returns Response object
 * @throws FetchTimeoutError if any single request times out
 * @throws FetchRetryError if all retry attempts are exhausted
 *
 * @example
 * ```typescript
 * // Default: 10s timeout, 3 retries with exponential backoff starting at 1s
 * const response = await resilientFetch("https://example.com/api");
 *
 * // Custom configuration
 * const response = await resilientFetch("https://example.com/api", {
 *   timeoutMs: 5000,
 *   retry: { maxRetries: 5, initialDelayMs: 500 },
 *   headers: { "Accept": "application/json" },
 * });
 *
 * // Disable retries
 * const response = await resilientFetch("https://example.com/api", {
 *   retry: false,
 * });
 * ```
 */
export async function resilientFetch(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { retry = {}, timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  // If retry is explicitly disabled
  if (retry === false) {
    return fetchWithTimeout(url, { timeoutMs, ...fetchOptions });
  }

  const config: Required<RetryConfig> = {
    maxRetries: retry.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    initialDelayMs: retry.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
    maxDelayMs: retry.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    backoffMultiplier: retry.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier,
  };

  let lastError: Error = new Error("No attempts made");
  let attempt = 0;

  while (attempt <= config.maxRetries) {
    try {
      const response = await fetchWithTimeout(url, { timeoutMs, ...fetchOptions });

      // Check for retryable HTTP status
      if (isRetryableStatus(response.status) && attempt < config.maxRetries) {
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        attempt++;
        await delay(calculateBackoffDelay(attempt - 1, config), undefined, { signal: options.signal ?? undefined });
        continue;
      }

      return response;
    } catch (error) {
      options.signal?.throwIfAborted();
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isRetryableError(error) && attempt < config.maxRetries) {
        attempt++;
        await delay(calculateBackoffDelay(attempt - 1, config), undefined, { signal: options.signal ?? undefined });
        continue;
      }

      // Non-retryable error or exhausted retries
      break;
    }
  }

  throw new FetchRetryError(url, attempt + 1, lastError);
}

/** Download a flow or context as bounded UTF-8. The deadline covers headers,
 * redirects, retry delays AND the final chunk; no redirect is followed before
 * checking its destination. Executable downloads default to same-origin. */
export async function fetchTextResource(url: string, opts: {
  policy?: ValidateUrlOptions; headers?: Record<string, string>; fetchFn?: typeof fetch;
  timeoutMs?: number; maxBytes?: number;
} = {}) {
  const timeoutMs = opts.timeoutMs ?? getTimeoutConfig().fetchTimeout;
  const signal = AbortSignal.timeout(timeoutMs);
  const limit = opts.maxBytes ?? MAX_INPUT_SIZE;
  const initial = validateUrl(url, opts.policy ?? {});
  let current = initial;
  try {
    for (let hops = 0; ; hops++) {
      const response = await resilientFetch(current.href, { headers: opts.headers, redirect: "manual", signal, timeoutMs, fetchFn: opts.fetchFn });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hops >= 5) throw new Error("Missing location or too many redirects");
        current = validateUrl(new URL(location, current).href, opts.policy ?? {});
        if (!opts.policy && current.origin !== initial.origin) throw new Error("Cross-origin flow redirect refused; use the final URL explicitly");
        continue;
      }
      const tooLarge = () => new Error(`Download exceeds the ${limit} byte limit`);
      if (response.ok && Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel(); throw tooLarge();
      }
      const chunks: Uint8Array[] = [];
      if (response.ok && response.body) {
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > limit) throw tooLarge();
          chunks.push(chunk);
        }
      } else { await response.body?.cancel(); }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      return { ok: response.ok, status: response.status, statusText: response.statusText, headers: response.headers, text };
    }
  } catch (cause) {
    if (signal.aborted) throw new FetchTimeoutError(initial.href, timeoutMs);
    throw cause;
  }
}
