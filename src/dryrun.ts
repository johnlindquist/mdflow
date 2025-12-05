/**
 * Dry-run / audit mode for inspecting what would be executed
 * Shows commands and prompt without running anything
 */

import type { AgentFrontmatter, CopilotFrontmatter } from "./types";
import type { ContextFile } from "./context";
import type { RunnerName } from "./runners/types";

export interface DryRunInfo {
  frontmatter: AgentFrontmatter;
  prompt: string;
  copilotArgs: string[];  // Kept for backward compatibility
  runnerArgs?: string[];
  runnerName?: RunnerName;
  contextFiles: ContextFile[];
  beforeCommands: string[];
  afterCommands: string[];
  templateVars: Record<string, string>;
}

/**
 * Format dry-run information for display
 */
export function formatDryRun(info: DryRunInfo): string {
  const sections: string[] = [];
  const runnerName = info.runnerName || "copilot";
  const args = info.runnerArgs || info.copilotArgs;

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

  // Before commands
  if (info.beforeCommands.length > 0) {
    sections.push("⚡ BEFORE COMMANDS (will execute)");
    sections.push("───────────────────────────────────────────────────────────────");
    for (let i = 0; i < info.beforeCommands.length; i++) {
      sections.push(`  ${i + 1}. ${info.beforeCommands[i]}`);
    }
    sections.push("");
  }

  // Runner command
  sections.push(`🤖 ${runnerName.toUpperCase()} COMMAND`);
  sections.push("───────────────────────────────────────────────────────────────");
  sections.push(`  ${runnerName} ${args.join(" ")} <prompt>`);
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

  // After commands
  if (info.afterCommands.length > 0) {
    sections.push("⚡ AFTER COMMANDS (will execute)");
    sections.push("───────────────────────────────────────────────────────────────");
    for (let i = 0; i < info.afterCommands.length; i++) {
      const note = i === 0 ? ` (receives ${runnerName} output via stdin)` : "";
      sections.push(`  ${i + 1}. ${info.afterCommands[i]}${note}`);
    }
    sections.push("");
  }

  // Configuration summary
  sections.push("⚙️  CONFIGURATION");
  sections.push("───────────────────────────────────────────────────────────────");
  sections.push(`  Runner: ${runnerName}`);
  if (info.frontmatter.model) {
    sections.push(`  Model: ${info.frontmatter.model}`);
  }
  const agent = info.frontmatter.copilot?.agent;
  if (agent) {
    sections.push(`  Agent: ${agent}`);
  }
  if (info.frontmatter.extract) {
    sections.push(`  Extract: ${info.frontmatter.extract}`);
  }
  if (info.frontmatter.cache) {
    sections.push(`  Cache: enabled`);
  }
  if (info.frontmatter.silent) {
    sections.push(`  Silent: true`);
  }
  if (info.frontmatter.interactive) {
    sections.push(`  Interactive: true`);
  }
  sections.push("");

  // Footer
  sections.push("═══════════════════════════════════════════════════════════════");
  sections.push("  To execute, run without --dry-run");
  sections.push("═══════════════════════════════════════════════════════════════");

  return sections.join("\n");
}

/**
 * Extract command list from string or array
 */
export function toCommandList(commands: string | string[] | undefined): string[] {
  if (!commands) return [];
  return Array.isArray(commands) ? commands : [commands];
}
