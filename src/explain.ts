/**
 * `md explain` subcommand - Shows resolved configuration for an agent
 *
 * Displays:
 * - Resolved command
 * - Final flags (after precedence merging)
 * - Final expanded prompt (truncated if long)
 * - Trust status + why (for remote URLs)
 * - Env keys set (redacted values)
 * - Configuration precedence applied
 */

import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { parseFrontmatter } from "./parse";
import {
  resolveCommand, buildArgs, extractPositionalMappings,
  extractEnvVars, hasInteractiveMarker,
} from "./command";
import {
  loadGlobalConfig, loadProjectConfig, loadFullConfig,
  applyDefaults, applyInteractiveMode, BUILTIN_DEFAULTS, getConfigFile,
} from "./config";
import { getAdapter as getEngineAdapter } from "./adapters";
import { resolveIsolationMode, resolveIsolationDefaults } from "./isolation";
import { extractSystemPromptSpec, applySystemPromptToFrontmatter } from "./system-prompt";
import { expandContentImports, hasContentImports } from "./imports";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { isDomainTrusted, extractDomain, getKnownHostsPath } from "./trust";
import { isRemoteUrl, fetchRemote, cleanupRemote } from "./remote";
import { getTokenUsage } from "./tokenizer";
import type { AgentFrontmatter, CommandDefaults } from "./types";

const PROMPT_PREVIEW_LENGTH = 1000;

export interface ExplainResult {
  agentPath: string;
  isRemote: boolean;
  command: string;
  commandSource: string;
  finalFrontmatter: AgentFrontmatter;
  builtinDefaults: CommandDefaults | undefined;
  globalDefaults: CommandDefaults | undefined;
  projectDefaults: CommandDefaults | undefined;
  originalFrontmatter: AgentFrontmatter;
  finalArgs: string[];
  positionalMappings: Map<number, string>;
  finalPrompt: string;
  promptTruncated: boolean;
  tokenUsage: { tokens: number; limit: number; percentage: number; exceeds: boolean };
  trustStatus?: { domain: string; trusted: boolean; knownHostsPath: string };
  envKeys: string[];
  interactiveMode: boolean;
  interactiveModeSource: string;
  configPaths: { global: string; globalExists: boolean; project: string | null; projectExists: boolean };
  isolation: {
    isolated: boolean;
    explicit: boolean;
    supported: boolean;
    flags: CommandDefaults;
    warning?: string;
  };
  systemPrompt?: {
    replace: boolean;
    appendCount: number;
    error?: string;
  };
}

function truncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: text.slice(0, maxLength) + "\n... (truncated)", truncated: true };
}

function findProjectConfigPath(cwd: string): string | null {
  for (const name of ["mdflow.config.yaml", ".mdflow.yaml", ".mdflow.json"]) {
    const path = join(cwd, name);
    if (existsSync(path)) return path;
  }
  return null;
}

export async function analyzeAgent(filePath: string, passthroughArgs: string[] = []): Promise<ExplainResult> {
  let localFilePath = filePath;
  let isRemote = false;

  if (isRemoteUrl(filePath)) {
    const remoteResult = await fetchRemote(filePath, { noCache: true });
    if (!remoteResult.success) throw new Error(`Failed to fetch remote file: ${remoteResult.error}`);
    localFilePath = remoteResult.localPath!;
    isRemote = true;
  }

  const content = await Bun.file(localFilePath).text();
  const { frontmatter: originalFrontmatter, body: rawBody } = parseFrontmatter(content);

  let command: string, commandSource: string;
  const cmdIdx = passthroughArgs.findIndex((a) => a === "--_command" || a === "-_c");
  if (cmdIdx !== -1 && cmdIdx + 1 < passthroughArgs.length) {
    command = passthroughArgs[cmdIdx + 1]!;
    commandSource = "CLI flag (--_command)";
  } else {
    command = resolveCommand(localFilePath);
    commandSource = `Filename pattern (.${command}.md)`;
  }

  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(process.cwd());
  const fullConfig = await loadFullConfig(process.cwd());

  const builtinDefaults = BUILTIN_DEFAULTS.commands?.[command];
  const globalDefaults = globalConfig.commands?.[command];
  const projectDefaults = projectConfig.commands?.[command];
  const fullDefaults = fullConfig.commands?.[command];

  // Isolation: mirror cli-runner — ON by default, config defaults <
  // isolation defaults < frontmatter, so explain shows exactly what a run
  // would do.
  const engineAdapter = getEngineAdapter(command);
  const isolatedFlagIdx = passthroughArgs.indexOf("--_isolated");
  let cliIsolated: boolean | undefined;
  if (isolatedFlagIdx !== -1) {
    const next = passthroughArgs[isolatedFlagIdx + 1];
    cliIsolated = next === "false" ? false : true;
  }
  const isolationMode = resolveIsolationMode({
    frontmatter: originalFrontmatter as AgentFrontmatter,
    cliValue: cliIsolated,
    commandDefaults: fullDefaults,
  });
  const isolationInfo = resolveIsolationDefaults(engineAdapter, command);
  let effectiveDefaults = fullDefaults;
  if (isolationMode.isolated && !isolationInfo.unsupportedWarning) {
    effectiveDefaults = { ...(fullDefaults ?? {}), ...isolationInfo.defaults };
  }

  let frontmatter = applyDefaults(originalFrontmatter as AgentFrontmatter, effectiveDefaults);

  const interactiveFromFilename = hasInteractiveMarker(localFilePath);
  const interactiveFromCli = passthroughArgs.includes("--_interactive") || passthroughArgs.includes("-_i");
  const interactiveFromFrontmatter = frontmatter._interactive === true || frontmatter._i === true;

  let interactiveModeSource = "none (print mode)";
  if (interactiveFromFilename) interactiveModeSource = "Filename (.i. marker)";
  else if (interactiveFromCli) interactiveModeSource = "CLI flag (--_interactive)";
  else if (interactiveFromFrontmatter) interactiveModeSource = "Frontmatter (_interactive: true)";

  frontmatter = applyInteractiveMode(frontmatter, command, interactiveFromFilename || interactiveFromCli);

  // System prompt: apply the same translation a run would, with a
  // placeholder writer so explain never touches the filesystem.
  let systemPromptResult: ExplainResult["systemPrompt"];
  const systemPromptSpec = extractSystemPromptSpec(frontmatter);
  if (systemPromptSpec) {
    systemPromptResult = {
      replace: systemPromptSpec.replace !== undefined,
      appendCount: systemPromptSpec.append?.length ?? 0,
    };
    try {
      const applied = applySystemPromptToFrontmatter(
        engineAdapter, command, frontmatter, systemPromptSpec,
        () => "<generated system prompt file>"
      );
      frontmatter = applied.frontmatter;
    } catch (err) {
      systemPromptResult.error = (err as Error).message;
    }
  }

  const envVars = extractEnvVars(frontmatter);
  const envKeys = envVars ? Object.keys(envVars) : [];

  const templateVars: Record<string, string> = {};
  const internalKeys = new Set([
    "_interactive", "_i", "_cwd", "_subcommand",
    "_isolated", "_system-prompt", "_append-system-prompt",
  ]);
  for (const key of Object.keys(frontmatter).filter((k) => k.startsWith("_") && !internalKeys.has(k))) {
    const value = frontmatter[key];
    if (value != null && value !== "") templateVars[key] = String(value);
  }

  let expandedBody = rawBody;
  const fileDir = dirname(resolve(localFilePath));
  if (hasContentImports(rawBody)) {
    try {
      expandedBody = await expandContentImports(rawBody, fileDir, new Set(), false, { invocationCwd: process.cwd() });
    } catch (err) {
      expandedBody = rawBody + `\n\n[Import expansion error: ${(err as Error).message}]`;
    }
  }

  for (const v of extractTemplateVars(expandedBody)) {
    if (!(v in templateVars)) templateVars[v] = `[MISSING: ${v}]`;
  }
  const finalPromptFull = substituteTemplateVars(expandedBody, templateVars);
  const { text: finalPrompt, truncated: promptTruncated } = truncateText(finalPromptFull, PROMPT_PREVIEW_LENGTH);

  const templateVarSet = new Set(Object.keys(templateVars));
  const finalArgs = buildArgs(frontmatter, templateVarSet);
  const positionalMappings = extractPositionalMappings(frontmatter);

  const model = frontmatter.model as string | undefined;
  const contextWindow = frontmatter.context_window as number | undefined;
  const tokenUsage = getTokenUsage(finalPromptFull, model, contextWindow);

  let trustStatus: ExplainResult["trustStatus"];
  if (isRemote) {
    const domain = extractDomain(filePath);
    trustStatus = { domain, trusted: await isDomainTrusted(filePath), knownHostsPath: getKnownHostsPath() };
  }

  const globalConfigPath = getConfigFile();
  const projectConfigPath = findProjectConfigPath(process.cwd());

  if (isRemote) await cleanupRemote(localFilePath);

  return {
    agentPath: filePath, isRemote, command, commandSource, finalFrontmatter: frontmatter,
    builtinDefaults, globalDefaults, projectDefaults, originalFrontmatter: originalFrontmatter as AgentFrontmatter,
    finalArgs, positionalMappings, finalPrompt, promptTruncated, tokenUsage, trustStatus, envKeys,
    interactiveMode: interactiveFromFilename || interactiveFromCli || interactiveFromFrontmatter,
    interactiveModeSource,
    configPaths: { global: globalConfigPath, globalExists: existsSync(globalConfigPath), project: projectConfigPath, projectExists: projectConfigPath !== null },
    isolation: {
      isolated: isolationMode.isolated,
      explicit: isolationMode.explicit,
      supported: !isolationInfo.unsupportedWarning,
      flags: isolationInfo.defaults,
      warning: isolationInfo.unsupportedWarning,
    },
    systemPrompt: systemPromptResult,
  };
}

/** Format explain result for console output */
export function formatExplainOutput(result: ExplainResult): string {
  const lines: string[] = [];
  const sep = "=".repeat(70);
  const thinSep = "-".repeat(70);

  lines.push(sep, "MD EXPLAIN - Agent Configuration Analysis", sep, "");
  lines.push(`Agent: ${result.agentPath}`);
  if (result.isRemote) lines.push(`Type: Remote URL`);
  lines.push("");

  lines.push(thinSep, "COMMAND", thinSep);
  lines.push(`Resolved command: ${result.command}`, `Source: ${result.commandSource}`, "");

  lines.push(thinSep, "MODE", thinSep);
  lines.push(`Interactive mode: ${result.interactiveMode ? "YES" : "NO (print mode)"}`);
  lines.push(`Source: ${result.interactiveModeSource}`, "");

  lines.push(thinSep, "ISOLATION", thinSep);
  if (result.isolation.isolated) {
    const source = result.isolation.explicit ? "explicit" : "default";
    if (result.isolation.supported) {
      lines.push(`ON (${source}) — the flow file is the entire behavior`);
      for (const [k, v] of Object.entries(result.isolation.flags)) {
        lines.push(`   ${k}: ${JSON.stringify(v)}`);
      }
      lines.push(`   (opt out with _isolated: false)`);
    } else {
      lines.push(`ON (${source}) — but this engine has no isolation controls; runs ambient`);
      if (result.isolation.warning) lines.push(`   ${result.isolation.warning}`);
    }
  } else {
    lines.push("OFF (_isolated: false) — ambient skills/MCP/context files load");
  }
  lines.push("");

  if (result.systemPrompt) {
    lines.push(thinSep, "SYSTEM PROMPT", thinSep);
    if (result.systemPrompt.error) {
      lines.push(`ERROR: ${result.systemPrompt.error}`);
    } else {
      if (result.systemPrompt.replace) lines.push("Replace: YES (_system-prompt)");
      if (result.systemPrompt.appendCount > 0) {
        lines.push(`Append segments: ${result.systemPrompt.appendCount} (_append-system-prompt)`);
      }
    }
    lines.push("");
  }

  lines.push(thinSep, "CONFIGURATION PRECEDENCE", thinSep, "(Later entries override earlier ones)", "");

  lines.push("1. Built-in defaults:");
  if (result.builtinDefaults) {
    for (const [k, v] of Object.entries(result.builtinDefaults)) lines.push(`   ${k}: ${JSON.stringify(v)}`);
  } else lines.push("   (none)");
  lines.push("");

  lines.push(`2. Global config (${result.configPaths.global}):`);
  if (result.configPaths.globalExists && result.globalDefaults) {
    for (const [k, v] of Object.entries(result.globalDefaults)) lines.push(`   ${k}: ${JSON.stringify(v)}`);
  } else lines.push(result.configPaths.globalExists ? "   (no defaults for this command)" : "   (file not found)");
  lines.push("");

  lines.push(`3. Project config (${result.configPaths.project || "not found"}):`);
  if (result.configPaths.projectExists && result.projectDefaults) {
    for (const [k, v] of Object.entries(result.projectDefaults)) lines.push(`   ${k}: ${JSON.stringify(v)}`);
  } else lines.push(result.configPaths.projectExists ? "   (no defaults for this command)" : "   (file not found)");
  lines.push("");

  lines.push("4. Agent frontmatter:");
  const fmEntries = Object.entries(result.originalFrontmatter);
  if (fmEntries.length > 0) for (const [k, v] of fmEntries) lines.push(`   ${k}: ${JSON.stringify(v)}`);
  else lines.push("   (none)");
  lines.push("");

  lines.push(thinSep, "FINAL MERGED CONFIGURATION", thinSep);
  const finalEntries = Object.entries(result.finalFrontmatter).filter(([k]) => !k.startsWith("_") || k === "_subcommand");
  if (finalEntries.length > 0) for (const [k, v] of finalEntries) lines.push(`${k}: ${JSON.stringify(v)}`);
  else lines.push("(none)");
  lines.push("");

  lines.push(thinSep, "FINAL CLI ARGS", thinSep);
  lines.push(result.finalArgs.length > 0 ? result.finalArgs.join(" ") : "(no flags)", "");

  if (result.positionalMappings.size > 0) {
    lines.push(thinSep, "POSITIONAL MAPPINGS", thinSep);
    for (const [pos, flag] of result.positionalMappings) lines.push(`$${pos} -> --${flag}`);
    lines.push("");
  }

  if (result.envKeys.length > 0) {
    lines.push(thinSep, "ENVIRONMENT VARIABLES (values redacted)", thinSep);
    for (const key of result.envKeys) lines.push(`${key}=****`);
    lines.push("");
  }

  if (result.trustStatus) {
    lines.push(thinSep, "TRUST STATUS", thinSep);
    lines.push(`Domain: ${result.trustStatus.domain}`, `Trusted: ${result.trustStatus.trusted ? "YES" : "NO"}`);
    lines.push(result.trustStatus.trusted ? `Reason: Domain in known_hosts (${result.trustStatus.knownHostsPath})` : `Reason: Domain not in known_hosts\nAction: Will prompt for trust on execution`);
    lines.push("");
  }

  lines.push(thinSep, "TOKEN USAGE", thinSep);
  lines.push(`Estimated tokens: ${result.tokenUsage.tokens.toLocaleString()}`);
  lines.push(`Context limit: ${result.tokenUsage.limit.toLocaleString()}`);
  lines.push(`Usage: ${result.tokenUsage.percentage.toFixed(1)}%`);
  if (result.tokenUsage.exceeds) lines.push(`WARNING: Exceeds context limit!`);
  lines.push("");

  lines.push(thinSep, "FINAL PROMPT" + (result.promptTruncated ? " (truncated)" : ""), thinSep);
  lines.push(result.finalPrompt, "", sep);

  return lines.join("\n");
}

/** Run the explain command */
export async function runExplain(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: md explain <agent.md> [flags]");
    console.error("\nShows resolved configuration for an agent without executing it.");
    console.error("\nExamples:");
    console.error("  md explain task.claude.md");
    console.error("  md explain task.claude.md --model opus");
    process.exit(1);
  }

  try {
    const result = await analyzeAgent(args[0]!, args.slice(1));
    console.log(formatExplainOutput(result));
  } catch (err) {
    console.error(`Error analyzing agent: ${(err as Error).message}`);
    process.exit(1);
  }
}
