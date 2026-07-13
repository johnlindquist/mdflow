/**
 * Pure-ish domain support for the interactive md Flow Workbench.
 *
 * This module deliberately contains no prompts or terminal rendering. It turns
 * an intent into a previewable flow draft, resolves the project-local flows/
 * target, and applies a draft using create-only writes. The TUI and a future
 * non-interactive CLI can therefore share exactly the same creation contract.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { getRegisteredAdapters } from "./adapters/index";
import { mdflowVersion, stampCreatedVersion } from "./compat";
import { inferEvalRecipes, renderEvalTemplate } from "./eval-convention";
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
  /** Persist an engine choice in the flow's own frontmatter. */
  engine?: string;
  /** Model passed to the engine as --model. */
  model?: string;
  /** Reasoning effort, translated per engine — requires `engine`. */
  effort?: string;
  /** CLI/API/doc references preloaded into the flow body (see docReferenceLine). */
  docs?: readonly string[];
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
  /** Scaffold the paired draft eval suite (default true). */
  withEval?: boolean;
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

/** Words that add nothing to a filename derived from a sentence of intent. */
const SLUG_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from", "in",
  "into", "is", "it", "its", "me", "my", "new", "of", "on", "or", "our",
  "please", "should", "so", "some", "that", "the", "their", "then", "this",
  "to", "up", "was", "were", "will", "with", "your",
]);

/**
 * Suggest a short, memorable filename stem from free-form intent. Unlike
 * slugifyFlowIntent — which sanitizes whatever it is given — this keeps only
 * the first few meaningful words so "Review database migrations for rollback
 * risks" becomes review-database-migrations, not the whole sentence.
 */
export function suggestFlowSlug(intent: string): string {
  const sanitized = slugifyFlowIntent(intent);
  if (sanitized === "new-flow") return sanitized; // Empty-intent fallback.
  const words = sanitized.split("-");
  const meaningful = words.filter((word) => !SLUG_STOPWORDS.has(word));
  const source = meaningful.length > 0 ? meaningful : words;
  const parts: string[] = [];
  for (const word of source) {
    if (parts.length >= 3) break;
    if (parts.length > 0 && [...parts, word].join("-").length > 32) break;
    parts.push(word);
  }
  return slugifyFlowIntent(parts.join("-"));
}

/** Engine offered first when composing a new flow. */
export const NEW_FLOW_DEFAULT_ENGINE = "codex";

const PREFERRED_ENGINE_ORDER = [
  "codex", "claude", "pi", "gemini", "copilot", "opencode", "droid", "cursor-agent", "agy",
];

/** Registered engines in composer order: the default first, unknowns last. */
export function listNewFlowEngines(): string[] {
  const registered = getRegisteredAdapters();
  return [
    ...PREFERRED_ENGINE_ORDER.filter((name) => registered.includes(name)),
    ...registered.filter((name) => !PREFERRED_ENGINE_ORDER.includes(name)).sort(),
  ];
}

/**
 * Model suggestions per engine. Suggestions only, never validation: the
 * composer accepts free text and the engine stays the authority. Sourced
 * 2026-07 from each installed CLI (copilot enumerates --model choices,
 * claude documents its aliases, codex/gemini names from live configs);
 * model names drift, so treat this list as a convenience, not a contract.
 */
const MODEL_SUGGESTIONS: Record<string, readonly string[]> = {
  codex: ["gpt-5.6-sol", "gpt-5.5-codex-max", "gpt-5.5"],
  claude: ["fable", "opus", "sonnet", "haiku"],
  gemini: ["gemini-3.1-pro", "gemini-2.5-pro"],
  copilot: [
    "claude-opus-4.6", "claude-sonnet-4.5", "claude-haiku-4.5",
    "gpt-5.3-codex", "gpt-5.2", "gemini-3-pro-preview",
  ],
};

/** Model suggestions for an engine; empty means "free text only". */
export function modelSuggestions(engine: string): readonly string[] {
  return MODEL_SUGGESTIONS[engine] ?? [];
}

interface EffortSupport {
  levels: readonly string[];
  frontmatter: (effort: string) => Record<string, unknown>;
}

/**
 * Reasoning-effort support per engine, each translated to that CLI's
 * verified control: claude --effort, codex -c model_reasoning_effort=…,
 * pi --thinking. Engines with no verified control are absent — the composer
 * hides the field and effortFrontmatter() throws rather than emitting a flag
 * that would break the flow's first run.
 */
const EFFORT_SUPPORT: Record<string, EffortSupport> = {
  claude: {
    levels: ["low", "medium", "high", "xhigh", "max"],
    frontmatter: (effort) => ({ effort }),
  },
  codex: {
    levels: ["minimal", "low", "medium", "high", "xhigh"],
    frontmatter: (effort) => ({ config: [`model_reasoning_effort=${effort}`] }),
  },
  pi: {
    levels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    frontmatter: (effort) => ({ thinking: effort }),
  },
};

/** Effort levels an engine supports; empty means the control doesn't exist. */
export function effortLevels(engine: string): readonly string[] {
  return EFFORT_SUPPORT[engine]?.levels ?? [];
}

/** Translate an effort level into engine-specific frontmatter. */
export function effortFrontmatter(engine: string, effort: string): Record<string, unknown> {
  const support = EFFORT_SUPPORT[engine];
  if (!support) {
    throw new Error(
      `${engine} has no verified reasoning-effort control; omit effort for this engine.`,
    );
  }
  const level = effort.trim();
  if (!support.levels.includes(level)) {
    throw new Error(
      `${engine} supports effort levels ${support.levels.join(", ")}; got "${level}".`,
    );
  }
  return support.frontmatter(level);
}

/**
 * Turn one docs/context entry into a flow-body line resolved at run time:
 * URLs and paths become @imports, anything with a space runs as an inline
 * command, and a bare tool name preloads that tool's --help output.
 */
export function docReferenceLine(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith("@") || /^!`.*`$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("!")) return `!\`${trimmed.slice(1).trim()}\``;
  if (/^https?:\/\//i.test(trimmed)) return `@${trimmed}`;
  const pathLike = /[\\/]/.test(trimmed) || /\.[a-z0-9]+$/i.test(trimmed);
  if (pathLike && /\s/.test(trimmed)) {
    // @imports terminate at whitespace, so this path cannot be expressed as
    // an import — and treating it as a shell command would execute it.
    throw new Error(
      `Docs entry "${trimmed}" looks like a path but contains spaces, which @imports cannot express. ` +
        `Rename the file, or prefix with ! to run it as a command (e.g. !cat '${trimmed}').`,
    );
  }
  if (/\s/.test(trimmed)) return `!\`${trimmed}\``;
  if (pathLike) return `@${trimmed}`;
  return `!\`${trimmed} --help\``;
}

/** Render docs/context entries as the flow body's Reference section. */
export function docsReferenceSection(docs: readonly string[]): string | undefined {
  const lines = docs.map((entry) => entry.trim()).filter(Boolean).map(docReferenceLine);
  if (lines.length === 0) return undefined;
  return ["## Reference", "", ...lines].join("\n");
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
  const slug = options.slug !== undefined ? slugifyFlowIntent(options.slug) : suggestFlowSlug(normalized);
  const description = (options.description ?? defaultDescription(normalized)).replace(/\s+/g, " ").trim();
  if (!description) throw new Error("Flow description cannot be empty.");

  const flowId = options.flowId ?? `flow_${randomUUID().replaceAll("-", "")}`;
  validateFlowId(flowId);
  const taskBody = options.body === undefined ? normalized : options.body.trim();
  const reference = docsReferenceSection(options.docs ?? []);
  const body = reference ? `${taskBody}\n\n${reference}` : taskBody;

  const engine = options.engine?.trim();
  const model = options.model?.trim();
  const effort = options.effort?.trim();
  if (effort && !engine) {
    throw new Error("Effort is engine-specific; choose an engine to set it.");
  }
  const data: Record<string, unknown> = { description };
  if (engine) data.engine = engine;
  if (model) data.model = model;
  if (effort) Object.assign(data, effortFrontmatter(engine!, effort));
  const frontmatter = yaml.dump(data, { lineWidth: -1, noRefs: true }).trimEnd();
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
- Record feedback after a run from the selected flow's Actions screen in \`md\`
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
  // A project-wide engine default is only stamped when the caller made an
  // explicit engine choice; a fallback here would silently change how every
  // engine-neutral flow in the repo resolves.
  const configContent = options.engine ? projectConfig(options.engine) : undefined; // Validate before the first write.

  if (existsSync(flowPath)) {
    return { status: "conflict", target, flowPath, created: [], skipped: [] };
  }

  // Orphaned sibling sidecars are executable TypeScript this call did not
  // write; silently pairing a brand-new flow with them would let unknown
  // code run on its first `md eval` (suite) or first run (hooks).
  const suitePath = flowPath.replace(/\.md$/i, ".eval.ts");
  const hooksPath = flowPath.replace(/\.md$/i, ".hooks.ts");
  if (existsSync(suitePath) || existsSync(hooksPath)) {
    return { status: "conflict", target, flowPath, created: [], skipped: [] };
  }

  mkdirSync(target.flowsDir, { recursive: true });
  if (writeExclusive(flowPath, draft.markdown) === "exists") {
    return { status: "conflict", target, flowPath, created: [], skipped: [] };
  }

  const created = [flowPath];
  const skipped: string[] = [];

  // Workbench-originated creates get the same paired draft suite as
  // `md create` — the coverage ratchet must not depend on which surface
  // created the flow. All-or-nothing: a suite failure rolls the flow back,
  // and so does LOSING the exclusive write (a suite that appeared between
  // the orphan precheck and here is executable code this call did not
  // write — pairing the new flow with it would be adoption, not creation).
  if (options.withEval !== false) {
    try {
      if (writeExclusive(suitePath, renderEvalTemplate(inferEvalRecipes(draft.markdown))) === "created") {
        created.push(suitePath);
      } else {
        try { rmSync(flowPath, { force: true }); } catch {}
        return { status: "conflict", target, flowPath, created: [], skipped: [] };
      }
    } catch (error) {
      try { rmSync(flowPath, { force: true }); } catch {}
      throw new Error(
        `Failed to write the eval suite (${suitePath}); rolled the new flow back: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const readmePath = join(target.flowsDir, "README.md");
  if (writeExclusive(readmePath, rosterReadme()) === "created") created.push(readmePath);
  else skipped.push(readmePath);

  // Re-check all supported config names at apply time in case the caller held
  // a previously resolved target while another process initialized the repo.
  const currentConfig = existingProjectConfig(target.projectRoot);
  if (currentConfig) {
    skipped.push(currentConfig);
  } else if (configContent) {
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
