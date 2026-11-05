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
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { containedWritePath } from "./contained-write";
import { registryLocation } from "./project-root";
import { fetchTextResource } from "./fetch";
import { MAX_INPUT_SIZE } from "./limits";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join } from "path";
import { atomicWriteFile, withAtomicFileLock } from "./state-file";
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

function registryTarget(paths: RegistryPaths, relativePath: string): string {
  const parts = relativePath.split("/");
  if (!relativePath.endsWith(".md") || parts.some(p => !/^[a-zA-Z0-9._-]+$/.test(p) || p === "." || p === "..")) {
    throw new Error("Invalid path in registry lockfile: " + relativePath);
  }
  containedWritePath(dirname(paths.mdflowDir), MDFLOW_DIR_NAME, REGISTRY_DIR_NAME, ...parts);
  return join(paths.registryDir, ...parts);
}

// Old locks stored absolute paths. Relocate their registry-relative suffix;
// never read, write or unlink the pathname supplied by an untrusted lock.
function portablePath(recorded: string): string {
  const path = recorded.replaceAll("\\", "/");
  if (!isAbsolute(path) && !/^[A-Za-z]:/.test(path)) return path;
  const marker = "/.mdflow/registry/";
  const idx = path.lastIndexOf(marker);
  if (idx < 0) throw new Error("Invalid installed path outside the registry");
  return path.slice(idx + marker.length);
}

function readLockfile(paths: RegistryPaths): RegistryLockfile {
  const entries: Record<string, LockfileEntry> = Object.create(null);
  const owner = dirname(paths.mdflowDir);
  if (!existsSync(owner)) return { entries };
  containedWritePath(owner, MDFLOW_DIR_NAME, LOCKFILE_NAME);
  let parsed: unknown;
  try {
    if (statSync(paths.lockfilePath).size > MAX_INPUT_SIZE) throw new Error("lockfile too large");
    parsed = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries };
    throw new Error("Unreadable registry lockfile: " + paths.lockfilePath, { cause: err });
  }
  if (!isRecord(parsed) || !isRecord(parsed.entries)) throw new Error("Invalid registry lockfile: expected entries");
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(parsed.entries)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || !isLockfileEntry(value) || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error("Invalid registry lockfile entry: " + name);
    }
    const installedPath = portablePath(value.installedPath);
    registryTarget(paths, installedPath);
    if (seen.has(installedPath)) throw new Error("Duplicate installed path: " + installedPath);
    seen.add(installedPath);
    entries[name] = { ...value, installedPath };
  }
  return { entries };
}

function writeLockfile(paths: RegistryPaths, lock: RegistryLockfile): void {
  atomicWriteFile(paths.lockfilePath, JSON.stringify(lock, null, 2) + "\n", 0o600);
}

function changeRegistry<T>(paths: RegistryPaths, change: (lock: RegistryLockfile) => T): T {
  containedWritePath(dirname(paths.mdflowDir), MDFLOW_DIR_NAME, LOCKFILE_NAME + ".lock");
  return withAtomicFileLock(paths.lockfilePath, () => change(readLockfile(paths)));
}

export function verifiedRegistryText(path: string, entry: LockfileEntry): string {
  if (statSync(path).size > MAX_INPUT_SIZE) throw new Error("Installed flow exceeds the input limit");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error("Registry integrity check failed (SHA-256 mismatch): " + path + ". Review the file and reinstall from the intended source.");
  }
  return bytes.toString("utf8");
}

/** Hash the very bytes returned to the parser, not an earlier file read. */
export function readVerifiedRegistryFlow(path: string): string {
  const location = registryLocation(path);
  if (!location) throw new Error("Not a registry path: " + path);
  const paths = getRegistryPaths("project", { cwd: location.owner });
  const target = registryTarget(paths, location.member);
  const lock = readLockfile(paths);
  const entry = Object.values(lock.entries).find(e => e.installedPath === location.member);
  if (!entry) throw new Error("Unpinned registry flow: " + path + ". Install it with md install before running it.");
  return verifiedRegistryText(target, entry);
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
  const response = await fetchTextResource(resolved.downloadUrl, { fetchFn: options.fetchFn,
    headers: { "User-Agent": "mdflow/registry", Accept: "text/markdown, text/plain, */*" },
  });
  if (!response.ok) throw new Error(`Failed to install agent from "${resolved.downloadUrl}": HTTP ${response.status} ${response.statusText}`);
  if (!response.text.trim()) throw new Error("Downloaded agent content is empty: " + resolved.downloadUrl);

  return changeRegistry(paths, lock => {
    let name = resolved.suggestedName;
    const collision = buildCollisionName(name, resolved.source);
    for (let i = 1; lock.entries[name] && lock.entries[name]!.source !== resolved.source; i++) {
      name = i === 1 ? collision : getNameWithoutMdExtension(collision) + "-" + i + ".md";
    }
    const member = lock.entries[name]?.installedPath ?? name;
    const target = registryTarget(paths, member);
    if (!lock.entries[name] && (existsSync(target) || Object.values(lock.entries).some(e => e.installedPath === member))) {
      throw new Error("Refusing to overwrite a file not owned by this install: " + target);
    }
    const stem = target.slice(0, -3);
    if ([stem + ".hooks.ts", stem + ".eval.ts"].some(p => existsSync(p))) {
      throw new Error("Refusing to install: unexpected sidecar file next to " + target + ". Remove it before installing.");
    }
    const entry: LockfileEntry = { source: resolved.source, sha256: hashSha256(response.text), installedPath: member,
      installedAt: (options.now?.() ?? new Date()).toISOString(), ...(resolved.resolvedRef && { resolvedRef: resolved.resolvedRef }),
    };
    // Both renames are atomic individually. An interruption between them is
    // detectable: a missing/mismatched pin can never authorize execution.
    atomicWriteFile(target, response.text, 0o644);
    lock.entries[name] = entry;
    writeLockfile(paths, lock);
    return { ...entry, name, scope, installedPath: target, lockfilePath: paths.lockfilePath };
  });
}

export async function removeAgent(name: string, options: RegistryOptions = {}): Promise<RemoveAgentResult> {
  if (!name.trim()) throw new Error("Agent name is required");
  const removedFrom: RegistryScope[] = [];
  const scopes: RegistryScope[] = options.scope ? [options.scope] : ["project", "user"];
  for (const scope of scopes) {
    const paths = getRegistryPaths(scope, options);
    if (!existsSync(paths.mdflowDir)) continue;
    changeRegistry(paths, lock => {
      const match = getCandidateNames(name).find(key => Object.hasOwn(lock.entries, key));
      if (!match) return;
      const entry = lock.entries[match]!;
      const target = registryTarget(paths, entry.installedPath);
      if (existsSync(target)) {
        verifiedRegistryText(target, entry); // never remove a locally replaced file
        unlinkSync(target);
      }
      delete lock.entries[match];
      writeLockfile(paths, lock);
      removedFrom.push(scope);
    });
  }
  return { name: normalizeAgentName(name), removed: removedFrom.length > 0, removedFrom };
}

export async function listAgents(options: RegistryOptions = {}): Promise<ListedAgent[]> {
  const scopes: RegistryScope[] = options.scope ? [options.scope] : ["project", "user"];
  const listed: ListedAgent[] = [];
  for (const scope of scopes) {
    const paths = getRegistryPaths(scope, options);
    for (const [name, entry] of Object.entries(readLockfile(paths).entries)) {
      listed.push({ ...entry, name, scope, lockfilePath: paths.lockfilePath, installedPath: registryTarget(paths, entry.installedPath) });
    }
  }
  return listed.sort((a, b) => b.installedAt.localeCompare(a.installedAt) || a.name.localeCompare(b.name));
}
