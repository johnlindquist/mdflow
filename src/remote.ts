/**
 * Remote execution support for running agents from URLs
 * Enables npx-style execution: md https://gist.github.com/user/setup.md
 */

import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { resilientFetch } from "./fetch";
import {
  getCachedContent,
  setCachedContent,
  DEFAULT_CACHE_TTL_MS,
  type CacheOptions,
} from "./cache";

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
  // GitHub Gist
  if (url.includes("gist.github.com")) {
    // https://gist.github.com/user/id -> https://gist.githubusercontent.com/user/id/raw
    const match = url.match(/gist\.github\.com\/([^\/]+)\/([a-f0-9]+)/);
    if (match) {
      return `https://gist.githubusercontent.com/${match[1]}/${match[2]}/raw`;
    }
  }

  // GitHub blob URL
  // https://github.com/user/repo/blob/branch/path -> https://raw.githubusercontent.com/user/repo/branch/path
  if (url.includes("github.com") && url.includes("/blob/")) {
    return url
      .replace("github.com", "raw.githubusercontent.com")
      .replace("/blob/", "/");
  }

  // GitLab raw
  if (url.includes("gitlab.com") && url.includes("/-/blob/")) {
    return url.replace("/-/blob/", "/-/raw/");
  }

  return url;
}

/**
 * Fetch remote content and save to temporary file
 * Returns the local path to the temporary file
 *
 * Uses persistent cache at ~/.mdflow/cache/ to avoid repeated fetches.
 * Cache uses SHA-256 hash of URL as filename with configurable TTL.
 */
export async function fetchRemote(
  url: string,
  options: FetchRemoteOptions = {}
): Promise<RemoteResult> {
  if (!isRemoteUrl(url)) {
    return { success: true, localPath: url, isRemote: false };
  }

  const { noCache = false, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = options;
  const rawUrl = toRawUrl(url);

  try {
    // Check cache first (unless noCache is set)
    const cacheResult = await getCachedContent(rawUrl, {
      noCache,
      ttlMs: cacheTtlMs,
    });

    let content: string;
    let fromCache = false;

    if (cacheResult.hit && cacheResult.content) {
      // Cache hit - use cached content
      console.error(`Cache hit: ${rawUrl}`);
      content = cacheResult.content;
      fromCache = true;
    } else {
      // Cache miss or expired - fetch fresh content
      if (cacheResult.expired) {
        console.error(`Cache expired, refetching: ${rawUrl}`);
      } else {
        console.error(`Fetching: ${rawUrl}`);
      }

      const response = await resilientFetch(rawUrl, {
        headers: {
          "User-Agent": "mdflow/1.0",
          Accept: "text/plain, text/markdown, */*",
        },
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          isRemote: true,
        };
      }

      content = await response.text();

      // Store in cache for future use
      await setCachedContent(rawUrl, content, { ttlMs: cacheTtlMs });
    }

    // Create temp directory for the execution
    const tempDir = await mkdtemp(join(tmpdir(), "mdflow-"));
    const fileName = extractFileName(url) || "remote.md";
    const localPath = join(tempDir, fileName);

    // Write content to temp file
    await Bun.write(localPath, content);

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
  try {
    const tempDir = join(localPath, "..");
    await rm(tempDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

