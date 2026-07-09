/**
 * Pure-ish domain support for the interactive md Flow Workbench.
 *
 * This module deliberately contains no prompts or terminal rendering. It turns
 * an intent into a previewable flow draft, resolves the project-local flows/
 * target, and applies a draft using create-only writes. The TUI and a future
 * non-interactive CLI can therefore share exactly the same creation contract.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { mdflowVersion, stampCreatedVersion } from "./compat";
import { ensureFlowIdentity } from "./evolution-core";
import {
  PROJECT_CONFIG_NAMES,
  resolveProjectRoot,
  type ProjectRootSource,
} from "./project-root";
import type {
  EvidenceEvent,
  EvidenceStatus,
  EvolutionRunRecord,
  EvolutionRunStatus,
} from "./evolution-store";

const DEFAULT_WORKBENCH_ENGINE = "pi";

export type WorkbenchTargetSource = ProjectRootSource;

export interface WorkbenchTarget {
  projectRoot: string;
  flowsDir: string;
  /** Existing project config, or the .mdflow.yaml path an apply would create. */
  configPath: string;
  existingConfigPath?: string;
  source: WorkbenchTargetSource;
}

export interface DraftFlowOptions {
  slug?: string;
  description?: string;
  body?: string;
  version?: string;
  flowId?: string;
}

export interface FlowDraft {
  intent: string;
  slug: string;
  filename: string;
  description: string;
  markdown: string;
}

export interface ApplyFlowDraftOptions {
  startPath?: string;
  target?: WorkbenchTarget;
  engine?: string;
}

export interface ApplyFlowDraftResult {
  status: "created" | "conflict";
  target: WorkbenchTarget;
  flowPath: string;
  /** Absolute paths created by this call. */
  created: string[];
  /** Absolute support-file paths that already existed and were left untouched. */
  skipped: string[];
}

export type WorkbenchRecommendedAction = "evolve-plan" | "evolve-show" | "evolve-apply" | "none";

export interface WorkbenchLifecycleSummary {
  evidence: Record<EvidenceStatus, number> & { total: number; actionable: number };
  evolution: {
    total: number;
    latestRunId?: string;
    latestStatus?: EvolutionRunStatus;
    active: boolean;
    reviewable: boolean;
  };
  headline: string;
  recommendedAction: WorkbenchRecommendedAction;
}

export interface SummarizeFlowLifecycleInput {
  evidence?: readonly EvidenceEvent[];
  runs?: readonly EvolutionRunRecord[];
  /** When supplied, ignore records belonging to other flows. */
  flowId?: string;
}

function existingProjectConfig(directory: string): string | undefined {
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function targetFor(projectRoot: string, source: WorkbenchTargetSource): WorkbenchTarget {
  const existingConfigPath = existingProjectConfig(projectRoot);
  return {
    projectRoot,
    flowsDir: join(projectRoot, "flows"),
    configPath: existingConfigPath ?? join(projectRoot, ".mdflow.yaml"),
    ...(existingConfigPath ? { existingConfigPath } : {}),
    source,
  };
}

/**
 * Find the nearest mdflow project marker, stopping at the first Git boundary.
 * An uninitialized Git repository targets its root; a non-Git directory
 * targets the directory the caller supplied.
 */
export function resolveWorkbenchTarget(startPath = process.cwd()): WorkbenchTarget {
  const target = resolveProjectRoot(startPath);
  return targetFor(target.projectRoot, target.source);
}

/** Turn free-form intent into a portable, bounded flow filename stem. */
export function slugifyFlowIntent(intent: string): string {
  const normalized = intent
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  const slug = normalized || "new-flow";
  // README.md is the roster file, and common case-insensitive filesystems
  // would consider readme.md the same path.
  return slug === "readme" ? "readme-flow" : slug;
}

function normalizedIntent(intent: string): string {
  const normalized = intent.trim();
  if (!normalized) throw new Error("Flow intent cannot be empty.");
  return normalized;
}

function defaultDescription(intent: string): string {
  const oneLine = intent.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 140) return oneLine;
  const prefix = oneLine.slice(0, 137).replace(/\s+\S*$/, "").trimEnd();
  return `${prefix || oneLine.slice(0, 137)}...`;
}

function validateFlowId(flowId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(flowId)) {
    throw new Error("Flow identity may contain only letters, numbers, underscores, and hyphens.");
  }
}

/**
 * Build a complete, previewable flow without touching disk or invoking an
 * engine. Version and identity injection make this deterministic in tests.
 */
export function draftFlowFromIntent(intent: string, options: DraftFlowOptions = {}): FlowDraft {
  const normalized = normalizedIntent(intent);
  const slug = slugifyFlowIntent(options.slug ?? normalized);
  const description = (options.description ?? defaultDescription(normalized)).replace(/\s+/g, " ").trim();
  if (!description) throw new Error("Flow description cannot be empty.");

  const flowId = options.flowId ?? `flow_${randomUUID().replaceAll("-", "")}`;
  validateFlowId(flowId);
  const body = options.body === undefined ? normalized : options.body.trim();
  const frontmatter = yaml.dump({ description }, { lineWidth: -1, noRefs: true }).trimEnd();
  const base = `---\n${frontmatter}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
  const versioned = stampCreatedVersion(base, options.version ?? mdflowVersion());
  const markdown = ensureFlowIdentity(versioned, flowId);

  return {
    intent: normalized,
    slug,
    filename: `${slug}.md`,
    description,
    markdown,
  };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

/** Write exactly one new file. Existing paths are never truncated. */
function writeExclusive(path: string, content: string): "created" | "exists" {
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "exists";
    throw error;
  }
}

function rosterReadme(): string {
  return `# Flow roster

Flows are reusable AI workflows defined as Markdown and run with
[mdflow](https://mdflow.dev).

- Open the Flow Workbench: \`md\`
- Run a flow directly by its filename stem: \`md <name>\`
- Preview it without an engine invocation: \`md <name> --_dry-run\`
- Record feedback after a run, then press \`i\` for its improvement workspace in \`md\`
`;
}

function projectConfig(engine: string): string {
  const cleanEngine = engine.trim();
  if (!cleanEngine) throw new Error("Project engine cannot be empty.");
  return `# mdflow project config — https://mdflow.dev
# Default engine for engine-neutral flows in this repo.
engine: ${yaml.dump(cleanEngine, { lineWidth: -1 }).trim()}

# Surface evidence after each run; proposals still require explicit review/apply.
evolve:
  mode: suggest
`;
}

/**
 * Add a draft and the minimal project support files. Every write uses `wx`;
 * an existing flow returns a conflict before any support file is considered.
 */
export function applyFlowDraft(
  draft: FlowDraft,
  options: ApplyFlowDraftOptions = {}
): ApplyFlowDraftResult {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug) || draft.filename !== `${draft.slug}.md`) {
    throw new Error(`Invalid flow draft filename: ${draft.filename}`);
  }
  const target = options.target ?? resolveWorkbenchTarget(options.startPath);
  const flowPath = join(target.flowsDir, draft.filename);
  const engine = options.engine ?? DEFAULT_WORKBENCH_ENGINE;
  const configContent = projectConfig(engine); // Validate before the first write.

  if (existsSync(flowPath)) {
    return { status: "conflict", target, flowPath, created: [], skipped: [] };
  }

  mkdirSync(target.flowsDir, { recursive: true });
  if (writeExclusive(flowPath, draft.markdown) === "exists") {
    return { status: "conflict", target, flowPath, created: [], skipped: [] };
  }

  const created = [flowPath];
  const skipped: string[] = [];
  const readmePath = join(target.flowsDir, "README.md");
  if (writeExclusive(readmePath, rosterReadme()) === "created") created.push(readmePath);
  else skipped.push(readmePath);

  // Re-check all supported config names at apply time in case the caller held
  // a previously resolved target while another process initialized the repo.
  const currentConfig = existingProjectConfig(target.projectRoot);
  if (currentConfig) {
    skipped.push(currentConfig);
  } else {
    const configPath = join(target.projectRoot, ".mdflow.yaml");
    if (writeExclusive(configPath, configContent) === "created") created.push(configPath);
    else skipped.push(configPath);
  }

  return { status: "created", target, flowPath, created, skipped };
}

const ACTIVE_EVOLUTION_STATUSES = new Set<EvolutionRunStatus>([
  "planned",
  "drafting",
  "verifying",
  "applying",
  "rolling_back",
]);

const REVIEWABLE_EVOLUTION_STATUSES = new Set<EvolutionRunStatus>([
  "proposed",
  "capability_rejected",
  "verified_improvement",
  "regression_safe",
  "rejected",
  "inconclusive",
]);

function evolutionLabel(status: EvolutionRunStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (status === "verified_improvement") return "verified improvement ready";
  if (status === "regression_safe") return "regression-safe proposal ready";
  return status.replaceAll("_", " ");
}

/** Summarize durable evidence/evolution records for one compact TUI status. */
export function summarizeFlowLifecycle(input: SummarizeFlowLifecycleInput): WorkbenchLifecycleSummary {
  const evidence = (input.evidence ?? []).filter((item) => !input.flowId || item.flowId === input.flowId);
  const runs = (input.runs ?? [])
    .filter((item) => !input.flowId || item.flow.id === input.flowId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const counts: WorkbenchLifecycleSummary["evidence"] = {
    open: 0,
    targeted: 0,
    resolved: 0,
    dismissed: 0,
    total: evidence.length,
    actionable: 0,
  };
  for (const item of evidence) counts[item.status]++;
  counts.actionable = counts.open + counts.targeted;

  const latest = runs[0];
  const active = latest ? ACTIVE_EVOLUTION_STATUSES.has(latest.status) : false;
  const reviewable = latest ? REVIEWABLE_EVOLUTION_STATUSES.has(latest.status) : false;
  let recommendedAction: WorkbenchRecommendedAction = "none";
  if (latest?.status === "verified_improvement" || latest?.status === "regression_safe") {
    recommendedAction = "evolve-apply";
  } else if (latest && (active || reviewable)) {
    recommendedAction = "evolve-show";
  } else if (counts.actionable > 0) {
    recommendedAction = "evolve-plan";
  }

  const headlineParts: string[] = [];
  if (counts.open > 0) headlineParts.push(`${counts.open} open feedback`);
  if (counts.targeted > 0) headlineParts.push(`${counts.targeted} targeted`);
  const statusLabel = evolutionLabel(latest?.status);
  if (statusLabel) headlineParts.push(statusLabel);

  return {
    evidence: counts,
    evolution: {
      total: runs.length,
      ...(latest ? { latestRunId: latest.id, latestStatus: latest.status } : {}),
      active,
      reviewable,
    },
    headline: headlineParts.join(" · ") || "No feedback or proposals yet",
    recommendedAction,
  };
}
