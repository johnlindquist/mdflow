/**
 * Agent registry for installing reusable markdown agents from remote sources.
 *
 * Supports:
 * - Direct URLs
 * - GitHub shorthand: gh:org/repo/path/to/agent.md@ref
 *
 * Agents are stored in either:
 * - Project registry: ./.mdflow/registry/
 * - User registry: ~/.mdflow/registry/
 *
 * Lockfile path:
 * - ./.mdflow/mdflow.lock.json
 * - ~/.mdflow/mdflow.lock.json
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";
import { toRawUrl } from "./remote";

export type RegistryScope = "project" | "user";

export interface LockfileEntry {
  source: string;
  resolvedRef?: string;
  sha256: string;
  installedPath: string;
  installedAt: string;
}

interface RegistryLockfile {
  entries: Record<string, LockfileEntry>;
}

export interface RegistryOptions {
  scope?: RegistryScope;
  cwd?: string;
  homeDir?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export interface InstallAgentResult extends LockfileEntry {
  name: string;
  scope: RegistryScope;
  lockfilePath: string;
}

export interface RemoveAgentResult {
  name: string;
  removed: boolean;
  removedFrom: RegistryScope[];
}

export interface ListedAgent extends LockfileEntry {
  name: string;
  scope: RegistryScope;
  lockfilePath: string;
}

interface RegistryPaths {
  scope: RegistryScope;
  mdflowDir: string;
  registryDir: string;
  lockfilePath: string;
}

interface ResolvedInstallSpec {
  source: string;
  downloadUrl: string;
  resolvedRef?: string;
  suggestedName: string;
}

const MDFLOW_DIR_NAME = ".mdflow";
const REGISTRY_DIR_NAME = "registry";
const LOCKFILE_NAME = "mdflow.lock.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLockfileEntry(value: unknown): value is LockfileEntry {
  if (!isRecord(value)) return false;
  if (typeof value.source !== "string") return false;
  if (typeof value.sha256 !== "string") return false;
  if (typeof value.installedPath !== "string") return false;
  if (typeof value.installedAt !== "string") return false;
  if (value.resolvedRef !== undefined && typeof value.resolvedRef !== "string") return false;
  return true;
}

function hashSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function getNameWithoutMdExtension(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function normalizeAgentName(input: string): string {
  const rawName = basename(input.trim());
  const fallback = rawName.length > 0 ? rawName : "agent.md";
  const safeName = fallback.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (safeName === "." || safeName === ".." || safeName.length === 0) {
    return "agent.md";
  }
  return safeName.endsWith(".md") ? safeName : `${safeName}.md`;
}

function extractNameFromUrl(downloadUrl: string): string {
  try {
    const parsed = new URL(downloadUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = parts[parts.length - 1];
    if (!lastSegment) return "agent.md";
    return normalizeAgentName(lastSegment);
  } catch {
    return "agent.md";
  }
}

function parseGhSpec(spec: string): ResolvedInstallSpec {
  const value = spec.slice(3);
  const atIndex = value.lastIndexOf("@");
  const pathPart = atIndex === -1 ? value : value.slice(0, atIndex);
  const refPart = atIndex === -1 ? "main" : value.slice(atIndex + 1);

  if (!pathPart || !refPart) {
    throw new Error(
      `Invalid GitHub agent spec "${spec}". Expected format: gh:org/repo/path/to/agent.md@ref`
    );
  }

  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length < 3) {
    throw new Error(
      `Invalid GitHub agent spec "${spec}". Expected format: gh:org/repo/path/to/agent.md@ref`
    );
  }

  const owner = segments[0];
  const repo = segments[1];
  const filePath = segments.slice(2).join("/");
  if (!filePath.endsWith(".md")) {
    throw new Error(`GitHub agent spec must point to a .md file, received: "${spec}"`);
  }

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${refPart}/${filePath}`;
  const fileName = normalizeAgentName(segments[segments.length - 1] ?? "agent.md");

  return {
    source: spec,
    downloadUrl: rawUrl,
    resolvedRef: refPart,
    suggestedName: fileName,
  };
}

export function resolveInstallSpec(spec: string): ResolvedInstallSpec {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Agent spec is required");
  }

  if (trimmed.startsWith("gh:")) {
    return parseGhSpec(trimmed);
  }

  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error(
      `Unsupported agent spec "${trimmed}". Use a URL or GitHub shorthand: gh:org/repo/path/to/agent.md@ref`
    );
  }

  const rawUrl = toRawUrl(trimmed);
  return {
    source: trimmed,
    downloadUrl: rawUrl,
    suggestedName: extractNameFromUrl(rawUrl),
  };
}

function resolveScope(options: RegistryOptions): RegistryScope {
  if (options.scope) return options.scope;
  const cwd = options.cwd ?? process.cwd();
  const projectMdflowDir = join(cwd, MDFLOW_DIR_NAME);
  return existsSync(projectMdflowDir) ? "project" : "user";
}

function getRegistryPaths(scope: RegistryScope, options: RegistryOptions): RegistryPaths {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.homeDir ?? homedir();
  const mdflowDir = scope === "project"
    ? join(cwd, MDFLOW_DIR_NAME)
    : join(userHome, MDFLOW_DIR_NAME);
  return {
    scope,
    mdflowDir,
    registryDir: join(mdflowDir, REGISTRY_DIR_NAME),
    lockfilePath: join(mdflowDir, LOCKFILE_NAME),
  };
}

async function ensureRegistryDirectories(paths: RegistryPaths): Promise<void> {
  await mkdir(paths.registryDir, { recursive: true });
}

async function readLockfile(lockfilePath: string): Promise<RegistryLockfile> {
  const file = Bun.file(lockfilePath);
  if (!await file.exists()) {
    return { entries: {} };
  }

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (error) {
    throw new Error(
      `Failed to parse registry lockfile at "${lockfilePath}": ${(error as Error).message}`
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid registry lockfile at "${lockfilePath}": expected an object`);
  }

  const entriesValue = parsed.entries;
  if (entriesValue === undefined) {
    return { entries: {} };
  }
  if (!isRecord(entriesValue)) {
    throw new Error(`Invalid registry lockfile at "${lockfilePath}": "entries" must be an object`);
  }

  const entries: Record<string, LockfileEntry> = {};
  for (const [name, value] of Object.entries(entriesValue)) {
    if (!isLockfileEntry(value)) {
      throw new Error(
        `Invalid registry lockfile entry "${name}" in "${lockfilePath}": expected {source,resolvedRef?,sha256,installedPath,installedAt}`
      );
    }
    entries[name] = value;
  }

  return { entries };
}

async function writeLockfile(lockfilePath: string, lockfile: RegistryLockfile): Promise<void> {
  await Bun.write(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
}

function buildCollisionName(name: string, source: string): string {
  const suffix = hashSha256(source).slice(0, 8);
  const base = getNameWithoutMdExtension(name);
  return `${base}-${suffix}.md`;
}

function getCandidateNames(name: string): string[] {
  const raw = basename(name.trim());
  const normalized = normalizeAgentName(raw);
  if (!raw) return [normalized];
  if (raw === normalized) return [raw];
  return [raw, normalized];
}

export async function installAgent(spec: string, options: RegistryOptions = {}): Promise<InstallAgentResult> {
  const resolved = resolveInstallSpec(spec);
  const scope = resolveScope(options);
  const paths = getRegistryPaths(scope, options);
  await ensureRegistryDirectories(paths);

  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(resolved.downloadUrl, {
    headers: {
      "User-Agent": "mdflow/registry",
      Accept: "text/markdown, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to install agent from "${resolved.downloadUrl}" (source: "${resolved.source}"): HTTP ${response.status} ${response.statusText}`
    );
  }

  const content = await response.text();
  if (content.trim().length === 0) {
    throw new Error(
      `Downloaded agent content is empty from "${resolved.downloadUrl}" (source: "${resolved.source}")`
    );
  }

  const lockfile = await readLockfile(paths.lockfilePath);
  let name = resolved.suggestedName;
  const existing = lockfile.entries[name];
  if (existing && existing.source !== resolved.source) {
    name = buildCollisionName(name, resolved.source);
    let collisionIndex = 2;
    while (lockfile.entries[name] && lockfile.entries[name]!.source !== resolved.source) {
      const base = getNameWithoutMdExtension(buildCollisionName(resolved.suggestedName, resolved.source));
      name = `${base}-${collisionIndex}.md`;
      collisionIndex += 1;
    }
  }

  const installedPath = join(paths.registryDir, name);
  await Bun.write(installedPath, content);

  const entry: LockfileEntry = {
    source: resolved.source,
    sha256: hashSha256(content),
    installedPath,
    installedAt: (options.now ? options.now() : new Date()).toISOString(),
  };
  if (resolved.resolvedRef) {
    entry.resolvedRef = resolved.resolvedRef;
  }

  lockfile.entries[name] = entry;
  await writeLockfile(paths.lockfilePath, lockfile);

  return {
    name,
    scope,
    lockfilePath: paths.lockfilePath,
    ...entry,
  };
}

export async function removeAgent(name: string, options: RegistryOptions = {}): Promise<RemoveAgentResult> {
  if (!name.trim()) {
    throw new Error("Agent name is required");
  }

  const targetNames = getCandidateNames(name);
  const scopes: RegistryScope[] = options.scope ? [options.scope] : ["project", "user"];
  const removedFrom: RegistryScope[] = [];

  for (const scope of scopes) {
    const paths = getRegistryPaths(scope, options);
    const hasLockfile = await Bun.file(paths.lockfilePath).exists();
    const hasRegistryDir = existsSync(paths.registryDir);
    if (!hasLockfile && !hasRegistryDir) continue;

    let lockfile: RegistryLockfile = { entries: {} };
    if (hasLockfile) {
      lockfile = await readLockfile(paths.lockfilePath);
    }

    const matchedFromLock = targetNames.find((target) => lockfile.entries[target] !== undefined);
    let matchedName = matchedFromLock;
    if (!matchedName && hasRegistryDir) {
      matchedName = targetNames.find((target) => existsSync(join(paths.registryDir, target)));
    }
    if (!matchedName) continue;

    const lockEntry = lockfile.entries[matchedName];
    const installedPath = lockEntry?.installedPath ?? join(paths.registryDir, matchedName);
    await rm(installedPath, { force: true });

    if (lockEntry) {
      delete lockfile.entries[matchedName];
      await writeLockfile(paths.lockfilePath, lockfile);
    }

    removedFrom.push(scope);
  }

  return {
    name: normalizeAgentName(name),
    removed: removedFrom.length > 0,
    removedFrom,
  };
}

export async function listAgents(options: RegistryOptions = {}): Promise<ListedAgent[]> {
  const scopes: RegistryScope[] = options.scope ? [options.scope] : ["project", "user"];
  const listed: ListedAgent[] = [];

  for (const scope of scopes) {
    const paths = getRegistryPaths(scope, options);
    if (!await Bun.file(paths.lockfilePath).exists()) continue;

    const lockfile = await readLockfile(paths.lockfilePath);
    for (const [name, entry] of Object.entries(lockfile.entries)) {
      listed.push({
        name,
        scope,
        lockfilePath: paths.lockfilePath,
        ...entry,
      });
    }
  }

  listed.sort((a, b) => {
    if (a.installedAt === b.installedAt) return a.name.localeCompare(b.name);
    return b.installedAt.localeCompare(a.installedAt);
  });

  return listed;
}
