/**
 * Dry-run mode for inspecting what would be executed
 * Shows commands and prompt without running anything
 */

import type { AgentFrontmatter } from "./types";
import type { ContextFile } from "./context";

export interface DryRunInfo {
  frontmatter: AgentFrontmatter;
  prompt: string;
  harnessArgs: string[];
  harnessName: string;
  contextFiles: ContextFile[];
  templateVars: Record<string, string>;
}

/**
 * Format dry-run information for display
 */
export function formatDryRun(info: DryRunInfo): string {
  const sections: string[] = [];
  const command = info.harnessName;
  const args = info.harnessArgs;

  // Header
  sections.push("═══════════════════════════════════════════════════════════════");
  sections.push("                          DRY RUN MODE");
  sections.push("═══════════════════════════════════════════════════════════════");
  sections.push("");

  // Prerequisites
  if (info.frontmatter.requires) {
    sections.push("📋 PREREQUISITES");
    sections.push("───────────────────────────────────────────────────────────────");
    if (info.frontmatter.requires.bin?.length) {
      sections.push(`  Binaries: ${info.frontmatter.requires.bin.join(", ")}`);
    }
    if (info.frontmatter.requires.env?.length) {
      sections.push(`  Environment: ${info.frontmatter.requires.env.join(", ")}`);
    }
    sections.push("");
  }

  // Template variables
  if (Object.keys(info.templateVars).length > 0) {
    sections.push("🔤 TEMPLATE VARIABLES");
    sections.push("───────────────────────────────────────────────────────────────");
    for (const [key, value] of Object.entries(info.templateVars)) {
      sections.push(`  {{ ${key} }} = "${value}"`);
    }
    sections.push("");
  }

  // Context files
  if (info.contextFiles.length > 0) {
    sections.push("📁 CONTEXT FILES");
    sections.push("───────────────────────────────────────────────────────────────");
    for (const file of info.contextFiles) {
      const lines = file.content.split("\n").length;
      sections.push(`  ${file.relativePath} (${lines} lines)`);
    }
    sections.push("");
  }

  // Command
  sections.push(`🤖 COMMAND`);
  sections.push("───────────────────────────────────────────────────────────────");
  sections.push(`  ${command} ${args.join(" ")} <prompt>`);
  sections.push("");

  // Prompt preview
  sections.push("📝 PROMPT PREVIEW");
  sections.push("───────────────────────────────────────────────────────────────");
  const promptLines = info.prompt.split("\n");
  const maxLines = 30;
  const previewLines = promptLines.slice(0, maxLines);
  for (const line of previewLines) {
    sections.push(`  ${line}`);
  }
  if (promptLines.length > maxLines) {
    sections.push(`  ... (${promptLines.length - maxLines} more lines)`);
  }
  sections.push("");

  // Configuration summary
  sections.push("⚙️  CONFIGURATION");
  sections.push("───────────────────────────────────────────────────────────────");
  sections.push(`  Command: ${command}`);
  // Show all frontmatter keys that aren't system keys
  const systemKeys = new Set(["command", "inputs", "context", "requires", "cache"]);
  for (const [key, value] of Object.entries(info.frontmatter)) {
    if (systemKeys.has(key)) continue;
    if (value === undefined || value === null) continue;
    sections.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  if (info.frontmatter.cache) {
    sections.push(`  Cache: enabled`);
  }
  sections.push("");

  // Footer
  sections.push("═══════════════════════════════════════════════════════════════");
  sections.push("  To execute, run without --dry-run");
  sections.push("═══════════════════════════════════════════════════════════════");

  return sections.join("\n");
}
