import { resolve, dirname, relative, basename, join } from "path";
import { realpathSync, existsSync } from "fs";
import { chmod, unlink } from "fs/promises";
import { homedir, platform, tmpdir } from "os";
import { Glob } from "bun";
// Lazy-load heavy dependencies for cold start optimization
import { resilientFetch } from "./fetch";
import { MAX_INPUT_SIZE, FileSizeLimitError, exceedsLimit } from "./limits";
import { estimateTokens, getContextLimit, countTokensAsync } from "./tokenizer";
import { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";
import { substituteTemplateVars } from "./template";
import { parseImports as parseImportsSafe, hasImportsInContent } from "./imports-parser";
import type { ImportAction, ExecutableCodeFenceAction, ProviderImportAction } from "./imports-types";
import { ImportError, getErrorMessage } from "./errors";
import { escapeShellArg, sanitizePath, validateUrl } from "./security";
import { runProvider, resolveContextProviderImport } from "./context-providers";

// Lazy-load ignore package (only needed for glob imports)
type IgnoreFactory = typeof import("ignore");
let _ignoreFactory: IgnoreFactory | null = null;
async function getIgnore(): Promise<IgnoreFactory> {
  if (!_ignoreFactory) {
    const mod = await import("ignore");
    _ignoreFactory = mod.default ?? mod;
  }
  return _ignoreFactory;
}

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
 * - @git:diff, @git:status, @git:log(20), @tree, @rg:pattern - First-class context providers
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
  /**
   * Dry-run mode: when true, commands are not executed.
   * Instead, a placeholder message is returned showing what would have been executed.
   */
  dryRun?: boolean;
  /**
   * Content-only mode for 3-phase pipeline.
   * When true, only expand file/url imports; leave commands for later.
   */
  _contentOnly?: boolean;
  /**
   * Internal cache of resolved project root for path traversal checks.
   * This keeps path policy stable across recursive import expansion.
   */
  _projectRoot?: string;
  /**
   * Optional token budget for first-class context providers (e.g. @git:diff, @tree).
   * When set, provider output falls back to summary mode/truncation to stay in budget.
   */
  _context_budget_tokens?: number;
}

const PROJECT_ROOT_MARKERS = [
  ".git",
  "package.json",
  "mdflow.config.yaml",
  ".mdflow.yaml",
  ".mdflow.json",
];

const URL_ALLOWLIST_ENV_KEYS = [
  "MDFLOW_IMPORT_URL_ALLOWLIST",
  "MDFLOW_URL_ALLOWLIST",
] as const;

const URL_BLOCKLIST_ENV_KEYS = [
  "MDFLOW_IMPORT_URL_BLOCKLIST",
  "MDFLOW_URL_BLOCKLIST",
] as const;

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
  let bytes: Uint8Array;
  try {
    const file = Bun.file(filePath);
    const buffer = await file.slice(0, BINARY_CHECK_SIZE).arrayBuffer();
    bytes = new Uint8Array(buffer);
  } catch (err) {
    throw createImportError(
      `Failed to inspect imported file "${filePath}" for binary content.`,
      "IMPORT_FILE_READ_FAILED",
      {
        filePath,
        suggestion: "Verify the file exists and is readable before importing it.",
      },
      err
    );
  }

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

import { getProcessManager } from "./process-manager";

/** Default command execution timeout in milliseconds (30 seconds) */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Get command timeout from ProcessManager or use default
 */
function getCommandTimeout(): number {
  try {
    return getProcessManager().timeouts.commandTimeout;
  } catch {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
}

/** Maximum command output size in characters (~25k tokens) */
const MAX_COMMAND_OUTPUT_SIZE = 100_000;

function createImportError(
  message: string,
  errorCode: "IMPORT_FILE_NOT_FOUND" | "IMPORT_FILE_READ_FAILED" | "IMPORT_BINARY_FILE" | "IMPORT_CIRCULAR_DEPENDENCY" | "IMPORT_COMMAND_FAILED" | "IMPORT_URL_FETCH_FAILED",
  context: Record<string, string | number | boolean | null | undefined>,
  cause?: unknown
): ImportError {
  return new ImportError(message, {
    errorCode,
    context,
    cause,
  });
}

/** Regex to strip ANSI escape codes from command output */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

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
 * Discover a project root for import path boundary checks.
 * Preference order:
 * 1. Nearest directory containing common project markers (.git/package.json/etc.)
 * 2. Starting directory when no marker exists.
 */
function detectProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  let previous = "";

  while (current !== previous) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (existsSync(join(current, marker))) {
        return current;
      }
    }

    previous = current;
    current = dirname(current);
  }

  return resolve(startDir);
}

function getProjectRoot(currentFileDir: string, importCtx?: ImportContext): string {
  if (importCtx?._projectRoot) {
    return importCtx._projectRoot;
  }

  const discovered = importCtx?.invocationCwd
    ? resolve(importCtx.invocationCwd)
    : detectProjectRoot(currentFileDir);

  if (importCtx) {
    importCtx._projectRoot = discovered;
  }

  return discovered;
}

/**
 * Resolve an import path relative to the current file's directory
 */
function resolveImportPath(importPath: string, currentFileDir: string, projectRoot: string): string {
  const resolvedImportPath = resolve(currentFileDir, importPath);
  return sanitizePath(projectRoot, resolvedImportPath);
}

function parseListFromEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readUrlPolicyList(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): string[] {
  for (const key of keys) {
    const value = env[key];
    if (value) {
      return parseListFromEnv(value);
    }
  }
  return [];
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
  if (match && match[1] && match[2] && match[3]) {
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
  if (match && match[1] && match[2]) {
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
    const currentLine = lines[i];
    if (!currentLine) continue;
    const line = currentLine.trim();

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
      for (let j = 0; j < currentLine.length; j++) {
        const char = currentLine[j];
        const prevChar = j > 0 ? currentLine[j - 1] : "";

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
        const trimmedLine = currentLine.trim();
        const nextLine = lines[i + 1];
        if (trimmedLine.endsWith(";") || trimmedLine.endsWith("}") ||
            (i + 1 < lines.length && nextLine && !nextLine.trim().startsWith("."))) {
          return lines.slice(startLine, i + 1).join("\n");
        }
      }
    }
  }

  if (startLine !== -1) {
    // Return everything from start to end if we couldn't find proper closure
    return lines.slice(startLine).join("\n");
  }

  throw createImportError(
    `Symbol "${symbolName}" not found in imported file content.`,
    "IMPORT_FILE_READ_FAILED",
    {
      symbol: symbolName,
      suggestion: "Check the symbol name and ensure it is declared in the imported file.",
    }
  );
}

/**
 * Load .gitignore patterns from directory and parents
 * Lazy-loads the ignore package on first use
 */
async function loadGitignore(dir: string): Promise<ReturnType<Awaited<ReturnType<typeof getIgnore>>>> {
  const ignore = await getIgnore();
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

    let gitignoreExists = false;
    try {
      gitignoreExists = await file.exists();
    } catch (err) {
      throw createImportError(
        `Failed to inspect ignore file "${gitignorePath}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          filePath: gitignorePath,
          suggestion: "Check read permissions for this directory and .gitignore file.",
        },
        err
      );
    }

    if (gitignoreExists) {
      try {
        const content = await file.text();
        ig.add(content.split("\n").filter(line => line.trim() && !line.startsWith("#")));
      } catch (err) {
        throw createImportError(
          `Failed to read ignore rules from "${gitignorePath}".`,
          "IMPORT_FILE_READ_FAILED",
          {
            filePath: gitignorePath,
            suggestion: "Ensure .gitignore is readable and encoded as UTF-8 text.",
          },
          err
        );
      }
    }

    // Stop at git root
    const gitDir = resolve(currentDir, ".git");
    let gitDirExists = false;
    try {
      gitDirExists = await Bun.file(gitDir).exists();
    } catch (err) {
      throw createImportError(
        `Failed while checking git root marker "${gitDir}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          filePath: gitDir,
          suggestion: "Verify directory permissions while resolving import glob roots.",
        },
        err
      );
    }

    if (gitDirExists) {
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
  const baseType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
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
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const policyEnv = importCtx?.env ?? process.env;
  const allowlist = readUrlPolicyList(policyEnv, URL_ALLOWLIST_ENV_KEYS);
  const blocklist = readUrlPolicyList(policyEnv, URL_BLOCKLIST_ENV_KEYS);

  let validatedUrl: URL;
  try {
    validatedUrl = validateUrl(url, { allowlist, blocklist });
  } catch (err) {
    throw createImportError(
      `Blocked URL import "${url}": ${getErrorMessage(err)}`,
      "IMPORT_URL_FETCH_FAILED",
      {
        url,
        allowlistEnabled: allowlist.length > 0,
        blocklistEnabled: blocklist.length > 0,
        suggestion:
          "Adjust MDFLOW_IMPORT_URL_ALLOWLIST/MDFLOW_IMPORT_URL_BLOCKLIST or import from an allowed host.",
      },
      err
    );
  }

  const targetUrl = validatedUrl.href;

  // Always log URL fetches to stderr for visibility
  console.error(`[imports] Fetching: ${targetUrl}`);

  try {
    const response = await resilientFetch(targetUrl, {
      headers: {
        "Accept": "text/markdown, application/json, text/plain, */*",
        "User-Agent": "mdflow/1.0",
      },
    });

    if (!response.ok) {
      throw createImportError(
        `Failed to fetch URL import "${targetUrl}": HTTP ${response.status} ${response.statusText}.`,
        "IMPORT_URL_FETCH_FAILED",
        {
          url: targetUrl,
          status: response.status,
          suggestion: "Check the URL, authentication, or network connectivity.",
        }
      );
    }

    const contentType = response.headers.get("content-type");
    const content = await response.text();

    // Check content type header
    if (contentType && isAllowedContentType(contentType)) {
      return content.trim();
    }

    // Content-type missing or generic - infer from content
    const inferred = inferContentType(content, targetUrl);
    if (inferred === "markdown" || inferred === "json") {
      return content.trim();
    }

    // Cannot determine content type - reject
    throw createImportError(
      `URL returned unsupported content type: ${contentType || "unknown"}. ` +
      `Only markdown and JSON are allowed. URL: ${targetUrl}`,
      "IMPORT_URL_FETCH_FAILED",
      {
        url: targetUrl,
        contentType: contentType || "unknown",
        suggestion: "Use a URL that serves markdown/json/plain text content.",
      }
    );
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw createImportError(
      `Failed to fetch URL import "${targetUrl}": ${getErrorMessage(err)}`,
      "IMPORT_URL_FETCH_FAILED",
      {
        url: targetUrl,
        suggestion: "Check the URL, proxy settings, and internet connectivity, then retry.",
      },
      err
    );
  }
}

function getContextProviderBudgetTokens(importCtx?: ImportContext): number | undefined {
  const budget = importCtx?._context_budget_tokens;
  if (budget === undefined || budget === null) {
    return undefined;
  }

  if (!Number.isFinite(budget)) {
    return undefined;
  }

  return Math.floor(budget);
}

type ProviderImportActionCompat = ProviderImportAction & {
  name?: string;
  subcommand?: string;
  arg?: string;
};

function getProviderInvocationSpec(
  action: ProviderImportAction
): { provider: string; argument?: string } {
  const compatAction = action as ProviderImportActionCompat;
  const compatArgument = compatAction.arg ?? compatAction.argument;
  const providerName = compatAction.name?.trim();
  const subcommand = compatAction.subcommand?.trim();

  if (providerName) {
    return {
      provider: subcommand ? `${providerName}:${subcommand}` : providerName,
      argument: compatArgument,
    };
  }

  return {
    provider: action.provider,
    argument: action.argument,
  };
}

async function processProviderImport(
  action: ProviderImportAction,
  currentFileDir: string,
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const providerCwd = importCtx?.invocationCwd ?? currentFileDir;
  const maxTokens = getContextProviderBudgetTokens(importCtx);
  const providerSpec = getProviderInvocationSpec(action);
  const providerAction: ProviderImportAction = {
    ...action,
    provider: providerSpec.provider as ProviderImportAction["provider"],
    argument: providerSpec.argument,
  };

  if (verbose) {
    console.error(`[imports] Expanding context provider: ${action.original}`);
  }

  try {
    if (providerCwd === process.cwd()) {
      return await runProvider(providerSpec.provider, providerSpec.argument, maxTokens);
    }

    return await resolveContextProviderImport(providerAction, {
      cwd: providerCwd,
      maxTokens,
    });
  } catch (err) {
    throw createImportError(
      `Failed to resolve context provider "${action.original}": ${getErrorMessage(err)}`,
      "IMPORT_COMMAND_FAILED",
      {
        provider: providerSpec.provider,
        providerArgument: providerSpec.argument,
        cwd: providerCwd,
        maxTokens,
        suggestion: "Verify provider syntax and ensure required binaries (git/rg/tree/find) are installed.",
      },
      err
    );
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
 * Extract the static prefix from a glob pattern (everything before the first wildcard)
 * Returns the directory portion that can be resolved as a path.
 */
function extractGlobBaseDir(pattern: string, currentFileDir: string): string {
  // Find the first glob character
  const firstWildcard = Math.min(
    ...[pattern.indexOf('*'), pattern.indexOf('?'), pattern.indexOf('[')]
      .filter(i => i !== -1)
      .concat([pattern.length]) // fallback if no wildcards
  );

  // Get everything before the wildcard
  const staticPrefix = pattern.slice(0, firstWildcard);

  // Find the last directory separator in the static prefix
  const lastSlash = staticPrefix.lastIndexOf('/');
  const dirPart = lastSlash === -1 ? '' : staticPrefix.slice(0, lastSlash);

  // Resolve the directory part
  if (pattern.startsWith('/')) {
    return dirPart || '/';
  }
  return resolve(currentFileDir, dirPart || '.');
}

/**
 * Process a glob import pattern
 */
async function processGlobImport(
  pattern: string,
  currentFileDir: string,
  projectRoot: string,
  verbose: boolean
): Promise<string> {
  const resolvedPattern = expandTilde(pattern);

  // Calculate the actual base directory for the glob
  // This handles patterns like "../../**/*.rs" by resolving the static prefix
  const unsafeGlobBaseDir = extractGlobBaseDir(resolvedPattern, currentFileDir);
  let globBaseDir: string;
  try {
    globBaseDir = sanitizePath(projectRoot, unsafeGlobBaseDir);
  } catch (err) {
    throw createImportError(
      `Glob import "${pattern}" escapes project root "${projectRoot}".`,
      "IMPORT_FILE_READ_FAILED",
      {
        pattern,
        projectRoot,
        suggestion: "Keep glob imports within the current project root.",
      },
      err
    );
  }

  if (verbose) {
    console.error(`[imports] Glob pattern: ${resolvedPattern} (base: ${globBaseDir})`);
  }

  // Load gitignore from the glob's base directory, not the agent file's directory
  const ig = await loadGitignore(globBaseDir);

  // Collect matching files
  // Use the resolved base directory as cwd for proper pattern matching
  const glob = new Glob(resolvedPattern.startsWith("/") ? resolvedPattern : pattern.replace(/^\.\//, ""));
  const files: Array<{ path: string; content: string }> = [];
  let totalChars = 0;

  const skippedBinaryFiles: string[] = [];

  try {
    for await (const file of glob.scan({ cwd: currentFileDir, absolute: true, onlyFiles: true })) {
      let safeFilePath: string;
      try {
        safeFilePath = sanitizePath(projectRoot, file);
      } catch (err) {
        throw createImportError(
          `Glob import "${pattern}" resolved a path outside project root.`,
          "IMPORT_FILE_READ_FAILED",
          {
            pattern,
            filePath: file,
            projectRoot,
            suggestion: "Adjust the glob pattern so it stays within project boundaries.",
          },
          err
        );
      }

      // Check gitignore - calculate relative path from the glob's base directory
      // This ensures paths don't start with "../" which the ignore package can't handle
      const relativePath = relative(globBaseDir, safeFilePath);

      // Skip paths that are still outside the glob base (shouldn't happen, but safety check)
      if (relativePath.startsWith('..')) {
        if (verbose) {
          console.error(`[imports] Skipping file outside glob base: ${file}`);
        }
        continue;
      }

      if (ig.ignores(relativePath)) {
        continue;
      }

      // Check if file is binary (skip with warning in glob imports)
      if (await isBinaryFileAsync(safeFilePath)) {
        skippedBinaryFiles.push(relativePath);
        continue;
      }

      const bunFile = Bun.file(safeFilePath);

      // Check individual file size before reading
      if (exceedsLimit(bunFile.size)) {
        throw new FileSizeLimitError(file, bunFile.size);
      }

      try {
        const content = await bunFile.text();
        totalChars += content.length;
        files.push({ path: relativePath, content });
      } catch (err) {
        throw createImportError(
          `Failed to read file "${file}" while expanding glob "${pattern}".`,
          "IMPORT_FILE_READ_FAILED",
          {
            filePath: safeFilePath,
            pattern,
            suggestion: "Check file permissions and encoding, then retry the import.",
          },
          err
        );
      }
    }
  } catch (err) {
    if (err instanceof ImportError || err instanceof FileSizeLimitError) {
      throw err;
    }
    throw createImportError(
      `Failed to expand glob import "${pattern}" from "${currentFileDir}".`,
      "IMPORT_FILE_READ_FAILED",
      {
        pattern,
        currentFileDir,
        suggestion: "Verify the glob path exists and that directories are readable.",
      },
      err
    );
  }

  // Log warning about skipped binary files
  if (skippedBinaryFiles.length > 0 && verbose) {
    console.error(`[imports] Skipped ${skippedBinaryFiles.length} binary file(s): ${skippedBinaryFiles.join(", ")}`);
  }

  // Sort by path for consistent ordering
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Get context limit (use env vars for model/limit override)
  const contextLimit = getContextLimit(
    process.env.MA_MODEL,
    Number(process.env.MA_CONTEXT_WINDOW) || undefined
  );

  // Use cheap token estimate first (chars / 4) for fast bailout
  const allContent = files.map((f) => f.content).join("\n");
  const estimatedTokens = estimateTokens(allContent);

  // Fast path: if estimate is well within limits, skip expensive tokenization
  let actualTokens: number;
  const needsAccurateCount = estimatedTokens > contextLimit * 0.7; // Near limit - need accurate count

  if (needsAccurateCount) {
    // Near the limit - do accurate count (lazy-loads tokenizer)
    actualTokens = await countTokensAsync(allContent);
  } else {
    // Well under limit - use estimate
    actualTokens = estimatedTokens;
  }

  // Always log glob expansion to stderr for visibility
  console.error(
    `[imports] Expanding ${pattern}: ${files.length} files (~${actualTokens.toLocaleString()} tokens${needsAccurateCount ? "" : " est"})`
  );

  // Error threshold - use dynamic context limit. MDFLOW_FORCE_CONTEXT is the
  // v3 name; MA_FORCE_CONTEXT remains as a legacy alias.
  const forceContext = process.env.MDFLOW_FORCE_CONTEXT || process.env.MA_FORCE_CONTEXT;
  if (actualTokens > contextLimit && !forceContext) {
    throw createImportError(
      `Glob import "${pattern}" would include ~${actualTokens.toLocaleString()} tokens (${files.length} files), ` +
      `which exceeds the ${contextLimit.toLocaleString()} token limit.`,
      "IMPORT_FILE_READ_FAILED",
      {
        pattern,
        tokenCount: actualTokens,
        contextLimit,
        suggestion: "Narrow the glob, or set MDFLOW_FORCE_CONTEXT=1 to override intentionally.",
      }
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
  const projectRoot = getProjectRoot(currentFileDir, importCtx);

  const resolveSafeImportPath = (rawPath: string): string => {
    try {
      return resolveImportPath(rawPath, currentFileDir, projectRoot);
    } catch (err) {
      throw createImportError(
        `Blocked import path "${rawPath}": ${getErrorMessage(err)}`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: rawPath,
          projectRoot,
          suggestion: "Keep imports within the project root or adjust invocation cwd.",
        },
        err
      );
    }
  };

  const ensureImportExists = async (resolvedPath: string, originalPath: string): Promise<ReturnType<typeof Bun.file>> => {
    const file = Bun.file(resolvedPath);
    let exists = false;
    try {
      exists = await file.exists();
    } catch (err) {
      throw createImportError(
        `Failed to check imported path "${resolvedPath}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: originalPath,
          resolvedPath,
          suggestion: "Check file permissions and verify the path is accessible.",
        },
        err
      );
    }
    if (!exists) {
      throw createImportError(
        `Import not found: ${originalPath} (resolved to ${resolvedPath})`,
        "IMPORT_FILE_NOT_FOUND",
        {
          importPath: originalPath,
          resolvedPath,
          suggestion: "Confirm the file exists and that relative paths are correct.",
        }
      );
    }
    return file;
  };

  const readImportText = async (file: ReturnType<typeof Bun.file>, resolvedPath: string, originalPath: string): Promise<string> => {
    try {
      return await file.text();
    } catch (err) {
      throw createImportError(
        `Failed to read imported file "${resolvedPath}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: originalPath,
          resolvedPath,
          suggestion: "Verify read permissions and that the file is valid UTF-8 text.",
        },
        err
      );
    }
  };

  // Check for glob pattern first
  if (isGlobPatternInternal(importPath)) {
    return processGlobImport(importPath, currentFileDir, projectRoot, verbose);
  }

  // Check for symbol extraction syntax
  const symbolParsed = parseSymbolExtractionInternal(importPath);
  if (symbolParsed.symbol) {
    const resolvedPath = resolveSafeImportPath(symbolParsed.path);

    const file = await ensureImportExists(resolvedPath, symbolParsed.path);

    // Check file size before reading
    if (exceedsLimit(file.size)) {
      throw new FileSizeLimitError(resolvedPath, file.size);
    }

    // Check for binary file (throw error for direct imports)
    if (await isBinaryFileAsync(resolvedPath)) {
      throw createImportError(
        `Cannot import binary file: ${symbolParsed.path} (resolved to ${resolvedPath})`,
        "IMPORT_BINARY_FILE",
        {
          importPath: symbolParsed.path,
          resolvedPath,
          suggestion: "Import a text file, or convert binary content to text before importing.",
        }
      );
    }

    if (verbose) {
      console.error(`[imports] Extracting symbol "${symbolParsed.symbol}" from: ${symbolParsed.path}`);
    }

    const content = await readImportText(file, resolvedPath, symbolParsed.path);
    // Track the resolved import
    if (resolvedImports) {
      resolvedImports.push(importPath);
    }
    try {
      return extractSymbol(content, symbolParsed.symbol);
    } catch (err) {
      throw createImportError(
        `Failed to extract symbol "${symbolParsed.symbol}" from "${resolvedPath}": ${getErrorMessage(err)}`,
        "IMPORT_FILE_READ_FAILED",
        {
          importPath: symbolParsed.path,
          resolvedPath,
          symbol: symbolParsed.symbol,
          suggestion: "Verify the symbol name exists and is exported in the target file.",
        },
        err
      );
    }
  }

  // Check for line range syntax
  const rangeParsed = parseLineRangeInternal(importPath);
  if (rangeParsed.start !== undefined && rangeParsed.end !== undefined) {
    const resolvedPath = resolveSafeImportPath(rangeParsed.path);

    const file = await ensureImportExists(resolvedPath, rangeParsed.path);

    // Check file size before reading
    if (exceedsLimit(file.size)) {
      throw new FileSizeLimitError(resolvedPath, file.size);
    }

    // Check for binary file (throw error for direct imports)
    if (await isBinaryFileAsync(resolvedPath)) {
      throw createImportError(
        `Cannot import binary file: ${rangeParsed.path} (resolved to ${resolvedPath})`,
        "IMPORT_BINARY_FILE",
        {
          importPath: rangeParsed.path,
          resolvedPath,
          suggestion: "Import a text file instead of binary data.",
        }
      );
    }

    if (verbose) {
      console.error(`[imports] Loading lines ${rangeParsed.start}-${rangeParsed.end} from: ${rangeParsed.path}`);
    }

    const content = await readImportText(file, resolvedPath, rangeParsed.path);
    // Track the resolved import
    if (resolvedImports) {
      resolvedImports.push(importPath);
    }
    return extractLines(content, rangeParsed.start, rangeParsed.end);
  }

  // Regular file import
  const resolvedPath = resolveSafeImportPath(importPath);

  // Check if file exists first (needed for canonical path resolution)
  const file = await ensureImportExists(resolvedPath, importPath);

  // Resolve to canonical path for cycle detection (handles symlinks)
  const canonicalPath = toCanonicalPath(resolvedPath);

  // Check for circular imports using canonical path
  if (stack.has(canonicalPath)) {
    const cycle = [...stack, canonicalPath].join(" -> ");
    throw createImportError(
      `Circular import detected: ${cycle}`,
      "IMPORT_CIRCULAR_DEPENDENCY",
      {
        importPath,
        resolvedPath,
        cycle,
        suggestion: "Break the cycle by removing at least one import in the chain.",
      }
    );
  }

  // Check file size before reading
  if (exceedsLimit(file.size)) {
    throw new FileSizeLimitError(resolvedPath, file.size);
  }

  // Check for binary file (throw error for direct imports)
  if (await isBinaryFileAsync(resolvedPath)) {
    throw createImportError(
      `Cannot import binary file: ${importPath} (resolved to ${resolvedPath})`,
      "IMPORT_BINARY_FILE",
      {
        importPath,
        resolvedPath,
        suggestion: "Import text/markdown/json files only.",
      }
    );
  }

  // Always log file loading to stderr for visibility
  console.error(`[imports] Loading: ${importPath}`);

  // Track the resolved import
  if (resolvedImports) {
    resolvedImports.push(importPath);
  }

  // Read file content
  const content = await readImportText(file, resolvedPath, importPath);

  // Recursively process imports in the imported file
  // Use canonical path in stack for consistent cycle detection
  const newStack = new Set(stack);
  newStack.add(canonicalPath);

  // For 3-phase pipeline: if in content-only mode, skip commands in recursive imports
  if (importCtx?._contentOnly) {
    return expandContentImports(content, dirname(resolvedPath), newStack, verbose, importCtx);
  }

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
 * Process a single command inline with comprehensive safety measures:
 * - Dry-run mode support
 * - Cross-platform shell support (Windows/Unix)
 * - Execution timeout (30s default)
 * - Binary output detection
 * - ANSI escape code stripping
 * - LiquidJS tag sanitization
 * - Output size limiting
 * - Detailed error reporting
 */
async function processCommandInline(
  command: string,
  currentFileDir: string,
  verbose: boolean,
  importCtx?: ImportContext,
  onProgress?: (chunk: string) => void,
  useDashboard: boolean = false
): Promise<string> {
  const isWin = platform() === "win32";

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
    const trimmed = processedCommand.trim();
    const firstSpace = trimmed.search(/\s/);
    const markdownPath = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const trailingArgs = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trimStart();
    const escapedMarkdownPath = escapeShellArg(markdownPath, isWin ? "win32" : "posix");
    actualCommand = `mdflow ${escapedMarkdownPath}${trailingArgs ? ` ${trailingArgs}` : ""}`;
    console.error(`[imports] Auto-running .md file with mdflow: ${actualCommand}`);
  } else {
    // Always log command execution unless dashboard is active (it shows progress)
    if (!useDashboard) {
      console.error(`[imports] Executing: ${processedCommand}`);
    }
  }

  // Improvement #3: Dry-run safety - skip execution if in dry-run mode
  if (importCtx?.dryRun) {
    console.error(`[imports] Dry-run: Skipping execution of '${actualCommand}'`);
    return `[Dry Run: Command "${actualCommand}" not executed]`;
  }

  // Use importCtx.env if provided, otherwise fall back to process.env
  const env = importCtx?.env ?? process.env;

  // Use invocationCwd for command execution if provided (allows agents in ~/.mdflow
  // to run commands in the user's current directory), fall back to file directory
  const commandCwd = importCtx?.invocationCwd ?? currentFileDir;

  // Improvement #5: Cross-platform shell support
  const shell = isWin ? "cmd.exe" : "sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", actualCommand] : ["-c", actualCommand];

  // Track process for timeout cleanup
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  const pm = getProcessManager();

  try {
    proc = Bun.spawn([shell, ...shellArgs], {
      cwd: commandCwd,
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });

    // Register with ProcessManager for centralized cleanup on SIGINT/SIGTERM
    pm.register(proc, `inline: ${actualCommand.slice(0, 40)}`);

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

    // Improvement #4: Execution timeout using Promise.race
    // Uses configurable timeout from ProcessManager
    const commandTimeout = getCommandTimeout();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        timedOut = true;
        proc?.kill();
        reject(createImportError(
          `Inline command timed out after ${commandTimeout}ms: ${actualCommand}`,
          "IMPORT_COMMAND_FAILED",
          {
            command: actualCommand,
            timeoutMs: commandTimeout,
            cwd: commandCwd,
            suggestion: "Increase MDFLOW_COMMAND_TIMEOUT or optimize the command.",
          }
        ));
      }, commandTimeout);
    });

    // Read streams with timeout (stdout/stderr are guaranteed with "pipe" option)
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
    await Promise.race([
      Promise.all([
        readStream(stdoutStream, stdoutChunks, true),
        readStream(stderrStream, stderrChunks, false)
      ]),
      timeoutPromise
    ]);

    await proc.exited;

    // Reconstruct full output as bytes first
    const stdoutBytes = Buffer.concat(stdoutChunks);
    const stderrBytes = Buffer.concat(stderrChunks);

    // Improvement #9: Detect and block binary output (check first 1KB for null bytes)
    const checkChunk = new Uint8Array(stdoutBytes.slice(0, 1024));
    if (checkChunk.includes(0)) {
      throw createImportError(
        `Inline command returned binary data and cannot be embedded as text: ${actualCommand}`,
        "IMPORT_COMMAND_FAILED",
        {
          command: actualCommand,
          cwd: commandCwd,
          suggestion: "Modify the command to output plain text.",
        }
      );
    }

    // Decode to strings
    let stdout = new TextDecoder().decode(stdoutBytes).trim();
    let stderr = new TextDecoder().decode(stderrBytes).trim();

    // Improvement #6: Strip ANSI escape codes from output
    stdout = stdout.replace(ANSI_ESCAPE_REGEX, '');
    stderr = stderr.replace(ANSI_ESCAPE_REGEX, '');

    // Improvement #10: Detailed error reporting with stderr
    if (proc.exitCode !== 0) {
      const errorOutput = stderr || stdout || "No output";
      throw createImportError(
        `Inline command failed (Exit ${proc.exitCode}): ${actualCommand}\nOutput: ${errorOutput}`,
        "IMPORT_COMMAND_FAILED",
        {
          command: actualCommand,
          exitCode: proc.exitCode,
          cwd: commandCwd,
          suggestion: "Run the command manually to debug and ensure it exits with code 0.",
        }
      );
    }

    // Combine stdout and stderr (stderr first if both exist)
    let output: string;
    if (stderr && stdout) {
      output = `${stderr}\n${stdout}`;
    } else {
      output = stdout || stderr || "";
    }

    // Improvement #8: Enforce output size limits
    if (output.length > MAX_COMMAND_OUTPUT_SIZE) {
      const truncatedChars = output.length - MAX_COMMAND_OUTPUT_SIZE;
      output = output.slice(0, MAX_COMMAND_OUTPUT_SIZE) +
        `\n... [Output truncated: ${truncatedChars.toLocaleString()} characters removed]`;
    }

    // Command output is processed after LiquidJS (Phase 3), so no template escaping needed
    return output;
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw createImportError(
      `Inline command failed: ${actualCommand} - ${getErrorMessage(err)}`,
      "IMPORT_COMMAND_FAILED",
      {
        command: actualCommand,
        cwd: commandCwd,
        timedOut,
        suggestion: "Verify shell command syntax and required tools in PATH.",
      },
      err
    );
  }
}

/**
 * Process an executable code fence by writing to temp file, making executable, and running
 */
async function processExecutableCodeFence(
  action: { shebang: string; language: string; code: string },
  currentFileDir: string,
  verbose: boolean,
  importCtx?: ImportContext
): Promise<string> {
  const { shebang, language, code } = action;
  const fullScript = `${shebang}\n${code}`;

  console.error(`[imports] Executing code fence (${language}): ${shebang}`);

  if (importCtx?.dryRun) {
    return "[Dry Run: Code fence not executed]";
  }

  const ext = { ts: 'ts', js: 'js', py: 'py', sh: 'sh', bash: 'sh' }[language] ?? language;
  const tmpFile = join(tmpdir(), `mdflow-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

  try {
    try {
      await Bun.write(tmpFile, fullScript);
      await chmod(tmpFile, 0o755);
    } catch (err) {
      throw createImportError(
        `Failed to prepare executable code fence temp file "${tmpFile}".`,
        "IMPORT_FILE_READ_FAILED",
        {
          tmpFile,
          language,
          suggestion: "Verify temporary directory permissions and free disk space.",
        },
        err
      );
    }

    const proc = Bun.spawn([tmpFile], {
      cwd: importCtx?.invocationCwd ?? currentFileDir,
      stdout: "pipe",
      stderr: "pipe",
      env: (importCtx?.env ?? process.env) as Record<string, string>,
    });

    let stdout = "";
    let stderr = "";
    try {
      stdout = await new Response(proc.stdout).text();
      stderr = await new Response(proc.stderr).text();
    } catch (err) {
      throw createImportError(
        `Failed to capture executable code fence output for "${tmpFile}".`,
        "IMPORT_COMMAND_FAILED",
        {
          tmpFile,
          language,
          suggestion: "Ensure the script writes text output and does not terminate abruptly.",
        },
        err
      );
    }

    await proc.exited;

    if (proc.exitCode !== 0) {
      const errorOutput = stderr || stdout || "No output";
      throw createImportError(
        `Code fence failed (Exit ${proc.exitCode}): ${errorOutput}`,
        "IMPORT_COMMAND_FAILED",
        {
          tmpFile,
          language,
          exitCode: proc.exitCode,
          suggestion: "Run the script manually to debug the failure.",
        }
      );
    }

    // Command output is processed after LiquidJS (Phase 3), so no template escaping needed
    return (stdout + stderr).trim().replace(ANSI_ESCAPE_REGEX, '');
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw createImportError(
      `Executable code fence failed: ${getErrorMessage(err)}`,
      "IMPORT_COMMAND_FAILED",
      {
        tmpFile,
        language,
        suggestion: "Validate the script interpreter and command dependencies.",
      },
      err
    );
  } finally {
    try {
      await unlink(tmpFile);
    } catch (err) {
      if (verbose) {
        const cleanupErr = createImportError(
          `Failed to clean up temp code fence file "${tmpFile}".`,
          "IMPORT_FILE_READ_FAILED",
          {
            tmpFile,
            suggestion: "Remove the temp file manually if it persists.",
          },
          err
        );
        console.error(`[imports] ${cleanupErr.message}`);
      }
    }
  }
}

/** Import types for categorizing imports during parallel resolution */
type ParsedImport =
  | { type: 'file'; full: string; path: string; index: number }
  | { type: 'url'; full: string; url: string; index: number }
  | { type: 'provider'; full: string; action: ProviderImportAction; index: number }
  | { type: 'command'; full: string; command: string; index: number }
  | { type: 'executable_code_fence'; full: string; action: ExecutableCodeFenceAction; index: number };

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
    if (match[1]) {
      imports.push({
        type: 'file',
        full: match[0],
        path: match[1],
        index: match.index,
      });
    }
  }

  // Parse URL imports
  URL_IMPORT_PATTERN.lastIndex = 0;
  while ((match = URL_IMPORT_PATTERN.exec(content)) !== null) {
    if (match[1]) {
      imports.push({
        type: 'url',
        full: match[0],
        url: match[1],
        index: match.index,
      });
    }
  }

  // Parse command inlines
  COMMAND_INLINE_PATTERN.lastIndex = 0;
  while ((match = COMMAND_INLINE_PATTERN.exec(content)) !== null) {
    if (match[1]) {
      imports.push({
        type: 'command',
        full: match[0],
        command: match[1],
        index: match.index,
      });
    }
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

  for (const { import: entry, content: replacement } of sortedResolved) {
    result = result.slice(0, entry.index) + replacement + result.slice(entry.index + entry.full.length);
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

  // Phase 1: Parse all imports using the context-aware parser
  // SECURITY FIX: Uses parseImportsSafe which ignores imports inside code blocks,
  // preventing accidental command execution from documentation examples
  const rawActions = parseImportsSafe(content);

  // Map ImportAction[] from the safe parser to ParsedImport[] for internal processing
  const imports: ParsedImport[] = rawActions.map(action => {
    switch (action.type) {
      case 'file': {
        // Preserve line range syntax in the path if present
        let path = action.path;
        if (action.lineRange) {
          path = `${action.path}:${action.lineRange.start}-${action.lineRange.end}`;
        }
        return { type: 'file' as const, full: action.original, path, index: action.index };
      }
      case 'glob':
        return { type: 'file' as const, full: action.original, path: action.pattern, index: action.index };
      case 'symbol':
        return { type: 'file' as const, full: action.original, path: `${action.path}#${action.symbol}`, index: action.index };
      case 'url':
        return { type: 'url' as const, full: action.original, url: action.url, index: action.index };
      case 'provider':
        return { type: 'provider' as const, full: action.original, action, index: action.index };
      case 'command':
        return { type: 'command' as const, full: action.original, command: action.command, index: action.index };
      case 'executable_code_fence':
        return { type: 'executable_code_fence' as const, full: action.original, action, index: action.index };
      default:
        // Should never happen, but TypeScript needs exhaustive handling
        return null as never;
    }
  });

  // If no imports, return content as-is
  if (imports.length === 0) {
    return content;
  }

  // Create semaphore for concurrency limiting
  const semaphore = new Semaphore(concurrencyLimit);

  // Initialize dashboard if we have any commands/fences and are in a TTY environment
  const commandImports = imports.filter(i => i.type === 'command' || i.type === 'executable_code_fence');
  const useDashboard = commandImports.length > 0 && process.stderr.isTTY && !verbose;
  const dashboard = useDashboard ? new ParallelDashboard() : null;

  if (dashboard) dashboard.start();

  try {
    // Phase 2: Resolve all imports in parallel with concurrency limiting
    const resolvePromises = imports.map(async (entry): Promise<ResolvedImportResult> => {
      return semaphore.run(async () => {
        let resolvedContent: string;

        switch (entry.type) {
          case 'file':
            resolvedContent = await processFileImport(entry.path, currentFileDir, stack, verbose, importCtx);
            break;
          case 'url':
            resolvedContent = await processUrlImport(entry.url, verbose, importCtx);
            // Track URL imports
            if (resolvedImportsTracker) {
              resolvedImportsTracker.push(entry.url);
            }
            break;
          case 'provider':
            resolvedContent = await processProviderImport(entry.action, currentFileDir, verbose, importCtx);
            // Track provider imports
            if (resolvedImportsTracker) {
              resolvedImportsTracker.push(entry.action.original);
            }
            break;
          case 'command':
            // Register with dashboard if active
            const cmdId = Math.random().toString(36).substring(7);
            if (dashboard) dashboard.register(cmdId, entry.command);

            try {
              resolvedContent = await processCommandInline(
                entry.command,
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
          case 'executable_code_fence':
            // Register with dashboard
            const fenceId = Math.random().toString(36).substring(7);
            if (dashboard) dashboard.register(fenceId, `Code Fence (${entry.action.language || 'script'})`);

            try {
              resolvedContent = await processExecutableCodeFence(entry.action, currentFileDir, verbose, importCtx);
            } finally {
              if (dashboard) dashboard.finish(fenceId);
            }
            break;
        }

        return { import: entry, content: resolvedContent };
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
 * Check if content contains any imports, URL imports, command inlines, or executable code fences
 */
export function hasImports(content: string): boolean {
  // Use context-aware checker from parser which now includes code fences
  return hasImportsInContent(content);
}

// ============================================================================
// 3-Phase Import Pipeline
// ============================================================================
// Enables LiquidJS template processing between file imports and command execution:
// 1. expandContentImports() - Expands @file, @glob, @url, @symbol, @provider
// 2. LiquidJS templates ({% capture %}, {{ var }}, etc.)
// 3. expandCommandImports() - Expands !`commands` with resolved template vars

/**
 * Check if content has content imports (file, glob, url, symbol, provider)
 */
export function hasContentImports(content: string): boolean {
  const actions = parseImportsSafe(content);
  return actions.some(a =>
    a.type === 'file' || a.type === 'glob' || a.type === 'url' || a.type === 'symbol' || a.type === 'provider'
  );
}

/**
 * Check if content has command imports (commands, executable code fences)
 */
export function hasCommandImports(content: string): boolean {
  const actions = parseImportsSafe(content);
  return actions.some(a => a.type === 'command' || a.type === 'executable_code_fence');
}

/**
 * Phase 1: Expand only content imports (file, glob, url, symbol)
 * Leaves !`command` syntax untouched for Phase 3.
 */
export async function expandContentImports(
  content: string,
  currentFileDir: string,
  stack: ImportStack = new Set(),
  verbose: boolean = false,
  importCtx?: ImportContext,
  concurrencyLimit: number = DEFAULT_CONCURRENCY_LIMIT
): Promise<string> {
  const ctx: ImportContext = importCtx ?? {};
  const tracker = ctx.resolvedImports;

  const rawActions = parseImportsSafe(content);

  // Filter to content imports only
  const contentActions = rawActions.filter(a =>
    a.type === 'file' || a.type === 'glob' || a.type === 'symbol' || a.type === 'url' || a.type === 'provider'
  );

  if (contentActions.length === 0) return content;

  const semaphore = new Semaphore(concurrencyLimit);

  const resolved = await Promise.all(
    contentActions.map(async (action): Promise<ResolvedImportResult> => {
      return semaphore.run(async () => {
        let resolvedContent: string;
        let parsed: ParsedImport;

        if (action.type === 'file') {
          let path = action.path;
          if (action.lineRange) {
            path = `${action.path}:${action.lineRange.start}-${action.lineRange.end}`;
          }
          parsed = { type: 'file', full: action.original, path, index: action.index };
          const contentOnlyCtx: ImportContext = { ...ctx, _contentOnly: true };
          resolvedContent = await processFileImport(path, currentFileDir, stack, verbose, contentOnlyCtx);
        } else if (action.type === 'glob') {
          parsed = { type: 'file', full: action.original, path: action.pattern, index: action.index };
          const contentOnlyCtx: ImportContext = { ...ctx, _contentOnly: true };
          resolvedContent = await processFileImport(action.pattern, currentFileDir, stack, verbose, contentOnlyCtx);
        } else if (action.type === 'symbol') {
          const path = `${action.path}#${action.symbol}`;
          parsed = { type: 'file', full: action.original, path, index: action.index };
          const contentOnlyCtx: ImportContext = { ...ctx, _contentOnly: true };
          resolvedContent = await processFileImport(path, currentFileDir, stack, verbose, contentOnlyCtx);
        } else if (action.type === 'provider') {
          parsed = { type: 'provider', full: action.original, action, index: action.index };
          resolvedContent = await processProviderImport(action, currentFileDir, verbose, ctx);
          if (tracker) tracker.push(action.original);
        } else {
          // action.type === 'url'
          parsed = { type: 'url', full: action.original, url: action.url, index: action.index };
          resolvedContent = await processUrlImport(action.url, verbose, ctx);
          if (tracker) tracker.push(action.url);
        }

        return { import: parsed, content: resolvedContent };
      });
    })
  );

  return injectResolvedImports(content, resolved);
}

/**
 * Phase 3: Expand only command imports (!`commands` and executable code fences)
 * Uses templateVars from LiquidJS processing for variable substitution in commands.
 */
export async function expandCommandImports(
  content: string,
  currentFileDir: string,
  verbose: boolean = false,
  importCtx?: ImportContext,
  concurrencyLimit: number = DEFAULT_CONCURRENCY_LIMIT
): Promise<string> {
  const ctx: ImportContext = importCtx ?? {};

  const rawActions = parseImportsSafe(content);

  // Filter to command imports only
  const cmdActions = rawActions.filter(a =>
    a.type === 'command' || a.type === 'executable_code_fence'
  );

  if (cmdActions.length === 0) return content;

  const semaphore = new Semaphore(concurrencyLimit);
  const useDashboard = cmdActions.length > 0 && process.stderr.isTTY && !verbose;
  const dashboard = useDashboard ? new ParallelDashboard() : null;

  if (dashboard) dashboard.start();

  try {
    const resolved = await Promise.all(
      cmdActions.map(async (action): Promise<ResolvedImportResult> => {
        return semaphore.run(async () => {
          let resolvedContent: string;
          let parsed: ParsedImport;

          if (action.type === 'command') {
            parsed = { type: 'command', full: action.original, command: action.command, index: action.index };
            const cmdId = Math.random().toString(36).substring(7);
            if (dashboard) dashboard.register(cmdId, action.command);

            try {
              resolvedContent = await processCommandInline(
                action.command, currentFileDir, verbose, ctx,
                (chunk) => { if (dashboard) dashboard.update(cmdId, chunk); },
                useDashboard
              );
            } finally {
              if (dashboard) dashboard.finish(cmdId);
            }
          } else {
            // action.type === 'executable_code_fence'
            parsed = { type: 'executable_code_fence', full: action.original, action, index: action.index };
            const fenceId = Math.random().toString(36).substring(7);
            if (dashboard) dashboard.register(fenceId, `Code (${action.language})`);

            try {
              resolvedContent = await processExecutableCodeFence(action, currentFileDir, verbose, ctx);
            } finally {
              if (dashboard) dashboard.finish(fenceId);
            }
          }

          return { import: parsed, content: resolvedContent };
        });
      })
    );

    return injectResolvedImports(content, resolved);
  } finally {
    if (dashboard) dashboard.stop();
  }
}
