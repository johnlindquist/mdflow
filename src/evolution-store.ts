import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalFlowPath, identifyFlow, sha256, type CapabilityDiff, type FlowIdentity } from "./evolution-core";

export type EvidenceType = "explicit_feedback" | "run_failure" | "quick_rerun" | "manual_note";
export type EvidenceConfidence = "high" | "medium" | "low";
export type EvidenceStatus = "open" | "targeted" | "resolved" | "dismissed";

export interface EvidenceEvent {
  id: string;
  flowId: string;
  flowPath: string;
  flowHash?: string;
  type: EvidenceType;
  confidence: EvidenceConfidence;
  message: string;
  timestamp: string;
  runId?: string;
  inputHash?: string;
  failureClass?: "behavior" | "provider" | "auth" | "timeout" | "environment" | "cancelled" | "unknown";
  redactedOutputRef?: string;
  status: EvidenceStatus;
}

interface EvidenceLogCreate {
  kind: "evidence";
  event: EvidenceEvent;
}

interface EvidenceLogStatus {
  kind: "status";
  id: string;
  status: EvidenceStatus;
  timestamp: string;
  runId?: string;
}

type EvidenceLogRecord = EvidenceLogCreate | EvidenceLogStatus;

export type EvolutionRunStatus =
  | "planned"
  | "drafting"
  | "proposed"
  | "capability_rejected"
  | "verifying"
  | "verified_improvement"
  | "regression_safe"
  | "rejected"
  | "inconclusive"
  | "applying"
  | "applied"
  | "dismissed"
  | "rolling_back"
  | "rolled_back";

export interface EvolutionRunRecord {
  schemaVersion: 1;
  id: string;
  flow: FlowIdentity;
  suitePath: string;
  status: EvolutionRunStatus;
  createdAt: string;
  updatedAt: string;
  currentHash: string;
  proposalHash?: string;
  evidenceIds: string[];
  targetEvidenceIds: string[];
  maintainer?: { engine: string; model?: string; source?: string; isolated?: boolean };
  plannedInvocations: number;
  actualInvocations: number;
  capabilityDiff?: CapabilityDiff;
  resultReason?: string;
  appliedAt?: string;
  rolledBackAt?: string;
}

export interface EvolutionRunEvent {
  runId: string;
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface EvolutionQueueJob {
  schemaVersion: 1;
  id: string;
  flow: FlowIdentity;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  logPath: string;
  runId?: string;
  pid?: number;
  exitCode?: number;
  error?: string;
}

function evolutionHome(): string {
  const override = process.env.MDFLOW_EVOLUTION_HOME?.trim();
  return override ? resolve(override) : join(homedir(), ".mdflow", "evolution");
}

export function evidenceFilePath(): string {
  const legacy = process.env.MDFLOW_COMPLAINTS_FILE?.trim();
  const override = process.env.MDFLOW_EVIDENCE_FILE?.trim();
  return resolve(override || legacy || join(evolutionHome(), "evidence.jsonl"));
}

export function evolutionRunsPath(): string {
  return join(evolutionHome(), "runs");
}

export function feedbackDraftPath(evidenceId: string): string {
  if (!/^fb_[A-Za-z0-9_-]+$/.test(evidenceId)) throw new Error(`Invalid feedback id: ${evidenceId}`);
  return join(evolutionHome(), "drafts", `${evidenceId}.eval-case.ts`);
}

export function evolutionJobsPath(): string {
  return join(evolutionHome(), "jobs");
}

export function evolutionJobPath(jobId: string): string {
  if (!/^evj_[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Invalid evolution job id: ${jobId}`);
  return join(evolutionJobsPath(), `${jobId}.json`);
}

export function createEvolutionJob(flowPath: string): EvolutionQueueJob {
  const id = `evj_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const job: EvolutionQueueJob = {
    schemaVersion: 1,
    id,
    flow: identifyFlow(flowPath),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    logPath: join(evolutionJobsPath(), `${id}.log`),
  };
  mkdirSync(evolutionJobsPath(), { recursive: true, mode: 0o700 });
  atomicWriteJson(evolutionJobPath(id), job);
  return job;
}

export function readEvolutionJob(jobId: string): EvolutionQueueJob {
  try {
    return JSON.parse(readFileSync(evolutionJobPath(jobId), "utf8")) as EvolutionQueueJob;
  } catch (error) {
    throw new Error(`Evolution job not found or unreadable: ${jobId}`, { cause: error });
  }
}

export function updateEvolutionJob(jobId: string, patch: Partial<Omit<EvolutionQueueJob, "id" | "schemaVersion" | "createdAt" | "flow">>): EvolutionQueueJob {
  const job = readEvolutionJob(jobId);
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  atomicWriteJson(evolutionJobPath(jobId), next);
  return next;
}

export function activeEvolutionJob(flowPath: string): EvolutionQueueJob | undefined {
  const root = evolutionJobsPath();
  if (!existsSync(root)) return undefined;
  const flowId = identifyFlow(flowPath).id;
  const jobs: EvolutionQueueJob[] = [];
  for (const path of new Bun.Glob("evj_*.json").scanSync({ cwd: root, absolute: true })) {
    try {
      const job = JSON.parse(readFileSync(path, "utf8")) as EvolutionQueueJob;
      if (job.flow.id !== flowId || (job.status !== "queued" && job.status !== "running")) continue;
      const age = Date.now() - Date.parse(job.updatedAt);
      let alive = false;
      if (job.pid) {
        try { process.kill(job.pid, 0); alive = true; } catch {}
      }
      if (!alive && age > 60 * 60 * 1000) {
        updateEvolutionJob(job.id, { status: "failed", error: "stale background job recovered after one hour" });
        continue;
      }
      jobs.push(job);
    } catch {}
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function evolutionRunPath(runId: string): string {
  if (!/^evr_[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid evolution run id: ${runId}`);
  return join(evolutionRunsPath(), runId);
}

export function atomicWriteFile(path: string, content: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", mode ?? 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, path);
  try {
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Some filesystems do not support fsync on directories.
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function withAtomicFileLock<T>(targetPath: string, fn: () => T, staleAfterMs = 60_000): T {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const acquire = () => openSync(lockPath, "wx", 0o600);
  let fd: number;
  try {
    fd = acquire();
  } catch {
    // The lock exists. A contender may observe it BETWEEN the owner's
    // open("wx") and its metadata write, so an empty/unparseable lock file
    // is NOT evidence of staleness — only age is. A fresh lock whose
    // metadata cannot be read yet is busy, never stale.
    let stale = false;
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // Lock vanished between open and stat: the owner finished. Retry once.
    }
    try {
      const value = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; createdAt?: string };
      // A malformed createdAt parses to NaN, and NaN would poison the
      // staleness math below (NaN > staleAfterMs is false forever). Treat any
      // non-finite claimed timestamp as absent and trust the file's mtime.
      const claimedCreatedAt = value.createdAt ? Date.parse(value.createdAt) : Number.NaN;
      const claimedAge = Number.isFinite(claimedCreatedAt) ? Date.now() - claimedCreatedAt : age;
      let alive = false;
      if (value.pid) {
        try { process.kill(value.pid, 0); alive = true; } catch {}
      }
      stale = !alive && Math.min(age, claimedAge) > staleAfterMs;
    } catch {
      // Unreadable metadata: trust the file's own age only.
      stale = age > staleAfterMs;
    }
    if (!stale) throw new Error(`State file is busy: ${targetPath}`);
    rmSync(lockPath, { force: true });
    try {
      fd = acquire();
    } catch {
      // Another contender won the takeover race — the lock is busy again.
      throw new Error(`State file is busy: ${targetPath}`);
    }
  }
  const token = randomUUID();
  let closed = false;
  let tokenWritten = false;
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), targetPath })}\n`);
    tokenWritten = true;
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    return fn();
  } finally {
    if (!closed) try { closeSync(fd); } catch {}
    if (!tokenWritten) {
      // The metadata write failed before the token landed on disk, so the
      // zero-byte lock created by our own open("wx") is still ours to remove.
      rmSync(lockPath, { force: true });
    } else {
      // Only release a lock we still own. While fn() ran, another actor may
      // have removed our lock (e.g. via stale takeover) and installed its own;
      // unconditionally unlinking would delete THAT owner's lock and let
      // concurrent writers into the critical section. Unreadable or missing
      // lock files are treated as "not ours — do not unlink".
      let owned = false;
      try {
        const value = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
        owned = value.token === token;
      } catch {}
      if (owned) rmSync(lockPath, { force: true });
    }
  }
}

function appendJsonl(path: string, value: unknown): void {
  withAtomicFileLock(path, () => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  });
}

export function recordEvidence(input: Omit<EvidenceEvent, "id" | "flowId" | "flowPath" | "timestamp" | "status"> & {
  flowPath: string;
  status?: EvidenceStatus;
}): EvidenceEvent {
  const message = input.message.trim();
  if (!message) throw new Error("Feedback message cannot be empty.");
  if (Buffer.byteLength(message, "utf8") > 4_000) {
    throw new Error("Feedback message exceeds the 4,000-byte privacy and prompt-safety limit.");
  }
  const flow = identifyFlow(input.flowPath);
  const event: EvidenceEvent = {
    ...input,
    message,
    id: `fb_${randomUUID().replaceAll("-", "")}`,
    flowId: flow.id,
    flowPath: flow.path,
    timestamp: new Date().toISOString(),
    status: input.status ?? "open",
  };
  appendJsonl(evidenceFilePath(), { kind: "evidence", event } satisfies EvidenceLogCreate);
  return event;
}

function legacyEvidence(value: Record<string, unknown>): EvidenceEvent | undefined {
  if (typeof value.agentPath !== "string" || typeof value.message !== "string" || typeof value.timestamp !== "string") return undefined;
  const flow = identifyFlow(value.agentPath);
  return {
    id: `fb_legacy_${sha256(JSON.stringify(value)).slice(0, 16)}`,
    flowId: flow.id,
    flowPath: flow.path,
    type: "explicit_feedback",
    confidence: "high",
    message: value.message,
    timestamp: value.timestamp,
    status: "open",
  };
}

export function readEvidence(path = evidenceFilePath()): EvidenceEvent[] {
  if (!existsSync(path)) return [];
  const events = new Map<string, EvidenceEvent>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as EvidenceLogRecord | Record<string, unknown>;
      if ((value as EvidenceLogCreate).kind === "evidence") {
        const event = (value as EvidenceLogCreate).event;
        if (event && typeof event.id === "string") events.set(event.id, event);
      } else if ((value as EvidenceLogStatus).kind === "status") {
        const update = value as EvidenceLogStatus;
        const current = events.get(update.id);
        if (current) events.set(update.id, { ...current, status: update.status, runId: update.runId ?? current.runId });
      } else {
        const migrated = legacyEvidence(value as Record<string, unknown>);
        if (migrated) events.set(migrated.id, migrated);
      }
    } catch {
      // Preserve availability when one line is damaged.
    }
  }
  return [...events.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function updateEvidenceStatus(id: string, status: EvidenceStatus, runId?: string): EvidenceEvent {
  const current = readEvidence().find((item) => item.id === id);
  if (!current) throw new Error(`Evidence not found: ${id}`);
  appendJsonl(evidenceFilePath(), { kind: "status", id, status, runId, timestamp: new Date().toISOString() } satisfies EvidenceLogStatus);
  return { ...current, status, runId: runId ?? current.runId };
}

/** Explicit privacy escape hatch. Normal lifecycle updates stay append-only. */
export function forgetEvidence(id: string): EvidenceEvent {
  const path = evidenceFilePath();
  const current = readEvidence(path).find((item) => item.id === id);
  if (!current) throw new Error(`Evidence not found: ${id}`);
  withAtomicFileLock(path, () => {
    const kept = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => {
      if (!line.trim()) return false;
      try {
        const value = JSON.parse(line) as EvidenceLogRecord | Record<string, unknown>;
        if ((value as EvidenceLogCreate).kind === "evidence") return (value as EvidenceLogCreate).event.id !== id;
        if ((value as EvidenceLogStatus).kind === "status") return (value as EvidenceLogStatus).id !== id;
        return `fb_legacy_${sha256(JSON.stringify(value)).slice(0, 16)}` !== id;
      } catch {
        return true;
      }
    });
    atomicWriteFile(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", 0o600);
  });
  rmSync(feedbackDraftPath(id), { force: true });
  const runsRoot = evolutionRunsPath();
  if (existsSync(runsRoot)) {
    for (const statePath of new Bun.Glob("evr_*/state.json").scanSync({ cwd: runsRoot, absolute: true })) {
      try {
        const run = JSON.parse(readFileSync(statePath, "utf8")) as EvolutionRunRecord;
        if (run.evidenceIds.includes(id)) rmSync(dirname(statePath), { recursive: true, force: true });
      } catch {}
    }
  }
  const jobsRoot = evolutionJobsPath();
  if (existsSync(jobsRoot)) {
    for (const logPath of new Bun.Glob("evj_*.log").scanSync({ cwd: jobsRoot, absolute: true })) {
      try {
        const log = readFileSync(logPath, "utf8");
        if (log.includes(id) || log.includes(current.message)) rmSync(logPath, { force: true });
      } catch {}
    }
  }
  return current;
}

export function createEvolutionRun(input: Omit<EvolutionRunRecord, "schemaVersion" | "id" | "createdAt" | "updatedAt">): EvolutionRunRecord {
  const id = `evr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const record: EvolutionRunRecord = { ...input, schemaVersion: 1, id, createdAt: now, updatedAt: now };
  const dir = evolutionRunPath(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteJson(join(dir, "state.json"), record);
  appendEvolutionEvent({ runId: id, type: "planned", timestamp: now });
  return record;
}

export function readEvolutionRun(runId: string): EvolutionRunRecord {
  const path = join(evolutionRunPath(runId), "state.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EvolutionRunRecord;
  } catch (error) {
    throw new Error(`Evolution run not found or unreadable: ${runId}`, { cause: error });
  }
}

export function updateEvolutionRun(runId: string, patch: Partial<Omit<EvolutionRunRecord, "id" | "schemaVersion" | "createdAt">>): EvolutionRunRecord {
  const current = readEvolutionRun(runId);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  atomicWriteJson(join(evolutionRunPath(runId), "state.json"), next);
  if (patch.status && patch.status !== current.status) {
    appendEvolutionEvent({ runId, type: patch.status, timestamp: next.updatedAt, data: patch.resultReason ? { reason: patch.resultReason } : undefined });
  }
  return next;
}

export function appendEvolutionEvent(event: EvolutionRunEvent): void {
  appendJsonl(join(evolutionRunPath(event.runId), "events.jsonl"), event);
}

export function writeEvolutionArtifact(runId: string, name: string, content: string | Uint8Array | unknown): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Invalid evolution artifact name: ${name}`);
  const path = join(evolutionRunPath(runId), name);
  if (existsSync(path)) throw new Error(`Evolution artifact is immutable and already exists: ${name}`);
  if (typeof content === "string" || content instanceof Uint8Array) atomicWriteFile(path, content);
  else atomicWriteJson(path, content);
  return path;
}

export function readEvolutionArtifact(runId: string, name: string): string {
  return readFileSync(join(evolutionRunPath(runId), name), "utf8");
}

export function listEvolutionRuns(flowPath?: string): EvolutionRunRecord[] {
  const root = evolutionRunsPath();
  if (!existsSync(root)) return [];
  const wanted = flowPath ? identifyFlow(flowPath).id : undefined;
  const glob = new Bun.Glob("evr_*/state.json");
  const records: EvolutionRunRecord[] = [];
  for (const file of glob.scanSync({ cwd: root, absolute: true })) {
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as EvolutionRunRecord;
      if (!wanted || record.flow.id === wanted) records.push(record);
    } catch {}
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pruneEvolutionData(olderThanMs: number, now = Date.now()): { runs: number; jobs: number } {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw new Error("Retention age must be a nonnegative number.");
  let runs = 0;
  const runRoot = evolutionRunsPath();
  if (existsSync(runRoot)) {
    for (const statePath of new Bun.Glob("evr_*/state.json").scanSync({ cwd: runRoot, absolute: true })) {
      try {
        const run = JSON.parse(readFileSync(statePath, "utf8")) as EvolutionRunRecord;
        const protectedState = run.status === "applied" || run.status === "applying" || run.status === "rolling_back";
        if (!protectedState && now - Date.parse(run.updatedAt) >= olderThanMs) {
          for (const id of run.evidenceIds) {
            try { updateEvidenceStatus(id, "open", run.id); } catch {}
          }
          rmSync(dirname(statePath), { recursive: true, force: true });
          runs++;
        }
      } catch {}
    }
  }

  let jobs = 0;
  const jobRoot = evolutionJobsPath();
  if (existsSync(jobRoot)) {
    for (const statePath of new Bun.Glob("evj_*.json").scanSync({ cwd: jobRoot, absolute: true })) {
      try {
        const job = JSON.parse(readFileSync(statePath, "utf8")) as EvolutionQueueJob;
        if ((job.status === "completed" || job.status === "failed") && now - Date.parse(job.updatedAt) >= olderThanMs) {
          rmSync(statePath, { force: true });
          rmSync(job.logPath, { force: true });
          jobs++;
        }
      } catch {}
    }
  }
  return { runs, jobs };
}

export interface FlowLock {
  path: string;
  release(): void;
}

export function acquireFlowLock(flowPath: string, staleAfterMs = 60 * 60 * 1000): FlowLock {
  const flow = identifyFlow(flowPath);
  const path = join(evolutionHome(), "locks", `${flow.id}.lock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tryAcquire = (): number => openSync(path, "wx", 0o600);
  let fd: number;
  try {
    fd = tryAcquire();
  } catch {
    let stale = false;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; createdAt?: string };
      const age = value.createdAt ? Date.now() - Date.parse(value.createdAt) : Number.POSITIVE_INFINITY;
      let alive = false;
      if (typeof value.pid === "number") {
        try { process.kill(value.pid, 0); alive = true; } catch {}
      }
      stale = !alive && age > staleAfterMs;
    } catch {
      stale = true;
    }
    if (!stale) throw new Error(`Evolution already running for ${flow.relativePath}`);
    rmSync(path, { force: true });
    fd = tryAcquire();
  }
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), flow })}\n`);
  fsyncSync(fd);
  closeSync(fd);
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      rmSync(path, { force: true });
    },
  };
}

export async function applyEvolutionRun(runId: string): Promise<EvolutionRunRecord> {
  const run = recoverEvolutionRun(runId);
  if (run.status === "applied") return run;
  if (run.status !== "verified_improvement" && run.status !== "regression_safe") {
    throw new Error(`Run ${runId} is not applyable (status: ${run.status}).`);
  }
  const lock = acquireFlowLock(run.flow.path);
  let wroteProposal = false;
  try {
    const plan = JSON.parse(readEvolutionArtifact(runId, "plan.json")) as {
      verification?: {
        flowHash: string;
        suiteHash: string;
        configHash: string;
        mdflowVersion: string;
        engine: string;
        engineSource: string;
        model?: string;
      };
    };
    if (!plan.verification) throw new Error("Run has no content-bound verification receipt.");
    const { buildVerificationEnvironmentFingerprint } = await import("./evals");
    const currentVerification = await buildVerificationEnvironmentFingerprint(run.flow.path, run.suitePath);
    const expected = plan.verification;
    const changed = (["flowHash", "suiteHash", "configHash", "mdflowVersion", "engine", "engineSource", "model"] as const)
      .filter((key) => currentVerification[key] !== expected[key]);
    if (changed.length > 0) {
      throw new Error(`Verification inputs changed after the proposal was created (${changed.join(", ")}). Re-run evolution.`);
    }
    const current = readFileSync(run.flow.path, "utf8");
    if (sha256(current) !== run.currentHash) {
      throw new Error("Flow changed after the proposal was created. Refusing to overwrite it.");
    }
    const proposal = readEvolutionArtifact(runId, "proposal.md");
    const mode = statSync(run.flow.path).mode & 0o777;
    updateEvolutionRun(runId, { status: "applying", resultReason: "atomic apply in progress" });
    atomicWriteFile(run.flow.path, proposal, mode);
    wroteProposal = true;
    for (const id of run.evidenceIds) updateEvidenceStatus(id, "resolved", runId);
    return updateEvolutionRun(runId, { status: "applied", appliedAt: new Date().toISOString(), resultReason: run.resultReason });
  } catch (error) {
    if (wroteProposal) {
      try {
        const original = readEvolutionArtifact(runId, "current.md");
        const mode = statSync(run.flow.path).mode & 0o777;
        atomicWriteFile(run.flow.path, original, mode);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Apply failed and rollback also failed for ${runId}`);
      }
    }
    for (const id of run.evidenceIds) {
      try { updateEvidenceStatus(id, "open", runId); } catch {}
    }
    try { updateEvolutionRun(runId, { status: run.status, resultReason: `apply failed: ${error instanceof Error ? error.message : String(error)}` }); } catch {}
    throw error;
  } finally {
    lock.release();
  }
}

export function rollbackEvolutionRun(runId: string): EvolutionRunRecord {
  const run = recoverEvolutionRun(runId);
  if (run.status === "rolled_back") return run;
  if (run.status !== "applied" || !run.proposalHash) throw new Error(`Run ${runId} is not currently applied.`);
  const lock = acquireFlowLock(run.flow.path);
  let wroteOriginal = false;
  try {
    const current = readFileSync(run.flow.path, "utf8");
    if (sha256(current) !== run.proposalHash) {
      throw new Error("Flow changed after application. Refusing to overwrite newer edits.");
    }
    const original = readEvolutionArtifact(runId, "current.md");
    const mode = statSync(run.flow.path).mode & 0o777;
    updateEvolutionRun(runId, { status: "rolling_back", resultReason: "atomic rollback in progress" });
    atomicWriteFile(run.flow.path, original, mode);
    wroteOriginal = true;
    for (const id of run.evidenceIds) updateEvidenceStatus(id, "open", runId);
    return updateEvolutionRun(runId, { status: "rolled_back", rolledBackAt: new Date().toISOString() });
  } catch (error) {
    if (wroteOriginal) {
      try {
        const proposal = readEvolutionArtifact(runId, "proposal.md");
        const mode = statSync(run.flow.path).mode & 0o777;
        atomicWriteFile(run.flow.path, proposal, mode);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `Rollback failed and proposal restore also failed for ${runId}`);
      }
    }
    try { updateEvolutionRun(runId, { status: "applied", resultReason: `rollback failed: ${error instanceof Error ? error.message : String(error)}` }); } catch {}
    throw error;
  } finally {
    lock.release();
  }
}

export function currentFlowHash(path: string): string {
  return sha256(readFileSync(canonicalFlowPath(path)));
}

/** Resolve a crash-interrupted apply/rollback from hashes, never guess from a backup filename. */
export function recoverEvolutionRun(runId: string): EvolutionRunRecord {
  const run = readEvolutionRun(runId);
  if (run.status !== "applying" && run.status !== "rolling_back") return run;
  const currentHash = currentFlowHash(run.flow.path);
  if (run.status === "applying") {
    if (run.proposalHash && currentHash === run.proposalHash) {
      for (const id of run.evidenceIds) {
        try { updateEvidenceStatus(id, "resolved", runId); } catch {}
      }
      return updateEvolutionRun(runId, { status: "applied", appliedAt: new Date().toISOString(), resultReason: "recovered completed apply from content hash" });
    }
    if (currentHash === run.currentHash) {
      return updateEvolutionRun(runId, {
        status: run.targetEvidenceIds.length > 0 ? "verified_improvement" : "regression_safe",
        resultReason: "recovered interrupted apply before source commit",
      });
    }
  } else {
    if (currentHash === run.currentHash) {
      for (const id of run.evidenceIds) {
        try { updateEvidenceStatus(id, "open", runId); } catch {}
      }
      return updateEvolutionRun(runId, { status: "rolled_back", rolledBackAt: new Date().toISOString(), resultReason: "recovered completed rollback from content hash" });
    }
    if (run.proposalHash && currentHash === run.proposalHash) {
      return updateEvolutionRun(runId, { status: "applied", resultReason: "recovered interrupted rollback before source commit" });
    }
  }
  return updateEvolutionRun(runId, { status: "inconclusive", resultReason: "source hash conflicts with interrupted transaction; manual review required" });
}
