import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type OutputFormat = "json" | "text" | "patch";

export type OutputConfig = {
  format?: OutputFormat;
  schema?: string;
  save?: string;
  apply?: boolean;
};

// Backward-compatible aliases for existing call sites.
export type StructuredOutputFormat = OutputFormat;
export type StructuredOutputConfig = OutputConfig;

interface ZodLikeSchema {
  parse: (value: unknown) => unknown;
}

type ZodIssue = { path?: PropertyKey[]; message: string };

export type ValidateOutputResult =
  | { success: true; data: unknown; error?: undefined }
  | { success: false; data?: undefined; error: string };

export interface ValidateOptions {
  baseDir?: string;
}

export interface SaveSinkOptions {
  cwd?: string;
}

export interface ApplySinkOptions {
  cwd?: string;
}

export interface SinkOutputOptions {
  save?: string;
  apply?: boolean;
  cwd?: string;
}

export interface SinkOutputResult {
  savedTo?: string;
  applied: boolean;
}

export interface ProcessStructuredOutputOptions {
  stdout: string;
  output: StructuredOutputConfig;
  baseDir?: string;
  cwd?: string;
  writeStdout?: (value: string) => void;
  suppressDefaultStdoutSink?: boolean;
}

export interface ProcessStructuredOutputResult {
  format: StructuredOutputFormat;
  value: unknown;
  savedTo?: string;
  applied: boolean;
}

interface FencedCodeBlock {
  language: string;
  content: string;
}

const JSON_FENCE_LANGUAGES = new Set(["json", "jsonc"]);
const PATCH_FENCE_LANGUAGES = new Set(["diff", "patch"]);

/**
 * Extract structured output from model stdout.
 * - json: parse from ```json first, then raw JSON objects/arrays
 * - patch: extract unified diff text
 * - text: passthrough
 */
export function extractStructured(
  stdout: string,
  format: StructuredOutputFormat = "text"
): unknown {
  if (format === "json") {
    const jsonCandidate = extractJsonCandidate(stdout);
    if (!jsonCandidate) {
      throw new Error("Unable to extract JSON from command output.");
    }

    const parsed = tryParseJson(jsonCandidate);
    if (!parsed.success) {
      throw new Error("Unable to parse extracted JSON.");
    }

    return parsed.value;
  }

  if (format === "patch") {
    const patch = extractUnifiedDiff(stdout);
    if (!patch) {
      throw new Error("Unable to extract unified diff from command output.");
    }
    return patch;
  }

  return stdout;
}

/**
 * Resolve schema ref (`./schema.ts#MySchema`) and validate a value with Zod.
 * Returns structured success/failure without throwing validation errors.
 */
export async function validateOutput(
  schemaRef: string,
  value: unknown,
  options: ValidateOptions = {}
): Promise<ValidateOutputResult> {
  try {
    const { modulePath, exportName } = parseSchemaRef(schemaRef);
    const resolvedModulePath = resolveSchemaPath(modulePath, options.baseDir);
    const moduleUrl = pathToFileURL(resolvedModulePath).href;
    const loadedModule = await import(moduleUrl);
    const schema = loadedModule[exportName];

    if (!isZodLikeSchema(schema)) {
      return {
        success: false,
        error: `Schema export "${exportName}" from "${modulePath}" is not a Zod schema (missing parse).`,
      };
    }

    const data = schema.parse(value);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: `Schema validation failed for "${schemaRef}". ${formatErrorMessage(error)}`,
    };
  }
}

/**
 * Legacy throwing validator kept for existing call sites.
 */
export async function validate(
  schemaRef: string,
  value: unknown,
  options: ValidateOptions = {}
): Promise<unknown> {
  const result = await validateOutput(schemaRef, value, options);
  if (!result.success) {
    throw new Error(result.error);
  }

  return result.data;
}

/**
 * Save extracted output to disk.
 */
export async function sinkSave(
  targetPath: string,
  value: unknown,
  format: StructuredOutputFormat,
  options: SaveSinkOptions = {}
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  const serialized = serializeStructuredValue(value, format);

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, serialized, "utf-8");

  return resolvedPath;
}

/**
 * Apply patch text with `git apply`.
 */
export function sinkApplyPatch(
  patchText: string,
  options: ApplySinkOptions = {}
): void {
  const result = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd: options.cwd ?? process.cwd(),
    input: patchText,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status === 0) {
    return;
  }

  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const details = stderr || stdout || `exit code ${result.status ?? "unknown"}`;
  throw new Error(`git apply failed: ${details}`);
}

/**
 * Save output to file and/or apply it as a patch.
 * Patch application only runs when content looks like a unified diff.
 */
export async function sinkOutput(
  options: SinkOutputOptions,
  content: string
): Promise<SinkOutputResult> {
  let savedTo: string | undefined;
  if (options.save) {
    savedTo = await sinkSave(options.save, content, "text", { cwd: options.cwd });
  }

  let applied = false;
  if (options.apply && detectUnifiedDiff(content)) {
    sinkApplyPatch(content, { cwd: options.cwd });
    applied = true;
  }

  return { savedTo, applied };
}

/**
 * Print parsed JSON with stable formatting.
 */
export function sinkPrintStructuredJson(
  value: unknown,
  writeStdout: (value: string) => void = console.log
): void {
  writeStdout(JSON.stringify(value, null, 2));
}

/**
 * End-to-end structured output processing.
 */
export async function processStructuredOutput(
  options: ProcessStructuredOutputOptions
): Promise<ProcessStructuredOutputResult> {
  const format = options.output.format ?? (options.output.apply ? "patch" : "text");

  if (options.output.apply && format !== "patch") throw new Error("Output apply=true requires format=patch.");
  let value = extractStructured(options.stdout, format);

  if (options.output.schema) {
    value = await validate(options.output.schema, value, { baseDir: options.baseDir });
  }

  let savedTo: string | undefined;
  if (options.output.save) {
    savedTo = await sinkSave(options.output.save, value, format, { cwd: options.cwd });
  }

  let applied = false;
  if (options.output.apply) {
    if (typeof value !== "string") {
      throw new Error("Patch output must be string data.");
    }
    sinkApplyPatch(value, { cwd: options.cwd });
    applied = true;
  }

  if (!options.suppressDefaultStdoutSink && !options.output.save && !options.output.apply) {
    if (format === "json") {
      sinkPrintStructuredJson(value, options.writeStdout);
    } else {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      (options.writeStdout ?? console.log)(text);
    }
  }

  return { format, value, savedTo, applied };
}

/**
 * Detect whether output includes a unified diff.
 */
export function detectUnifiedDiff(output: string): boolean {
  return extractUnifiedDiff(output) !== null;
}

/**
 * Detect whether output includes parseable JSON.
 */
export function detectJsonOutput(output: string): boolean {
  return extractJsonCandidate(output) !== null;
}

/**
 * Extract first parseable JSON snippet from output.
 * Search order: ```json blocks, full raw object/array, then balanced object/array snippets.
 */
export function extractJsonCandidate(output: string): string | null {
  const blocks = parseFencedCodeBlocks(output);
  const jsonBlocks = blocks.filter((block) => JSON_FENCE_LANGUAGES.has(block.language));

  for (const block of jsonBlocks) {
    const candidate = block.content.trim();
    if (!candidate) continue;
    if (tryParseJson(candidate).success) {
      return candidate;
    }
  }

  const raw = output.trim();
  if (raw && looksLikeJsonContainer(raw) && tryParseJson(raw).success) {
    return raw;
  }

  for (const candidate of extractBalancedJsonCandidates(output)) {
    if (tryParseJson(candidate).success) {
      return candidate;
    }
  }

  return null;
}

/**
 * Extract unified diff text from fenced blocks or raw output.
 */
export function extractUnifiedDiff(output: string): string | null {
  const blocks = parseFencedCodeBlocks(output);
  for (const block of blocks) {
    if (!PATCH_FENCE_LANGUAGES.has(block.language)) continue;
    const patch = extractUnifiedDiffFromText(block.content);
    if (patch) {
      return patch;
    }
  }

  return extractUnifiedDiffFromText(output);
}

function parseFencedCodeBlocks(output: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  const regex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(output)) !== null) {
    const language = (match[1] ?? "").toLowerCase().trim();
    const content = (match[2] ?? "").trim();
    blocks.push({ language, content });
  }

  return blocks;
}

function extractUnifiedDiffFromText(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = findUnifiedDiffStart(lines);
  if (start === -1) {
    return null;
  }

  const collected: string[] = [];
  let sawHunkHeader = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("@@")) {
      sawHunkHeader = true;
    }

    if (isUnifiedDiffLine(line, sawHunkHeader)) {
      collected.push(line);
      continue;
    }

    if (line.trim() === "") {
      collected.push(line);
      continue;
    }

    break;
  }

  const body = collected.join("\n").trim();
  if (!body || !body.includes("\n+++ ") || !body.includes("--- ")) {
    return null;
  }

  return body.endsWith("\n") ? body : `${body}\n`;
}

function findUnifiedDiffStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("--- ")) {
      continue;
    }

    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const candidate = lines[j] ?? "";
      if (candidate.startsWith("+++ ")) {
        return i;
      }
      if (candidate.trim() && !candidate.startsWith("index ")) {
        break;
      }
    }
  }

  return -1;
}

function isUnifiedDiffLine(line: string, sawHunkHeader: boolean): boolean {
  if (line.startsWith("diff --git ")) return true;
  if (line.startsWith("index ")) return true;
  if (line.startsWith("new file mode ")) return true;
  if (line.startsWith("deleted file mode ")) return true;
  if (line.startsWith("rename from ")) return true;
  if (line.startsWith("rename to ")) return true;
  if (line.startsWith("--- ")) return true;
  if (line.startsWith("+++ ")) return true;
  if (line.startsWith("@@")) return true;
  if (line === "\\ No newline at end of file") return true;
  if (line.startsWith("Binary files ")) return true;
  if (sawHunkHeader && /^[ +\-]/.test(line)) return true;
  return false;
}

function extractBalancedJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (char !== "{" && char !== "[") {
      continue;
    }

    const candidate = sliceBalancedJson(output, i);
    if (!candidate) {
      continue;
    }

    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    candidates.push(normalized);
  }

  return candidates;
}

function sliceBalancedJson(input: string, startIndex: number): string | null {
  const first = input[startIndex];
  if (first !== "{" && first !== "[") {
    return null;
  }

  const stack: string[] = [first === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let i = startIndex + 1; i < input.length; i++) {
    const char = input[i] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) {
        return null;
      }

      if (stack.length === 0) {
        return input.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function tryParseJson(value: string): { success: true; value: unknown } | { success: false } {
  try {
    return { success: true, value: JSON.parse(value) };
  } catch {
    return { success: false };
  }
}

function parseSchemaRef(schemaRef: string): { modulePath: string; exportName: string } {
  const hashIndex = schemaRef.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex === schemaRef.length - 1) {
    throw new Error(
      `Invalid schema reference "${schemaRef}". Use "<path>#<ExportName>" (example: ./schema.ts#MySchema).`
    );
  }

  const modulePath = schemaRef.slice(0, hashIndex).trim();
  const exportName = schemaRef.slice(hashIndex + 1).trim();

  if (!modulePath || !exportName) {
    throw new Error(
      `Invalid schema reference "${schemaRef}". Use "<path>#<ExportName>" (example: ./schema.ts#MySchema).`
    );
  }

  return { modulePath, exportName };
}

function resolveSchemaPath(modulePath: string, baseDir?: string): string {
  if (modulePath.startsWith("file://")) {
    return new URL(modulePath).pathname;
  }

  if (isAbsolute(modulePath)) {
    return modulePath;
  }

  const cwd = baseDir ?? process.cwd();
  return resolve(cwd, modulePath);
}

function isZodLikeSchema(value: unknown): value is ZodLikeSchema {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!("parse" in value)) {
    return false;
  }

  return typeof value.parse === "function";
}

function looksLikeJsonContainer(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

function formatValidationIssues(issues?: ZodIssue[]): string {
  if (!issues || issues.length === 0) {
    return "Validation failed with unknown schema errors.";
  }

  return issues
    .map((issue) => {
      const path = issue.path && issue.path.length > 0
        ? issue.path.map(String).join(".")
        : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function formatErrorMessage(error: unknown): string {
  if (!error) {
    return "Unknown error.";
  }

  if (typeof error === "object") {
    const maybeZodError = error as { issues?: ZodIssue[]; message?: string };
    if (maybeZodError.issues && maybeZodError.issues.length > 0) {
      return formatValidationIssues(maybeZodError.issues);
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function serializeStructuredValue(value: unknown, format: StructuredOutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
