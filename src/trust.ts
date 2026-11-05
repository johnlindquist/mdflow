/**
 * Trust on First Use (TOFU) security policy for remote URL execution
 *
 * When a remote URL is encountered for the first time:
 * 1. Pause execution and display the command, frontmatter, and body preview
 * 2. Ask user to confirm execution
 * 3. Optionally remember the domain for future use
 *
 * Trusted domains are stored in ~/.mdflow/known_hosts
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "node:fs";
import { atomicWriteFile, withAtomicFileLock } from "./state-file";
import { validateUrl } from "./security";
import type { AgentFrontmatter } from "./types";

const CONFIG_DIR = join(homedir(), ".mdflow");
const KNOWN_HOSTS_FILE = join(CONFIG_DIR, "known_hosts");

/** Maximum body preview length in characters */
const BODY_PREVIEW_LENGTH = 500;

/**
 * Extract domain from a URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
}

/**
 * Load trusted domains from ~/.mdflow/known_hosts
 * Returns an empty set if the file doesn't exist
 */
function readHosts(): Set<string> {
  try { return new Set(readFileSync(KNOWN_HOSTS_FILE, "utf8").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"))); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw cause; }
}
export async function loadKnownHosts(): Promise<Set<string>> { return readHosts(); }

function writeHosts(hosts: Set<string>): void {
  atomicWriteFile(KNOWN_HOSTS_FILE, ["# mdflow known hosts", "# Origins trusted for remote execution (bare hosts mean HTTPS on its default port).", ...[...hosts].sort(), ""].join("\n"));
}
export async function saveKnownHosts(hosts: Set<string>): Promise<void> {
  withAtomicFileLock(KNOWN_HOSTS_FILE, () => writeHosts(hosts));
}
export async function isDomainTrusted(url: string): Promise<boolean> {
  const parsed = validateUrl(url, {});
  const hosts = readHosts();
  return hosts.has(parsed.origin) || (parsed.protocol === "https:" && !parsed.port && hosts.has(parsed.hostname));
}
export async function addTrustedDomain(url: string): Promise<void> {
  const origin = validateUrl(url, {}).origin;
  withAtomicFileLock(KNOWN_HOSTS_FILE, () => writeHosts(readHosts().add(origin)));
}

/** Escape terminal controls and bidi overrides before displaying remote bytes at a consent prompt. */
function displayUntrusted(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Format frontmatter for display. */
function formatFrontmatter(frontmatter: AgentFrontmatter): string {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) {
    return "  (none)";
  }
  return entries
    .map(([key, value]) => {
      if (typeof value === "object") {
        return `  ${key}: ${JSON.stringify(value)}`;
      }
      return `  ${key}: ${value}`;
    })
    .join("\n");
}

/**
 * Truncate body for preview with ellipsis
 */
function truncateBody(body: string, maxLength: number = BODY_PREVIEW_LENGTH): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength) + "\n... (truncated)";
}

/** Result from trust prompt */
export interface TrustPromptResult {
  /** Whether the user approved execution */
  approved: boolean;
  /** Whether to remember this domain */
  rememberDomain: boolean;
}

/**
 * Display preview of remote content and prompt for user confirmation
 *
 * @param url - The remote URL being executed
 * @param command - The resolved command to run
 * @param frontmatter - Parsed frontmatter from the markdown file
 * @param body - The body content (will be truncated for preview)
 * @returns Object with approved (boolean) and rememberDomain (boolean)
 */
export async function promptForTrust(
  url: string,
  command: string,
  frontmatter: AgentFrontmatter,
  body: string
): Promise<TrustPromptResult> {
  const domain = validateUrl(url, {}).origin;

  console.error("\n");
  console.error("=".repeat(70));
  console.error("SECURITY WARNING: Remote Agent Execution");
  console.error("=".repeat(70));
  console.error("");
  console.error(`URL: ${displayUntrusted(url)}`);
  console.error(`Domain: ${domain}`);
  console.error("");
  console.error("-".repeat(70));
  console.error("Command to execute:");
  console.error("-".repeat(70));
  console.error(`  ${displayUntrusted(command)}`);
  console.error("");
  console.error("-".repeat(70));
  console.error("Frontmatter (CLI flags):");
  console.error("-".repeat(70));
  console.error(displayUntrusted(formatFrontmatter(frontmatter)));
  console.error("");
  console.error("-".repeat(70));
  console.error("Body preview:");
  console.error("-".repeat(70));
  console.error(displayUntrusted(truncateBody(body)));
  console.error("");
  console.error("=".repeat(70));
  console.error("");

  // Inquirer loads lazily: trust prompts only appear for untrusted remote
  // flows, and its ~50ms import must never tax ordinary local startup.
  const { confirm, select } = await import("@inquirer/prompts");

  // First confirm execution
  const approved = await confirm({
    message: `Execute this remote agent from ${domain}?`,
    default: false,
  });

  if (!approved) {
    return { approved: false, rememberDomain: false };
  }

  // Ask whether to remember this domain
  const rememberChoice = await select({
    message: `Trust ${domain} for future executions?`,
    choices: [
      { name: "No, ask me next time", value: "no" },
      { name: `Yes, trust every path on ${domain}`, value: "yes" },
    ],
    default: "no",
  });

  return {
    approved: true,
    rememberDomain: rememberChoice === "yes",
  };
}

/**
 * Get the known hosts file path (for display/debugging)
 */
export function getKnownHostsPath(): string {
  return KNOWN_HOSTS_FILE;
}

/**
 * Clear the known hosts file (for testing)
 */
export async function clearKnownHosts(): Promise<void> {
  try {
    const file = Bun.file(KNOWN_HOSTS_FILE);
    if (await file.exists()) {
      await Bun.write(KNOWN_HOSTS_FILE, "");
    }
  } catch {
    // Ignore errors
  }
}
