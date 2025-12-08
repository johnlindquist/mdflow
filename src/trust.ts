/**
 * Trust on First Use (TOFU) security policy for remote URL execution
 *
 * When a remote URL is encountered for the first time:
 * 1. Pause execution and display the command, frontmatter, and body preview
 * 2. Ask user to confirm execution
 * 3. Optionally remember the domain for future use
 *
 * Trusted domains are stored in ~/.markdown-agent/known_hosts
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";
import { confirm, select } from "@inquirer/prompts";
import type { AgentFrontmatter } from "./types";

const CONFIG_DIR = join(homedir(), ".markdown-agent");
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
 * Load trusted domains from ~/.markdown-agent/known_hosts
 * Returns an empty set if the file doesn't exist
 */
export async function loadKnownHosts(): Promise<Set<string>> {
  try {
    const file = Bun.file(KNOWN_HOSTS_FILE);
    if (!await file.exists()) {
      return new Set();
    }
    const content = await file.text();
    const domains = content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    return new Set(domains);
  } catch {
    return new Set();
  }
}

/**
 * Save trusted domains to ~/.markdown-agent/known_hosts
 */
export async function saveKnownHosts(hosts: Set<string>): Promise<void> {
  // Ensure config directory exists
  await mkdir(CONFIG_DIR, { recursive: true });

  const content = [
    "# markdown-agent known hosts",
    "# Domains listed here are trusted for remote execution",
    "# Add one domain per line",
    "",
    ...Array.from(hosts).sort(),
    "",
  ].join("\n");

  await Bun.write(KNOWN_HOSTS_FILE, content);
}

/**
 * Check if a domain is already trusted
 */
export async function isDomainTrusted(url: string): Promise<boolean> {
  const domain = extractDomain(url);
  const knownHosts = await loadKnownHosts();
  return knownHosts.has(domain);
}

/**
 * Add a domain to the known_hosts file
 */
export async function addTrustedDomain(url: string): Promise<void> {
  const domain = extractDomain(url);
  const knownHosts = await loadKnownHosts();
  knownHosts.add(domain);
  await saveKnownHosts(knownHosts);
}

/**
 * Format frontmatter for display
 */
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
  const domain = extractDomain(url);

  console.error("\n");
  console.error("=".repeat(70));
  console.error("SECURITY WARNING: Remote Agent Execution");
  console.error("=".repeat(70));
  console.error("");
  console.error(`URL: ${url}`);
  console.error(`Domain: ${domain}`);
  console.error("");
  console.error("-".repeat(70));
  console.error("Command to execute:");
  console.error("-".repeat(70));
  console.error(`  ${command}`);
  console.error("");
  console.error("-".repeat(70));
  console.error("Frontmatter (CLI flags):");
  console.error("-".repeat(70));
  console.error(formatFrontmatter(frontmatter));
  console.error("");
  console.error("-".repeat(70));
  console.error("Body preview:");
  console.error("-".repeat(70));
  console.error(truncateBody(body));
  console.error("");
  console.error("=".repeat(70));
  console.error("");

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
      { name: `Yes, always trust ${domain}`, value: "yes" },
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
