import { resolve, dirname } from "path";
import { homedir } from "os";

/**
 * Expand markdown imports, URL imports, and command inlines
 *
 * Supports three syntaxes:
 * - @~/path/to/file.md or @./relative/path.md - Inline file contents
 * - @https://example.com/docs or @http://... - Fetch URL content (markdown/json only)
 * - !`command` - Execute command and inline stdout/stderr
 *
 * Imports are processed recursively, with circular import detection.
 * URL imports validate content type - only markdown and json are allowed.
 */

/** Track files being processed to detect circular imports */
type ImportStack = Set<string>;

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
 * Pattern to match @filepath imports
 * Matches: @~/path/to/file.md, @./relative/path.md, @/absolute/path.md
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
  if (verbose) {
    console.error(`[imports] Fetching: ${url}`);
  }

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/markdown, application/json, text/plain, */*",
        "User-Agent": "markdown-agent/1.0",
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
 * Process a single file import
 */
async function processFileImport(
  importPath: string,
  currentFileDir: string,
  stack: ImportStack,
  verbose: boolean
): Promise<string> {
  const resolvedPath = resolveImportPath(importPath, currentFileDir);

  // Check for circular imports
  if (stack.has(resolvedPath)) {
    const cycle = [...stack, resolvedPath].join(" -> ");
    throw new Error(`Circular import detected: ${cycle}`);
  }

  // Check if file exists
  const file = Bun.file(resolvedPath);
  if (!await file.exists()) {
    throw new Error(`Import not found: ${importPath} (resolved to ${resolvedPath})`);
  }

  if (verbose) {
    console.error(`[imports] Loading: ${importPath}`);
  }

  // Read file content
  const content = await file.text();

  // Recursively process imports in the imported file
  const newStack = new Set(stack);
  newStack.add(resolvedPath);

  return expandImports(content, dirname(resolvedPath), newStack, verbose);
}

/**
 * Process a single command inline
 */
async function processCommandInline(
  command: string,
  currentFileDir: string,
  verbose: boolean
): Promise<string> {
  if (verbose) {
    console.error(`[imports] Executing: ${command}`);
  }

  try {
    const result = Bun.spawnSync(["sh", "-c", command], {
      cwd: currentFileDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();

    // Combine stdout and stderr (stderr first if both exist)
    if (stderr && stdout) {
      return `${stderr}\n${stdout}`;
    }
    return stdout || stderr || "";
  } catch (err) {
    throw new Error(`Command failed: ${command} - ${(err as Error).message}`);
  }
}

/**
 * Expand all imports, URL imports, and command inlines in content
 *
 * @param content - The markdown content to process
 * @param currentFileDir - Directory of the current file (for relative imports)
 * @param stack - Set of files already being processed (for circular detection)
 * @param verbose - Whether to log import/command activity
 * @returns Content with all imports and commands expanded
 */
export async function expandImports(
  content: string,
  currentFileDir: string,
  stack: ImportStack = new Set(),
  verbose: boolean = false
): Promise<string> {
  let result = content;

  // Process file imports first
  // We need to process them one at a time due to async and potential path changes
  let match;

  // Reset regex state and find all file imports
  FILE_IMPORT_PATTERN.lastIndex = 0;
  const fileImports: Array<{ full: string; path: string; index: number }> = [];

  while ((match = FILE_IMPORT_PATTERN.exec(content)) !== null) {
    fileImports.push({
      full: match[0],
      path: match[1],
      index: match.index,
    });
  }

  // Process file imports in reverse order to preserve indices
  for (const imp of fileImports.reverse()) {
    const replacement = await processFileImport(imp.path, currentFileDir, stack, verbose);
    result = result.slice(0, imp.index) + replacement + result.slice(imp.index + imp.full.length);
  }

  // Process URL imports
  URL_IMPORT_PATTERN.lastIndex = 0;
  const urlImports: Array<{ full: string; url: string; index: number }> = [];

  while ((match = URL_IMPORT_PATTERN.exec(result)) !== null) {
    urlImports.push({
      full: match[0],
      url: match[1],
      index: match.index,
    });
  }

  // Process URL imports in reverse order to preserve indices
  for (const imp of urlImports.reverse()) {
    const replacement = await processUrlImport(imp.url, verbose);
    result = result.slice(0, imp.index) + replacement + result.slice(imp.index + imp.full.length);
  }

  // Process command inlines
  COMMAND_INLINE_PATTERN.lastIndex = 0;
  const commandInlines: Array<{ full: string; command: string; index: number }> = [];

  while ((match = COMMAND_INLINE_PATTERN.exec(result)) !== null) {
    commandInlines.push({
      full: match[0],
      command: match[1],
      index: match.index,
    });
  }

  // Process command inlines in reverse order to preserve indices
  for (const cmd of commandInlines.reverse()) {
    const replacement = await processCommandInline(cmd.command, currentFileDir, verbose);
    result = result.slice(0, cmd.index) + replacement + result.slice(cmd.index + cmd.full.length);
  }

  return result;
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
