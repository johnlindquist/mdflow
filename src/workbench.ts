/**
 * The interactive md Flow Workbench.
 *
 * This module deliberately owns presentation and intent collection only. It
 * returns an action to the CLI, which remains responsible for running engines
 * and performing writes. Keeping that boundary explicit makes every action's
 * cost and side effects visible before the prompt exits.
 */

import {
  AbortPromptError,
  CancelPromptError,
  createPrompt,
  ExitPromptError,
  isDownKey,
  isEnterKey,
  isUpKey,
  makeTheme,
  type KeypressEvent,
  useEffect,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentFile } from "./cli";
import {
  describeCreateScope,
  formatCreateScope,
  type CreateLocation,
} from "./create";
import {
  draftFlowFromIntent,
  effortLevels,
  listNewFlowEngines,
  modelSuggestions,
  NEW_FLOW_DEFAULT_ENGINE,
  slugifyFlowIntent,
  suggestFlowSlug,
  type FlowDraft,
  type WorkbenchLifecycleSummary,
} from "./workbench-model";
import { rankWorkbenchFlows } from "./workbench-search";
import { flowCommand } from "./tips";
import {
  CANONICAL_HOOK_EVENTS,
  hooksFileForFlow,
  type CanonicalHookEvent,
} from "./hooks";
import {
  getWorkbenchHooksStatus,
  hydrateWorkbenchHooksStatus,
  type WorkbenchHooksStatus,
} from "./workbench-hooks";

export type WorkbenchAction =
  | "run"
  | "dry-run"
  | "edit"
  | "hooks-add"
  | "hooks-open"
  | "create"
  | "feedback"
  | "evolve-plan"
  | "evolve-propose"
  | "evolve-apply"
  | "evolve-rollback"
  | "cancel";

/** A compact safety vocabulary shared by every Workbench screen. */
export type WorkbenchEffect = "FREE" | "ENGINE" | "LOCAL WRITE";

export interface WorkbenchEvidenceStatus {
  /** Open feedback items which can still drive an evolution. */
  open?: number;
  /** All recorded evidence for the flow. */
  total?: number;
  /** Open feedback items represented by an eval case. */
  covered?: number;
  /** Evidence already targeted by an evolution run. */
  targeted?: number;
  headline?: string;
}

export interface WorkbenchEvalStatus {
  state?: "missing" | "unknown" | "current" | "stale" | "passing" | "failing" | string;
  passed?: number;
  total?: number;
  current?: boolean;
  headline?: string;
}

export interface WorkbenchProposalStatus {
  state?: "none" | "ready" | "running" | "verified" | "blocked" | "applied" | string;
  /** Most recent proposal run; required for apply. */
  runId?: string;
  /** Most recent applied run; required for rollback. */
  appliedRunId?: string;
  headline?: string;
  capabilityDelta?: string;
}

/** Optional lifecycle data rendered beside a flow. */
export interface WorkbenchFlowStatus {
  evidence?: WorkbenchEvidenceStatus;
  eval?: WorkbenchEvalStatus;
  proposal?: WorkbenchProposalStatus;
  /** A single state-derived recommendation, not a rotating generic tip. */
  next?: string;
}

/**
 * Bridge the durable lifecycle model into the deliberately presentation-sized
 * status shape accepted by the prompt. Eval state can be layered in by the
 * caller because eval receipts live outside the evidence/evolution ledger.
 */
export function workbenchStatusFromLifecycle(
  summary: WorkbenchLifecycleSummary,
  evaluation?: WorkbenchEvalStatus,
): WorkbenchFlowStatus {
  const latestStatus = summary.evolution.latestStatus;
  const runId = summary.evolution.latestRunId;
  const next = summary.recommendedAction === "evolve-apply"
    ? "Review the verified proposal, then apply it explicitly."
    : summary.recommendedAction === "evolve-show"
      ? runId
        ? `Review evolution run ${runId} before deciding what comes next.`
        : "Review the latest evolution run before deciding what comes next."
      : summary.recommendedAction === "evolve-plan"
        ? "Preview evolution readiness and cost for free."
      : "Run the flow, then open Actions to record anything it misses.";
  return {
    evidence: {
      open: summary.evidence.open,
      total: summary.evidence.total,
      targeted: summary.evidence.targeted,
    },
    ...(evaluation ? { eval: evaluation } : {}),
    proposal: {
      state: latestStatus ?? "none",
      ...(runId ? { runId } : {}),
      ...(latestStatus === "applied" && runId ? { appliedRunId: runId } : {}),
    },
    next,
  };
}

export interface WorkbenchConfig {
  files: readonly AgentFile[];
  /** Name displayed in the title bar. Defaults to the project directory name. */
  projectName?: string;
  /** Used to make shell commands and paths compact. Defaults to cwd. */
  projectRoot?: string;
  /** Actual launch directory, which may be nested below projectRoot. */
  cwd?: string;
  /**
   * Destination for new flows. A noncanonical value becomes the composer's
   * explicit custom scope so the preview and CLI write cannot diverge.
   */
  flowsDirectory?: string;
  /** Executable shown in exact shell equivalents. Defaults to md. */
  commandName?: string;
  /** Height of the main content area. It is still clamped to the terminal. */
  pageSize?: number;
  /** Status may be keyed by absolute path, project-relative path, filename, or name. */
  statuses?: Readonly<Record<string, WorkbenchFlowStatus | undefined>>;
  /** Takes precedence over statuses when supplied. Must be synchronous for rendering. */
  statusFor?: (file: AgentFile) => WorkbenchFlowStatus | undefined;
  /** Optional hook-status seams for deterministic demos/tests; production uses the mtime cache. */
  hooksStatusFor?: (file: AgentFile) => WorkbenchHooksStatus;
  hydrateHooksStatus?: (file: AgentFile) => Promise<WorkbenchHooksStatus>;
}

/**
 * The prompt never mutates application state. The caller executes the returned
 * action and can then re-open the Workbench with refreshed files/status.
 */
export interface WorkbenchResult {
  action: WorkbenchAction;
  effect: WorkbenchEffect;
  /** Exact non-interactive shell equivalent displayed in the TUI. */
  command: string;
  file?: AgentFile;
  path?: string;
  intent?: string;
  draft?: FlowDraft;
  /** Engine chosen in the composer; project scope may also seed first-time config. */
  engine?: string;
  /** Exact args passed to `runCreate`; keeps writes on the CLI side. */
  createArgs?: string[];
  feedback?: string;
  runId?: string;
  /** Present for hook scaffolding/open actions; writes stay in the CLI layer. */
  hooksPath?: string;
  hookEvents?: CanonicalHookEvent[];
}

type WorkbenchScreen = "home" | "create" | "feedback" | "actions" | "hooks" | "confirm";
type FeedbackReturnScreen = "home" | "actions";
type WorkbenchWriteAction = "evolve-apply" | "evolve-rollback";

interface ExtendedKeypressEvent extends KeypressEvent {
  sequence?: string;
  meta?: boolean;
  shift?: boolean;
}

export interface FlowRow {
  kind: "flow";
  file: AgentFile;
  score: number;
  matchIndices: number[];
  matchField?: "name" | "description" | "path";
  matchValue?: string;
}

type HomeRow = FlowRow;

const ESCAPE_CODES = /\x1b\[[0-9;]*m/g;
const fileCache = new Map<string, { mtimeMs: number; content: string }>();

const color = {
  reset: "\x1b[0m",
  bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
  dim: (value: string) => `\x1b[90m${value}\x1b[0m`,
  cyan: (value: string) => `\x1b[36m${value}\x1b[0m`,
  blue: (value: string) => `\x1b[34m${value}\x1b[0m`,
  green: (value: string) => `\x1b[32m${value}\x1b[0m`,
  yellow: (value: string) => `\x1b[33m${value}\x1b[0m`,
  red: (value: string) => `\x1b[31m${value}\x1b[0m`,
  inverse: (value: string) => `\x1b[7m${value}\x1b[27m`,
};

const EFFECT_COLOR: Record<WorkbenchEffect, (value: string) => string> = {
  FREE: color.green,
  ENGINE: color.yellow,
  "LOCAL WRITE": color.blue,
};

/** Clear cached source previews after the caller edits or creates a flow. */
export function clearWorkbenchPreviewCache(): void {
  fileCache.clear();
}

function stripAnsi(value: string): string {
  return value.replace(ESCAPE_CODES, "");
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;

  // Rendered Workbench labels contain only complete SGR sequences. Walking the
  // styled string avoids cutting an escape sequence while clipping a column.
  let visible = 0;
  let index = 0;
  const target = Math.max(0, width - 1);
  while (index < value.length && visible < target) {
    if (value[index] === "\x1b") {
      const end = value.indexOf("m", index);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    visible += 1;
    index += 1;
  }
  return `${value.slice(0, index)}…${color.reset}`;
}

function fit(value: string, width: number): string {
  const clipped = clip(value, width);
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
}

function wrapPlainText(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length <= width) {
      line += ` ${word}`;
      continue;
    }
    if (line) lines.push(line);
    if (word.length <= width) {
      line = word;
      continue;
    }
    for (let offset = 0; offset < word.length; offset += width) {
      const part = word.slice(offset, offset + width);
      if (part.length === width) lines.push(part);
      else line = part;
    }
    if (word.length % width === 0) line = "";
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function keycap(value: string): string {
  return color.inverse(` ${value} `);
}

function effectBadge(effect: WorkbenchEffect): string {
  return EFFECT_COLOR[effect](`[${effect}]`);
}

function readFlow(file: AgentFile): string {
  try {
    if (!existsSync(file.path)) {
      fileCache.delete(file.path);
      return `[Flow not found: ${file.path}]`;
    }
    // mtime keys the cache so previews track external edits without a manual
    // clear — a prerequisite for live-reloading the roster.
    const mtimeMs = statSync(file.path).mtimeMs;
    const cached = fileCache.get(file.path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.content;
    const content = readFileSync(file.path, "utf8");
    fileCache.set(file.path, { mtimeMs, content });
    return content;
  } catch (error) {
    return `[Unable to preview flow: ${String(error)}]`;
  }
}

function projectPath(path: string, root: string): string {
  const display = relative(root, path);
  if (!display || display.startsWith("..")) return path;
  return display.split("\\").join("/");
}

function resolveFlowsDirectory(config: WorkbenchConfig, root: string): string {
  const requested = config.flowsDirectory ?? "flows";
  return isAbsolute(requested) ? requested : resolve(root, requested);
}

const CREATE_LOCATIONS: readonly CreateLocation[] = ["project", "cwd", "user", "custom"];

function createDirectoryFor(
  location: CreateLocation,
  customDir: string,
  cwd: string,
  flowsDirectory: string,
): string {
  if (location === "project") return flowsDirectory;
  if (location === "cwd") return cwd;
  if (location === "user") return join(homedir(), ".mdflow");
  return resolve(cwd, customDir.trim() || ".");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandForFlow(commandName: string, path: string, root: string): string {
  return flowCommand(path, root, commandName);
}

/** Everything the composer collects before a flow is created. */
export interface NewFlowSpec {
  intent: string;
  slug: string;
  docs: string[];
  engine: string;
  model?: string;
  effort?: string;
  location?: CreateLocation;
  customDir?: string;
}

/** Comma-separated docs entries — commands keep their internal spaces. */
export function splitDocsInput(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** Exact args handed back to the CLI for a composer creation. */
export function newFlowArgs(spec: NewFlowSpec): string[] {
  const parts = [
    spec.intent,
    "--name",
    spec.slug,
    "--engine",
    spec.engine,
  ];
  if (spec.model) parts.push("--model", spec.model);
  if (spec.effort) parts.push("--effort", spec.effort);
  for (const doc of spec.docs) parts.push("--docs", doc);
  const location = spec.location ?? "project";
  if (location === "project") parts.push("--project");
  else if (location === "cwd") parts.push("--location", "cwd");
  else if (location === "user") parts.push("--global");
  else parts.push("--dir", spec.customDir?.trim() || ".");
  return parts;
}

/** Exact non-interactive shell equivalent of a composer creation. */
export function newFlowCommand(spec: NewFlowSpec, commandName = "md"): string {
  return [commandName, "create", ...newFlowArgs(spec).map(shellQuote)].join(" ");
}

function draftFromSpec(spec: NewFlowSpec): FlowDraft {
  return draftFlowFromIntent(spec.intent, {
    slug: spec.slug,
    docs: spec.docs,
    engine: spec.engine,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
  });
}

function createResult(
  config: WorkbenchConfig,
  root: string,
  cwd: string,
  flowsDirectory: string,
  spec: NewFlowSpec,
): WorkbenchResult {
  const draft = draftFromSpec(spec);
  const path = join(
    createDirectoryFor(spec.location ?? "project", spec.customDir ?? "", cwd, flowsDirectory),
    draft.filename,
  );
  const commandName = config.commandName ?? "md";
  const createArgs = newFlowArgs(spec);
  return {
    action: "create",
    effect: "LOCAL WRITE",
    command: newFlowCommand(spec, commandName),
    intent: spec.intent,
    draft,
    path,
    engine: spec.engine,
    createArgs,
  };
}

function statusFor(config: WorkbenchConfig, file: AgentFile, root: string): WorkbenchFlowStatus {
  const direct = config.statusFor?.(file);
  if (direct) return direct;
  const statuses = config.statuses;
  if (!statuses) return {};
  return statuses[file.path]
    ?? statuses[projectPath(file.path, root)]
    ?? statuses[file.name]
    ?? statuses[basename(file.path)]
    ?? {};
}

/** Pure helper used by the prompt and by terminal-demo fixtures. */
export function getWorkbenchRows(files: readonly AgentFile[], query: string): HomeRow[] {
  return rankWorkbenchFlows(files, query).map((ranked) => ({
    kind: "flow",
    file: ranked.file,
    score: ranked.score,
    matchIndices: ranked.match?.indices ?? [],
    ...(ranked.match ? { matchField: ranked.match.field, matchValue: ranked.match.value } : {}),
  }));
}

function statusBadge(status: WorkbenchFlowStatus): string {
  const fragments: string[] = [];
  const open = status.evidence?.open ?? 0;
  if (open > 0) fragments.push(color.yellow(`${open} feedback`));

  const evalState = status.eval?.state;
  if (evalState === "passing" || evalState === "current") fragments.push(color.green("eval ✓"));
  else if (evalState === "failing") fragments.push(color.red("eval ×"));
  else if (evalState === "stale") fragments.push(color.yellow("eval stale"));
  else if (evalState === "missing") fragments.push(color.dim("needs proof"));

  const proposalState = status.proposal?.state;
  if (["verified", "verified_improvement", "regression_safe"].includes(proposalState ?? "")) {
    fragments.push(color.cyan("proposal ready"));
  }
  else if (["running", "planned", "drafting", "verifying", "applying", "rolling_back"].includes(proposalState ?? "")) {
    fragments.push(color.yellow("evolving…"));
  }
  else if (proposalState === "applied") fragments.push(color.green("applied"));
  else if (["blocked", "capability_rejected", "rejected", "inconclusive"].includes(proposalState ?? "")) {
    fragments.push(color.red("blocked"));
  }
  return fragments.join(color.dim(" · "));
}

function evidenceLine(status: WorkbenchFlowStatus): string {
  const evidence = status.evidence;
  if (evidence?.headline) return evidence.headline;
  const open = evidence?.open ?? 0;
  const total = evidence?.total ?? open;
  if (total === 0) return "No feedback recorded";
  const pieces = [`${open} open / ${total} total`];
  if (evidence?.covered !== undefined) {
    pieces.push(`${evidence.covered}/${open} open item${open === 1 ? "" : "s"} covered`);
  }
  if ((evidence?.targeted ?? 0) > 0) pieces.push(`${evidence!.targeted} targeted`);
  return pieces.join(" · ");
}

function evalLine(status: WorkbenchFlowStatus): string {
  const evaluation = status.eval;
  if (evaluation?.headline) return evaluation.headline;
  const state = evaluation?.state ?? "unknown";
  if (evaluation?.total !== undefined) {
    return `${evaluation.passed ?? 0}/${evaluation.total} passing · ${state}`;
  }
  if (state === "missing") return "No eval suite yet";
  return state === "unknown" ? "Proof status unknown" : state;
}

function proposalLine(status: WorkbenchFlowStatus): string {
  const proposal = status.proposal;
  if (proposal?.headline) return proposal.headline;
  const state = proposal?.state ?? "none";
  if (state === "none") return "No proposal";
  return proposal?.runId ? `${state} · ${proposal.runId}` : state;
}

function hooksLine(status: WorkbenchHooksStatus): string {
  if (status.state === "none") return color.dim("no hooks");
  if (status.state === "loading") return color.dim("loading events…");
  if (status.state === "error") return color.yellow("file found · unable to list events");
  const count = status.events.length;
  return `${count} event${count === 1 ? "" : "s"} (${status.events.join(", ")})`;
}

function inferredNext(status: WorkbenchFlowStatus): string {
  if (status.next) return status.next;
  if ((status.evidence?.open ?? 0) === 0) return "Run the flow, then open Actions to record anything it misses.";
  if (status.eval?.state === "missing") return "Represent open feedback with an eval case before proposing.";
  if (status.eval?.state === "stale") return "Refresh proof before asking an engine for a proposal.";
  if (["verified", "verified_improvement", "regression_safe"].includes(status.proposal?.state ?? "")) {
    return "Review the verified proposal before applying it.";
  }
  if (status.proposal?.state === "applied") return "Keep the run ID available for a guarded rollback.";
  return "Preview evolution readiness for free with md evolve plan.";
}

function markdownLines(content: string, maxLines: number, width: number): string[] {
  const source = content.replace(/\r\n/g, "\n").split("\n");
  const rendered: string[] = [];
  for (const raw of source) {
    const line = raw.trimEnd();
    let styled = safeText(line);
    if (/^#{1,6}\s/.test(line)) styled = color.yellow(color.bold(line));
    else if (line === "---") styled = color.dim(line);
    else if (/^[A-Za-z_][\w-]*:/.test(line)) styled = line.replace(/^([^:]+:)/, color.blue("$1"));
    else if (/^\s*[-*]\s/.test(line)) styled = line.replace(/^\s*([-*])/, color.cyan("$1"));
    rendered.push(clip(styled, width));
    if (rendered.length >= maxLines) break;
  }
  if (source.length > maxLines && rendered.length > 0) {
    rendered[rendered.length - 1] = color.dim(`… ${source.length - maxLines + 1} more lines`);
  }
  while (rendered.length < maxLines) rendered.push("");
  return rendered;
}

function selectedFile(rows: HomeRow[], cursor: number): AgentFile | undefined {
  const row = rows[Math.min(cursor, Math.max(0, rows.length - 1))];
  return row?.file;
}

function currentFile(files: readonly AgentFile[], path: string | undefined): AgentFile | undefined {
  return path ? files.find((file) => file.path === path) : undefined;
}

function printableCharacter(key: ExtendedKeypressEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (!sequence || [...sequence].length !== 1 || /[\u0000-\u001f\u007f]/u.test(sequence)) return undefined;
  return safeText(sequence);
}

function resultForFlow(
  action: "run" | "dry-run" | "edit" | "evolve-plan" | "evolve-propose",
  file: AgentFile,
  config: WorkbenchConfig,
  root: string,
): WorkbenchResult {
  const commandName = config.commandName ?? "md";
  const base = commandForFlow(commandName, file.path, root);
  if (action === "run") return { action, effect: "ENGINE", command: base, file, path: file.path };
  if (action === "dry-run") {
    return { action, effect: "FREE", command: `${base} --_dry-run`, file, path: file.path };
  }
  if (action === "edit") {
    return {
      action,
      effect: "LOCAL WRITE",
      command: `$EDITOR ${shellQuote(projectPath(file.path, root))}`,
      file,
      path: file.path,
    };
  }
  const evolveAction = action === "evolve-plan" ? "plan" : "propose";
  return {
    action,
    effect: action === "evolve-plan" ? "FREE" : "ENGINE",
    command: `${commandName} evolve ${evolveAction} ${shellQuote(projectPath(file.path, root))}`,
    file,
    path: file.path,
  };
}

/** Exact local-write intent returned by the canonical-event picker. */
export function hooksAddResult(
  file: AgentFile,
  events: readonly CanonicalHookEvent[],
  commandName = "md",
  root = process.cwd(),
): WorkbenchResult {
  const hookEvents = [...events];
  const flowArg = projectPath(file.path, root);
  return {
    action: "hooks-add",
    effect: "LOCAL WRITE",
    command: [commandName, "hooks", "add", shellQuote(flowArg), ...hookEvents].join(" "),
    file,
    path: file.path,
    hooksPath: hooksFileForFlow(file.path),
    hookEvents,
  };
}

/** Existing hooks are opened for editing and never scaffolded over. */
export function hooksOpenResult(
  file: AgentFile,
  hooksPath: string,
  root = process.cwd(),
): WorkbenchResult {
  return {
    action: "hooks-open",
    effect: "LOCAL WRITE",
    command: `$EDITOR ${shellQuote(projectPath(hooksPath, root))}`,
    file,
    path: file.path,
    hooksPath,
  };
}

/**
 * Build the result held behind the Workbench's explicit local-write gate.
 * Exported so callers and tests can verify the exact command before execution.
 */
export function evolveWriteResult(
  action: WorkbenchWriteAction,
  file: AgentFile,
  runId: string,
  commandName = "md",
): WorkbenchResult {
  const evolveAction = action === "evolve-apply" ? "apply" : "rollback";
  return {
    action,
    effect: "LOCAL WRITE",
    command: `${commandName} evolve ${evolveAction} ${shellQuote(runId)}`,
    file,
    path: file.path,
    runId,
  };
}

/** Only Enter confirms a pending local write. */
export function isEvolveWriteConfirmationKey(key: KeypressEvent): boolean {
  if (key.ctrl || (key as ExtendedKeypressEvent).meta) return false;
  return isEnterKey(key);
}

type FlowAction =
  | "run"
  | "dry-run"
  | "edit"
  | "hooks-add"
  | "hooks-open"
  | "feedback"
  | "evolve-plan"
  | "evolve-propose"
  | "evolve-apply"
  | "evolve-rollback";

interface FlowActionRow {
  action: FlowAction;
  label: string;
  effect: WorkbenchEffect;
  enabled: boolean;
  runId?: string;
  hooksPath?: string;
}

function flowActionRows(
  status: WorkbenchFlowStatus,
  hooks: WorkbenchHooksStatus,
): FlowActionRow[] {
  const proposalRunId = status.proposal?.runId;
  const canApply = Boolean(
    proposalRunId
    && ["verified", "verified_improvement", "regression_safe"].includes(status.proposal?.state ?? ""),
  );
  const rollbackRunId = status.proposal?.appliedRunId
    ?? (status.proposal?.state === "applied" ? proposalRunId : undefined);
  const hooksAction: FlowActionRow = hooks.state === "none"
    ? { action: "hooks-add", label: "Add hooks", effect: "LOCAL WRITE", enabled: true }
    : {
        action: "hooks-open",
        label: hooks.state === "ready"
          ? `Open hooks file (${hooks.events.length} event${hooks.events.length === 1 ? "" : "s"})`
          : hooks.state === "loading"
            ? "Open hooks file (loading events…)"
            : "Open hooks file (events unavailable)",
        effect: "LOCAL WRITE",
        enabled: true,
        hooksPath: hooks.path,
      };
  return [
    { action: "run", label: "Run flow", effect: "ENGINE", enabled: true },
    { action: "dry-run", label: "Preview dry-run", effect: "FREE", enabled: true },
    { action: "edit", label: "Edit flow", effect: "LOCAL WRITE", enabled: true },
    hooksAction,
    { action: "feedback", label: "Add feedback", effect: "LOCAL WRITE", enabled: true },
    { action: "evolve-plan", label: "Plan evolution readiness", effect: "FREE", enabled: true },
    { action: "evolve-propose", label: "Create evolution proposal", effect: "ENGINE", enabled: true },
    {
      action: "evolve-apply",
      label: proposalRunId ? `Apply ${proposalRunId}` : "Apply verified proposal",
      effect: "LOCAL WRITE",
      enabled: canApply,
      ...(canApply && proposalRunId ? { runId: proposalRunId } : {}),
    },
    {
      action: "evolve-rollback",
      label: rollbackRunId ? `Roll back ${rollbackRunId}` : "Roll back applied proposal",
      effect: "LOCAL WRITE",
      enabled: Boolean(rollbackRunId),
      ...(rollbackRunId ? { runId: rollbackRunId } : {}),
    },
  ];
}

function moveActionCursor(rows: readonly FlowActionRow[], cursor: number, delta: number): number {
  if (rows.length === 0) return 0;
  for (let step = 1; step <= rows.length; step += 1) {
    const next = (cursor + delta * step + rows.length) % rows.length;
    if (rows[next]?.enabled) return next;
  }
  return cursor;
}

function renderColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  const height = Math.max(left.length, right.length);
  const separator = ` ${color.dim("│")} `;
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(`${fit(left[index] ?? "", leftWidth)}${separator}${fit(right[index] ?? "", rightWidth)}`);
  }
  return lines;
}

function titleBar(projectName: string, screen: WorkbenchScreen, width: number): string {
  const screenName = screen === "home" ? "FLOW WORKBENCH" : screen.toUpperCase();
  const left = `${color.cyan(color.bold("◆ md"))} ${color.dim("·")} ${safeText(projectName)}`;
  const gap = Math.max(1, width - visibleLength(left) - screenName.length);
  return `${left}${" ".repeat(gap)}${color.dim(screenName)}`;
}

function highlightIndices(value: string, indices: readonly number[]): string {
  if (indices.length === 0) return safeText(value);
  const selected = new Set(indices);
  let rendered = "";
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const matched = Array.from({ length: character.length }, (_, offset) => index + offset)
      .some((position) => selected.has(position));
    rendered += matched
      ? `\x1b[1;36m${safeText(character)}\x1b[22;39m`
      : safeText(character);
    index += character.length;
  }
  return rendered;
}

function highlightMatchExcerpt(value: string, indices: readonly number[]): string {
  if (indices.length === 0) return safeText(value);
  const first = indices[0]!;
  const last = indices[indices.length - 1]!;
  const start = Math.max(0, first - 6);
  const end = Math.min(value.length, last + 13);
  const excerpt = value.slice(start, end);
  const adjusted = indices.filter((index) => index >= start && index < end).map((index) => index - start);
  return `${start > 0 ? "…" : ""}${highlightIndices(excerpt, adjusted)}${end < value.length ? "…" : ""}`;
}

function renderHome(
  config: WorkbenchConfig,
  rows: HomeRow[],
  cursor: number,
  filter: string,
  root: string,
  hooks: WorkbenchHooksStatus,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const effectiveCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const rowSlots = Math.max(1, contentHeight - 1);
  const start = Math.max(0, Math.min(effectiveCursor - Math.floor(rowSlots / 2), rows.length - rowSlots));
  const visibleRows = rows.slice(start, start + rowSlots);
  const left: string[] = [];
  const count = filter
    ? `${rows.length}/${config.files.length} matches`
    : `${rows.length} flow${rows.length === 1 ? "" : "s"}`;
  left.push(`${color.dim("Find:")} ${color.cyan(safeText(filter))}${color.cyan("▏")}  ${color.dim(count)}`);

  if (rows.length === 0) {
    left.push(
      filter
        ? color.yellow(`No flows match '${safeText(filter)}'`)
        : color.yellow("No runnable flows found"),
    );
    left.push(color.dim("ctrl+o creates a flow with an explicit scope"));
  }

  if (rows.length > 0) {
    for (let index = 0; index < rowSlots; index += 1) {
      const row = visibleRows[index];
      if (!row) {
        left.push("");
        continue;
      }
      const absoluteIndex = start + index;
      const isSelected = absoluteIndex === effectiveCursor;
      const status = statusFor(config, row.file, root);
      const badge = statusBadge(status);
      const name = highlightIndices(
        row.file.name,
        row.matchField === "name" ? row.matchIndices : [],
      );
      const text = row.matchField && row.matchField !== "name" && row.matchValue
        ? ` ${color.dim(`${row.matchField}:`)} ${highlightMatchExcerpt(row.matchValue, row.matchIndices)}  ${color.dim("→")} ${name}`
        : ` ${name}${badge ? `  ${badge}` : ""}`;
      const fitted = fit(text, leftWidth);
      left.push(isSelected ? color.inverse(fitted) : fitted);
    }
  }
  while (left.length < contentHeight) left.push("");

  const row = rows[effectiveCursor];
  const right: string[] = [];
  if (row) {
    const file = row.file;
    const status = statusFor(config, file, root);
    right.push(color.bold(file.name));
    right.push(color.dim(projectPath(file.path, root)));
    if (file.description) right.push(clip(safeText(file.description), rightWidth));
    right.push("");
    right.push(`${color.dim("Evidence")}  ${clip(evidenceLine(status), Math.max(10, rightWidth - 10))}`);
    right.push(`${color.dim("Eval")}      ${clip(evalLine(status), Math.max(10, rightWidth - 10))}`);
    right.push(`${color.dim("Proposal")}  ${clip(proposalLine(status), Math.max(10, rightWidth - 10))}`);
    right.push(`${color.dim("Hooks")}     ${clip(hooksLine(hooks), Math.max(10, rightWidth - 10))}`);
    right.push("");
    const remaining = Math.max(0, contentHeight - right.length);
    right.push(...markdownLines(readFlow(file), remaining, rightWidth));
  } else {
    right.push(color.cyan(color.bold(filter ? "No runnable flow selected" : "Create your first useful flow")));
    right.push("");
    right.push("Describe the repeatable outcome in plain language.");
    right.push(color.dim("Then pick a name, engine, model, effort, and docs to preload."));
    right.push("");
    right.push(`${keycap("ctrl+o")} New flow  ${effectBadge("FREE")}`);
    while (right.length < contentHeight) right.push("");
  }
  while (right.length < contentHeight) right.push("");

  return renderColumns(left, right, leftWidth, rightWidth);
}

type CreateField = "scope" | "directory" | "intent" | "name" | "docs" | "engine" | "model" | "effort";
const TEXT_CREATE_FIELDS: ReadonlySet<CreateField> = new Set(["directory", "intent", "name", "docs", "model"]);

/** Effort is only offered for engines with a verified effort control. */
function createFields(engine: string, location: CreateLocation): CreateField[] {
  const fields: CreateField[] = ["scope"];
  if (location === "custom") fields.push("directory");
  fields.push("intent", "name", "docs", "engine", "model");
  if (effortLevels(engine).length > 0) fields.push("effort");
  return fields;
}

/** Raw composer inputs; empty name/model/effort mean "let mdflow decide". */
interface ComposerState {
  intent: string;
  name: string;
  docs: string;
  model: string;
  engine: string;
  location: CreateLocation;
  customDir: string;
  effort?: string;
  focus: CreateField;
}

function specFromComposer(composer: ComposerState): NewFlowSpec {
  const intent = composer.intent.trim();
  return {
    intent,
    slug: composer.name.trim()
      ? slugifyFlowIntent(composer.name)
      : suggestFlowSlug(intent || "new flow"),
    docs: splitDocsInput(composer.docs),
    engine: composer.engine,
    location: composer.location,
    ...(composer.location === "custom" ? { customDir: composer.customDir.trim() || "." } : {}),
    ...(composer.model.trim() ? { model: composer.model.trim() } : {}),
    ...(composer.effort ? { effort: composer.effort } : {}),
  };
}

function renderCreate(
  config: WorkbenchConfig,
  composer: ComposerState,
  root: string,
  cwd: string,
  flowsDirectory: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const spec = specFromComposer(composer);
  const commandName = config.commandName ?? "md";
  const targetDirectory = createDirectoryFor(composer.location, composer.customDir, cwd, flowsDirectory);
  const flowPath = join(targetDirectory, `${spec.slug}.md`);
  const scope = describeCreateScope({
    location: composer.location,
    flowPath,
    slug: spec.slug,
    cwd,
    projectRoot: root,
  });
  const marker = (field: CreateField) => (composer.focus === field ? color.cyan("❯") : " ");
  const caret = (field: CreateField) => (composer.focus === field ? color.cyan("▏") : "");
  const text = (field: CreateField, value: string, placeholder: string) =>
    `${marker(field)} ${value ? safeText(value) : ""}${caret(field)}${value ? "" : ` ${color.dim(placeholder)}`}`;
  const label = (name: string) => color.dim(name.padEnd(10));
  const scopeName = composer.location === "user" ? "GLOBAL" : composer.location.toUpperCase();
  const scopeLines = wrapPlainText(formatCreateScope(scope, "creating"), leftWidth)
    .map((line) => color.yellow(color.bold(line)));

  const left = [
    color.bold("Compose a new flow"),
    color.dim("Tab/↑↓ fields · ←/→ choices · Enter create · Esc back"),
    ...scopeLines,
    `${label("Scope")}${marker("scope")} ${color.cyan("‹")} ${color.bold(scopeName)} ${color.cyan("›")}`,
    ...(composer.location === "custom"
      ? [`${label("Directory")}${text("directory", composer.customDir, "relative or absolute path")}`]
      : []),
    ...(composer.location === "custom" && !composer.customDir.trim()
      ? [color.red("Choose a custom directory before creating.")]
      : []),
    `${label("Intent")}${text("intent", composer.intent, "the repeatable job, in plain language")}`,
    `${label("Name")}${composer.name
      ? text("name", composer.name, "")
      : `${marker("name")} ${safeText(spec.slug)}${caret("name")} ${color.dim("(auto — type to override)")}`}`,
    `${label("Docs")}${text("docs", composer.docs, "gog --help, https://…  (comma-separated)")}`,
    `${label("Engine")}${marker("engine")} ${color.cyan("‹")} ${safeText(composer.engine)} ${color.cyan("›")}`,
    `${label("Model")}${composer.model
      ? text("model", composer.model, "")
      : `${marker("model")} ${color.dim("engine default")}${caret("model")} ${color.dim("(←/→ suggestions or type)")}`}`,
    ...(createFields(composer.engine, composer.location).includes("effort")
      ? [`${label("Effort")}${marker("effort")} ${color.cyan("‹")} ${composer.effort ?? "engine default"} ${color.cyan("›")}`]
      : []),
    `${color.dim("Shell")} ${spec.intent ? newFlowCommand(spec, commandName) : `${commandName} create`}`,
  ];
  while (left.length < contentHeight) left.push("");

  // Draft validation (docs entries, effort levels) must degrade to an inline
  // message: the live preview re-renders on every keystroke and a throw here
  // would take down the whole prompt.
  let draft: FlowDraft | undefined;
  let draftError: string | undefined;
  if (spec.intent) {
    try {
      draft = draftFromSpec(spec);
    } catch (error) {
      draftError = error instanceof Error ? error.message : String(error);
    }
  }
  const right = [
    color.bold("LIVE DRAFT"),
    color.dim(draft ? draft.filename : draftError ? "fix the highlighted input" : "waiting for an intent…"),
    "",
  ];
  if (draftError) right.push(color.red(safeText(draftError)));
  if (draft) {
    // The identity is assigned by the model when the action is accepted. Hide
    // its random value here so unrelated re-renders do not make the preview
    // appear unstable.
    const stablePreview = draft.markdown.replace(/^(_flow_id:\s*).+$/m, "$1<assigned on create>");
    right.push(...markdownLines(stablePreview, Math.max(0, contentHeight - right.length), rightWidth));
  }
  while (right.length < contentHeight) right.push("");
  return renderColumns(left, right, leftWidth, rightWidth);
}

function renderFeedback(
  file: AgentFile,
  feedback: string,
  config: WorkbenchConfig,
  root: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const commandName = config.commandName ?? "md";
  const status = statusFor(config, file, root);
  const left = [
    color.bold("What did this flow miss?"),
    color.dim(file.name),
    "",
    `${color.cyan(">")} ${safeText(feedback)}${color.cyan("▏")}`,
    "",
    color.dim("Feedback is durable, private evidence. It is not proof by itself."),
    "",
    `${color.dim("Shell")} ${commandName} feedback ${shellQuote(projectPath(file.path, root))} ${shellQuote(feedback || "<message>")}`,
  ];
  while (left.length < contentHeight) left.push("");

  const right = [
    color.bold("EVIDENCE"),
    "",
    `${color.dim("Current")}  ${evidenceLine(status)}`,
    `${color.dim("After save")} one new open feedback item`,
    "",
    color.dim("Next useful step"),
    "Represent the failure with an eval, then preview evolution for free.",
  ];
  while (right.length < contentHeight) right.push("");
  return renderColumns(left, right, leftWidth, rightWidth);
}

function renderActions(
  file: AgentFile,
  config: WorkbenchConfig,
  root: string,
  hooks: WorkbenchHooksStatus,
  cursor: number,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const status = statusFor(config, file, root);
  const actions = flowActionRows(status, hooks);
  const effectiveCursor = Math.min(cursor, actions.length - 1);
  const left = [
    color.bold(file.name),
    color.dim(projectPath(file.path, root)),
    "",
    color.cyan("Evidence  →  Eval  →  Proposal  →  Decision"),
    "",
    `${color.dim("Evidence")}  ${evidenceLine(status)}`,
    `${color.dim("Eval")}      ${evalLine(status)}`,
    `${color.dim("Proposal")}  ${proposalLine(status)}`,
    `${color.dim("Hooks")}     ${hooksLine(hooks)}`,
    "",
    color.dim("Recommended next step"),
    clip(inferredNext(status), leftWidth),
  ];
  while (left.length < contentHeight) left.push("");

  const right = [
    color.bold("ACTIONS"),
    color.dim("↑↓ or ctrl+p/n · Enter chooses · Tab returns"),
    "",
  ];
  for (const [index, action] of actions.entries()) {
    const label = `${action.label}  ${stripAnsi(effectBadge(action.effect))}`;
    const padded = fit(action.enabled ? label : color.dim(label), rightWidth);
    right.push(index === effectiveCursor ? color.inverse(stripAnsi(padded)) : padded);
  }
  if (status.proposal?.capabilityDelta) {
    right.push("", color.dim("Capability change"), clip(status.proposal.capabilityDelta, rightWidth));
  }
  while (right.length < contentHeight) right.push("");
  return renderColumns(left, right, leftWidth, rightWidth);
}

const HOOK_EVENT_HINTS: Record<CanonicalHookEvent, string> = {
  sessionStart: "session begins",
  userPromptSubmit: "prompt submitted",
  preToolUse: "before a tool call",
  postToolUse: "after a tool call",
  permissionRequest: "approval requested",
  preCompact: "before compaction",
  postCompact: "after compaction",
  subagentStart: "subagent begins",
  subagentStop: "subagent finishes",
  stop: "turn finishes",
  sessionEnd: "session ends",
};

function renderHooksPicker(
  file: AgentFile,
  selectedEvents: readonly CanonicalHookEvent[],
  cursor: number,
  root: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const hooksPath = hooksFileForFlow(file.path);
  const selectedSummary = selectedEvents.length > 0
    ? selectedEvents.join(", ")
    : "none selected yet";
  const left = [
    color.bold("Add lifecycle hooks"),
    color.dim(file.name),
    `${effectBadge("LOCAL WRITE")} Creates one executable TypeScript file beside the flow.`,
    color.dim("No engine runs. Existing hooks files are never overwritten."),
    "",
    color.dim("Hooks file"),
    clip(projectPath(hooksPath, root), leftWidth),
    "",
    color.dim(`Selected (${selectedEvents.length})`),
    ...wrapPlainText(selectedSummary, leftWidth),
  ].slice(0, contentHeight);
  while (left.length < contentHeight) left.push("");

  const rowSlots = Math.max(1, contentHeight - 3);
  const effectiveCursor = Math.min(cursor, CANONICAL_HOOK_EVENTS.length - 1);
  const start = Math.max(
    0,
    Math.min(effectiveCursor - Math.floor(rowSlots / 2), CANONICAL_HOOK_EVENTS.length - rowSlots),
  );
  const visibleEvents = CANONICAL_HOOK_EVENTS.slice(start, start + rowSlots);
  const right = [
    color.bold("CANONICAL EVENTS"),
    color.dim("Space toggles · Tab/↑↓ cycles · Enter creates · Esc cancels"),
    "",
  ];
  for (const [index, event] of visibleEvents.entries()) {
    const absoluteIndex = start + index;
    const checked = selectedEvents.includes(event) ? "[x]" : "[ ]";
    const label = fit(`${checked} ${event}  ${color.dim(HOOK_EVENT_HINTS[event])}`, rightWidth);
    right.push(absoluteIndex === effectiveCursor ? color.inverse(stripAnsi(label)) : label);
  }
  while (right.length < contentHeight) right.push("");
  return renderColumns(left, right, leftWidth, rightWidth);
}

function renderEvolveWriteConfirmation(
  result: WorkbenchResult,
  root: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const isApply = result.action === "evolve-apply";
  const verb = isApply ? "Apply" : "Roll back";
  const filePath = result.file ? projectPath(result.file.path, root) : result.path ?? "";
  const left = [
    color.red(color.bold(`CONFIRM ${verb.toUpperCase()}`)),
    effectBadge("LOCAL WRITE"),
    "",
    isApply
      ? "This writes the reviewed proposal into your local flow."
      : "This restores the local flow from the selected evolution run.",
    "",
    color.dim("Nothing happens until you confirm again."),
    color.dim("Esc returns to Actions without writing."),
  ];
  while (left.length < contentHeight) left.push("");

  const right = [
    color.bold("WRITE DETAILS"),
    "",
    color.dim("Flow"),
    filePath,
    "",
    color.dim("Run ID"),
    result.runId ?? "",
    "",
    color.dim("Exact shell command"),
    result.command,
  ];
  while (right.length < contentHeight) right.push("");
  return renderColumns(left, right, leftWidth, rightWidth);
}

function footerFor(
  screen: WorkbenchScreen,
  file: AgentFile | undefined,
  config: WorkbenchConfig,
  root: string,
  composer: ComposerState,
  feedback: string,
  hookEvents: readonly CanonicalHookEvent[],
  confirmation?: WorkbenchResult,
): string[] {
  const commandName = config.commandName ?? "md";
  if (screen === "create") {
    const spec = specFromComposer(composer);
    const command = spec.intent ? newFlowCommand(spec, commandName) : `${commandName} create`;
    return [
      `${keycap("Enter")} Create ${effectBadge("LOCAL WRITE")}  ${keycap("Tab")} Next field  ${keycap("Esc")} Back`,
      `${color.dim("Shell:")} ${command}`,
    ];
  }
  if (screen === "feedback") {
    const command = file
      ? `${commandName} feedback ${shellQuote(projectPath(file.path, root))} ${shellQuote(feedback || "<message>")}`
      : `${commandName} feedback`;
    return [
      `${keycap("Enter")} Save ${effectBadge("LOCAL WRITE")}  ${keycap("Esc")} Back`,
      `${color.dim("Shell:")} ${command}`,
    ];
  }
  if (screen === "actions") {
    return [
      `${keycap("↑↓ / ctrl+p/n")} Select  ${keycap("Enter")} Choose  ${keycap("Tab / Esc")} Back`,
      file ? `${color.dim("Next:")} ${inferredNext(statusFor(config, file, root))}` : "",
    ];
  }
  if (screen === "hooks") {
    const result = file
      ? hooksAddResult(file, hookEvents, commandName, root)
      : undefined;
    return [
      `${keycap("Space")} Toggle  ${keycap("Tab / Shift+Tab")} Cycle  ${keycap("Enter")} Create ${effectBadge("LOCAL WRITE")}  ${keycap("Esc")} Cancel`,
      `${color.dim("Shell:")} ${result?.command ?? `${commandName} hooks add <flow.md> <event…>`}`,
    ];
  }
  if (screen === "confirm") {
    return [
      `${keycap("Enter")} Confirm  ${effectBadge("LOCAL WRITE")}  ${keycap("Esc")} Cancel / Back`,
      confirmation ? `${color.dim("Shell:")} ${confirmation.command}` : "",
    ];
  }
  const shell = file ? commandForFlow(commandName, file.path, root) : "no flow selected";
  return [
    `${keycap("↑↓ / ctrl+p/n")} Select  ${keycap("Enter")} Run  ${keycap("Tab / →")} Actions  ${keycap("ctrl+o")} New flow  ${keycap("Esc")} Clear / quit`,
    `${color.dim("Shell:")} ${shell}`,
  ];
}

/** Raw @inquirer/core prompt, exported for composition and terminal demos. */
export const workbenchPrompt = createPrompt<WorkbenchResult, WorkbenchConfig>((config, done) => {
  const cwd = resolve(config.cwd ?? process.cwd());
  const root = resolve(config.projectRoot ?? cwd);
  const flowsDirectory = resolveFlowsDirectory(config, root);
  const canonicalFlowsDirectory = resolve(root, "flows");
  const configuredCustomDirectory = flowsDirectory !== canonicalFlowsDirectory;
  const defaultCreateLocationIndex = configuredCustomDirectory
    ? CREATE_LOCATIONS.indexOf("custom")
    : CREATE_LOCATIONS.indexOf("project");
  const defaultCustomDir = configuredCustomDirectory ? flowsDirectory : "";
  const projectName = config.projectName ?? (basename(root) || "project");
  const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });
  const engines = listNewFlowEngines();
  const defaultEngineIndex = Math.max(0, engines.indexOf(NEW_FLOW_DEFAULT_ENGINE));
  const [screen, setScreen] = useState<WorkbenchScreen>("home");
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [actionCursor, setActionCursor] = useState(0);
  const [intent, setIntent] = useState("");
  const [customDirInput, setCustomDirInput] = useState(defaultCustomDir);
  const [nameInput, setNameInput] = useState("");
  const [docsInput, setDocsInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [engineIndex, setEngineIndex] = useState(defaultEngineIndex);
  const [createLocationIndex, setCreateLocationIndex] = useState(defaultCreateLocationIndex);
  const [effortIndex, setEffortIndex] = useState(0);
  const [createFieldIndex, setCreateFieldIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [feedbackReturn, setFeedbackReturn] = useState<FeedbackReturnScreen>("home");
  const [confirmation, setConfirmation] = useState<WorkbenchResult | undefined>(undefined);
  const [hookEventCursor, setHookEventCursor] = useState(0);
  const [selectedHookEvents, setSelectedHookEvents] = useState<CanonicalHookEvent[]>([]);
  const [, setHooksHydrationTick] = useState<object>({});

  const rows = getWorkbenchRows(config.files, filter);
  const effectiveCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const homeFile = selectedFile(rows, effectiveCursor);
  const activeFile = currentFile(config.files, activePath) ?? homeFile;
  const hooksDisplayFile = screen === "home"
    ? homeFile
    : screen === "actions" || screen === "hooks"
      ? activeFile
      : undefined;
  const readHooksStatus = config.hooksStatusFor ?? getWorkbenchHooksStatus;
  const hydrateHooksStatus = config.hydrateHooksStatus ?? hydrateWorkbenchHooksStatus;
  const displayedHooksStatus: WorkbenchHooksStatus = hooksDisplayFile
    ? readHooksStatus(hooksDisplayFile)
    : { state: "none" };
  const hooksHydrationKey = displayedHooksStatus.state === "loading"
    ? `${displayedHooksStatus.path}\0${displayedHooksStatus.mtimeMs}`
    : "";

  useEffect(() => {
    if (!hooksDisplayFile || displayedHooksStatus.state !== "loading") return;
    let active = true;
    void hydrateHooksStatus(hooksDisplayFile).then(() => {
      if (active) setHooksHydrationTick({});
    });
    return () => { active = false; };
  }, [hooksDisplayFile?.path, hooksHydrationKey]);

  const composerEngine = engines[engineIndex] ?? NEW_FLOW_DEFAULT_ENGINE;
  const composerLocation = CREATE_LOCATIONS[createLocationIndex] ?? "project";
  const composerFields = createFields(composerEngine, composerLocation);
  const composerFocus = composerFields[Math.min(createFieldIndex, composerFields.length - 1)]!;
  const composerEffort = effortIndex > 0 ? effortLevels(composerEngine)[effortIndex - 1] : undefined;
  const composer: ComposerState = {
    intent,
    name: nameInput,
    docs: docsInput,
    model: modelInput,
    engine: composerEngine,
    location: composerLocation,
    customDir: customDirInput,
    ...(composerEffort ? { effort: composerEffort } : {}),
    focus: composerFocus,
  };
  const homeHooksStatus: WorkbenchHooksStatus = homeFile
    ? readHooksStatus(homeFile)
    : { state: "none" };
  const activeHooksStatus: WorkbenchHooksStatus = activeFile
    ? readHooksStatus(activeFile)
    : { state: "none" };
  const actions = activeFile
    ? flowActionRows(statusFor(config, activeFile, root), activeHooksStatus)
    : [];
  const effectiveActionCursor = Math.min(actionCursor, Math.max(0, actions.length - 1));

  const openComposer = (seedIntent: string) => {
    setIntent(seedIntent);
    setCustomDirInput(defaultCustomDir);
    setNameInput("");
    setDocsInput("");
    setModelInput("");
    setEngineIndex(defaultEngineIndex);
    setCreateLocationIndex(defaultCreateLocationIndex);
    setEffortIndex(0);
    setCreateFieldIndex(0);
    setScreen("create");
  };

  const finishFlow = (action: "run" | "dry-run" | "edit" | "evolve-plan" | "evolve-propose", file: AgentFile) => {
    done(resultForFlow(action, file, config, root));
  };

  useKeypress((keypress, readline) => {
    const key = keypress as ExtendedKeypressEvent;
    if (key.name === "tab") readline.clearLine(0);

    if (screen === "confirm") {
      if (key.name === "tab") return;
      if (key.name === "escape") {
        setConfirmation(undefined);
        setScreen("actions");
        return;
      }
      if (confirmation && isEvolveWriteConfirmationKey(key)) done(confirmation);
      return;
    }

    if (screen === "hooks") {
      if (key.name === "escape") {
        setSelectedHookEvents([]);
        setScreen("actions");
        return;
      }
      if ((key.name === "tab" && key.shift) || key.name === "up") {
        setHookEventCursor(
          (hookEventCursor + CANONICAL_HOOK_EVENTS.length - 1) % CANONICAL_HOOK_EVENTS.length,
        );
        return;
      }
      if (key.name === "tab" || key.name === "down") {
        setHookEventCursor((hookEventCursor + 1) % CANONICAL_HOOK_EVENTS.length);
        return;
      }
      if (key.name === "space" || key.sequence === " ") {
        const event = CANONICAL_HOOK_EVENTS[hookEventCursor];
        if (!event) return;
        setSelectedHookEvents(
          selectedHookEvents.includes(event)
            ? selectedHookEvents.filter((selected) => selected !== event)
            : [...selectedHookEvents, event],
        );
        return;
      }
      if (isEnterKey(key) && activeFile && selectedHookEvents.length > 0) {
        done(hooksAddResult(activeFile, selectedHookEvents, config.commandName ?? "md", root));
      }
      return;
    }

    if (screen === "create") {
      if (isEnterKey(key)) {
        if (intent.trim() && (composerLocation !== "custom" || customDirInput.trim())) {
          try {
            done(createResult(config, root, cwd, flowsDirectory, specFromComposer(composer)));
          } catch {
            // The live preview explains invalid docs/effort input; keep editing.
          }
        }
        return;
      }
      if (key.name === "escape") {
        setScreen("home");
        return;
      }
      if ((key.name === "tab" && key.shift) || key.name === "up") {
        setCreateFieldIndex((composerFields.indexOf(composerFocus) + composerFields.length - 1) % composerFields.length);
        return;
      }
      if (key.name === "tab" || key.name === "down") {
        setCreateFieldIndex((composerFields.indexOf(composerFocus) + 1) % composerFields.length);
        return;
      }
      if (key.name === "left" || key.name === "right") {
        const delta = key.name === "right" ? 1 : -1;
        if (composerFocus === "scope") {
          setCreateLocationIndex((createLocationIndex + delta + CREATE_LOCATIONS.length) % CREATE_LOCATIONS.length);
          return;
        }
        if (composerFocus === "engine") {
          setEngineIndex((engineIndex + delta + engines.length) % engines.length);
          setEffortIndex(0);
          return;
        }
        if (composerFocus === "effort") {
          const optionCount = effortLevels(composerEngine).length + 1;
          setEffortIndex((effortIndex + delta + optionCount) % optionCount);
          return;
        }
        if (composerFocus === "model") {
          const options = ["", ...modelSuggestions(composerEngine)];
          const current = options.indexOf(modelInput);
          const base = current === -1 ? 0 : current;
          setModelInput(options[(base + delta + options.length) % options.length] ?? "");
        }
        return;
      }
      const editors: Partial<Record<CreateField, [string, (value: string) => void]>> = {
        directory: [customDirInput, setCustomDirInput],
        intent: [intent, setIntent],
        name: [nameInput, setNameInput],
        docs: [docsInput, setDocsInput],
        model: [modelInput, setModelInput],
      };
      const editor = TEXT_CREATE_FIELDS.has(composerFocus) ? editors[composerFocus] : undefined;
      if (!editor) return;
      const [value, setValue] = editor;
      if (key.name === "backspace") {
        setValue(value.slice(0, -1));
        return;
      }
      const character = printableCharacter(key);
      if (character) setValue(value + character);
      return;
    }

    if (screen === "feedback") {
      if (key.name === "tab") return;
      if (isEnterKey(key)) {
        const value = feedback.trim();
        if (activeFile && value) {
          const commandName = config.commandName ?? "md";
          done({
            action: "feedback",
            effect: "LOCAL WRITE",
            command: `${commandName} feedback ${shellQuote(projectPath(activeFile.path, root))} ${shellQuote(value)}`,
            file: activeFile,
            path: activeFile.path,
            feedback: value,
          });
        }
        return;
      }
      if (key.name === "escape") {
        setScreen(feedbackReturn);
        setFeedback("");
        return;
      }
      if (key.name === "backspace") {
        setFeedback(feedback.slice(0, -1));
        return;
      }
      const character = printableCharacter(key);
      if (character) setFeedback(feedback + character);
      return;
    }

    if (screen === "actions") {
      if (key.name === "tab" || key.name === "escape" || key.name === "left") {
        setScreen("home");
        return;
      }
      if (isUpKey(key) || (key.ctrl && key.name === "p")) {
        setActionCursor(moveActionCursor(actions, effectiveActionCursor, -1));
        return;
      }
      if (isDownKey(key) || (key.ctrl && key.name === "n")) {
        setActionCursor(moveActionCursor(actions, effectiveActionCursor, 1));
        return;
      }
      if (!activeFile || !isEnterKey(key)) return;
      const selected = actions[effectiveActionCursor];
      if (!selected?.enabled) return;
      if (["run", "dry-run", "edit", "evolve-plan", "evolve-propose"].includes(selected.action)) {
        finishFlow(selected.action as "run" | "dry-run" | "edit" | "evolve-plan" | "evolve-propose", activeFile);
        return;
      }
      if (selected.action === "feedback") {
        setFeedbackReturn("actions");
        setFeedback("");
        setScreen("feedback");
        return;
      }
      if (selected.action === "hooks-open" && selected.hooksPath) {
        done(hooksOpenResult(activeFile, selected.hooksPath, root));
        return;
      }
      if (selected.action === "hooks-add") {
        setHookEventCursor(0);
        setSelectedHookEvents([]);
        setScreen("hooks");
        return;
      }
      if (selected.runId) {
        const writeAction = selected.action === "evolve-apply" ? "evolve-apply" : "evolve-rollback";
        setConfirmation(evolveWriteResult(writeAction, activeFile, selected.runId, config.commandName ?? "md"));
        setScreen("confirm");
      }
      return;
    }

    // Home is always a live search field: every printable character filters.
    if (key.name === "tab" || key.name === "right") {
      if (homeFile) {
        setActivePath(homeFile.path);
        setActionCursor(0);
        setScreen("actions");
      }
      return;
    }
    if (key.ctrl && key.name === "o") {
      openComposer(filter.trim());
      return;
    }
    if (isEnterKey(key)) {
      const row = rows[effectiveCursor];
      if (row) finishFlow("run", row.file);
      return;
    }
    if (isUpKey(key) || (key.ctrl && key.name === "p")) {
      if (rows.length > 0) setCursor(Math.max(0, effectiveCursor - 1));
      return;
    }
    if (isDownKey(key) || (key.ctrl && key.name === "n")) {
      if (rows.length > 0) setCursor(Math.min(rows.length - 1, effectiveCursor + 1));
      return;
    }
    if (key.name === "escape") {
      if (filter) {
        setFilter("");
        setCursor(0);
      } else {
        done({ action: "cancel", effect: "FREE", command: "" });
      }
      return;
    }
    if (key.name === "backspace") {
      if (filter) {
        setFilter(filter.slice(0, -1));
        setCursor(0);
      }
      return;
    }
    const character = printableCharacter(key);
    if (character) {
      setFilter(filter + character);
      setCursor(0);
    }
  });

  const terminalWidth = Math.max(52, process.stdout.columns || 100);
  const terminalHeight = Math.max(16, process.stdout.rows || 28);
  const contentHeight = Math.max(8, Math.min(config.pageSize ?? 15, terminalHeight - 8));
  const leftWidth = Math.max(22, Math.floor((terminalWidth - 3) * 0.42));
  const rightWidth = Math.max(24, terminalWidth - leftWidth - 3);
  const body = screen === "home"
    ? renderHome(config, rows, effectiveCursor, filter, root, homeHooksStatus, contentHeight, leftWidth, rightWidth)
    : screen === "create"
      ? renderCreate(config, composer, root, cwd, flowsDirectory, contentHeight, leftWidth, rightWidth)
      : screen === "feedback" && activeFile
        ? renderFeedback(activeFile, feedback, config, root, contentHeight, leftWidth, rightWidth)
        : screen === "actions" && activeFile
          ? renderActions(activeFile, config, root, activeHooksStatus, effectiveActionCursor, contentHeight, leftWidth, rightWidth)
          : screen === "hooks" && activeFile
            ? renderHooksPicker(activeFile, selectedHookEvents, hookEventCursor, root, contentHeight, leftWidth, rightWidth)
            : screen === "confirm" && confirmation
              ? renderEvolveWriteConfirmation(confirmation, root, contentHeight, leftWidth, rightWidth)
              : renderHome(config, rows, effectiveCursor, filter, root, homeHooksStatus, contentHeight, leftWidth, rightWidth);
  const footerFile = screen === "home" ? homeFile : activeFile;
  const footer = footerFor(
    screen,
    footerFile,
    config,
    root,
    composer,
    feedback,
    selectedHookEvents,
    confirmation,
  );
  return [
    `${prefix} ${titleBar(projectName, screen, terminalWidth - 2)}`,
    color.dim("─".repeat(Math.max(1, terminalWidth - 2))),
    ...body,
    color.dim("─".repeat(Math.max(1, terminalWidth - 2))),
    ...footer,
  ].join("\n");
});

export type ShowWorkbenchOptions = Omit<WorkbenchConfig, "files">;

/**
 * Friendly entry point for the CLI. Ctrl+C and force-close become the same
 * explicit cancel action as Esc on an empty query, so callers do not need exception control
 * flow for normal user cancellation. Unexpected prompt errors still throw:
 * a rendering bug must surface, not masquerade as the user backing out.
 */
export async function showWorkbench(
  files: readonly AgentFile[],
  options: ShowWorkbenchOptions = {},
): Promise<WorkbenchResult> {
  try {
    return await workbenchPrompt({ ...options, files });
  } catch (error) {
    if (
      error instanceof ExitPromptError ||
      error instanceof CancelPromptError ||
      error instanceof AbortPromptError
    ) {
      return { action: "cancel", effect: "FREE", command: "" };
    }
    throw error;
  }
}
