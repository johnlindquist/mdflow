import { resolve, dirname, relative, basename } from "path";
import { realpathSync } from "fs";
import { homedir } from "os";
import { Glob } from "bun";
import ignore from "ignore";
import { resilientFetch } from "./fetch";
import { MAX_INPUT_SIZE, FileSizeLimitError, exceedsLimit } from "./limits";
import { countTokens, getContextLimit } from "./tokenizer";
import { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";
import { substituteTemplateVars } from "./template";

/**
 * TTY Dashboard for monitoring parallel command execution
 * Handles rendering stacked spinners and live output previews
 */
class ParallelDashboard {
  private items: Map<string, { command: string; status: string; frame: number }> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private isTTY: boolean;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private linesRendered = 0;

  constructor() {
    this.isTTY = process.stderr.isTTY ?? false;
  }

  start() {
    if (!this.isTTY) return;
    process.stderr.write('\x1B[?25l'); // Hide cursor
    this.interval = setInterval(() => this.render(), 80);
  }

  stop() {
    if (!this.isTTY) return;
    if (this.interval) clearInterval(this.interval);
    this.clear();
    process.stderr.write('\x1B[?25h'); // Show cursor
  }

  register(id: string, command: string) {
    // Truncate command visual if too long
    const displayCmd = command.length > 40 ? command.slice(0, 37) + '...' : command;
    this.items.set(id, { command: displayCmd, status: 'Starting...', frame: 0 });
  }

  update(id: string, chunk: string) {
    const item = this.items.get(id);
    if (item) {
      // Clean newlines and take last 15 chars
      const clean = chunk.replace(/[\r\n]/g, ' ').trim();
      const preview = clean.length > 15 ? '...' + clean.slice(-15) : clean;
      item.status = preview || item.status;
    }
  }

  finish(id: string) {
    this.items.delete(id);
    this.render(); // Immediate update to remove line
  }

  private clear() {
    if (this.linesRendered > 0) {
      // Move up linesRendered times and clear screen down
      process.stderr.write(`\x1B[${this.linesRendered}A`);
      process.stderr.write('\x1B[0J');
      this.linesRendered = 0;
    }
  }

  private render() {
    this.clear();

    const lines: string[] = [];

    for (const [_, item] of this.items) {
      item.frame = (item.frame + 1) % this.spinnerFrames.length;
      const spinner = this.spinnerFrames[item.frame];
      // Format: ⠋ command : last output
      lines.push(`${spinner} ${item.command} : \x1B[90m${item.status}\x1B[0m`);
    }

    if (lines.length > 0) {
      process.stderr.write(lines.join('\n') + '\n');
      this.linesRendered = lines.length;
    }
  }
}

// Re-export pipeline components for direct access
export { parseImports, hasImportsInContent, isGlobPattern, parseLineRange, parseSymbolExtraction } from "./imports-parser";
export { injectImports, createResolvedImport } from "./imports-injector";
export type { ImportAction, ResolvedImport, SystemEnvironment } from "./imports-types";
export { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";

/**
 * Expand markdown imports, URL imports, and command inlines
 *
 * Supports multiple syntaxes:
 * - @~/path/to/file.md or @./relative/path.md - Inline file contents
 * - @./src/**\/*.ts - Glob patterns (respects .gitignore)
 * - @./file.ts:10-50 - Line range extraction
 * - @./file.ts#SymbolName - Symbol extraction (interface, function, class, type, const)
 * - @https://example.com/docs or @http://... - Fetch URL content (markdown/json only)
 * - !`command` - Execute command and inline stdout/stderr
 *
 * Imports are processed recursively, with circular import detection.
 * URL imports validate content type - only markdown and json are allowed.
 *
 * ## Pipeline Architecture
 *
 * The import system is split into three phases:
 * 1. **Parser** (pure): `parseImports()` - scans content, returns ImportActions
 * 2. **Resolver** (impure): resolves actions via I/O (files, URLs, commands)
 * 3. **Injector** (pure): `injectImports()` - stitches resolved content back
 *
 * This separation enables thorough unit testing of regex parsing and injection
 * without filesystem dependencies.
 */

/** Track files being processed to detect circular imports */
type ImportStack = Set<string>;

/** Track resolved import paths for introspection */
export type ResolvedImportsTracker = string[];

/**
 * Import context for passing runtime dependencies
 * Used to inject environment variables and track resolved imports
 */
export interface ImportContext {
  /** Environment variables (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** Track resolved imports for ExecutionPlan */
  resolvedImports?: ResolvedImportsTracker;
  /**
   * Working directory for command execution (!`cmd` inlines).
   * When set, commands run in this directory instead of the agent file's directory.
   * This allows agents in ~/.mdflow to execute commands in the user's invocation directory.
   */
  invocationCwd?: string;
  /**
   * Template variables for substitution in inline commands (!`cmd`).
   * When provided, {{ _varname }} patterns in command strings are substituted
   * before execution, allowing dynamic command construction.
   */
  templateVars?: Record<string, string>;
}

/**
 * File extensions that are known to be binary
 * These are checked first before content inspection
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".svg", ".tiff", ".tif",
  // Executables and libraries
  ".exe", ".dll", ".so", ".dylib", ".bin",
  // Archives
  ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2", ".xz",
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // Databases
  ".sqlite", ".db", ".sqlite3",
  // Data files
  ".dat", ".data",
  // System files
  ".DS_Store",
  // Other binary formats
  ".wasm", ".pyc", ".class", ".o", ".a", ".lib",
]);

/** Size of buffer to check for binary content (8KB) */
const BINARY_CHECK_SIZE = 8192;

/**
 * Check if a file is binary based on extension or content
 *
 * @param filePath - Path to the file
 * @param content - Optional buffer to check (if already read)
 * @returns true if file appears to be binary
 */
export function isBinaryFile(filePath: string, content?: Buffer): boolean {
  // Check extension first (fast path)
  const ext = filePath.toLowerCase().match(/\.[^./\\]+$/)?.[0] || "";
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  // Check for files without extensions that are typically binary
  const base = filePath.split(/[/\\]/).pop() || "";
  if (base === ".DS_Store") {
    return true;
  }

  // If content provided, check for null bytes
  if (content) {
    const checkSize = Math.min(content.length, BINARY_CHECK_SIZE);
    for (let i = 0; i < checkSize; i++) {
      if (content[i] === 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a file is binary by reading its first bytes
 *
 * @param filePath - Path to the file
 * @returns true if file appears to be binary
 */
export async function isBinaryFileAsync(filePath: string): Promise<boolean> {
  // Check extension first (fast path)
  if (isBinaryFile(filePath)) {
    return true;
  }

  // Read first 8KB and check for null bytes
  const file = Bun.file(filePath);
  const buffer = await file.slice(0, BINARY_CHECK_SIZE).arrayBuffer();
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }

  return false;
}

/** Maximum token count before error (approx 4 chars per token) */
export const MAX_TOKENS = 100_000;
/** Warning threshold for high token count */
export const WARN_TOKENS = 50_000;
export const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

/**
 * Expand a path that may start with ~ to use home directory
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return filePath.replace("~", homedir());
  }
  return filePath;
}

/**
 * Resolve an import path relative to the current file's directory
 */
function resolveImportPath(importPath: string, currentFileDir: string): string {
  const expanded = expandTilde(importPath);

  // Absolute paths (including expanded ~) stay as-is
  if (expanded.startsWith("/")) {
    return expanded;
  }

  // Relative paths resolve from current file's directory
  return resolve(currentFileDir, expanded);
}

/**
 * Resolve a path to its canonical form (resolving symlinks)
 * This ensures that symlinks to the same file are detected as identical
 * for cycle detection purposes.
 *
 * @param filePath - The path to resolve
 * @returns The canonical (real) path, or the original path if resolution fails
 */
export function toCanonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    // File might not exist yet, or other error - return original path
    return filePath;
  }
}

/**
 * Check if a path contains glob characters
 */
function isGlobPatternInternal(path: string): boolean {
  return path.includes("*") || path.includes("?") || path.includes("[");
}

/**
 * Parse import path for line range syntax: @./file.ts:10-50
 */
function parseLineRangeInternal(path: string): { path: string; start?: number; end?: number } {
  const match = path.match(/^(.+):(\d+)-(\d+)$/);
  if (match) {
    return {
      path: match[1],
      start: parseInt(match[2], 10),
      end: parseInt(match[3], 10),
    };
  }
  return { path };
}

/**
 * Parse import path for symbol extraction: @./file.ts#SymbolName
 */
function parseSymbolExtractionInternal(path: string): { path: string; symbol?: string } {
  const match = path.match(/^(.+)#([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
  if (match) {
    return {
      path: match[1],
      symbol: match[2],
    };
  }
  return { path };
}

/**
 * Extract lines from content by range
 */
function extractLines(content: string, start: number, end: number): string {
  const lines = content.split("\n");
  // Convert to 0-indexed, clamp to valid range
  const startIdx = Math.max(0, start - 1);
  const endIdx = Math.min(lines.length, end);
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Extract a symbol definition from TypeScript/JavaScript content
 * Supports: interface, type, function, class, const, let, var, enum
 */
function extractSymbol(content: string, symbolName: string): string {
  const lines = content.split("\n");

  // Patterns to match symbol declarations
  const patterns = [
    // interface Name { ... }
    new RegExp(`^(export\\s+)?interface\\s+${symbolName}\\s*(extends\\s+[^{]+)?\\{`),
    // type Name = ...
    new RegExp(`^(export\\s+)?type\\s+${symbolName}\\s*(<[^>]+>)?\\s*=`),
    // function Name(...) { ... }
    new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${symbolName}\\s*(<[^>]+>)?\\s*\\(`),
    // class Name { ... }
    new RegExp(`^(export\\s+)?(abstract\\s+)?class\\s+${symbolName}\\s*(extends\\s+[^{]+)?(implements\\s+[^{]+)?\\{`),
    // const/let/var Name = ...
    new RegExp(`^(export\\s+)?(const|let|var)\\s+${symbolName}\\s*(:[^=]+)?\\s*=`),
    // enum Name { ... }
    new RegExp(`^(export\\s+)?enum\\s+${symbolName}\\s*\\{`),
  ];

  let startLine = -1;
  let braceDepth = 0;
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";
  let foundDeclaration = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check if this line starts the symbol we're looking for
    if (startLine === -1) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          startLine = i;
          foundDeclaration = true;
          break;
        }
      }
    }

    if (startLine !== -1) {
      // Count braces/parens to find the end of the declaration
      for (let j = 0; j < lines[i].length; j++) {
        const char = lines[i][j];
        const prevChar = j > 0 ? lines[i][j - 1] : "";

        // Handle string literals
        if (!inString && (char === '"' || char === "'" || char === "`")) {
          inString = true;
          stringChar = char;
        } else if (inString && char === stringChar && prevChar !== "\\") {
          inString = false;
        }

        if (!inString) {
          if (char === "{") braceDepth++;
          else if (char === "}") braceDepth--;
          else if (char === "(") parenDepth++;
          else if (char === ")") parenDepth--;
        }
      }

      // Check if we've closed all braces (for block declarations)
      if (foundDeclaration && braceDepth === 0 && parenDepth === 0) {
        // For type aliases, we need to check for semicolon or end of statement
        const currentLine = lines[i].trim();
        if (currentLine.endsWith(";") || currentLine.endsWith("}") ||
            (i + 1 < lines.length && !lines[i + 1].trim().startsWith("."))) {
          return lines.slice(startLine, i + 1).join("\n");
        }
      }
    }
  }

  if (startLine !== -1) {
    // Return everything from start to end if we couldn't find proper closure
    return lines.slice(startLine).join("\n");
  }

  throw new Error(`Symbol "${symbolName}" not found in file`);
}

/**
 * Load .gitignore patterns from directory and parents
 */
async function loadGitignore(dir: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();

  // Always ignore common patterns
  ig.add([
    ".git",
    "node_modules",
    ".DS_Store",
    "*.log",
  ]);

  // Walk up to find .gitignore files
  let currentDir = dir;
  const root = resolve("/");

  while (currentDir !== root) {
    const gitignorePath = resolve(currentDir, ".gitignore");
    const file = Bun.file(gitignorePath);

    if (await file.exists()) {
      const content = await file.text();
      ig.add(content.split("\n").filter(line => line.trim() && !line.startsWith("#")));
    }

    // Stop at git root
    const gitDir = resolve(currentDir, ".git");
    if (await Bun.file(gitDir).exists()) {
      break;
    }

    currentDir = dirname(currentDir);
  }

  return ig;
}

/**
 * Pattern to match @filepath imports (including globs, line ranges, and symbols)
 * Matches: @~/path/to/file.md, @./relative/path.md, @/absolute/path.md
 * Also: @./src/**\/*.ts, @./file.ts:10-50, @./file.ts#Symbol
 * The path continues until whitespace or end of line
 */
const FILE_IMPORT_PATTERN = /@(~?[.\/][^\s]+)/g;

/**
 * Pattern to match !`command` inlines
 * Matches: !`any command here`
 * Supports multi-word commands inside backticks
 */
const COMMAND_INLINE_PATTERN = /!\`([^`]+)\`/g;

/**
 * Pattern to match @url imports
 * Matches: @https://example.com/path, @http://example.com/path
 * Does NOT match emails like foo@example.com (requires http:// or https://)
 * The URL continues until whitespace or end of line
 */
const URL_IMPORT_PATTERN = /@(https?:\/\/[^\s]+)/g;

/**
 * Allowed content types for URL imports
 */
const ALLOWED_CONTENT_TYPES = [
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/json",
  "application/x-json",
  "text/json",
];

/**
 * Check if a content type is allowed
 */
function isAllowedContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  // Extract the base type (ignore charset and other params)
  const baseType = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(baseType);
}

/**
 * Determine if content looks like markdown or JSON
 * Used when content-type header is missing or generic
 */
function inferContentType(content: string, url: string): "markdown" | "json" | "unknown" {
  const trimmed = content.trim();

  // Check if it looks like JSON
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON
    }
  }

  // Check URL extension
  const urlLower = url.toLowerCase();
  if (urlLower.endsWith(".md") || urlLower.endsWith(".markdown")) {
    return "markdown";
  }
  if (urlLower.endsWith(".json")) {
    return "json";
  }

  // Check for common markdown patterns
  if (trimmed.startsWith("#") ||
      trimmed.includes("\n#") ||
      trimmed.includes("\n- ") ||
      trimmed.includes("\n* ") ||
      trimmed.includes("```")) {
    return "markdown";
  }

  return "unknown";
}

/**
 * Process a URL import by fetching and validating content
 */
async function processUrlImport(
  url: string,
  verbose: boolean
): Promise<string> {
  // Always log URL fetches to stderr for visibility
  console.error(`[imports] Fetching: ${url}`);

  try {
    const response = await resilientFetch(url, {
      headers: {
        "Accept": "text/markdown, application/json, text/plain, */*",
        "User-Agent": "mdflow/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type");
    const content = await response.text();

    // Check content type header
    if (contentType && isAllowedContentType(contentType)) {
      return content.trim();
    }

    // Content-type missing or generic - infer from content
    const inferred = inferContentType(content, url);
    if (inferred === "markdown" || inferred === "json") {
      return content.trim();
    }

    // Cannot determine content type - reject
    throw new Error(
      `URL returned unsupported content type: ${contentType || "unknown"}. ` +
      `Only markdown and JSON are allowed. URL: ${url}`
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("unsupported content type")) {
      throw err;
    }
    throw new Error(`Failed to fetch URL: ${url} - ${(err as Error).message}`);
  }
}

/**
 * Format files as XML for LLM consumption
 */
function formatFilesAsXml(files: Array<{ path: string; content: string }>): string {
  return files.map(file => {
    const name = basename(file.path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "_$1") || "file";
    return `<${name} path="${file.path}">\n${file.content}\n</${name}>`;
  }).join("\n\n");
}

/**
 * Process a glob import pattern
 */
async function processGlobImport(
  pattern: string,
  currentFileDir: string,
  verbose: boolean
): Promise<string> {
  const resolvedPattern = expandTilde(pattern);
  const baseDir = resolvedPattern.startsWith("/") ? "/" : currentFileDir;

  // For relative patterns, we need to resolve from the current directory
  const globPattern = resolvedPattern.startsWith("/")
    ? resolvedPattern
    : resolve(currentFileDir, resolvedPattern).replace(currentFileDir + "/", "");

  if (verbose) {
    console.error(`[imports] Glob pattern: ${globPattern} in ${currentFileDir}`);
  }

  // Load gitignore
  const ig = await loadGitignore(currentFileDir);

  // Collect matching files
  const glob = new Glob(resolvedPattern.startsWith("/") ? resolvedPattern : pattern.replace(/^\.\//, ""));
  const files: Array<{ path: string; content: string }> = [];
  let totalChars = 0;

  const skippedBinaryFiles: string[] = [];

  for await (const file of glob.scan({ cwd: currentFileDir, absolute: true, onlyFiles: true })) {
    // Check gitignore
    const relativePath = relative(currentFileDir, file);
    if (ig.ignores(relativePath)) {
      continue;
    }

    // Check if file is binary (skip with warning in glob imports)
    if (await isBinaryFileAsync(file)) {
      skippedBinaryFiles.push(relativePath);
      continue;
    }

    const bunFile = Bun.file(file);

    // Check individual file size before reading
    if (exceedsLimit(bunFile.size)) {
      throw new FileSizeLimitError(file, bunFile.size);
    }

    const content = await bunFile.text();
    totalChars += content.length;

    files.push({ path: relativePath, content });
  }

  // Log warning about skipped binary files
  if (skippedBinaryFiles.length > 0 && verbose) {
    console.error(`[imports] Skipped ${skippedBinaryFiles.length} binary file(s): ${skippedBinaryFiles.join(", ")}`);
  }

  // Sort by path for consistent ordering
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Count tokens using real tokenizer
  const allContent = files.map((f) => f.content).join("\n");
  const actualTokens = countTokens(allContent);

  // Get context limit (use env vars for model/limit override)
  const contextLimit = getContextLimit(
    process.env.MA_MODEL,
    Number(process.env.MA_CONTEXT_WINDOW) || undefined
  );

  // Always log glob expansion to stderr for visibility
  console.error(
    `[imports] Expanding ${pattern}: ${files.length} files (~${actualTokens.toLocaleString()} tokens)`
  );

  // Error threshold - use dynamic context limit
  if (actualTokens > contextLimit && !process.env.MA_FORCE_CONTEXT) {
    throw new Error(
      `Glob import "${pattern}" would include ~${actualTokens.toLocaleString()} tokens (${files.length} files), ` +
        `which exceeds the ${contextLimit.toLocaleString()} token limit.\n` +
        `To override this limit, set the MA_FORCE_CONTEXT=1 environment variable.`
    );
  }

  // Warning threshold (50% of limit) - warn but don't error
  const warnThreshold = Math.floor(contextLimit * 0.5);
  if (actualTokens > warnThreshold && actualTokens <= contextLimit) {
    console.error(
      `[imports] Warning: High token count (~${actualTokens.toLocaleString()}). This may be expensive.`
    );
  }

  return formatFilesAsXml(files);
}

/**
 * Process a single file import (with optional line range or symbol extraction)
 */
async function processFileImport(
  importPath: string,
  currentFileDir: string,
  stack: ImportStack,
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const resolvedImports = importCtx?.resolvedImports;
  // Check for glob pattern first
  if (isGlobPatternInternal(importPath)) {
    return processGlobImport(importPath, currentFileDir, verbose);
  }

  // Check for symbol extraction syntax
  const symbolParsed = parseSymbolExtractionInternal(importPath);
  if (symbolParsed.symbol) {
    const resolvedPath = resolveImportPath(symbolParsed.path, currentFileDir);

    const file = Bun.file(resolvedPath);
    if (!await file.exists()) {
      throw new Error(`Import not found: ${symbolParsed.path} (resolved to ${resolvedPath})`);
    }

    // Check file size before reading
    if (exceedsLimit(file.size)) {
      throw new FileSizeLimitError(resolvedPath, file.size);
    }

    // Check for binary file (throw error for direct imports)
    if (await isBinaryFileAsync(resolvedPath)) {
      throw new Error(`Cannot import binary file: ${symbolParsed.path} (resolved to ${resolvedPath})`);
    }

    if (verbose) {
      console.error(`[imports] Extracting symbol "${symbolParsed.symbol}" from: ${symbolParsed.path}`);
    }

    const content = await file.text();
    // Track the resolved import
    if (resolvedImports) {
      resolvedImports.push(importPath);
    }
    return extractSymbol(content, symbolParsed.symbol);
  }

  // Check for line range syntax
  const rangeParsed = parseLineRangeInternal(importPath);
  if (rangeParsed.start !== undefined && rangeParsed.end !== undefined) {
    const resolvedPath = resolveImportPath(rangeParsed.path, currentFileDir);

    const file = Bun.file(resolvedPath);
    if (!await file.exists()) {
      throw new Error(`Import not found: ${rangeParsed.path} (resolved to ${resolvedPath})`);
    }

    // Check file size before reading
    if (exceedsLimit(file.size)) {
      throw new FileSizeLimitError(resolvedPath, file.size);
    }

    // Check for binary file (throw error for direct imports)
    if (await isBinaryFileAsync(resolvedPath)) {
      throw new Error(`Cannot import binary file: ${rangeParsed.path} (resolved to ${resolvedPath})`);
    }

    if (verbose) {
      console.error(`[imports] Loading lines ${rangeParsed.start}-${rangeParsed.end} from: ${rangeParsed.path}`);
    }

    const content = await file.text();
    // Track the resolved import
    if (resolvedImports) {
      resolvedImports.push(importPath);
    }
    return extractLines(content, rangeParsed.start, rangeParsed.end);
  }

  // Regular file import
  const resolvedPath = resolveImportPath(importPath, currentFileDir);

  // Check if file exists first (needed for canonical path resolution)
  const file = Bun.file(resolvedPath);
  if (!await file.exists()) {
    throw new Error(`Import not found: ${importPath} (resolved to ${resolvedPath})`);
  }

  // Resolve to canonical path for cycle detection (handles symlinks)
  const canonicalPath = toCanonicalPath(resolvedPath);

  // Check for circular imports using canonical path
  if (stack.has(canonicalPath)) {
    const cycle = [...stack, canonicalPath].join(" -> ");
    throw new Error(`Circular import detected: ${cycle}`);
  }

  // Check file size before reading
  if (exceedsLimit(file.size)) {
    throw new FileSizeLimitError(resolvedPath, file.size);
  }

  // Check for binary file (throw error for direct imports)
  if (await isBinaryFileAsync(resolvedPath)) {
    throw new Error(`Cannot import binary file: ${importPath} (resolved to ${resolvedPath})`);
  }

  // Always log file loading to stderr for visibility
  console.error(`[imports] Loading: ${importPath}`);

  // Track the resolved import
  if (resolvedImports) {
    resolvedImports.push(importPath);
  }

  // Read file content
  const content = await file.text();

  // Recursively process imports in the imported file
  // Use canonical path in stack for consistent cycle detection
  const newStack = new Set(stack);
  newStack.add(canonicalPath);

  return expandImports(content, dirname(resolvedPath), newStack, verbose, importCtx);
}

/**
 * Pattern to detect markdown file paths that should be auto-run with `md`
 * Matches: foo.md, ./foo.md, ~/foo.md, /path/to/foo.md, foo.claude.md, etc.
 * The command must start with a path-like pattern and end with .md
 */
const MD_FILE_COMMAND_PATTERN = /^(~?\.?\.?\/)?[^\s]+\.md(\s|$)/;

/**
 * Check if a command looks like a markdown file that should be run with `mdflow`
 */
export function isMarkdownFileCommand(command: string): boolean {
  return MD_FILE_COMMAND_PATTERN.test(command.trim());
}

/**
 * Process a single command inline
 */
async function processCommandInline(
  command: string,
  currentFileDir: string,
  verbose: boolean,
  importCtx?: ImportContext,
  onProgress?: (chunk: string) => void,
  useDashboard: boolean = false
): Promise<string> {
  // Substitute template variables in command string if provided
  // This allows commands like !`echo {{ _name }}` to use frontmatter variables
  let processedCommand = command;
  if (importCtx?.templateVars && Object.keys(importCtx.templateVars).length > 0) {
    processedCommand = substituteTemplateVars(command, importCtx.templateVars);
    if (processedCommand !== command) {
      console.error(`[imports] Command with vars: ${command} → ${processedCommand}`);
    }
  }

  // Auto-prefix markdown files with `mdflow` to run them as agents
  let actualCommand = processedCommand;
  if (isMarkdownFileCommand(processedCommand)) {
    actualCommand = `mdflow ${processedCommand}`;
    console.error(`[imports] Auto-running .md file with mdflow: ${actualCommand}`);
  } else {
    // Always log command execution unless dashboard is active (it shows progress)
    if (!useDashboard) {
      console.error(`[imports] Executing: ${processedCommand}`);
    }
  }

  // Use importCtx.env if provided, otherwise fall back to process.env
  const env = importCtx?.env ?? process.env;

  // Use invocationCwd for command execution if provided (allows agents in ~/.mdflow
  // to run commands in the user's current directory), fall back to file directory
  const commandCwd = importCtx?.invocationCwd ?? currentFileDir;

  try {
    const proc = Bun.spawn(["sh", "-c", actualCommand], {
      cwd: commandCwd,
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });

    // Buffers for final output
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    // Helper to read a stream and trigger callbacks
    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      chunks: Uint8Array[],
      isStdout: boolean
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);

        // Update dashboard via callback if provided (only for stdout to reduce noise)
        if (isStdout && onProgress) {
          onProgress(decoder.decode(value));
        }
      }
    };

    // Read both streams concurrently
    await Promise.all([
      readStream(proc.stdout, stdoutChunks, true),
      readStream(proc.stderr, stderrChunks, false)
    ]);

    await proc.exited;

    // Reconstruct full output
    const stdout = new TextDecoder().decode(Buffer.concat(stdoutChunks)).trim();
    const stderr = new TextDecoder().decode(Buffer.concat(stderrChunks)).trim();

    // Combine stdout and stderr (stderr first if both exist)
    let output: string;
    if (stderr && stdout) {
      output = `${stderr}\n${stdout}`;
    } else {
      output = stdout || stderr || "";
    }

    // Wrap in {% raw %}...{% endraw %} to prevent LiquidJS from interpreting
    // any template-like syntax (e.g., {{ variable }}) in command output
    if (output) {
      return `{% raw %}\n${output}\n{% endraw %}`;
    }
    return output;
  } catch (err) {
    throw new Error(`Command failed: ${actualCommand} - ${(err as Error).message}`);
  }
}

/** Import types for categorizing imports during parallel resolution */
type ParsedImport =
  | { type: 'file'; full: string; path: string; index: number }
  | { type: 'url'; full: string; url: string; index: number }
  | { type: 'command'; full: string; command: string; index: number };

/** Result of resolving an import */
interface ResolvedImportResult {
  import: ParsedImport;
  content: string;
}

/**
 * Parse all imports from content in a single pass
 * Returns imports sorted by their position in the content
 */
function parseAllImports(content: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  let match;

  // Parse file imports
  FILE_IMPORT_PATTERN.lastIndex = 0;
  while ((match = FILE_IMPORT_PATTERN.exec(content)) !== null) {
    imports.push({
      type: 'file',
      full: match[0],
      path: match[1],
      index: match.index,
    });
  }

  // Parse URL imports
  URL_IMPORT_PATTERN.lastIndex = 0;
  while ((match = URL_IMPORT_PATTERN.exec(content)) !== null) {
    imports.push({
      type: 'url',
      full: match[0],
      url: match[1],
      index: match.index,
    });
  }

  // Parse command inlines
  COMMAND_INLINE_PATTERN.lastIndex = 0;
  while ((match = COMMAND_INLINE_PATTERN.exec(content)) !== null) {
    imports.push({
      type: 'command',
      full: match[0],
      command: match[1],
      index: match.index,
    });
  }

  // Sort by index to maintain order
  imports.sort((a, b) => a.index - b.index);

  return imports;
}

/**
 * Inject resolved imports back into content
 * Processes in reverse order to preserve indices
 */
function injectResolvedImports(content: string, resolved: ResolvedImportResult[]): string {
  let result = content;

  // Sort by index descending to process from end to start (preserves indices)
  const sortedResolved = [...resolved].sort((a, b) => b.import.index - a.import.index);

  for (const { import: imp, content: replacement } of sortedResolved) {
    result = result.slice(0, imp.index) + replacement + result.slice(imp.index + imp.full.length);
  }

  return result;
}

/**
 * Expand all imports, URL imports, and command inlines in content
 *
 * This is the main entry point that orchestrates the three-phase pipeline:
 * 1. Parse: Find all imports in the content (single pass)
 * 2. Resolve: Fetch content for each import in parallel (with concurrency limit)
 * 3. Inject: Replace import markers with resolved content
 *
 * The parallel resolution uses a semaphore to limit concurrent I/O operations,
 * preventing file descriptor exhaustion when processing many imports.
 *
 * For TTY environments with multiple commands, a live dashboard shows progress
 * with spinners and output previews for each running command.
 *
 * @param content - The markdown content to process
 * @param currentFileDir - Directory of the current file (for relative imports)
 * @param stack - Set of files already being processed (for circular detection)
 * @param verbose - Whether to log import/command activity
 * @param contextOrTracker - Optional ImportContext or array to collect resolved import paths
 * @param concurrencyLimit - Maximum concurrent I/O operations (default: 10)
 * @returns Content with all imports and commands expanded
 */
export async function expandImports(
  content: string,
  currentFileDir: string,
  stack: ImportStack = new Set(),
  verbose: boolean = false,
  contextOrTracker?: ImportContext | ResolvedImportsTracker,
  concurrencyLimit: number = DEFAULT_CONCURRENCY_LIMIT
): Promise<string> {
  // Normalize the 5th parameter - can be either ImportContext or ResolvedImportsTracker (for backward compat)
  const importCtx: ImportContext = Array.isArray(contextOrTracker)
    ? { resolvedImports: contextOrTracker }
    : (contextOrTracker ?? {});
  const resolvedImportsTracker = importCtx.resolvedImports;

  // Phase 1: Parse all imports in a single pass
  const imports = parseAllImports(content);

  // If no imports, return content as-is
  if (imports.length === 0) {
    return content;
  }

  // Create semaphore for concurrency limiting
  const semaphore = new Semaphore(concurrencyLimit);

  // Initialize dashboard if we have multiple commands and are in a TTY environment
  const commandImports = imports.filter(i => i.type === 'command');
  const useDashboard = commandImports.length > 1 && process.stderr.isTTY && !verbose;
  const dashboard = useDashboard ? new ParallelDashboard() : null;

  if (dashboard) dashboard.start();

  try {
    // Phase 2: Resolve all imports in parallel with concurrency limiting
    const resolvePromises = imports.map(async (imp): Promise<ResolvedImportResult> => {
      return semaphore.run(async () => {
        let resolvedContent: string;

        switch (imp.type) {
          case 'file':
            resolvedContent = await processFileImport(imp.path, currentFileDir, stack, verbose, importCtx);
            break;
          case 'url':
            resolvedContent = await processUrlImport(imp.url, verbose);
            // Track URL imports
            if (resolvedImportsTracker) {
              resolvedImportsTracker.push(imp.url);
            }
            break;
          case 'command':
            // Register with dashboard if active
            const cmdId = Math.random().toString(36).substring(7);
            if (dashboard) dashboard.register(cmdId, imp.command);

            try {
              resolvedContent = await processCommandInline(
                imp.command,
                currentFileDir,
                verbose,
                importCtx,
                (chunk) => {
                  if (dashboard) dashboard.update(cmdId, chunk);
                },
                useDashboard
              );
            } finally {
              if (dashboard) dashboard.finish(cmdId);
            }
            break;
        }

        return { import: imp, content: resolvedContent };
      });
    });

    // Wait for all resolutions to complete
    const resolvedImports = await Promise.all(resolvePromises);

    // Phase 3: Inject resolved content back into the original
    return injectResolvedImports(content, resolvedImports);
  } finally {
    if (dashboard) dashboard.stop();
  }
}

/**
 * Check if content contains any imports, URL imports, or command inlines
 */
export function hasImports(content: string): boolean {
  FILE_IMPORT_PATTERN.lastIndex = 0;
  URL_IMPORT_PATTERN.lastIndex = 0;
  COMMAND_INLINE_PATTERN.lastIndex = 0;

  return (
    FILE_IMPORT_PATTERN.test(content) ||
    URL_IMPORT_PATTERN.test(content) ||
    COMMAND_INLINE_PATTERN.test(content)
  );
}
