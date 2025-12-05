/**
 * Result caching for expensive LLM calls
 * Caches based on hash of inputs (frontmatter + prompt + context)
 */

import { mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

const CACHE_DIR = ".md-agent/cache";
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100; // Maximum number of cache entries

export interface CacheEntry {
  hash: string;
  timestamp: number;
  output: string;
}

/**
 * Generate a hash from the prompt and context
 */
export function generateCacheKey(components: {
  frontmatter: object;
  body: string;
  contextFiles?: Array<{ path: string; content: string }>;
}): string {
  const data = JSON.stringify({
    frontmatter: components.frontmatter,
    body: components.body,
    context: components.contextFiles?.map(f => ({
      path: f.path,
      content: f.content,
    })) || [],
  });

  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Get cache directory path (relative to cwd)
 */
export function getCacheDir(cwd: string = process.cwd()): string {
  return join(cwd, CACHE_DIR);
}

/**
 * Ensure cache directory exists
 */
export async function ensureCacheDir(cwd?: string): Promise<string> {
  const cacheDir = getCacheDir(cwd);
  await mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Get cache file path for a hash
 */
function getCachePath(hash: string, cwd?: string): string {
  return join(getCacheDir(cwd), `${hash}.json`);
}

/**
 * Read from cache if valid entry exists
 */
export async function readCache(hash: string, cwd?: string): Promise<string | null> {
  const cachePath = getCachePath(hash, cwd);

  try {
    const file = Bun.file(cachePath);
    if (!await file.exists()) {
      return null;
    }

    const content = await file.json() as CacheEntry;

    // Check if cache is expired
    const age = Date.now() - content.timestamp;
    if (age > MAX_CACHE_AGE_MS) {
      // Clean up expired cache
      await unlink(cachePath).catch(() => {});
      return null;
    }

    // Verify hash matches
    if (content.hash !== hash) {
      return null;
    }

    return content.output;
  } catch {
    return null;
  }
}

/**
 * Write result to cache
 */
export async function writeCache(
  hash: string,
  output: string,
  cwd?: string
): Promise<void> {
  await ensureCacheDir(cwd);
  const cachePath = getCachePath(hash, cwd);

  const entry: CacheEntry = {
    hash,
    timestamp: Date.now(),
    output,
  };

  await Bun.write(cachePath, JSON.stringify(entry, null, 2));

  // Clean old entries in background
  cleanOldCacheEntries(cwd).catch(() => {});
}

/**
 * Clear all cache entries
 */
export async function clearCache(cwd?: string): Promise<number> {
  const cacheDir = getCacheDir(cwd);
  let cleared = 0;

  try {
    const entries = await readdir(cacheDir);
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        await unlink(join(cacheDir, entry)).catch(() => {});
        cleared++;
      }
    }
  } catch {
    // Cache dir doesn't exist
  }

  return cleared;
}

/**
 * Clean up old cache entries
 */
async function cleanOldCacheEntries(cwd?: string): Promise<void> {
  const cacheDir = getCacheDir(cwd);

  try {
    const entries = await readdir(cacheDir);
    const cacheFiles = entries.filter(e => e.endsWith(".json"));

    // If under limit, just clean expired
    if (cacheFiles.length <= MAX_CACHE_SIZE) {
      for (const file of cacheFiles) {
        const filePath = join(cacheDir, file);
        try {
          const content = await Bun.file(filePath).json() as CacheEntry;
          const age = Date.now() - content.timestamp;
          if (age > MAX_CACHE_AGE_MS) {
            await unlink(filePath).catch(() => {});
          }
        } catch {
          // Remove invalid cache files
          await unlink(filePath).catch(() => {});
        }
      }
      return;
    }

    // Over limit - remove oldest entries
    const stats = await Promise.all(
      cacheFiles.map(async file => {
        const filePath = join(cacheDir, file);
        const s = await stat(filePath);
        return { file, mtime: s.mtime.getTime() };
      })
    );

    // Sort by modification time (oldest first)
    stats.sort((a, b) => a.mtime - b.mtime);

    // Remove oldest entries until under limit
    const toRemove = stats.slice(0, stats.length - MAX_CACHE_SIZE);
    for (const { file } of toRemove) {
      await unlink(join(cacheDir, file)).catch(() => {});
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(cwd?: string): Promise<{
  entries: number;
  totalBytes: number;
  oldestMs: number | null;
}> {
  const cacheDir = getCacheDir(cwd);
  let entries = 0;
  let totalBytes = 0;
  let oldestMs: number | null = null;

  try {
    const files = await readdir(cacheDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        entries++;
        const filePath = join(cacheDir, file);
        const s = await stat(filePath);
        totalBytes += s.size;
        const age = Date.now() - s.mtime.getTime();
        if (oldestMs === null || age > oldestMs) {
          oldestMs = age;
        }
      }
    }
  } catch {
    // Cache dir doesn't exist
  }

  return { entries, totalBytes, oldestMs };
}
