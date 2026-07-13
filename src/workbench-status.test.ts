import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentFile } from "./cli";
import {
  buildVerificationFingerprint,
  inspectEvalSuitePlan,
  recordEvalResult,
} from "./evals";
import { identifyFlow } from "./evolution-core";
import {
  recordEvidence,
  type EvolutionRunRecord,
  type EvolutionRunStatus,
} from "./evolution-store";
import {
  buildWorkbenchStatusMap,
  buildWorkbenchStatusMapSync,
} from "./workbench-status";

let root: string;
let repo: string;
let state: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["MDFLOW_EVOLUTION_HOME", "MDFLOW_EVIDENCE_FILE", "MDFLOW_EVAL_RESULTS"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mdflow-workbench-status-"));
  repo = join(root, "repo");
  state = join(root, "state");
  mkdirSync(repo, { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MDFLOW_EVOLUTION_HOME = state;
  process.env.MDFLOW_EVIDENCE_FILE = join(state, "evidence.jsonl");
  process.env.MDFLOW_EVAL_RESULTS = join(state, "eval-results.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function writeFlow(name = "review", body = "Review the change.\n"): AgentFile {
  const path = join(repo, `${name}.md`);
  writeFileSync(path, `---\ndescription: Review changes\nengine: codex\n---\n${body}`);
  return { name, path, source: "project", description: "Review changes" };
}

function writeSuite(file: AgentFile, evidence: string[] = []): string {
  const path = file.path.replace(/\.md$/, ".eval.ts");
  writeFileSync(path, `
globalThis.__mdflowWorkbenchSuiteExecuted = true;
export default [{
  name: "reviews safely",
  evidence: ${JSON.stringify(evidence)},
  check: () => null,
}];
`);
  return path;
}

function runFixture(
  file: AgentFile,
  id: string,
  status: EvolutionRunStatus,
  createdAt: string,
  patch: Partial<EvolutionRunRecord> = {},
): EvolutionRunRecord {
  return {
    schemaVersion: 1,
    id,
    flow: identifyFlow(file.path),
    suitePath: file.path.replace(/\.md$/, ".eval.ts"),
    status,
    createdAt,
    updatedAt: createdAt,
    currentHash: "current",
    evidenceIds: [],
    targetEvidenceIds: [],
    plannedInvocations: 3,
    actualInvocations: 3,
    ...patch,
  };
}

describe("workbench lifecycle status", () => {
  it("counts open and targeted evidence while keeping covered scoped to open feedback", () => {
    const file = writeFlow();
    recordEvidence({ flowPath: file.path, type: "explicit_feedback", confidence: "high", message: "open", status: "open" });
    recordEvidence({ flowPath: file.path, type: "manual_note", confidence: "medium", message: "targeted", status: "targeted" });
    recordEvidence({ flowPath: file.path, type: "manual_note", confidence: "medium", message: "resolved", status: "resolved" });

    const status = buildWorkbenchStatusMapSync([file])[file.path]!;
    expect(status.evidence).toMatchObject({ open: 1, targeted: 1, covered: 0, total: 3 });
    expect(status.eval).toMatchObject({ state: "missing", current: false });
    expect(status.proposal?.state).toBe("none");
    expect(status.next).toContain("Represent actionable feedback with an eval case");
  });

  it("inspects coverage and case counts without executing eval suite top-level code", () => {
    const file = writeFlow();
    const feedback = recordEvidence({
      flowPath: file.path,
      type: "explicit_feedback",
      confidence: "high",
      message: "missed a rollback risk",
    });
    writeSuite(file, [feedback.id]);
    delete (globalThis as Record<string, unknown>).__mdflowWorkbenchSuiteExecuted;

    const status = buildWorkbenchStatusMapSync([file])[file.path]!;
    expect((globalThis as Record<string, unknown>).__mdflowWorkbenchSuiteExecuted).toBeUndefined();
    expect(status.evidence).toMatchObject({ open: 1, covered: 1, targeted: 0 });
    expect(status.eval).toMatchObject({ state: "unknown", passed: 0, total: 1, current: false });
    expect(status.next).toContain("establish current proof");
  });

  it("uses content-bound freshness asynchronously and reports passing, stale, and failing receipts", async () => {
    const file = writeFlow();
    const suite = writeSuite(file);
    const plan = inspectEvalSuitePlan(suite);
    const firstVerification = await buildVerificationFingerprint(file.path, suite, plan.cases);
    recordEvalResult(suite, {
      flow: file.path,
      pass: 1,
      fail: 0,
      total: 1,
      lastRunAt: "2026-07-09T10:00:00.000Z",
      full: true,
      currentClean: true,
      verification: firstVerification,
      lastRunFingerprint: firstVerification.fingerprint,
      inconclusive: 0,
      flaky: 0,
      cases: [],
    });

    let status = (await buildWorkbenchStatusMap([file]))[file.path]!;
    expect(status.eval).toMatchObject({ state: "passing", passed: 1, total: 1, current: true });

    writeFileSync(file.path, "---\ndescription: changed\nengine: codex\n---\nChanged body.\n");
    status = (await buildWorkbenchStatusMap([file]))[file.path]!;
    expect(status.eval).toMatchObject({
      state: "unknown",
      passed: 1,
      total: 1,
      current: false,
      verdict: "Stale",
    });
    expect(status.eval?.headline).toContain("changed");

    const failingVerification = await buildVerificationFingerprint(file.path, suite, plan.cases);
    recordEvalResult(suite, {
      flow: file.path,
      pass: 0,
      fail: 1,
      total: 1,
      lastRunAt: "2026-07-09T11:00:00.000Z",
      full: true,
      currentClean: false,
      verification: failingVerification,
      lastRunFingerprint: failingVerification.fingerprint,
      inconclusive: 0,
      flaky: 0,
      cases: [],
    });
    status = (await buildWorkbenchStatusMap([file]))[file.path]!;
    expect(status.eval).toMatchObject({ state: "failing", passed: 0, total: 1, current: true });
  });

  it("static draft metadata can never render Verified", async () => {
    const file = writeFlow();
    // Hand-written draft suite: the ONLY draft signal is the static
    // `draft: true` case metadata — no MDFLOW_DRAFT_CASE sentinel anywhere.
    const suite = file.path.replace(/\.md$/, ".eval.ts");
    writeFileSync(suite, `
export default [{
  name: "draft",
  draft: true,
  check: () => null,
}];
`);
    // A clean, full, fingerprint-bound receipt exists (e.g. someone called
    // the exported runEvalSuite directly). Without the draft fact this would
    // classify Verified — a false green.
    const plan = inspectEvalSuitePlan(suite);
    const verification = await buildVerificationFingerprint(file.path, suite, plan.cases);
    recordEvalResult(suite, {
      flow: file.path,
      pass: 1,
      fail: 0,
      total: 1,
      lastRunAt: "2026-07-11T10:00:00.000Z",
      full: true,
      currentClean: true,
      verification,
      lastRunFingerprint: verification.fingerprint,
      inconclusive: 0,
      flaky: 0,
      cases: [],
    });

    const syncStatus = buildWorkbenchStatusMapSync([file])[file.path]!;
    expect(syncStatus.eval).toMatchObject({
      state: "unknown",
      current: false,
      verdict: "Unverified",
    });
    expect(syncStatus.eval?.verdictReason).toContain("draft");

    const status = (await buildWorkbenchStatusMap([file]))[file.path]!;
    expect(status.eval?.state).not.toBe("passing");
    expect(status.eval?.verdict).not.toBe("Verified");
    expect(status.eval).toMatchObject({
      state: "unknown",
      current: false,
      verdict: "Unverified",
    });
    expect(status.eval?.verdictReason).toContain("draft");
  });

  it("keeps verified_improvement distinct from regression_safe and exposes run IDs and capability deltas", () => {
    const file = writeFlow();
    const applied = runFixture(file, "evr_applied", "applied", "2026-07-09T09:00:00.000Z");
    const regressionSafe = runFixture(file, "evr_safe", "regression_safe", "2026-07-09T10:00:00.000Z", {
      capabilityDiff: {
        added: ["command:git status"],
        removed: ["file:local:old.md"],
        safe: false,
      },
    });

    let status = buildWorkbenchStatusMapSync([file], {
      evidence: [],
      runs: [applied, regressionSafe],
      ledger: {},
    })[file.path]!;
    expect(status.proposal).toMatchObject({
      state: "regression_safe",
      runId: "evr_safe",
      appliedRunId: "evr_applied",
    });
    expect(status.proposal?.headline).toContain("no targeted improvement measured");
    expect(status.proposal?.capabilityDelta).toContain("Blocked additions: command:git status");
    expect(status.next).toContain("did not measure an improvement");

    const improved = runFixture(file, "evr_improved", "verified_improvement", "2026-07-09T11:00:00.000Z");
    status = buildWorkbenchStatusMapSync([file], {
      evidence: [],
      runs: [improved],
      ledger: {},
    })[file.path]!;
    expect(status.proposal?.state).toBe("verified_improvement");
    expect(status.proposal?.headline).toContain("targeted feedback improved");
    expect(status.next).toContain("measured improvement");
  });
});
