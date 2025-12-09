/**
 * Fetch utilities with timeout and retry support
 *
 * Provides resilient fetch operations with:
 * - AbortController-based timeouts (default: 10 seconds)
 * - Exponential backoff retry for transient failures (default: 3 retries, starting at 1s)
 */

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
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
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
  const { retry = {}, ...fetchOptions } = options;

  // If retry is explicitly disabled
  if (retry === false) {
    return fetch(url, fetchOptions);
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
      const response = await fetch(url, fetchOptions);

      // Check for retryable HTTP status
      if (isRetryableStatus(response.status) && attempt < config.maxRetries) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        attempt++;
        const delay = calculateBackoffDelay(attempt - 1, config);
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isRetryableError(error) && attempt < config.maxRetries) {
        attempt++;
        const delay = calculateBackoffDelay(attempt - 1, config);
        await sleep(delay);
        continue;
      }

      // Non-retryable error or exhausted retries
      break;
    }
  }

  throw new FetchRetryError(url, attempt + 1, lastError);
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
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        attempt++;
        const delay = calculateBackoffDelay(attempt - 1, config);
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isRetryableError(error) && attempt < config.maxRetries) {
        attempt++;
        const delay = calculateBackoffDelay(attempt - 1, config);
        await sleep(delay);
        continue;
      }

      // Non-retryable error or exhausted retries
      break;
    }
  }

  throw new FetchRetryError(url, attempt + 1, lastError);
}
