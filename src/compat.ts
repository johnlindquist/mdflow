/**
 * Frontmatter compatibility/versioning system.
 *
 * Every flow carries the mdflow version it is known to work with, without the
 * user ever thinking about it:
 * - `_mdflow_version`: stamped at creation time (`md create`, `md init`).
 * - `_compat`: the newest mdflow version that has successfully run the flow;
 *   stamped/upgraded automatically after a successful local run.
 *
 * Both are `_`-prefixed system keys: never passed as CLI flags, and a file
 * whose frontmatter contains ONLY these keys still counts as a plain document
 * for the document-vs-flow decision.
 *
 * Stamping is a surgical, line-level edit of the frontmatter block — the rest
 * of the file is preserved byte for byte (evolve relies on byte-identical
 * bodies, and users rely on their formatting surviving).
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseRawFrontmatter } from "./parse";

/** Frontmatter keys owned by the compat system. */
export const COMPAT_KEYS = new Set(["_mdflow_version", "_compat"]);

let cachedVersion: string | null = null;

/** The running mdflow version, read from package.json. */
export function mdflowVersion(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
      cachedVersion = String(pkg.version ?? "0.0.0");
    } catch {
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** Parse a semver-ish string ("3.0.0", "v3.0.0-next.2"). Null if unparseable. */
export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const match = String(raw)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Semver comparison: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release outranks any prerelease of the same core version.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai) ? Number(ai) : null;
    const bn = /^\d+$/.test(bi) ? Number(bi) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
    } else if (an !== null) {
      return -1; // numeric identifiers sort before alphanumeric
    } else if (bn !== null) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The newest mdflow version this flow is known to work with:
 * max(_compat, _mdflow_version). Null when the flow carries no version info.
 */
export function recordedVersion(frontmatter: Record<string, unknown>): ParsedVersion | null {
  const compat = parseVersion(frontmatter["_compat"]);
  const created = parseVersion(frontmatter["_mdflow_version"]);
  if (compat && created) return compareVersions(compat, created) >= 0 ? compat : created;
  return compat ?? created;
}

/**
 * True when the frontmatter is empty apart from compat-owned keys — used by
 * the document-vs-flow decision so stamping never turns a document into an
 * executable flow (or vice versa).
 */
export function isCompatOnlyFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return Object.keys(frontmatter).every((key) => COMPAT_KEYS.has(key));
}

/**
 * A one-line stderr notice when the flow's recorded version and the running
 * mdflow disagree on major version. Null when they agree, when the flow has
 * no version info (it gets stamped on first success), or when versions are
 * unparseable.
 */
export function compatNotice(
  frontmatter: Record<string, unknown>,
  currentVersion = mdflowVersion()
): string | null {
  const recorded = recordedVersion(frontmatter);
  const current = parseVersion(currentVersion);
  if (!recorded || !current) return null;
  const recordedRaw = frontmatter["_compat"] ?? frontmatter["_mdflow_version"];
  if (recorded.major > current.major) {
    return `flow expects mdflow v${recorded.major} (last verified with ${String(recordedRaw)}); this is mdflow ${currentVersion} — consider upgrading mdflow`;
  }
  if (recorded.major < current.major) {
    return `flow was last verified with mdflow ${String(recordedRaw)} (v${recorded.major}); this is mdflow ${currentVersion} — a clean run will re-verify it automatically`;
  }
  return null;
}

/** Split content into shebang prefix (with trailing newline) and the rest. */
function splitShebang(content: string): [string, string] {
  if (!content.startsWith("#!")) return ["", content];
  const nl = content.indexOf("\n");
  if (nl === -1) return [content + "\n", ""];
  return [content.slice(0, nl + 1), content.slice(nl + 1)];
}

/**
 * Set a top-level `key: value` line inside the frontmatter block, creating
 * the block if absent. Everything else is preserved byte for byte.
 */
function setFrontmatterKey(content: string, key: string, value: string): string {
  const [shebang, rest] = splitShebang(content);
  const lines = rest.split("\n");

  if (lines[0]?.trim() !== "---") {
    // No frontmatter block — create one above the body.
    return `${shebang}---\n${key}: ${value}\n---\n\n${rest.replace(/^\n+/, "")}`;
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    // Unterminated block — leave the file alone rather than guess.
    return content;
  }

  // Top-level YAML keys sit at column 0, so a column-0 match is unambiguous.
  const keyLine = `${key}: ${value}`;
  for (let i = 1; i < endIndex; i++) {
    if (lines[i]!.startsWith(`${key}:`)) {
      lines[i] = keyLine;
      return shebang + lines.join("\n");
    }
  }
  lines.splice(endIndex, 0, keyLine);
  return shebang + lines.join("\n");
}

/**
 * Stamp the creation version (`_mdflow_version`) into flow content that does
 * not already carry version info. Pure; returns the (possibly unchanged)
 * content. Used by `md init` when writing/verifying scaffolded flows.
 */
export function stampCreatedVersion(content: string, version = mdflowVersion()): string {
  try {
    const { frontmatter } = parseRawFrontmatter(content);
    const fm = (frontmatter ?? {}) as Record<string, unknown>;
    if (fm["_mdflow_version"] !== undefined || fm["_compat"] !== undefined) return content;
    return setFrontmatterKey(content, "_mdflow_version", version);
  } catch {
    return content; // unparseable frontmatter — never make it worse
  }
}

/**
 * Compute the post-success `_compat` stamp. Returns the new content, or null
 * when no write is needed. Pure — file IO lives in stampCompatFile.
 *
 * Writes only when it matters: when the flow carries no version info at all,
 * or when the recorded version is behind on major or minor. Patch and
 * prerelease bumps of mdflow do NOT rewrite every flow — that would turn
 * each release into a wall of one-line git diffs across users' repos.
 */
export function applyCompatStamp(content: string, version = mdflowVersion()): string | null {
  const current = parseVersion(version);
  if (!current) return null;

  let fm: Record<string, unknown>;
  try {
    fm = (parseRawFrontmatter(content).frontmatter ?? {}) as Record<string, unknown>;
  } catch {
    return null; // unparseable frontmatter — leave the file alone
  }

  const recorded = recordedVersion(fm);
  if (recorded) {
    if (compareVersions(recorded, current) >= 0) return null;
    if (recorded.major === current.major && recorded.minor === current.minor) return null;
  }

  const next = setFrontmatterKey(content, "_compat", version);
  return next === content ? null : next;
}

/**
 * After a successful run, record the running mdflow version as verified
 * compatible. Best-effort and silent: a failed stamp must never break a
 * successful run. Returns true when the file was updated.
 */
export function stampCompatFile(filePath: string, version = mdflowVersion()): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    const next = applyCompatStamp(content, version);
    if (next === null) return false;
    writeFileSync(filePath, next);
    return true;
  } catch {
    return false;
  }
}
