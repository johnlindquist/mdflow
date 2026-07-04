/**
 * Context Dashboard - Visual context tree and cost estimation
 *
 * Shows a "Pre-Flight" dashboard displaying:
 * - Context tree (files being imported)
 * - Total size in bytes/KB
 * - Estimated token count
 * - Color-coded by size (green=small, yellow=medium, red=large)
 */

import { dirname, resolve, basename, relative } from "path";
import { Glob } from "bun";
import { parseImports } from "./imports-parser";
import type { ImportAction } from "./imports-types";
import { estimateTokens } from "./tokenizer";

/** Size thresholds for color coding (in bytes) */
const SIZE_THRESHOLD_SMALL = 5 * 1024;    // 5KB - green
const SIZE_THRESHOLD_MEDIUM = 20 * 1024;  // 20KB - yellow
// Above 20KB is red

/** ANSI color codes */
const COLORS = {
  reset: "\x1B[0m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  red: "\x1B[31m",
  cyan: "\x1B[36m",
  dim: "\x1B[2m",
  bold: "\x1B[1m",
};

/** Box drawing characters */
const BOX = {
  vertical: "\u2502",      // |
  branch: "\u251C",        // |-
  corner: "\u2514",        // L
  horizontal: "\u2500",    // -
};

/** Context item representing a file or import */
export interface ContextItem {
  /** Display name (relative path or URL) */
  name: string;
  /** Type of import */
  type: "file" | "glob" | "url" | "command" | "symbol" | "prompt";
  /** Size in bytes (0 for commands/urls that haven't been fetched) */
  size: number;
  /** Number of files (for globs) */
  fileCount?: number;
  /** Children (for nested imports) */
  children?: ContextItem[];
  /** Original import path */
  originalPath?: string;
}

/** Result of context analysis */
export interface ContextAnalysis {
  /** The main prompt file */
  promptFile: string;
  /** All context items */
  items: ContextItem[];
  /** Total size in bytes */
  totalSize: number;
  /** Total file count */
  totalFiles: number;
  /** Estimated token count */
  estimatedTokens: number;
}

/** Color config type for renderDashboard */
type ColorConfig = typeof COLORS | { reset: ""; green: ""; yellow: ""; red: ""; cyan: ""; dim: ""; bold: "" };

/**
 * Get color code based on size
 */
function getSizeColor(size: number, c: ColorConfig): string {
  if (size <= SIZE_THRESHOLD_SMALL) return c.green;
  if (size <= SIZE_THRESHOLD_MEDIUM) return c.yellow;
  return c.red;
}

/**
 * Format bytes to human readable string
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

/**
 * Format token count to human readable string
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Analyze imports from content without expanding them
 * Returns information about what would be imported
 */
export async function analyzeContext(
  filePath: string,
  content: string,
  currentDir?: string
): Promise<ContextAnalysis> {
  const fileDir = currentDir ?? dirname(resolve(filePath));
  const items: ContextItem[] = [];
  let totalSize = 0;
  let totalFiles = 1; // Start with 1 for the prompt file itself

  // Get prompt file size
  const promptFile = Bun.file(filePath);
  const promptSize = await promptFile.exists() ? promptFile.size : content.length;
  totalSize += promptSize;

  // Add prompt file as first item
  items.push({
    name: basename(filePath),
    type: "prompt",
    size: promptSize,
    originalPath: filePath,
  });

  // Parse imports from content
  const imports = parseImports(content);

  // Analyze each import
  for (const entry of imports) {
    const item = await analyzeImport(entry, fileDir);
    if (item) {
      items.push(item);
      totalSize += item.size;
      totalFiles += item.fileCount ?? 1;
    }
  }

  // Estimate tokens from total size (rough: chars/4)
  const estimatedTokens = estimateTokens(content) + Math.ceil(totalSize / 4);

  return {
    promptFile: filePath,
    items,
    totalSize,
    totalFiles,
    estimatedTokens,
  };
}

/**
 * Analyze a single import action
 */
async function analyzeImport(
  action: ImportAction,
  fileDir: string
): Promise<ContextItem | null> {
  switch (action.type) {
    case "file": {
      const resolvedPath = resolvePath(action.path, fileDir);
      const file = Bun.file(resolvedPath);
      let size = 0;
      if (await file.exists()) {
        size = file.size;
      }
      return {
        name: `@${action.path}`,
        type: "file",
        size,
        originalPath: resolvedPath,
      };
    }

    case "glob": {
      const { files, totalSize } = await analyzeGlob(action.pattern, fileDir);
      return {
        name: `@${action.pattern}`,
        type: "glob",
        size: totalSize,
        fileCount: files.length,
      };
    }

    case "url": {
      // URLs are fetched at runtime, so we can't know the size ahead of time
      return {
        name: `@${action.url}`,
        type: "url",
        size: 0, // Unknown until fetched
      };
    }

    case "command": {
      // Commands are executed at runtime
      return {
        name: `!\`${truncate(action.command, 30)}\``,
        type: "command",
        size: 0, // Unknown until executed
      };
    }

    case "symbol": {
      const resolvedPath = resolvePath(action.path, fileDir);
      const file = Bun.file(resolvedPath);
      let size = 0;
      if (await file.exists()) {
        // Symbol extraction - estimate ~10% of file size
        size = Math.ceil(file.size * 0.1);
      }
      return {
        name: `@${action.path}#${action.symbol}`,
        type: "symbol",
        size,
        originalPath: resolvedPath,
      };
    }

    case "executable_code_fence": {
      // Code fences are executed at runtime
      return {
        name: `[code fence: ${action.language}]`,
        type: "command",
        size: 0,
      };
    }

    default:
      return null;
  }
}

/**
 * Analyze glob pattern and return file info
 */
async function analyzeGlob(
  pattern: string,
  fileDir: string
): Promise<{ files: string[]; totalSize: number }> {
  const glob = new Glob(pattern.replace(/^\.\//, ""));
  const files: string[] = [];
  let totalSize = 0;

  try {
    for await (const file of glob.scan({ cwd: fileDir, absolute: true, onlyFiles: true })) {
      const bunFile = Bun.file(file);
      files.push(relative(fileDir, file));
      totalSize += bunFile.size;
    }
  } catch {
    // Glob pattern might not match anything
  }

  return { files, totalSize };
}

/**
 * Resolve import path relative to file directory
 */
function resolvePath(importPath: string, fileDir: string): string {
  if (importPath.startsWith("~/")) {
    const { homedir } = require("os");
    return importPath.replace("~", homedir());
  }
  if (importPath.startsWith("/")) {
    return importPath;
  }
  return resolve(fileDir, importPath);
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Render the context dashboard to a string
 */
export function renderDashboard(
  analysis: ContextAnalysis,
  options: { color?: boolean; compact?: boolean } = {}
): string {
  const { color = true, compact = false } = options;
  const c = color ? COLORS : { reset: "", green: "", yellow: "", red: "", cyan: "", dim: "", bold: "" };

  const lines: string[] = [];

  // Header
  const headerIcon = "\uD83D\uDCE6"; // Package emoji
  lines.push("");
  lines.push(
    `${c.bold}${headerIcon} Context: ${analysis.totalFiles} file${analysis.totalFiles !== 1 ? "s" : ""} (${formatSize(analysis.totalSize)})${c.reset}`
  );

  // Tree view
  const lastIndex = analysis.items.length - 1;
  analysis.items.forEach((item, index) => {
    const isLast = index === lastIndex;
    const prefix = isLast ? `${BOX.corner}${BOX.horizontal}${BOX.horizontal} ` : `${BOX.branch}${BOX.horizontal}${BOX.horizontal} `;

    const sizeColor = getSizeColor(item.size, c);
    const sizeStr = item.size > 0 ? ` ${c.dim}(${formatSize(item.size)})${c.reset}` : "";
    const countStr = item.fileCount ? ` ${c.dim}(${item.fileCount} files)${c.reset}` : "";

    let typeIndicator = "";
    switch (item.type) {
      case "prompt":
        typeIndicator = `${c.cyan}(Prompt)${c.reset}`;
        break;
      case "glob":
        typeIndicator = `${c.dim}[glob]${c.reset}`;
        break;
      case "url":
        typeIndicator = `${c.dim}[url]${c.reset}`;
        break;
      case "command":
        typeIndicator = `${c.dim}[cmd]${c.reset}`;
        break;
      case "symbol":
        typeIndicator = `${c.dim}[sym]${c.reset}`;
        break;
    }

    if (compact) {
      lines.push(`${prefix}${sizeColor}${item.name}${c.reset}${sizeStr}${countStr}`);
    } else {
      lines.push(`${prefix}${sizeColor}${item.name}${c.reset}${sizeStr}${countStr} ${typeIndicator}`);
    }
  });

  // Footer with token estimate
  lines.push("");
  const tokenColor = analysis.estimatedTokens > 50000 ? c.yellow :
                     analysis.estimatedTokens > 100000 ? c.red : c.green;
  lines.push(`${c.dim}Estimated: ${c.reset}${tokenColor}~${formatTokens(analysis.estimatedTokens)} tokens${c.reset}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Print the context dashboard to stderr
 */
export function printDashboard(analysis: ContextAnalysis): void {
  const output = renderDashboard(analysis, { color: process.stderr.isTTY });
  console.error(output);
}

/**
 * Quick check if content has any imports that would benefit from a dashboard
 */
export function shouldShowDashboard(content: string): boolean {
  const imports = parseImports(content);
  return imports.length > 0;
}
