/**
 * Persistent cache module for remote URL content
 *
 * Stores fetched remote content in ~/.mdflow/cache/ using SHA-256 hashes
 * of URLs as filenames. Implements TTL-based cache expiration.
 */

import { mkdir, stat, readFile, writeFile, rm, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

/** Default TTL for cached content (1 hour in milliseconds) */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** Cache directory path */
export const CACHE_DIR = join(homedir(), ".mdflow", "cache");

/** Cache entry metadata stored alongside content */
export interface CacheMetadata {
  url: string;
  fetchedAt: number;
  ttlMs: number;
}

/** Result of a cache lookup */
export interface CacheResult {
  hit: boolean;
  content?: string;
  metadata?: CacheMetadata;
  expired?: boolean;
}

/** Options for cache operations */
export interface CacheOptions {
  /** Time-to-live in milliseconds (default: 1 hour) */
  ttlMs?: number;
  /** Force bypass cache on read (still writes to cache) */
  noCache?: boolean;
}

/**
 * Generate a SHA-256 hash of a URL for use as a cache filename
 */
export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Ensure the cache directory exists
 */
export async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
}

/**
 * Get the file paths for a cached URL
 */
function getCachePaths(url: string): { contentPath: string; metadataPath: string } {
  const hash = hashUrl(url);
  return {
    contentPath: join(CACHE_DIR, `${hash}.content`),
    metadataPath: join(CACHE_DIR, `${hash}.meta.json`),
  };
}

/**
 * Check if a cache entry exists and is valid (not expired)
 */
export async function getCachedContent(
  url: string,
  options: CacheOptions = {}
): Promise<CacheResult> {
  const { ttlMs = DEFAULT_CACHE_TTL_MS, noCache = false } = options;

  // If noCache is set, always return miss
  if (noCache) {
    return { hit: false };
  }

  const { contentPath, metadataPath } = getCachePaths(url);

  try {
    // Read metadata first to check expiration
    const metadataRaw = await readFile(metadataPath, "utf-8");
    const metadata: CacheMetadata = JSON.parse(metadataRaw);

    // Check if cache is expired
    const now = Date.now();
    const age = now - metadata.fetchedAt;
    const effectiveTtl = metadata.ttlMs || ttlMs;

    if (age > effectiveTtl) {
      return { hit: false, metadata, expired: true };
    }

    // Read content
    const content = await readFile(contentPath, "utf-8");

    return { hit: true, content, metadata };
  } catch (error) {
    // Cache miss - file doesn't exist or is corrupted
    return { hit: false };
  }
}

/**
 * Store content in the cache
 */
export async function setCachedContent(
  url: string,
  content: string,
  options: CacheOptions = {}
): Promise<void> {
  const { ttlMs = DEFAULT_CACHE_TTL_MS } = options;

  await ensureCacheDir();

  const { contentPath, metadataPath } = getCachePaths(url);

  const metadata: CacheMetadata = {
    url,
    fetchedAt: Date.now(),
    ttlMs,
  };

  // Write both files
  await Promise.all([
    writeFile(contentPath, content, "utf-8"),
    writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8"),
  ]);
}

/**
 * Invalidate a specific cache entry
 */
export async function invalidateCacheEntry(url: string): Promise<boolean> {
  const { contentPath, metadataPath } = getCachePaths(url);

  try {
    await Promise.all([
      rm(contentPath, { force: true }),
      rm(metadataPath, { force: true }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear all expired cache entries
 */
export async function clearExpiredCache(): Promise<number> {
  let cleared = 0;

  try {
    await ensureCacheDir();
    const files = await readdir(CACHE_DIR);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));

    for (const metaFile of metaFiles) {
      const metadataPath = join(CACHE_DIR, metaFile);

      try {
        const metadataRaw = await readFile(metadataPath, "utf-8");
        const metadata: CacheMetadata = JSON.parse(metadataRaw);

        const now = Date.now();
        const age = now - metadata.fetchedAt;

        if (age > metadata.ttlMs) {
          const hash = metaFile.replace(".meta.json", "");
          const contentPath = join(CACHE_DIR, `${hash}.content`);

          await Promise.all([
            rm(contentPath, { force: true }),
            rm(metadataPath, { force: true }),
          ]);
          cleared++;
        }
      } catch {
        // Skip corrupted entries
      }
    }
  } catch {
    // Cache directory doesn't exist or can't be read
  }

  return cleared;
}

/**
 * Clear all cache entries
 */
export async function clearAllCache(): Promise<number> {
  let cleared = 0;

  try {
    const files = await readdir(CACHE_DIR);

    for (const file of files) {
      try {
        await rm(join(CACHE_DIR, file), { force: true });
        cleared++;
      } catch {
        // Skip files that can't be removed
      }
    }
  } catch {
    // Cache directory doesn't exist
  }

  return cleared;
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  entries: number;
  totalSize: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}> {
  let entries = 0;
  let totalSize = 0;
  let oldestEntry: number | null = null;
  let newestEntry: number | null = null;

  try {
    await ensureCacheDir();
    const files = await readdir(CACHE_DIR);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));

    for (const metaFile of metaFiles) {
      const metadataPath = join(CACHE_DIR, metaFile);
      const hash = metaFile.replace(".meta.json", "");
      const contentPath = join(CACHE_DIR, `${hash}.content`);

      try {
        const metadataRaw = await readFile(metadataPath, "utf-8");
        const metadata: CacheMetadata = JSON.parse(metadataRaw);

        const contentStat = await stat(contentPath);
        totalSize += contentStat.size;
        entries++;

        if (oldestEntry === null || metadata.fetchedAt < oldestEntry) {
          oldestEntry = metadata.fetchedAt;
        }
        if (newestEntry === null || metadata.fetchedAt > newestEntry) {
          newestEntry = metadata.fetchedAt;
        }
      } catch {
        // Skip corrupted entries
      }
    }
  } catch {
    // Cache directory doesn't exist
  }

  return { entries, totalSize, oldestEntry, newestEntry };
}
