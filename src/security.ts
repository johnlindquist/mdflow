import { homedir } from "os";
import { isAbsolute, relative, resolve, sep } from "path";

const URL_PROTOCOL_ALLOWLIST = new Set(["http:", "https:"]);

const SENSITIVE_ENV_PATTERNS: RegExp[] = [
  /(^|_)SECRET($|_)/i,
  /(^|_)TOKEN($|_)/i,
  /(^|_)PASSWORD($|_)/i,
  /(^|_)PASS($|_)/i,
  /(^|_)API[_-]?KEY($|_)/i,
  /(^|_)PRIVATE[_-]?KEY($|_)/i,
  /(^|_)CLIENT[_-]?SECRET($|_)/i,
  /(^|_)ACCESS[_-]?KEY($|_)/i,
  /(^|_)AUTH($|_)/i,
  /(^|_)CREDENTIAL/i,
];

const PUBLIC_ENV_PREFIXES = ["PUBLIC_", "NEXT_PUBLIC_", "VITE_"];

export interface SanitizePathOptions {
  baseDir: string;
  projectRoot: string;
}

export interface ValidateUrlOptions {
  allowlist?: readonly string[];
  blocklist?: readonly string[];
}

export type ShellEscapeMode = "posix" | "win32";

function expandTilde(input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    return input.replace("~", homedir());
  }
  return input;
}

function isWithinBasePath(candidatePath: string, basePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function sanitizePathWithinBasePath(basePath: string, inputPath: string): string {
  const resolvedBasePath = resolve(expandTilde(basePath));
  const resolvedInputPath = resolve(resolvedBasePath, expandTilde(inputPath));

  if (isWithinBasePath(resolvedInputPath, resolvedBasePath)) {
    return resolvedInputPath;
  }

  const hasTraversalSegments = inputPath
    .split(/[\\/]+/)
    .some((segment) => segment === "..");

  if (hasTraversalSegments) {
    throw new Error(
      `Path traversal blocked: "${inputPath}" escapes base path "${resolvedBasePath}".`
    );
  }

  throw new Error(
    `Import path "${inputPath}" resolves outside base path "${resolvedBasePath}".`
  );
}

export function sanitizePath(basePath: string, inputPath: string): string;
export function sanitizePath(inputPath: string, options: SanitizePathOptions): string;
export function sanitizePath(
  basePathOrInputPath: string,
  inputPathOrOptions: string | SanitizePathOptions
): string {
  if (typeof inputPathOrOptions === "string") {
    return sanitizePathWithinBasePath(basePathOrInputPath, inputPathOrOptions);
  }

  const projectRoot = resolve(expandTilde(inputPathOrOptions.projectRoot));
  const baseDir = resolve(expandTilde(inputPathOrOptions.baseDir));
  const resolvedPath = resolve(baseDir, expandTilde(basePathOrInputPath));

  if (isWithinBasePath(resolvedPath, projectRoot)) {
    return resolvedPath;
  }

  const hasTraversalSegments = basePathOrInputPath
    .split(/[\\/]+/)
    .some((segment) => segment === "..");

  if (hasTraversalSegments) {
    throw new Error(
      `Path traversal blocked: "${basePathOrInputPath}" escapes project root "${projectRoot}".`
    );
  }

  throw new Error(
    `Import path "${basePathOrInputPath}" resolves outside project root "${projectRoot}".`
  );
}

function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase();
}

function matchesDomainRule(url: URL, rawRule: string): boolean {
  const rule = normalizeRule(rawRule);
  if (!rule) return false;
  if (rule === "*") return true;

  const href = url.href.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const hostWithPort = url.port ? `${hostname}:${url.port}` : hostname;

  if (rule.startsWith("http://") || rule.startsWith("https://")) {
    return href.startsWith(rule);
  }

  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }

  return hostWithPort === rule || hostname === rule;
}

function parseHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}".`);
  }

  if (!URL_PROTOCOL_ALLOWLIST.has(parsed.protocol)) {
    throw new Error(
      `Unsupported URL protocol "${parsed.protocol}". Only http:// and https:// are allowed.`
    );
  }
  return parsed;
}

export function validateUrl(rawUrl: string): boolean;
export function validateUrl(rawUrl: string, options: ValidateUrlOptions): URL;
export function validateUrl(rawUrl: string, options?: ValidateUrlOptions): boolean | URL {
  let parsed: URL;
  try {
    parsed = parseHttpUrl(rawUrl);
  } catch (err) {
    if (!options) {
      return false;
    }
    throw err;
  }

  if (!options) {
    return true;
  }

  const blocklist = (options.blocklist ?? []).filter(Boolean);
  if (blocklist.some((rule) => matchesDomainRule(parsed, rule))) {
    throw new Error(`URL host is blocked by policy: "${parsed.hostname}".`);
  }

  const allowlist = (options.allowlist ?? []).filter(Boolean);
  if (allowlist.length > 0 && !allowlist.some((rule) => matchesDomainRule(parsed, rule))) {
    throw new Error(
      `URL host is not in allowlist: "${parsed.hostname}".`
    );
  }

  return parsed;
}

export function escapeShellArg(arg: string, mode: ShellEscapeMode = "posix"): string {
  if (mode === "win32") {
    if (arg.length === 0) return "\"\"";
    const escaped = arg
      .replace(/"/g, "\"\"")
      .replace(/([&|<>^%!])/g, "^$1");
    return `"${escaped}"`;
  }

  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

export function detectSensitiveEnvVars(
  source: Iterable<string> | Record<string, unknown>
): string[] {
  const rawKeys = Symbol.iterator in Object(source)
    ? Array.from(source as Iterable<string>)
    : Object.keys(source as Record<string, unknown>);

  const found = new Set<string>();

  for (const rawKey of rawKeys) {
    const key = rawKey.trim();
    if (!key) continue;

    const upperKey = key.toUpperCase();
    if (PUBLIC_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      continue;
    }

    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(upperKey))) {
      found.add(key);
    }
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}
