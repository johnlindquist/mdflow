/**
 * Input size limits for OOM protection
 *
 * Prevents memory exhaustion when users pipe large files or import massive content.
 * A 10MB limit provides reasonable headroom for most use cases while preventing
 * catastrophic memory usage.
 */

/** Maximum input size in bytes (10MB) */
export const MAX_INPUT_SIZE = 10 * 1024 * 1024;

/** Human-readable size for error messages */
export const MAX_INPUT_SIZE_HUMAN = "10MB";

/**
 * Error thrown when stdin input exceeds the size limit
 */
export class StdinSizeLimitError extends Error {
  constructor(bytesRead: number) {
    super(
      `Input exceeds ${MAX_INPUT_SIZE_HUMAN} limit (read ${formatBytes(bytesRead)} so far). ` +
      `Use a file path argument instead of piping large content.`
    );
    this.name = "StdinSizeLimitError";
  }
}

/**
 * Error thrown when a file import exceeds the size limit
 */
export class FileSizeLimitError extends Error {
  constructor(filePath: string, fileSize: number) {
    super(
      `File "${filePath}" exceeds ${MAX_INPUT_SIZE_HUMAN} limit (${formatBytes(fileSize)}). ` +
      `Consider using line ranges (@./file.ts:1-100) or symbol extraction (@./file.ts#FunctionName) ` +
      `to import only the relevant portion.`
    );
    this.name = "FileSizeLimitError";
  }
}

/**
 * Format bytes as human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Check if a size exceeds the input limit
 */
export function exceedsLimit(bytes: number): boolean {
  return bytes > MAX_INPUT_SIZE;
}
