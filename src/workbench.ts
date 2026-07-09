/**
 * The interactive md Flow Workbench.
 *
 * This module deliberately owns presentation and intent collection only. It
 * returns an action to the CLI, which remains responsible for running engines
 * and performing writes. Keeping that boundary explicit makes every action's
 * cost and side effects visible before the prompt exits.
 */

import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  makeTheme,
  type KeypressEvent,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentFile } from "./cli";
import {
  draftFlowFromIntent,
  type FlowDraft,
  type WorkbenchLifecycleSummary,
} from "./workbench-model";
import { flowCommand } from "./tips";

export type WorkbenchAction =
  | "run"
  | "dry-run"
  | "edit"
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
        : "Run the flow, then record anything it misses with f.";
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
  /** Destination for new flows. Relative paths are resolved from projectRoot. */
  flowsDirectory?: string;
  /** Executable shown in exact shell equivalents. Defaults to md. */
  commandName?: string;
  /** Height of the main content area. It is still clamped to the terminal. */
  pageSize?: number;
  /** Status may be keyed by absolute path, project-relative path, filename, or name. */
  statuses?: Readonly<Record<string, WorkbenchFlowStatus | undefined>>;
  /** Takes precedence over statuses when supplied. Must be synchronous for rendering. */
  statusFor?: (file: AgentFile) => WorkbenchFlowStatus | undefined;
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
  feedback?: string;
  runId?: string;
}

type WorkbenchScreen = "home" | "create" | "feedback" | "improve" | "confirm";
type FeedbackReturnScreen = "home" | "improve";
type WorkbenchWriteAction = "evolve-apply" | "evolve-rollback";

interface ExtendedKeypressEvent extends KeypressEvent {
  sequence?: string;
  meta?: boolean;
  shift?: boolean;
}

interface FlowRow {
  kind: "flow";
  file: AgentFile;
  score: number;
}

interface CreateRow {
  kind: "create";
  score: number;
}

type HomeRow = FlowRow | CreateRow;

const ESCAPE_CODES = /\x1b\[[0-9;]*m/g;
const fileCache = new Map<string, string>();

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

function keycap(value: string): string {
  return color.inverse(` ${value} `);
}

function effectBadge(effect: WorkbenchEffect): string {
  return EFFECT_COLOR[effect](`[${effect}]`);
}

function readFlow(file: AgentFile): string {
  const cached = fileCache.get(file.path);
  if (cached !== undefined) return cached;
  try {
    const content = existsSync(file.path)
      ? readFileSync(file.path, "utf8")
      : `[Flow not found: ${file.path}]`;
    fileCache.set(file.path, content);
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandForFlow(commandName: string, path: string, root: string): string {
  return flowCommand(path, root, commandName);
}

function createResult(
  config: WorkbenchConfig,
  root: string,
  flowsDirectory: string,
  intent: string,
): WorkbenchResult {
  const draft = draftFlowFromIntent(intent);
  const path = join(flowsDirectory, draft.filename);
  const commandName = config.commandName ?? "md";
  return {
    action: "create",
    effect: "LOCAL WRITE",
    command: `${commandName} create ${shellQuote(intent)}`,
    intent,
    draft,
    path,
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

function matchScore(query: string, file: AgentFile): number {
  if (!query) return 1 + Math.min(15, file.frecency ?? 0);
  const needle = query.toLowerCase();
  const name = file.name.toLowerCase();
  const description = (file.description ?? "").toLowerCase();
  const path = file.path.toLowerCase();
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 85;
  if (name.includes(needle)) return 70;
  if (description.includes(needle)) return 55;
  if (`${name} ${description} ${path}`.includes(needle)) return 40;

  let index = 0;
  for (const character of name) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return 20;
  }
  return 0;
}

/** Pure helper used by the prompt and by terminal-demo fixtures. */
export function getWorkbenchRows(files: readonly AgentFile[], query: string): HomeRow[] {
  if (!query.trim()) {
    // Discovery already encodes the product hierarchy (project roster before
    // legacy/user/PATH files, then frecency within each source). Preserve it
    // until the user explicitly searches.
    return [
      ...files.map((file, index) => ({ kind: "flow" as const, file, score: files.length - index })),
      { kind: "create", score: -1 },
    ];
  }
  const flowRows = files
    .map((file) => ({ kind: "flow" as const, file, score: matchScore(query.trim(), file) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name));
  // Creation is deliberately part of search rather than a detached wizard.
  return [...flowRows, { kind: "create", score: -1 }];
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
  else if (["running", "drafting", "verifying"].includes(proposalState ?? "")) fragments.push(color.yellow("evolving…"));
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

function inferredNext(status: WorkbenchFlowStatus): string {
  if (status.next) return status.next;
  if ((status.evidence?.open ?? 0) === 0) return "Run the flow, then record anything it misses with f.";
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
  return row?.kind === "flow" ? row.file : undefined;
}

function currentFile(files: readonly AgentFile[], path: string | undefined): AgentFile | undefined {
  return path ? files.find((file) => file.path === path) : undefined;
}

function printableCharacter(key: ExtendedKeypressEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (!sequence || sequence.length !== 1 || sequence < " ") return undefined;
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

/** Only Enter or an explicit C confirms a pending local write. */
export function isEvolveWriteConfirmationKey(key: KeypressEvent): boolean {
  if (key.ctrl || (key as ExtendedKeypressEvent).meta) return false;
  return isEnterKey(key) || key.name === "c";
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

function renderHome(
  config: WorkbenchConfig,
  rows: HomeRow[],
  cursor: number,
  filter: string,
  searchActive: boolean,
  root: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const effectiveCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const rowSlots = Math.max(1, contentHeight - 1);
  const start = Math.max(0, Math.min(effectiveCursor - Math.floor(rowSlots / 2), rows.length - rowSlots));
  const visibleRows = rows.slice(start, start + rowSlots);
  const left: string[] = [];
  const prompt = filter
    ? `${color.dim("Find:")} ${color.cyan(safeText(filter))}${searchActive ? color.cyan("▏") : ""}`
    : searchActive
      ? `${color.dim("Find:")} ${color.cyan("▏")} ${color.dim("type a name, outcome, or path")}`
      : color.dim("Type to filter · / searches reserved shortcuts too");
  left.push(prompt);

  for (let index = 0; index < rowSlots; index += 1) {
    const row = visibleRows[index];
    if (!row) {
      left.push("");
      continue;
    }
    const absoluteIndex = start + index;
    const isSelected = absoluteIndex === effectiveCursor;
    let text: string;
    if (row.kind === "create") {
      const label = filter.trim() ? `＋ Create “${safeText(filter.trim())}”` : "＋ Create a new flow…";
      text = color.cyan(label);
    } else {
      const status = statusFor(config, row.file, root);
      const badge = statusBadge(status);
      text = ` ${row.file.name}${badge ? `  ${badge}` : ""}`;
    }
    const fitted = fit(text, leftWidth);
    left.push(isSelected ? color.inverse(stripAnsi(fitted)) : fitted);
  }

  const row = rows[effectiveCursor];
  const right: string[] = [];
  if (row?.kind === "flow") {
    const file = row.file;
    const status = statusFor(config, file, root);
    right.push(color.bold(file.name));
    right.push(color.dim(projectPath(file.path, root)));
    if (file.description) right.push(clip(safeText(file.description), rightWidth));
    right.push("");
    right.push(`${color.dim("Evidence")}  ${clip(evidenceLine(status), Math.max(10, rightWidth - 10))}`);
    right.push(`${color.dim("Eval")}      ${clip(evalLine(status), Math.max(10, rightWidth - 10))}`);
    right.push(`${color.dim("Proposal")}  ${clip(proposalLine(status), Math.max(10, rightWidth - 10))}`);
    right.push("");
    const remaining = Math.max(0, contentHeight - right.length);
    right.push(...markdownLines(readFlow(file), remaining, rightWidth));
  } else {
    right.push(color.cyan(color.bold(filter.trim() ? "Turn this search into a flow" : "Create your first useful flow")));
    right.push("");
    right.push("Describe the repeatable outcome in plain language.");
    right.push(color.dim("mdflow will propose a slug, description, and Markdown draft."));
    right.push("");
    right.push(`${keycap("Enter")} Compose  ${effectBadge("FREE")}`);
    right.push(`${keycap("N")} New flow from anywhere`);
    while (right.length < contentHeight) right.push("");
  }
  while (right.length < contentHeight) right.push("");

  return renderColumns(left, right, leftWidth, rightWidth);
}

function previewDraft(intent: string): FlowDraft | undefined {
  if (!intent.trim()) return undefined;
  return draftFlowFromIntent(intent.trim());
}

function renderCreate(
  config: WorkbenchConfig,
  intent: string,
  root: string,
  flowsDirectory: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const draft = previewDraft(intent);
  const commandName = config.commandName ?? "md";
  const left = [
    color.bold("What repeatable job should this flow do?"),
    "",
    `${color.cyan(">")} ${safeText(intent)}${color.cyan("▏")}`,
    "",
    color.dim("Describe the outcome; mdflow handles the filename and scaffolding."),
    "",
  ];
  if (draft) {
    left.push(`${color.dim("Flow")}  ${draft.filename}`);
    left.push(`${color.dim("Path")}  ${projectPath(join(flowsDirectory, draft.filename), root)}`);
    left.push("");
    left.push(`${color.dim("Shell")} ${commandName} create ${shellQuote(intent.trim())}`);
  } else {
    left.push(color.dim("Example: Review staged changes for concurrency bugs"));
  }
  while (left.length < contentHeight) left.push("");

  const right = [color.bold("LIVE DRAFT"), color.dim(draft ? draft.filename : "waiting for an intent…"), ""];
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

function renderImprove(
  file: AgentFile,
  config: WorkbenchConfig,
  root: string,
  contentHeight: number,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const status = statusFor(config, file, root);
  const commandName = config.commandName ?? "md";
  const fileArg = shellQuote(projectPath(file.path, root));
  const proposalRunId = status.proposal?.runId;
  const canApply = Boolean(
    proposalRunId
    && ["verified", "verified_improvement", "regression_safe"].includes(status.proposal?.state ?? ""),
  );
  const rollbackRunId = status.proposal?.appliedRunId
    ?? (status.proposal?.state === "applied" ? proposalRunId : undefined);
  const left = [
    color.bold(file.name),
    color.dim(projectPath(file.path, root)),
    "",
    color.cyan("Evidence  →  Eval  →  Proposal  →  Decision"),
    "",
    `${color.dim("Evidence")}  ${evidenceLine(status)}`,
    `${color.dim("Eval")}      ${evalLine(status)}`,
    `${color.dim("Proposal")}  ${proposalLine(status)}`,
    "",
    color.dim("Safest useful next step"),
    clip(inferredNext(status), leftWidth),
  ];
  while (left.length < contentHeight) left.push("");

  const right = [
    color.bold("ACTIONS"),
    "",
    `${keycap("P")} Plan readiness       ${effectBadge("FREE")}`,
    color.dim(`   ${commandName} evolve plan ${fileArg}`),
    "",
    `${keycap("O")} Create proposal      ${effectBadge("ENGINE")}`,
    color.dim(`   ${commandName} evolve propose ${fileArg}`),
    "",
    canApply
      ? `${keycap("A")} Apply ${proposalRunId}  ${effectBadge("LOCAL WRITE")}`
      : color.dim(" A  Apply · available after a proposal is verified"),
    rollbackRunId
      ? `${keycap("R")} Roll back ${rollbackRunId}  ${effectBadge("LOCAL WRITE")}`
      : color.dim(" R  Roll back · available after an apply"),
    "",
    `${keycap("F")} Add feedback  ${effectBadge("LOCAL WRITE")}`,
  ];
  if (status.proposal?.capabilityDelta) {
    right.push("", color.dim("Capability change"), clip(status.proposal.capabilityDelta, rightWidth));
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
    color.dim("Esc returns to Improve without writing."),
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
  intent: string,
  feedback: string,
  confirmation?: WorkbenchResult,
): string[] {
  const commandName = config.commandName ?? "md";
  if (screen === "create") {
    const command = intent.trim() ? `${commandName} create ${shellQuote(intent.trim())}` : `${commandName} create`;
    return [
      `${keycap("Enter")} Create ${effectBadge("LOCAL WRITE")}  ${keycap("Esc")} Back`,
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
  if (screen === "improve") {
    return [
      `${keycap("P")} Plan ${effectBadge("FREE")}  ${keycap("O")} Propose ${effectBadge("ENGINE")}  ${keycap("A")} Apply  ${keycap("R")} Rollback  ${keycap("Esc")} Back`,
      file ? `${color.dim("Next:")} ${inferredNext(statusFor(config, file, root))}` : "",
    ];
  }
  if (screen === "confirm") {
    return [
      `${keycap("Enter")} Confirm  ${keycap("C")} Confirm  ${effectBadge("LOCAL WRITE")}  ${keycap("Esc")} Cancel / Back`,
      confirmation ? `${color.dim("Shell:")} ${confirmation.command}` : "",
    ];
  }
  const shell = file ? commandForFlow(commandName, file.path, root) : `${commandName} create`;
  return [
    `${keycap("Enter")} Run ${effectBadge("ENGINE")}  ${keycap("D")} Dry-run ${effectBadge("FREE")}`,
    `${keycap("↑↓")} Browse  ${keycap("E")} Edit ${effectBadge("LOCAL WRITE")}  ${keycap("N")} New  ${keycap("I")} Improve  ${keycap("F")} Feedback`,
    `${color.dim("Shell:")} ${shell}`,
  ];
}

/** Raw @inquirer/core prompt, exported for composition and terminal demos. */
export const workbenchPrompt = createPrompt<WorkbenchResult, WorkbenchConfig>((config, done) => {
  const root = resolve(config.projectRoot ?? process.cwd());
  const flowsDirectory = resolveFlowsDirectory(config, root);
  const projectName = config.projectName ?? (basename(root) || "project");
  const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });
  const [screen, setScreen] = useState<WorkbenchScreen>("home");
  const [filter, setFilter] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [intent, setIntent] = useState("");
  const [feedback, setFeedback] = useState("");
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [feedbackReturn, setFeedbackReturn] = useState<FeedbackReturnScreen>("home");
  const [confirmation, setConfirmation] = useState<WorkbenchResult | undefined>(undefined);

  const rows = getWorkbenchRows(config.files, filter);
  const effectiveCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const homeFile = selectedFile(rows, effectiveCursor);
  const activeFile = currentFile(config.files, activePath) ?? homeFile;

  const finishFlow = (action: "run" | "dry-run" | "edit" | "evolve-plan" | "evolve-propose", file: AgentFile) => {
    done(resultForFlow(action, file, config, root));
  };

  useKeypress((keypress) => {
    const key = keypress as ExtendedKeypressEvent;

    if (screen === "confirm") {
      if (key.name === "escape") {
        setConfirmation(undefined);
        setScreen("improve");
        return;
      }
      if (confirmation && isEvolveWriteConfirmationKey(key)) {
        done(confirmation);
      }
      return;
    }

    if (screen === "create") {
      if (isEnterKey(key)) {
        const value = intent.trim();
        if (value) done(createResult(config, root, flowsDirectory, value));
        return;
      }
      if (key.name === "escape") {
        setScreen("home");
        return;
      }
      if (key.name === "backspace") {
        setIntent(intent.slice(0, -1));
        return;
      }
      const character = printableCharacter(key);
      if (character) setIntent(intent + character);
      return;
    }

    if (screen === "feedback") {
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

    if (screen === "improve") {
      if (key.name === "escape") {
        setScreen("home");
        return;
      }
      if (!activeFile) return;
      if (key.name === "p") {
        finishFlow("evolve-plan", activeFile);
        return;
      }
      if (key.name === "o") {
        finishFlow("evolve-propose", activeFile);
        return;
      }
      if (key.name === "e") {
        finishFlow("edit", activeFile);
        return;
      }
      if (key.name === "f") {
        setFeedbackReturn("improve");
        setFeedback("");
        setScreen("feedback");
        return;
      }
      const status = statusFor(config, activeFile, root);
      const commandName = config.commandName ?? "md";
      if (
        key.name === "a"
        && status.proposal?.runId
        && ["verified", "verified_improvement", "regression_safe"].includes(status.proposal.state ?? "")
      ) {
        const runId = status.proposal.runId;
        setConfirmation(evolveWriteResult("evolve-apply", activeFile, runId, commandName));
        setScreen("confirm");
        return;
      }
      const rollbackRunId = status.proposal?.appliedRunId
        ?? (status.proposal?.state === "applied" ? status.proposal.runId : undefined);
      if (key.name === "r" && rollbackRunId) {
        setConfirmation(evolveWriteResult("evolve-rollback", activeFile, rollbackRunId, commandName));
        setScreen("confirm");
      }
      return;
    }

    // Home: a filter is a first-class mode so reserved single-key shortcuts
    // remain discoverable. Press / before searching for a name that starts with
    // n, i, f, d, e, or q.
    if (isEnterKey(key)) {
      const row = rows[effectiveCursor];
      if (row?.kind === "flow") {
        finishFlow("run", row.file);
      } else {
        setIntent(filter.trim());
        setScreen("create");
      }
      return;
    }
    if (isUpKey(key) || (key.ctrl && key.name === "p")) {
      setCursor(Math.max(0, effectiveCursor - 1));
      return;
    }
    if (isDownKey(key) || (key.ctrl && key.name === "n")) {
      setCursor(Math.min(rows.length - 1, effectiveCursor + 1));
      return;
    }
    if (key.name === "escape") {
      if (filter || searchActive) {
        setFilter("");
        setSearchActive(false);
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
    if (!searchActive && !filter) {
      if (key.sequence === "/") {
        setSearchActive(true);
        return;
      }
      if (key.name === "q") {
        done({ action: "cancel", effect: "FREE", command: "" });
        return;
      }
      if (key.name === "n") {
        setIntent("");
        setScreen("create");
        return;
      }
      if (homeFile && (key.name === "d" || (key.ctrl && key.name === "r"))) {
        finishFlow("dry-run", homeFile);
        return;
      }
      if (homeFile && (key.name === "e" || key.name === "tab")) {
        finishFlow("edit", homeFile);
        return;
      }
      if (homeFile && key.name === "i") {
        setActivePath(homeFile.path);
        setScreen("improve");
        return;
      }
      if (homeFile && key.name === "f") {
        setActivePath(homeFile.path);
        setFeedbackReturn("home");
        setFeedback("");
        setScreen("feedback");
        return;
      }
    }
    const character = printableCharacter(key);
    if (character) {
      setSearchActive(true);
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
    ? renderHome(config, rows, effectiveCursor, filter, searchActive, root, contentHeight, leftWidth, rightWidth)
    : screen === "create"
      ? renderCreate(config, intent, root, flowsDirectory, contentHeight, leftWidth, rightWidth)
      : screen === "feedback" && activeFile
        ? renderFeedback(activeFile, feedback, config, root, contentHeight, leftWidth, rightWidth)
        : screen === "improve" && activeFile
          ? renderImprove(activeFile, config, root, contentHeight, leftWidth, rightWidth)
          : screen === "confirm" && confirmation
            ? renderEvolveWriteConfirmation(confirmation, root, contentHeight, leftWidth, rightWidth)
          : renderHome(config, rows, effectiveCursor, filter, searchActive, root, contentHeight, leftWidth, rightWidth);
  const footerFile = screen === "home" ? homeFile : activeFile;
  const footer = footerFor(screen, footerFile, config, root, intent, feedback, confirmation);
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
 * Friendly entry point for the CLI. Ctrl+C and prompt failures become the same
 * explicit cancel action as Esc/q, so callers do not need exception control
 * flow for normal user cancellation.
 */
export async function showWorkbench(
  files: readonly AgentFile[],
  options: ShowWorkbenchOptions = {},
): Promise<WorkbenchResult> {
  try {
    return await workbenchPrompt({ ...options, files });
  } catch {
    return { action: "cancel", effect: "FREE", command: "" };
  }
}
