import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertPlainDirectory, containedWritePath } from "./contained-write";
import { atomicWriteFile } from "./state-file";
import { MAX_INPUT_SIZE } from "./limits";

export const WORKFLOW_CACHE_DIR = join(".mdflow", ".cache");
export interface WorkflowCacheInput {
  prompt: string;
  args: string[];
  tool: string;
  /** The effective flow, step, argv mapping and explicit environment. Hashed, never persisted. */
  context?: string;
  cacheDir?: string;
}
export interface WorkflowCachedResult { stdout: string; stderr: string; exitCode: number }
export interface WorkflowCacheLookupResult { hit: boolean; key: string; result?: WorkflowCachedResult }

/** Preflight before any engine spend and check again at the actual read/write. */
export function workflowCachePath(cacheDir = WORKFLOW_CACHE_DIR, file = "probe.json"): string {
  const dir = resolve(cacheDir);
  if (basename(dir) === ".cache" && basename(dirname(dir)) === ".mdflow") {
    return containedWritePath(dirname(dirname(dir)), ".mdflow", ".cache", file);
  }
  assertPlainDirectory(dir);
  return join(dir, file);
}

export function createWorkflowCacheKey(input: Omit<WorkflowCacheInput, "cacheDir">): string {
  return createHash("sha256").update(JSON.stringify([2, input.context, input.tool, input.args, input.prompt])).digest("hex");
}

export async function getCachedResult(input: WorkflowCacheInput): Promise<WorkflowCacheLookupResult> {
  const key = createWorkflowCacheKey(input);
  const path = workflowCachePath(input.cacheDir, key + ".json");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_INPUT_SIZE) return { hit: false, key };
    const record = JSON.parse(await readFile(path, "utf8"));
    const r = record?.result;
    if (record?.key === key && r?.exitCode === 0 && typeof r.stdout === "string" && typeof r.stderr === "string") {
      return { hit: true, key, result: r };
    }
    return { hit: false, key };
  } catch (err) {
    if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === "ENOENT") return { hit: false, key };
    throw err;
  }
}

export async function setCachedResult(input: WorkflowCacheInput, result: WorkflowCachedResult): Promise<{ key: string }> {
  const key = createWorkflowCacheKey(input);
  const content = JSON.stringify({ key, result });
  if (Buffer.byteLength(content) <= MAX_INPUT_SIZE) atomicWriteFile(workflowCachePath(input.cacheDir, key + ".json"), content);
  return { key };
}
