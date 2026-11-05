/**
 * Persistent cache module for remote URL content
 *
 * Stores fetched remote content in ~/.mdflow/cache/ using SHA-256 hashes
 * of URLs as filenames. Implements TTL-based cache expiration with
 * HTTP conditional request support (ETag/Last-Modified).
 */

import { mkdir, stat, readFile, writeFile, rm, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { atomicWriteFile } from "./state-file";
import { MAX_INPUT_SIZE } from "./limits";

/** Default TTL for cached content (1 hour in milliseconds) */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** Cache directory path */
export const CACHE_DIR = join(homedir(), ".mdflow", "cache");

/** Cache entry metadata stored alongside content */
export interface CacheMetadata {
  url: string;
  fetchedAt: number;
  sha256: string;
  ttlMs: number;
  /** ETag from HTTP response for conditional requests */
  etag?: string;
  /** Last-Modified header from HTTP response */
  lastModified?: string;
}

/**
 * Proper LRU (Least Recently Used) cache implementation
 *
 * Uses Map's insertion order property: delete+set refreshes recency.
 * When capacity is exceeded, evicts the least recently used entry.
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Get a value and refresh its recency (move to end)
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Delete and re-set to move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Check if key exists without affecting recency
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Set a value, evicting LRU entry if at capacity
   */
  set(key: K, value: V): void {
    // Zero-capacity cache stores nothing
    if (this.maxSize <= 0) {
      return;
    }

    // If key exists, delete it first to refresh position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry in Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Delete a specific entry
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all keys (for testing/debugging)
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }
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
  /** ETag from HTTP response header */
  etag?: string;
  /** Last-Modified from HTTP response header */
  lastModified?: string;
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
export function getCachePaths(url: string): { contentPath: string; metadataPath: string } {
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

    if (metadata.url !== url || !Number.isFinite(metadata.fetchedAt) || !Number.isFinite(metadata.ttlMs)) return { hit: false };
    const info = await stat(contentPath);
    if (!info.isFile() || info.size > MAX_INPUT_SIZE) return { hit: false };
    const bytes = await readFile(contentPath);
    if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) return { hit: false };
    const content = bytes.toString("utf8");
    // Check if cache is expired
    const now = Date.now();
    const age = now - metadata.fetchedAt;
    const effectiveTtl = metadata.ttlMs || ttlMs;

    if (age > effectiveTtl) {
      return { hit: false, metadata, content, expired: true };
    }

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
  const { ttlMs = DEFAULT_CACHE_TTL_MS, etag, lastModified } = options;

  await ensureCacheDir();

  const { contentPath, metadataPath } = getCachePaths(url);

  const metadata: CacheMetadata = {
    url,
    sha256: createHash("sha256").update(content).digest("hex"),
    fetchedAt: Date.now(),
    ttlMs,
    ...(etag && { etag }),
    ...(lastModified && { lastModified }),
  };

  atomicWriteFile(contentPath, content);
  atomicWriteFile(metadataPath, JSON.stringify(metadata));
}

/**
 * Update cache metadata without changing content (for 304 Not Modified responses)
 */
export async function touchCacheEntry(
  url: string,
  options: CacheOptions = {}
): Promise<boolean> {
  const { ttlMs = DEFAULT_CACHE_TTL_MS, etag, lastModified } = options;
  const { metadataPath } = getCachePaths(url);

  try {
    const metadataRaw = await readFile(metadataPath, "utf-8");
    const existingMetadata: CacheMetadata = JSON.parse(metadataRaw);

    // Update fetchedAt to reset TTL, preserve or update etag/lastModified
    const updatedMetadata: CacheMetadata = {
      ...existingMetadata,
      fetchedAt: Date.now(),
      ttlMs,
      ...(etag && { etag }),
      ...(lastModified && { lastModified }),
    };

    atomicWriteFile(metadataPath, JSON.stringify(updatedMetadata));
    return true;
  } catch {
    return false;
  }
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
