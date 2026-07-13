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

import { existsSync, readFileSync } from "fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "path";
import { parseFrontmatter } from "./parse";
import { mdflowVersion } from "./compat";
import {
  FLOW_UX_PROTOCOL_VERSION,
  flowIdForPath,
  mapInputsToProtocol,
  type ProtocolInput,
} from "./roster";
import {
  resolveEngine, buildArgs, extractPositionalMappings,
  extractEnvVars, hasInteractiveMarker,
} from "./command";
import {
  loadGlobalConfig, loadProjectConfig, loadFullConfig,
  applyDefaults, applyInteractiveMode, BUILTIN_DEFAULTS, getConfigFile,
} from "./config";
import { getAdapter as getEngineAdapter } from "./adapters";
import {
  applyIsolationDefaults,
  resolveIsolationMode,
  resolveIsolationDefaults,
} from "./isolation";
import { extractSystemPromptSpec, applySystemPromptToFrontmatter } from "./system-prompt";
import { expandContentImports, hasContentImports } from "./imports";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { isFormInputs, getFormInputDefaults } from "./form-inputs";
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
  /** The complete resolved prompt (never truncated); used by --json mode. */
  finalPromptFull: string;
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
  hooks?: {
    file: string;
    source: string;
    events: string[];
    error?: string;
    warnings?: string[];
  };
  /** Static eval-suite status (verdict from the trust ledger); local flows only. */
  evaluation?: import("./eval-convention").EvalStatus;
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

export async function analyzeAgent(
  filePath: string,
  passthroughArgs: string[] = [],
  cwd: string = process.cwd()
): Promise<ExplainResult> {
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

  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(cwd);
  const fullConfig = await loadFullConfig(cwd);

  let command: string, commandSource: string;
  const engineIdx = passthroughArgs.indexOf("--engine");
  const deprecatedEngineIdx = passthroughArgs.findIndex(
    (arg) => arg === "--_command" || arg === "-_c" || arg === "--tool"
  );
  const cliEngineIdx = engineIdx !== -1 ? engineIdx : deprecatedEngineIdx;
  if (cliEngineIdx !== -1 && cliEngineIdx + 1 < passthroughArgs.length) {
    command = passthroughArgs[cliEngineIdx + 1]!;
    commandSource = `CLI flag (${passthroughArgs[cliEngineIdx]})`;
  } else {
    const resolved = resolveEngine(localFilePath, originalFrontmatter as AgentFrontmatter, {
      configEngine: fullConfig.engine,
    });
    command = resolved.engine;
    commandSource = resolved.source === "filename"
      ? `Filename pattern (.${command}.md)`
      : resolved.source === "frontmatter"
        ? "Agent frontmatter (engine:)"
        : resolved.source === "config"
          ? projectConfig.engine
            ? "Project config (engine:)"
            : "Global config (engine:)"
          : resolved.source === "env"
            ? "Environment (MDFLOW_ENGINE)"
            : "Built-in default";
  }

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
  let frontmatter = isolationMode.isolated && !isolationInfo.unsupportedWarning
    ? applyIsolationDefaults(
        originalFrontmatter as AgentFrontmatter,
        fullDefaults,
        isolationInfo.defaults
      )
    : applyDefaults(originalFrontmatter as AgentFrontmatter, fullDefaults);

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

  // Hooks: mirror the run path — discover the flow's hooks file, read its
  // events, and apply the adapter translation so the final command shows
  // exactly what a run would spawn. Discovery here is STRICTLY STATIC:
  // explain is documented FREE and must never execute hook code. Errors are
  // captured, never thrown: explain always renders.
  let hooksResult: ExplainResult["hooks"];
  {
    const { resolveHooksFile, listHandledEventsStatic, applyHooksToFrontmatter } = await import("./hooks");
    const hooksFlagIdx = passthroughArgs.indexOf("--_hooks");
    const cliHooksValue =
      hooksFlagIdx !== -1 && hooksFlagIdx + 1 < passthroughArgs.length
        ? passthroughArgs[hooksFlagIdx + 1]
        : undefined;
    const resolvedHooks = resolveHooksFile({
      flowPath: localFilePath,
      frontmatterValue: frontmatter._hooks,
      cliValue: cliHooksValue,
      isRemote,
    });
    if (resolvedHooks.kind === "file") {
      hooksResult = { file: resolvedHooks.path, source: resolvedHooks.source, events: [] };
      if (resolvedHooks.rejected) {
        hooksResult.error = resolvedHooks.rejected;
      } else if (resolvedHooks.missing) {
        hooksResult.error = `Hooks file not found: ${resolvedHooks.path}`;
      } else {
        const listed = listHandledEventsStatic(resolvedHooks.path);
        if (!listed.ok) {
          hooksResult.error =
            `${listed.error} (explain never executes hook programs; a real run ` +
            `may still interrogate this file)`;
        } else {
          hooksResult.events = listed.events;
          try {
            const applied = applyHooksToFrontmatter(engineAdapter, command, frontmatter, {
              hooksFile: resolve(resolvedHooks.path),
              events: listed.events,
              isolated: isolationMode.isolated,
              prepareEnvironment: false,
            });
            frontmatter = applied.frontmatter;
            hooksResult.warnings = applied.warnings;
          } catch (err) {
            hooksResult.error = (err as Error).message;
          }
        }
      }
    } else if (frontmatter._hooks !== undefined) {
      frontmatter = { ...frontmatter };
      delete frontmatter._hooks;
    }
  }

  // Behavioral eval status: static planner + trust ledger only. A suite with
  // top-level side effects must never execute during explain, and a broken
  // status computation must never fail the explanation itself — but an
  // unreadable trust ledger is surfaced fail-closed as an explicit
  // Unverified status, never silently omitted (hiding the section would make
  // ledger corruption invisible exactly when it matters).
  let evaluationResult: ExplainResult["evaluation"];
  if (!isRemote) {
    try {
      const { inspectEvalStatus } = await import("./eval-convention");
      evaluationResult = await inspectEvalStatus(localFilePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/eval trust ledger/i.test(message)) {
        const { resolveEvalSuitePath } = await import("./evals");
        const suitePath = resolveEvalSuitePath(resolve(localFilePath));
        evaluationResult = {
          flowPath: resolve(localFilePath),
          suitePath,
          exists: existsSync(suitePath),
          inspectable: false,
          draft: false,
          draftCaseIds: [],
          managedCaseIds: [],
          verdict: "Unverified",
          reason: `trust ledger unreadable (LEDGER_UNREADABLE): ${message}`,
          current: false,
        };
      } else {
        evaluationResult = undefined;
      }
    }
  }

  const envVars = extractEnvVars(frontmatter);
  const envKeys = envVars ? Object.keys(envVars) : [];

  const templateVars: Record<string, string> = {};
  const internalKeys = new Set([
    "_interactive", "_i", "_cwd", "_subcommand", "_steps", "_output", "_inputs",
    "_isolated", "_system-prompt", "_append-system-prompt", "_hooks",
  ]);
  for (const key of Object.keys(frontmatter).filter((k) => k.startsWith("_") && !internalKeys.has(k))) {
    const value = frontmatter[key];
    if (value != null && value !== "") templateVars[key] = String(value);
  }

  // Mirror the run path: typed `_inputs` defaults fill template vars, and
  // `--_name value` / `--_name=value` CLI overrides win over defaults.
  if (isFormInputs(frontmatter._inputs)) {
    const defaults = getFormInputDefaults(frontmatter._inputs);
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in templateVars)) templateVars[key] = value;
    }
  }
  for (let i = 0; i < passthroughArgs.length; i++) {
    const arg = passthroughArgs[i];
    if (!arg || !arg.startsWith("--_")) continue;
    if (arg.includes("=")) {
      const eqIndex = arg.indexOf("=");
      const key = arg.slice(2, eqIndex);
      if (!internalKeys.has(key)) templateVars[key] = arg.slice(eqIndex + 1);
      continue;
    }
    const key = arg.slice(2);
    if (internalKeys.has(key)) continue;
    const next = passthroughArgs[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      templateVars[key] = next;
      i++;
    }
  }

  let expandedBody = rawBody;
  const fileDir = dirname(resolve(localFilePath));
  if (hasContentImports(rawBody)) {
    try {
      expandedBody = await expandContentImports(rawBody, fileDir, new Set(), false, { invocationCwd: cwd });
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
  const projectConfigPath = findProjectConfigPath(cwd);

  if (isRemote) await cleanupRemote(localFilePath);

  return {
    agentPath: filePath, isRemote, command, commandSource, finalFrontmatter: frontmatter,
    builtinDefaults, globalDefaults, projectDefaults, originalFrontmatter: originalFrontmatter as AgentFrontmatter,
    finalArgs, positionalMappings, finalPrompt, finalPromptFull, promptTruncated, tokenUsage, trustStatus, envKeys,
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
    hooks: hooksResult,
    evaluation: evaluationResult,
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
      lines.push(`ON (${source}) — ambient engine context is disabled; host capabilities remain available`);
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

  if (result.hooks) {
    lines.push(thinSep, "LIFECYCLE HOOKS", thinSep);
    lines.push(`File: ${result.hooks.file} (${result.hooks.source})`);
    if (result.hooks.error) {
      lines.push(`ERROR: ${result.hooks.error}`);
    } else {
      lines.push(`Events: ${result.hooks.events.join(", ")}`);
      for (const warning of result.hooks.warnings ?? []) {
        lines.push(warning);
      }
    }
    lines.push("");
  }

  if (result.evaluation) {
    const evaluation = result.evaluation;
    lines.push(thinSep, "BEHAVIORAL EVAL", thinSep);
    if (!evaluation.exists) {
      lines.push(`No eval suite yet (expected: ${evaluation.suitePath})`);
      lines.push(`Verdict: ${evaluation.verdict} — ${evaluation.reason}`);
      lines.push(`Create one: md eval add ${result.agentPath}`);
    } else {
      lines.push(`Suite: ${evaluation.suitePath}`);
      if (evaluation.cases !== undefined) {
        lines.push(`Cases: ${evaluation.cases}${evaluation.draft ? ` (draft: ${evaluation.draftCaseIds.join(", ")})` : ""}`);
        lines.push(`Paid invocations: ${evaluation.plannedInvocations}`);
      }
      lines.push(`Verdict: ${evaluation.verdict}`);
      lines.push(`Reason: ${evaluation.reason}`);
      if (evaluation.lastCleanAt) lines.push(`Last clean run: ${evaluation.lastCleanAt}`);
      lines.push(`Next: md eval ${result.agentPath} --plan`);
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

/**
 * Machine-facing serialization of an explain result (Flow UX Protocol v1).
 * Free: builds on analyzeAgent, which never invokes an engine.
 */
export interface ExplainJson {
  protocolVersion: number;
  flowId: string;
  path: string;
  engine: string;
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  promptIncluded: boolean;
  promptTokensEstimate: number;
  inputs: ProtocolInput[];
  warnings: string[];
  configFingerprint: string;
  /**
   * Additive: static eval-suite verdict. Deliberately OUTSIDE
   * configFingerprint — a suite edit changes proof state, not how the flow
   * executes.
   */
  evaluation?: import("./eval-convention").EvalStatus;
}

/**
 * Build the `md explain <flow> --json` payload. FREE — no engine call.
 *
 * `configFingerprint` is a sha256 over the resolved (merged) config, the raw
 * flow file content, and the running mdflow version, so the app can cache
 * explanations keyed on `(path, mtimeMs, cwd, mdflowVersion, configFingerprint)`.
 */
export async function buildExplainJson(
  filePath: string,
  passthroughArgs: string[] = [],
  cwd: string = process.cwd()
): Promise<ExplainJson> {
  const result = await analyzeAgent(filePath, passthroughArgs, cwd);
  return explainJsonFromResult(result, filePath, passthroughArgs, cwd);
}

/**
 * Build the protocol payload from an existing analysis. Split out so callers
 * that need both the full ExplainResult and the protocol shape (md render)
 * analyze the flow exactly once.
 */
export async function explainJsonFromResult(
  result: ExplainResult,
  filePath: string,
  passthroughArgs: string[] = [],
  cwd: string = process.cwd()
): Promise<ExplainJson> {
  // Effective run cwd: --_cwd flag > frontmatter _cwd > invocation cwd.
  let cwdFromCli: string | undefined;
  const cwdIdx = passthroughArgs.indexOf("--_cwd");
  if (cwdIdx !== -1 && cwdIdx + 1 < passthroughArgs.length) {
    cwdFromCli = passthroughArgs[cwdIdx + 1];
  }
  const effectiveCwd = resolve(
    cwdFromCli ?? (result.finalFrontmatter._cwd as string | undefined) ?? cwd
  );

  // Full argv exactly as a run would build it: subcommand tokens, flag args,
  // then the prompt positional (respecting $N positional mappings). An
  // interactive flow with a blank body submits no positional at all.
  const args = [...result.finalArgs];
  if (result.finalFrontmatter._subcommand) {
    const sub = result.finalFrontmatter._subcommand;
    const subs = Array.isArray(sub) ? sub.map(String) : [String(sub)];
    args.unshift(...subs);
  }
  const prompt = result.finalPromptFull;
  const promptIncluded = !(result.interactiveMode && !prompt.trim());
  if (promptIncluded) {
    const mapping = result.positionalMappings.get(1);
    if (mapping) {
      args.push(mapping.length === 1 ? `-${mapping}` : `--${mapping}`, prompt);
    } else {
      args.push(prompt);
    }
  }

  const warnings: string[] = [];
  if (result.isolation.warning) warnings.push(result.isolation.warning);
  if (result.systemPrompt?.error) warnings.push(result.systemPrompt.error);
  if (result.hooks?.error) warnings.push(result.hooks.error);
  if (result.hooks?.warnings) warnings.push(...result.hooks.warnings);

  // Fingerprint: resolved config + flow content + hook bytes + mdflow
  // version. Hooks are included because a changed hook file (same path)
  // changes the events explain/render display and the -c override the flow
  // would run with — a cache keyed on this must therefore invalidate.
  const fullConfig = await loadFullConfig(cwd);
  let flowContent = "";
  try {
    flowContent = await Bun.file(result.isRemote ? filePath : resolve(filePath)).text();
  } catch {
    // Remote flows were cleaned up after analysis; hash without content.
  }
  const hasher = createHash("sha256")
    .update(JSON.stringify(fullConfig))
    .update("\0")
    .update(flowContent)
    .update("\0")
    .update(mdflowVersion());
  if (result.hooks && !result.hooks.error) {
    try {
      hasher.update("\0hooks\0").update(readFileSync(result.hooks.file, "utf8"));
    } catch {
      // Hook file vanished between analysis and hashing: config-level cache
      // key still reflects the flow; a real run would fail loudly.
    }
  }
  const fingerprint = hasher.digest("hex");

  return {
    protocolVersion: FLOW_UX_PROTOCOL_VERSION,
    flowId: flowIdForPath(resolve(filePath), { cwd }),
    path: result.isRemote ? filePath : resolve(filePath),
    engine: result.command,
    command: result.command,
    args,
    cwd: effectiveCwd,
    prompt,
    promptIncluded,
    promptTokensEstimate: Math.ceil(prompt.length / 4),
    inputs: mapInputsToProtocol(result.originalFrontmatter._inputs),
    warnings,
    configFingerprint: `sha256:${fingerprint}`,
    ...(result.evaluation ? { evaluation: result.evaluation } : {}),
  };
}

/** Run the explain command */
export async function runExplain(args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  const cleanArgs = args.filter((arg) => arg !== "--json");

  if (cleanArgs.length === 0) {
    console.error("Usage: md explain <agent.md> [flags] [--json]");
    console.error("\nShows resolved configuration for an agent without executing it.");
    console.error("\nExamples:");
    console.error("  md explain task.claude.md");
    console.error("  md explain task.claude.md --model opus");
    console.error("  md explain flows/review.md --json");
    process.exit(1);
  }

  try {
    if (jsonMode) {
      const payload = await buildExplainJson(cleanArgs[0]!, cleanArgs.slice(1));
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    const result = await analyzeAgent(cleanArgs[0]!, cleanArgs.slice(1));
    console.log(formatExplainOutput(result));
  } catch (err) {
    console.error(`Error analyzing agent: ${(err as Error).message}`);
    process.exit(1);
  }
}
