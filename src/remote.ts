/**
 * Remote execution support for running agents from URLs
 * Enables npx-style execution: md https://gist.github.com/user/setup.md
 *
 * Supports HTTP conditional requests (ETag/Last-Modified) for efficient
 * cache revalidation without re-downloading unchanged content.
 */

import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { fetchTextResource } from "./fetch";
import {
  getCachedContent,
  setCachedContent,
  DEFAULT_CACHE_TTL_MS,
} from "./cache";

const ownedDownloads = new Map<string, string>();

export interface RemoteResult {
  success: boolean;
  localPath?: string;
  error?: string;
  isRemote: boolean;
  /** Whether the content was served from cache */
  fromCache?: boolean;
}

export interface FetchRemoteOptions {
  /** Skip cache and fetch fresh content */
  noCache?: boolean;
  /** Custom TTL for cache (default: 1 hour) */
  cacheTtlMs?: number;
}

/**
 * Check if a path is a remote URL
 */
export function isRemoteUrl(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

/**
 * Convert GitHub URLs to raw content URLs
 */
export function toRawUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return url;
  if (parsed.hostname === "gist.github.com") {
    const match = parsed.pathname.match(/^\/([^/]+)\/([a-f0-9]+)\/?$/i);
    if (match) return `https://gist.githubusercontent.com/${match[1]}/${match[2]}/raw`;
  }
  if (parsed.hostname === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(parsed.pathname)) {
    parsed.hostname = "raw.githubusercontent.com";
    parsed.pathname = parsed.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/");
    return parsed.href;
  }
  if (parsed.hostname === "gitlab.com" && parsed.pathname.includes("/-/blob/")) {
    parsed.pathname = parsed.pathname.replace("/-/blob/", "/-/raw/");
    return parsed.href;
  }
  return url;
}

/**
 * Fetch remote content and save to temporary file
 * Returns the local path to the temporary file
 *
 * Uses persistent cache at ~/.mdflow/cache/ to avoid repeated fetches.
 * Cache uses SHA-256 hash of URL as filename with configurable TTL.
 *
 * Supports HTTP conditional requests:
 * - If cache has ETag, sends If-None-Match header
 * - If cache has Last-Modified, sends If-Modified-Since header
 * - On 304 Not Modified, reuses cached content and refreshes TTL
 */
export async function fetchRemote(
  url: string,
  options: FetchRemoteOptions = {}
): Promise<RemoteResult> {
  if (!isRemoteUrl(url)) {
    return { success: true, localPath: url, isRemote: false };
  }

  const { noCache = false, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = options;
  try {
    const rawUrl = toRawUrl(url);
    // Check cache first (unless noCache is set)
    const cacheResult = await getCachedContent(rawUrl, {
      noCache,
      ttlMs: cacheTtlMs,
    });

    let content: string;
    let fromCache = false;

    if (cacheResult.hit && cacheResult.content !== undefined) {
      // Cache hit and not expired - use cached content
      console.error(`Cache hit: ${rawUrl}`);
      content = cacheResult.content;
      fromCache = true;
    } else {
      // Cache miss or expired - fetch (with conditional request if we have cached data)
      const headers: Record<string, string> = {
        "User-Agent": "mdflow/1.0",
        Accept: "text/plain, text/markdown, */*",
      };

      // Add conditional request headers if we have cached metadata
      const cachedMeta = cacheResult.metadata;
      if (cachedMeta?.etag) {
        headers["If-None-Match"] = cachedMeta.etag;
      }
      if (cachedMeta?.lastModified) {
        headers["If-Modified-Since"] = cachedMeta.lastModified;
      }

      if (cacheResult.expired && (cachedMeta?.etag || cachedMeta?.lastModified)) {
        console.error(`Cache expired, validating: ${rawUrl}`);
      } else if (cacheResult.expired) {
        console.error(`Cache expired, refetching: ${rawUrl}`);
      } else {
        console.error(`Fetching: ${rawUrl}`);
      }

      const response = await fetchTextResource(rawUrl, { headers });

      // Handle 304 Not Modified - content hasn't changed
      if (response.status === 304 && cacheResult.metadata && cacheResult.content !== undefined) {
        console.error(`Not modified (304), using cache: ${rawUrl}`);

        // Reuse the digest-checked snapshot that supplied the validators.
        content = cacheResult.content;
        await setCachedContent(rawUrl, content, {
          ttlMs: cacheTtlMs, etag: response.headers.get("etag") ?? cachedMeta?.etag,
          lastModified: response.headers.get("last-modified") ?? cachedMeta?.lastModified,
        });
        fromCache = true;
      } else if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          isRemote: true,
        };
      } else {
        // New content - extract cache headers and store
        content = response.text;

        const etag = response.headers.get("etag") || undefined;
        const lastModified = response.headers.get("last-modified") || undefined;

        // Store in cache for future use with HTTP headers
        await setCachedContent(rawUrl, content, {
          ttlMs: cacheTtlMs,
          etag,
          lastModified,
        });
      }
    }

    // Create temp directory for the execution
    const tempDir = await mkdtemp(join(tmpdir(), "mdflow-"));
    const fileName = extractFileName(url) || "remote.md";
    const localPath = join(tempDir, fileName);

    // Write content to temp file
    try { await Bun.write(localPath, content); } catch (err) { await rm(tempDir, { recursive: true, force: true }); throw err; }
    ownedDownloads.set(localPath, tempDir);

    if (!fromCache) {
      console.error(`Saved to: ${localPath}`);
    }

    return { success: true, localPath, isRemote: true, fromCache };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
      isRemote: true,
    };
  }
}

/**
 * Extract filename from URL
 */
function extractFileName(url: string): string | null {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/");
  const lastPart = pathParts[pathParts.length - 1];

  if (lastPart && (lastPart.endsWith(".md") || lastPart.endsWith(".ag"))) {
    return lastPart;
  }

  return null;
}

/**
 * Cleanup temporary remote file
 */
export async function cleanupRemote(localPath: string): Promise<void> {
  const dir = ownedDownloads.get(localPath);
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
  ownedDownloads.delete(localPath);
}

