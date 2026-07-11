/**
 * Read-only lifecycle summaries for the Flow Workbench.
 *
 * The synchronous builder is suitable for an immediate first render. It uses
 * the latest recorded eval result, but cannot prove that the receipt still
 * matches the current flow/config/suite. The asynchronous builder performs
 * that content-bound freshness check without importing or executing eval
 * suite code.
 */

import { existsSync } from "node:fs";
import type { AgentFile } from "./cli";
import {
  buildVerificationFingerprint,
  getEvalLedgerEntry,
  inspectEvalSuitePlan,
  readEvalLedger,
  resolveEvalSuitePath,
  type EvalLedgerEntry,
  type EvalSuitePlan,
} from "./evals";
import { identifyFlow, type CapabilityDiff } from "./evolution-core";
import {
  listEvolutionRuns,
  readEvidence,
  type EvidenceEvent,
  type EvolutionRunRecord,
  type EvolutionRunStatus,
} from "./evolution-store";
import type {
  WorkbenchEvalStatus,
  WorkbenchFlowStatus,
  WorkbenchProposalStatus,
} from "./workbench";

export type WorkbenchStatusMap = Record<string, WorkbenchFlowStatus>;

/** Optional snapshots let callers share one consistent read across renders. */
export interface WorkbenchStatusMapOptions {
  evidence?: readonly EvidenceEvent[];
  runs?: readonly EvolutionRunRecord[];
  ledger?: Record<string, EvalLedgerEntry>;
}

interface EvalSnapshot {
  suitePath: string;
  exists: boolean;
  plan?: EvalSuitePlan;
  planError?: string;
  entry?: EvalLedgerEntry;
  /** Undefined means the synchronous builder did not check freshness. */
  receiptCurrent?: boolean;
  receiptError?: string;
}

interface FlowSnapshot {
  file: AgentFile;
  evidence: EvidenceEvent[];
  runs: EvolutionRunRecord[];
  evaluation: EvalSnapshot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupedByFlowId<T extends { flowId: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.flowId) ?? [];
    group.push(item);
    grouped.set(item.flowId, group);
  }
  return grouped;
}

function runsByFlowId(items: readonly EvolutionRunRecord[]): Map<string, EvolutionRunRecord[]> {
  const grouped = new Map<string, EvolutionRunRecord[]>();
  for (const item of items) {
    const group = grouped.get(item.flow.id) ?? [];
    group.push(item);
    grouped.set(item.flow.id, group);
  }
  for (const group of grouped.values()) {
    group.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt));
  }
  return grouped;
}

function inspectEvaluation(file: AgentFile, ledger: Record<string, EvalLedgerEntry>): EvalSnapshot {
  const suitePath = resolveEvalSuitePath(file.path);
  if (!existsSync(suitePath)) return { suitePath, exists: false };

  const entry = getEvalLedgerEntry(suitePath, ledger);
  try {
    return {
      suitePath,
      exists: true,
      plan: inspectEvalSuitePlan(suitePath),
      entry,
    };
  } catch (error) {
    return {
      suitePath,
      exists: true,
      planError: errorMessage(error),
      entry,
    };
  }
}

function readSnapshots(
  files: readonly AgentFile[],
  options: WorkbenchStatusMapOptions,
): FlowSnapshot[] {
  const evidence = options.evidence ?? readEvidence();
  const runs = options.runs ?? listEvolutionRuns();
  const ledger = options.ledger ?? readEvalLedger();
  const evidenceGroups = groupedByFlowId(evidence);
  const runGroups = runsByFlowId(runs);

  return files.map((file) => {
    const flowId = identifyFlow(file.path).id;
    return {
      file,
      evidence: evidenceGroups.get(flowId) ?? [],
      runs: runGroups.get(flowId) ?? [],
      evaluation: inspectEvaluation(file, ledger),
    };
  });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function evidenceStatus(items: readonly EvidenceEvent[], plan?: EvalSuitePlan) {
  const open = items.filter((item) => item.status === "open");
  const targeted = items.filter((item) => item.status === "targeted");
  const represented = new Set(plan?.cases.flatMap((item) => item.evidence) ?? []);
  const coveredOpen = open.filter((item) => represented.has(item.id));
  const coveredTargeted = targeted.filter((item) => represented.has(item.id));
  const actionable = [...open, ...targeted];
  const coveredActionable = [...coveredOpen, ...coveredTargeted];

  let headline = "No feedback recorded";
  if (items.length > 0) {
    const coverage = open.length > 0
      ? `${coveredOpen.length}/${open.length} open covered`
      : "no open feedback";
    headline = `${plural(open.length, "open item")} · ${plural(targeted.length, "targeted item")} · ${coverage}`;
  }

  return {
    status: {
      open: open.length,
      targeted: targeted.length,
      covered: coveredOpen.length,
      total: items.length,
      headline,
    },
    actionable,
    coveredActionable,
  };
}

function resultCounts(snapshot: EvalSnapshot): Pick<WorkbenchEvalStatus, "passed" | "total"> {
  if (snapshot.entry) {
    return { passed: snapshot.entry.pass, total: snapshot.entry.total };
  }
  if (snapshot.plan) return { passed: 0, total: snapshot.plan.cases.length };
  return {};
}

function evalStatus(snapshot: EvalSnapshot): WorkbenchEvalStatus {
  if (!snapshot.exists) {
    return { state: "missing", current: false, headline: "No eval suite yet" };
  }
  if (snapshot.planError) {
    return {
      state: "unknown",
      current: false,
      headline: `Eval suite cannot be inspected safely: ${snapshot.planError}`,
    };
  }

  const counts = resultCounts(snapshot);
  const entry = snapshot.entry;
  const cases = snapshot.plan?.cases.length ?? entry?.total ?? 0;
  if (!entry) {
    return {
      ...counts,
      state: "unknown",
      current: false,
      headline: `${plural(cases, "eval case")} · no proof recorded`,
    };
  }

  const inconclusive = entry.inconclusive ?? 0;
  const flaky = entry.flaky ?? 0;
  if (snapshot.receiptError) {
    return {
      ...counts,
      state: "unknown",
      current: false,
      headline: `${entry.pass}/${entry.total} last passing · proof freshness unavailable: ${snapshot.receiptError}`,
    };
  }
  if (snapshot.receiptCurrent === false) {
    return {
      ...counts,
      state: "unknown",
      current: false,
      headline: `${entry.pass}/${entry.total} last passing · recorded proof is not current`,
    };
  }
  if (inconclusive > 0 || flaky > 0) {
    const qualifiers = [
      inconclusive > 0 ? plural(inconclusive, "inconclusive case") : "",
      flaky > 0 ? plural(flaky, "flaky case") : "",
    ].filter(Boolean).join(" · ");
    return {
      ...counts,
      state: "unknown",
      current: snapshot.receiptCurrent,
      headline: `${entry.pass}/${entry.total} passing · ${qualifiers}`,
    };
  }
  if (entry.fail > 0) {
    return {
      ...counts,
      state: "failing",
      current: snapshot.receiptCurrent,
      headline: `${entry.pass}/${entry.total} passing · ${plural(entry.fail, "failing case")}`,
    };
  }
  if (entry.currentClean && entry.total > 0 && entry.pass === entry.total) {
    return {
      ...counts,
      state: "passing",
      current: snapshot.receiptCurrent,
      headline: `${entry.pass}/${entry.total} passing${snapshot.receiptCurrent === true ? " · current proof" : " · last clean receipt"}`,
    };
  }
  return {
    ...counts,
    state: "unknown",
    current: snapshot.receiptCurrent,
    headline: `${entry.pass}/${entry.total} passing · proof is incomplete`,
  };
}

function capabilityDelta(diff: CapabilityDiff | undefined): string | undefined {
  if (!diff || (diff.added.length === 0 && diff.removed.length === 0)) return undefined;
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`${diff.safe ? "Added" : "Blocked additions"}: ${diff.added.join(", ")}`);
  }
  if (diff.removed.length > 0) parts.push(`Removed: ${diff.removed.join(", ")}`);
  return parts.join(" · ");
}

function proposalHeadline(status: EvolutionRunStatus, runId: string): string {
  switch (status) {
    case "planned": return `planned · ${runId}`;
    case "drafting": return `drafting · ${runId}`;
    case "proposed": return `proposed · ${runId} · verification pending`;
    case "capability_rejected": return `capability_rejected · ${runId}`;
    case "verifying": return `verifying · ${runId}`;
    case "verified_improvement": return `verified_improvement · ${runId} · targeted feedback improved`;
    case "regression_safe": return `regression_safe · ${runId} · no targeted improvement measured`;
    case "rejected": return `rejected · ${runId}`;
    case "inconclusive": return `inconclusive · ${runId}`;
    case "applying": return `applying · ${runId}`;
    case "applied": return `applied · ${runId}`;
    case "dismissed": return `dismissed · ${runId}`;
    case "rolling_back": return `rolling_back · ${runId}`;
    case "rolled_back": return `rolled_back · ${runId}`;
  }
}

function proposalStatus(runs: readonly EvolutionRunRecord[]): WorkbenchProposalStatus {
  const latest = runs[0];
  const applied = runs.find((run) => run.status === "applied");
  if (!latest) return { state: "none", headline: "No proposal" };
  return {
    state: latest.status,
    runId: latest.id,
    appliedRunId: applied?.id,
    headline: proposalHeadline(latest.status, latest.id),
    capabilityDelta: capabilityDelta(latest.capabilityDiff),
  };
}

function currentFailingCases(snapshot: EvalSnapshot, actionableIds: Set<string>): boolean {
  if (snapshot.receiptCurrent === false || !snapshot.entry || snapshot.entry.fail === 0) return false;
  const failures = snapshot.entry.cases?.filter((item) => item.status === "fail") ?? [];
  return failures.length === snapshot.entry.fail
    && failures.every((item) => item.evidence.some((id) => actionableIds.has(id)));
}

function proposalNext(run: EvolutionRunRecord | undefined): string | undefined {
  if (!run) return undefined;
  switch (run.status) {
    case "planned":
      return `Review plan ${run.id}, then create a proposal when you are ready to spend an engine invocation.`;
    case "drafting":
    case "proposed":
    case "verifying":
      return `Let ${run.id} finish, then review its verification result.`;
    case "verified_improvement":
      return `Review verified_improvement ${run.id}, then apply it if the measured improvement matches your intent.`;
    case "regression_safe":
      return `Review regression_safe ${run.id} carefully: it passed regression checks but did not measure an improvement to targeted feedback.`;
    case "capability_rejected":
      return `Review the blocked capability additions in ${run.id} before drafting another proposal.`;
    case "rejected":
      return `Inspect why ${run.id} regressed behavior, then revise or retry the proposal.`;
    case "inconclusive":
      return `Resolve the inconclusive verification for ${run.id} before applying or retrying.`;
    case "applying":
    case "rolling_back":
      return `Recover or finish the in-progress ${run.status} transaction ${run.id} before continuing.`;
    case "applied":
      return `Keep applied run ${run.id} available for a hash-guarded rollback.`;
    case "dismissed":
    case "rolled_back":
      return undefined;
  }
}

function nextAction(
  snapshot: FlowSnapshot,
  evaluation: WorkbenchEvalStatus,
  actionable: readonly EvidenceEvent[],
  coveredActionable: readonly EvidenceEvent[],
): string {
  const lifecycle = proposalNext(snapshot.runs[0]);
  if (lifecycle) return lifecycle;

  if (actionable.length === 0) return "Run the flow, then open Actions to record anything it misses.";
  if (!snapshot.evaluation.exists) return "Represent actionable feedback with an eval case before proposing.";
  if (snapshot.evaluation.planError) return "Make the eval suite statically inspectable before asking an engine for a proposal.";

  const uncovered = actionable.length - coveredActionable.length;
  if (uncovered > 0) {
    return `Link ${plural(uncovered, "actionable feedback item")} to eval cases before proposing.`;
  }
  if (evaluation.state === "unknown") return "Run the eval suite to establish current proof before proposing.";
  if (evaluation.state === "failing") {
    const actionableIds = new Set(actionable.map((item) => item.id));
    return currentFailingCases(snapshot.evaluation, actionableIds)
      ? "Preview evolution readiness for the feedback-linked failures with md evolve plan."
      : "Review the failing eval cases, then preview evolution readiness with md evolve plan.";
  }
  return "Preview evolution readiness for free with md evolve plan.";
}

function statusFromSnapshot(snapshot: FlowSnapshot): WorkbenchFlowStatus {
  const evidence = evidenceStatus(snapshot.evidence, snapshot.evaluation.plan);
  const evaluation = evalStatus(snapshot.evaluation);
  return {
    evidence: evidence.status,
    eval: evaluation,
    proposal: proposalStatus(snapshot.runs),
    next: nextAction(snapshot, evaluation, evidence.actionable, evidence.coveredActionable),
  };
}

/**
 * Build immediately from evidence, evolution state, a static suite plan, and
 * the last ledger result. No eval suite module is imported or executed.
 */
export function buildWorkbenchStatusMapSync(
  files: readonly AgentFile[],
  options: WorkbenchStatusMapOptions = {},
): WorkbenchStatusMap {
  return Object.fromEntries(readSnapshots(files, options).map((snapshot) => [
    snapshot.file.path,
    statusFromSnapshot(snapshot),
  ]));
}

/**
 * Build statuses with content-bound receipt freshness. This hashes the current
 * flow, config, suite, and statically inspected cases; it never imports or
 * executes eval suite code.
 */
export async function buildWorkbenchStatusMap(
  files: readonly AgentFile[],
  options: WorkbenchStatusMapOptions = {},
): Promise<WorkbenchStatusMap> {
  const snapshots = readSnapshots(files, options);
  await Promise.all(snapshots.map(async (snapshot) => {
    const { evaluation } = snapshot;
    if (!evaluation.plan || !evaluation.entry?.lastRunFingerprint || !evaluation.entry.verification) {
      if (evaluation.entry) evaluation.receiptCurrent = false;
      return;
    }
    try {
      const current = await buildVerificationFingerprint(
        snapshot.file.path,
        evaluation.suitePath,
        evaluation.plan.cases,
      );
      evaluation.receiptCurrent = evaluation.entry.lastRunFingerprint === current.fingerprint
        && evaluation.entry.verification.fingerprint === current.fingerprint;
    } catch (error) {
      evaluation.receiptCurrent = false;
      evaluation.receiptError = errorMessage(error);
    }
  }));

  return Object.fromEntries(snapshots.map((snapshot) => [
    snapshot.file.path,
    statusFromSnapshot(snapshot),
  ]));
}
