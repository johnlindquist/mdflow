/**
 * The eval convention layer — scaffolding, static inspection, and the
 * canonical verdict classifier for `<flow>.eval.ts` suites.
 *
 * Parallels the lifecycle-hooks convention (src/hooks.ts + src/hooks-cli.ts):
 * a suite is a sibling file discovered by name, scaffolded from a template
 * with stable line-oriented markers so `md eval add/remove` can edit it
 * surgically, and inspected TEXTUALLY on passive surfaces. `md eval list`,
 * `md eval coverage`, `md explain`, and the Workbench must never import
 * suite code — the static planner (src/evals.ts inspectEvalSuitePlan) plus
 * the marker parse here are the only allowed discovery mechanisms.
 *
 * Fail-closed by design: every scaffolded case carries STATIC `draft: true`
 * metadata (readable by the planner without executing anything) plus a
 * `MDFLOW_DRAFT_CASE` sentinel in its assertion, and the runner refuses paid
 * execution while either remains — a fresh scaffold can never mint a hollow
 * "Verified" receipt.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { loadFullConfig } from "./config";
import { resolveEngine } from "./command";
import { isCompatOnlyFrontmatter } from "./compat";
import { resolveEvolutionPolicy } from "./evolution-core";
import { parseFrontmatter } from "./parse";
import type { AgentFrontmatter } from "./types";
import {
  buildVerificationFingerprint,
  inspectEvalSuitePlan,
  getEvalLedgerEntry,
  readEvalLedger,
  resolveEvalSuitePath,
  type EvalCasePlan,
  type EvalLedgerEntry,
  type EvalSuitePlan,
} from "./evals";

/**
 * Template markers anchoring static inspection and surgical CLI edits.
 * Deliberately boring, line-oriented, and stable — a hand-rewritten suite
 * that drops them stays runnable and listable, just not recipe-editable.
 * Matching tolerates leading whitespace (formatters may re-indent) but is
 * SCOPED to the template's cases array: a marker-looking line in a doc
 * comment or template literal elsewhere is never treated as structure.
 */
export const EVAL_CASES_OPEN_MARKER = "const cases: EvalCase[] = [";
export const EVAL_INSERT_MARKER = "  // mdflow:case:insert";
export const EVAL_CASE_START_PREFIX = "  // mdflow:case:start ";
export const EVAL_CASE_END_PREFIX = "  // mdflow:case:end ";
/**
 * Sentinel string inside scaffolded assertions. An occurrence INSIDE the
 * cases array marks the suite as a fail-closed draft; mentions elsewhere
 * (docs, comments) do not block runs — the static `draft: true` case
 * metadata is the primary draft mechanism.
 */
export const EVAL_DRAFT_MARKER = "MDFLOW_DRAFT_CASE";

const CASES_OPEN_TOKEN = EVAL_CASES_OPEN_MARKER.trim();
const INSERT_TOKEN = EVAL_INSERT_MARKER.trim();
const START_TOKEN = EVAL_CASE_START_PREFIX.trim();
const END_TOKEN = EVAL_CASE_END_PREFIX.trim();

export const EVAL_RECIPES = [
  "output",
  "stdin",
  "prompt",
  "fixture",
  "stochastic",
  "nonzero",
] as const;

export type EvalRecipe = (typeof EVAL_RECIPES)[number];

export const EVAL_RECIPE_DESCRIPTIONS: Record<EvalRecipe, string> = {
  output: "assert one observable invariant on stdout",
  stdin: "pipe representative input and assert how behavior changes",
  prompt: "pass a positional argument (_1/_args) and assert on it",
  fixture: "plant files with setup() and assert on output + ctx.dir",
  stochastic: "repeat trials with a quorum for nondeterministic checks",
  nonzero: "assert an expected failure path (allowNonZero + failureClass)",
};

export function isEvalRecipe(value: string): value is EvalRecipe {
  return (EVAL_RECIPES as readonly string[]).includes(value);
}

const RECIPE_BLOCKS: Record<EvalRecipe, string> = {
  output: `  {
    name: "TODO: define one observable output invariant",
    draft: true, // delete this line when the assertion below is real
    check: ({ stdout }) => {
      // Parse structure, validate numeric bounds, or inspect files in ctx.dir.
      // Never snapshot prose or require one exact sentence — engines are stochastic.
      void stdout;
      return "${EVAL_DRAFT_MARKER}: replace this with a real invariant";
    },
  },`,
  stdin: `  {
    name: "TODO: handles representative piped input",
    draft: true, // delete this line when the assertion below is real
    stdin: "representative input\\n",
    check: ({ stdout }) => {
      void stdout;
      return "${EVAL_DRAFT_MARKER}: assert how stdin changes observable behavior";
    },
  },`,
  prompt: `  {
    name: "TODO: handles representative positional input",
    draft: true, // delete this line when the assertion below is real
    // prompt is passed as the first positional argument ({{ _1 }} / {{ _args }}).
    prompt: "representative positional input",
    check: ({ stdout }) => {
      void stdout;
      return "${EVAL_DRAFT_MARKER}: assert behavior driven by _1 or _args";
    },
  },`,
  fixture: `  {
    name: "TODO: handles a planted fixture",
    draft: true, // delete this line when the assertion below is real
    setup: async (dir) => {
      await Bun.write(\`\${dir}/fixture.json\`, JSON.stringify({ id: 7, state: "known" }));
    },
    check: async ({ stdout, dir }) => {
      const fixture = await Bun.file(\`\${dir}/fixture.json\`).json();
      void stdout;
      void fixture;
      return "${EVAL_DRAFT_MARKER}: assert output and/or resulting files";
    },
  },`,
  stochastic: `  {
    name: "TODO: preserves the invariant across stochastic trials",
    draft: true, // delete this line when the assertion below is real
    kind: "stochastic",
    repetitions: 3,
    quorum: 2,
    check: ({ stdout }) => {
      void stdout;
      return "${EVAL_DRAFT_MARKER}: define the invariant that must pass 2 of 3";
    },
  },`,
  nonzero: `  {
    name: "TODO: reports an expected invalid-input failure",
    draft: true, // delete this line when the assertion below is real
    allowNonZero: true,
    check: ({ exitCode, stderr, failureClass }) => {
      if (failureClass && failureClass !== "unknown") return \`unexpected \${failureClass} failure\`;
      void exitCode;
      void stderr;
      return "${EVAL_DRAFT_MARKER}: assert the expected local exit and diagnostic";
    },
  },`,
};

/** Render one managed case block, wrapped in its start/end markers. */
export function renderEvalCaseBlock(recipe: EvalRecipe): string {
  return `${EVAL_CASE_START_PREFIX}${recipe}\n${RECIPE_BLOCKS[recipe]}\n${EVAL_CASE_END_PREFIX}${recipe}\n`;
}

/**
 * Render a full draft suite. Every scaffolded case fails with the draft
 * marker until its assertion is replaced — the scaffold teaches the shape
 * without ever producing a hollow pass.
 */
export function renderEvalTemplate(recipes: EvalRecipe[] = ["output"]): string {
  const unique = [...new Set(recipes.length > 0 ? recipes : ["output" as EvalRecipe])];
  const blocks = unique.map((recipe) => renderEvalCaseBlock(recipe)).join("");
  return `/**
 * Behavioral eval suite — run with: md eval <flow.md> --plan (free), then --yes (paid).
 *
 * Each case runs the flow FOR REAL in an isolated temp workspace. Check
 * invariants (structure, counts, bounds, file existence), never exact
 * wording. Return null on pass, or a human-readable failure reason.
 */
import type { EvalCase } from "mdflow/src/evals";

${EVAL_CASES_OPEN_MARKER}
${blocks}${EVAL_INSERT_MARKER}
];

export default cases;
`;
}

/**
 * Deterministically pick starter recipes from a flow's source: stdin flows
 * get a stdin case, positional flows a prompt case, flows that shell out to
 * inline commands a fixture case. Everything else starts with output.
 */
export function inferEvalRecipes(flowSource: string): EvalRecipe[] {
  const recipes: EvalRecipe[] = [];
  if (/\{\{\s*_stdin\b/.test(flowSource)) recipes.push("stdin");
  if (/\{\{\s*_(?:1|args)\b/.test(flowSource)) recipes.push("prompt");
  if (/!`/.test(flowSource)) recipes.push("fixture");
  return recipes.length > 0 ? [...new Set(recipes)] : ["output"];
}

export interface ManagedEvalCaseBlock {
  id: string;
  /** Line index of the start marker (0-based). */
  startLine: number;
  /** Line index of the end marker (0-based, inclusive). */
  endLine: number;
  source: string;
}

export interface ManagedEvalCaseParse {
  blocks: ManagedEvalCaseBlock[];
  insertMarkerCount: number;
  /** Line index of the cases-array open marker, when present. */
  scopeStart?: number;
  /** Line index of the closing `];` after the open marker, when found. */
  scopeEnd?: number;
}

/**
 * Parse the template's managed-case markers textually. Markers only count
 * inside the cases array (between `const cases: EvalCase[] = [` and its
 * closing `];`) and tolerate re-indentation. Throws on structural damage
 * (unbalanced, nested, or duplicate markers) — the CLI surfaces that as
 * "edit it manually" instead of guessing at function boundaries.
 */
export function parseManagedEvalCases(source: string): ManagedEvalCaseParse {
  const lines = source.split(/\r?\n/);
  let scopeStart: number | undefined;
  let scopeEnd: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (scopeStart === undefined) {
      if (line.trim() === CASES_OPEN_TOKEN) scopeStart = index;
    } else if (line.trim() === "];") {
      scopeEnd = index;
      break;
    }
  }

  const blocks: ManagedEvalCaseBlock[] = [];
  const seen = new Set<string>();
  let open: { id: string; startLine: number } | null = null;
  let insertMarkerCount = 0;
  const inScope = (index: number) =>
    scopeStart !== undefined && index > scopeStart && (scopeEnd === undefined || index < scopeEnd);
  for (const [index, line] of lines.entries()) {
    if (!inScope(index)) continue;
    const trimmed = line.trim();
    if (trimmed === INSERT_TOKEN) {
      insertMarkerCount++;
      continue;
    }
    if (trimmed.startsWith(START_TOKEN)) {
      const id = trimmed.slice(START_TOKEN.length).trim();
      if (!id) throw new Error(`line ${index + 1}: start marker has no case id`);
      if (open) throw new Error(`line ${index + 1}: nested case marker "${id}" inside "${open.id}"`);
      if (seen.has(id)) throw new Error(`line ${index + 1}: duplicate case id "${id}"`);
      open = { id, startLine: index };
      continue;
    }
    if (trimmed.startsWith(END_TOKEN)) {
      const id = trimmed.slice(END_TOKEN.length).trim();
      if (!open) throw new Error(`line ${index + 1}: end marker "${id}" with no open case`);
      if (open.id !== id) {
        throw new Error(`line ${index + 1}: end marker "${id}" does not close "${open.id}"`);
      }
      seen.add(id);
      blocks.push({
        id,
        startLine: open.startLine,
        endLine: index,
        source: lines.slice(open.startLine, index + 1).join("\n"),
      });
      open = null;
    }
  }
  if (open) throw new Error(`unterminated case marker "${open.id}"`);
  return { blocks, insertMarkerCount, scopeStart, scopeEnd };
}

/**
 * Draft case ids detected from the sentinel, scoped to the cases array.
 * Managed blocks report their id; a sentinel inside the array but outside
 * any block reports "(unmanaged)". Sentinel mentions OUTSIDE the cases
 * array (docs, comments, helper strings) never block a run — the static
 * `draft: true` case metadata (read by the planner) is the primary check.
 */
export function detectDraftCaseIds(source: string): string[] {
  let parsed: ManagedEvalCaseParse;
  try {
    parsed = parseManagedEvalCases(source);
  } catch {
    // Structurally damaged markers: the sentinel cannot be localized, so the
    // whole suite counts as one draft — fail closed, never fail open.
    return source.includes(EVAL_DRAFT_MARKER) ? ["(unmanaged)"] : [];
  }
  const ids = parsed.blocks
    .filter((block) => block.source.includes(EVAL_DRAFT_MARKER))
    .map((block) => block.id);
  if (parsed.scopeStart !== undefined) {
    const lines = source.split(/\r?\n/);
    const blockLines = new Set<number>();
    for (const block of parsed.blocks) {
      for (let line = block.startLine; line <= block.endLine; line++) blockLines.add(line);
    }
    const end = parsed.scopeEnd ?? lines.length;
    for (let line = parsed.scopeStart + 1; line < end; line++) {
      if (!blockLines.has(line) && lines[line]!.includes(EVAL_DRAFT_MARKER)) {
        ids.push("(unmanaged)");
        break;
      }
    }
  } else if (source.includes(EVAL_DRAFT_MARKER)) {
    // No recognizable cases array to scope by: conservative whole-file rule.
    return ["(unmanaged)"];
  }
  return ids;
}

/** The file's dominant end-of-line sequence. */
function dominantEol(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Split preserving each line's own terminator so edits touch only the lines
 * they mean to — a file with mixed endings keeps them everywhere else.
 * eolLines[i] corresponds to the i-th logical line of split(/\r?\n/) for
 * every index that can hold a marker.
 */
function splitPreservingEol(source: string): string[] {
  return source.length === 0 ? [] : source.split(/(?<=\n)/);
}

/**
 * Insert fresh recipe blocks before the single insert marker. Recipes whose
 * managed id already exists are skipped (idempotent). Throws when the file
 * no longer matches the template shape. Untouched lines keep their exact
 * bytes (including their original line endings).
 */
export function insertEvalRecipes(
  source: string,
  recipes: EvalRecipe[]
): { updated: string; added: EvalRecipe[] } {
  const parsed = parseManagedEvalCases(source);
  if (parsed.insertMarkerCount === 0) {
    throw new Error(
      `missing insertion marker (\`${INSERT_TOKEN}\`); add the case manually or regenerate the suite`
    );
  }
  if (parsed.insertMarkerCount > 1) {
    throw new Error(`found ${parsed.insertMarkerCount} insertion markers; expected exactly one`);
  }
  const existing = new Set(parsed.blocks.map((block) => block.id));
  const added = [...new Set(recipes)].filter((recipe) => !existing.has(recipe));
  if (added.length === 0) return { updated: source, added: [] };

  const logical = source.split(/\r?\n/);
  let markerIndex = -1;
  const end = parsed.scopeEnd ?? logical.length;
  for (let line = (parsed.scopeStart ?? 0) + 1; line < end; line++) {
    if (logical[line]!.trim() === INSERT_TOKEN) {
      markerIndex = line;
      break;
    }
  }
  if (markerIndex === -1) {
    throw new Error(`missing insertion marker (\`${INSERT_TOKEN}\`); add the case manually or regenerate the suite`);
  }
  const eol = dominantEol(source);
  const blockText = added.map((recipe) => renderEvalCaseBlock(recipe)).join("");
  const insertText = eol === "\r\n" ? blockText.replace(/\n/g, "\r\n") : blockText;
  const eolLines = splitPreservingEol(source);
  eolLines.splice(markerIndex, 0, insertText);
  return { updated: eolLines.join(""), added };
}

/**
 * Remove managed blocks by exact id. Throws when any requested id has no
 * matching intact marker block — never guesses at hand-written boundaries.
 * Remaining lines keep their exact bytes.
 */
export function removeManagedEvalCases(source: string, ids: string[]): string {
  const parsed = parseManagedEvalCases(source);
  const byId = new Map(parsed.blocks.map((block) => [block.id, block]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `no removable managed case(s) for: ${missing.join(", ")} ` +
        `(not present, or the file diverged from the md eval template — edit it manually)`
    );
  }
  const drop = new Set<number>();
  for (const id of ids) {
    const block = byId.get(id)!;
    for (let line = block.startLine; line <= block.endLine; line++) drop.add(line);
  }
  return splitPreservingEol(source)
    .filter((_, index) => !drop.has(index))
    .join("");
}

export interface StaticEvalInspection {
  flowPath: string;
  suitePath: string;
  exists: boolean;
  plan?: EvalSuitePlan;
  /** Set when the suite exists but cannot be planned without executing it. */
  planError?: string;
  managedCaseIds: string[];
  draftCaseIds: string[];
  draft: boolean;
  hasInsertMarker: boolean;
  source?: string;
}

/**
 * Everything passive surfaces may know about a suite: existence, the static
 * plan, managed/draft case ids. Reads text only — never imports the module.
 */
export function inspectEvalSuiteStatic(
  flowPath: string,
  policyRepetitions = 1
): StaticEvalInspection {
  const suitePath = resolveEvalSuitePath(flowPath);
  if (!existsSync(suitePath)) {
    return {
      flowPath,
      suitePath,
      exists: false,
      managedCaseIds: [],
      draftCaseIds: [],
      draft: false,
      hasInsertMarker: false,
    };
  }
  const source = readFileSync(suitePath, "utf8");
  let plan: EvalSuitePlan | undefined;
  let planError: string | undefined;
  try {
    plan = inspectEvalSuitePlan(suitePath, policyRepetitions);
  } catch (error) {
    planError = error instanceof Error ? error.message : String(error);
  }
  let managedCaseIds: string[] = [];
  let hasInsertMarker = false;
  try {
    const parsed = parseManagedEvalCases(source);
    managedCaseIds = parsed.blocks.map((block) => block.id);
    hasInsertMarker = parsed.insertMarkerCount === 1;
  } catch {
    // Damaged markers: not surgically editable, but still runnable/plannable.
  }
  // Draft = static `draft: true` metadata (primary) ∪ scoped sentinel scan.
  const draftFromPlan = plan?.cases.filter((item) => item.draft).map((item) => item.name) ?? [];
  const draftCaseIds = [...new Set([...detectDraftCaseIds(source), ...draftFromPlan])];
  return {
    flowPath,
    suitePath,
    exists: true,
    plan,
    planError,
    managedCaseIds,
    draftCaseIds,
    draft: draftCaseIds.length > 0,
    hasInsertMarker,
    source,
  };
}

export type EvalVerdict = "Verified" | "Stale" | "Flaky" | "Failing" | "Unverified";

export interface EvalVerdictInput {
  suiteExists: boolean;
  /** False when the suite cannot be statically planned. */
  inspectable: boolean;
  draft: boolean;
  plannedCases: number;
  entry?: EvalLedgerEntry;
  currentFingerprint?: string;
}

export interface EvalVerdictResult {
  verdict: EvalVerdict;
  /** True when the verdict describes the flow's CURRENT bytes. */
  current: boolean;
  reason: string;
}

/**
 * The one fail-closed classifier. Precedence: missing/draft/uninspectable →
 * Unverified; unknown freshness (no current fingerprint could be computed) →
 * Unverified; old bytes → Stale regardless of their old outcome; current
 * mixed trials → Flaky; current behavioral failures → Failing; current
 * provider/auth/environment uncertainty → Unverified; only a complete,
 * current, fingerprint-bound, all-pass run → Verified.
 */
export function classifyEvalVerdict(input: EvalVerdictInput): EvalVerdictResult {
  if (!input.suiteExists) {
    return { verdict: "Unverified", current: false, reason: "no sibling eval suite" };
  }
  if (!input.inspectable) {
    return {
      verdict: "Unverified",
      current: false,
      reason: "suite cannot be inspected without executing code",
    };
  }
  if (input.draft) {
    return { verdict: "Unverified", current: false, reason: "draft assertions remain" };
  }
  const entry = input.entry;
  if (!entry) {
    return {
      verdict: "Unverified",
      current: false,
      reason: "no full eval receipt has been recorded",
    };
  }
  if (!entry.full) {
    return {
      verdict: "Unverified",
      current: false,
      reason: "latest receipt is a filtered or partial run",
    };
  }
  if (!entry.verification || !entry.lastRunFingerprint) {
    return { verdict: "Unverified", current: false, reason: "receipt is not fingerprint-bound" };
  }
  if (!input.currentFingerprint) {
    // Unknown freshness is NOT the same claim as "the content changed":
    // Stale asserts a diff; this asserts we could not look.
    return {
      verdict: "Unverified",
      current: false,
      reason: "freshness could not be established for the current content",
    };
  }
  if (input.currentFingerprint !== entry.verification.fingerprint) {
    return {
      verdict: "Stale",
      current: false,
      reason: "flow, imports, hooks, suite, config, engine, or model changed",
    };
  }
  if ((entry.flaky ?? 0) > 0) {
    return {
      verdict: "Flaky",
      current: true,
      reason: `${entry.flaky} case(s) mixed pass and fail trials`,
    };
  }
  if (entry.fail > 0) {
    return { verdict: "Failing", current: true, reason: `${entry.fail} behavioral case(s) failed` };
  }
  if ((entry.inconclusive ?? 0) > 0) {
    return {
      verdict: "Unverified",
      current: true,
      reason: `${entry.inconclusive} case(s) were inconclusive`,
    };
  }
  if (
    !entry.currentClean ||
    entry.total !== input.plannedCases ||
    entry.pass !== entry.total ||
    entry.total === 0
  ) {
    return { verdict: "Unverified", current: true, reason: "receipt is incomplete or not clean" };
  }
  return {
    verdict: "Verified",
    current: true,
    reason: `${entry.pass}/${entry.total} cases passed on current content`,
  };
}

export interface EvalStatus {
  flowPath: string;
  suitePath: string;
  exists: boolean;
  inspectable: boolean;
  draft: boolean;
  draftCaseIds: string[];
  managedCaseIds: string[];
  cases?: number;
  plannedInvocations?: number;
  verdict: EvalVerdict;
  reason: string;
  current: boolean;
  lastRunAt?: string;
  lastFullRunAt?: string;
  lastCleanAt?: string;
  receiptFingerprint?: string;
  currentFingerprint?: string;
}

/** Policy repetitions for a flow (frontmatter/config), defaulting to 1. */
export async function resolveFlowPolicyRepetitions(flowPath: string): Promise<number> {
  try {
    const frontmatter = parseFrontmatter(readFileSync(flowPath, "utf8")).frontmatter;
    const config = await loadFullConfig(dirname(flowPath));
    return resolveEvolutionPolicy(frontmatter.evolve ?? config.evolve).repetitions;
  } catch {
    return 1;
  }
}

/**
 * Full status for one flow: static inspection + trust-ledger receipt +
 * content-bound freshness. Free and read-only; never imports suite code.
 */
export async function inspectEvalStatus(
  flowPath: string,
  options: { ledger?: Record<string, EvalLedgerEntry>; policyRepetitions?: number } = {}
): Promise<EvalStatus> {
  const absolute = resolve(flowPath);
  // The recorded fingerprint hashes cases AFTER policy repetitions are
  // applied (see runEvalCli), so freshness comparison must plan with the
  // same policy or every receipt would look Stale.
  const policyRepetitions = options.policyRepetitions ?? await resolveFlowPolicyRepetitions(absolute);
  const inspection = inspectEvalSuiteStatic(absolute, policyRepetitions);
  const ledger = options.ledger ?? readEvalLedger();
  const entry = inspection.exists ? getEvalLedgerEntry(inspection.suitePath, ledger) : undefined;

  let currentFingerprint: string | undefined;
  // Freshness hashing only runs when there is a fingerprint-bound receipt to
  // compare against — a passive surface must not walk file graphs for flows
  // that could not classify beyond Unverified anyway.
  if (inspection.exists && inspection.plan && !inspection.draft && entry?.verification) {
    try {
      const cases: EvalCasePlan[] = inspection.plan.cases;
      currentFingerprint = (
        await buildVerificationFingerprint(absolute, inspection.suitePath, cases)
      ).fingerprint;
    } catch {
      // Fingerprint unavailable (unreadable config/imports, graph bounds):
      // stays undefined, which classifies fail-closed as Unverified
      // ("freshness could not be established") — never Verified.
    }
  }

  const verdict = classifyEvalVerdict({
    suiteExists: inspection.exists,
    inspectable: Boolean(inspection.plan),
    draft: inspection.draft,
    plannedCases: inspection.plan?.cases.length ?? 0,
    entry,
    currentFingerprint,
  });

  return {
    flowPath: absolute,
    suitePath: inspection.suitePath,
    exists: inspection.exists,
    inspectable: Boolean(inspection.plan),
    draft: inspection.draft,
    draftCaseIds: inspection.draftCaseIds,
    managedCaseIds: inspection.managedCaseIds,
    cases: inspection.plan?.cases.length,
    plannedInvocations: inspection.plan?.invocations,
    verdict: verdict.verdict,
    reason: verdict.reason,
    current: verdict.current,
    lastRunAt: entry?.lastRunAt,
    lastFullRunAt: entry?.lastFullRunAt ?? (entry?.full ? entry?.lastRunAt : undefined),
    lastCleanAt: entry?.lastCleanAt,
    receiptFingerprint: entry?.verification?.fingerprint,
    currentFingerprint,
  };
}

export interface EvalCoverageBaseline {
  schemaVersion: 1;
  /** flow path (project-relative, POSIX) → reason it may stay uncovered. */
  uncovered: Record<string, string>;
}

export interface EvalCoverageReport {
  root: string;
  scanned: number;
  covered: string[];
  uncovered: string[];
  /** Uncovered flows excused by a baseline entry. */
  baselined: string[];
  zombies: Array<{ path: string; reason: string }>;
  failures: string[];
  ok: boolean;
}

const COVERAGE_SKIP_FILES = new Set(["readme.md", "claude.md", "agents.md"]);
const COVERAGE_SKIP_DIRS = new Set(["node_modules", "dist", "out"]);

/**
 * The runtime document-vs-flow rule, reused for enumeration: a markdown
 * file with no meaningful frontmatter and only an implicitly resolved
 * engine is a document, not a flow — it needs no eval suite. This is what
 * lets a real `changelog.md` FLOW count for coverage while a repo's
 * CHANGELOG document does not.
 */
function isRunnableFlowFile(path: string): boolean {
  let frontmatter: AgentFrontmatter;
  try {
    frontmatter = parseFrontmatter(readFileSync(path, "utf8")).frontmatter;
  } catch {
    return false;
  }
  try {
    const resolved = resolveEngine(path, frontmatter, {});
    const implicit = resolved.source === "env" || resolved.source === "config" || resolved.source === "default";
    return !(implicit && isCompatOnlyFrontmatter(frontmatter as Record<string, unknown>));
  } catch {
    return true;
  }
}

/** Enumerate flow files under a directory (skips docs, hidden dirs, deps). */
export function listEvalFlows(rootDir: string): string[] {
  return listFlowsRecursive(resolve(rootDir)).sort();
}

function listFlowsRecursive(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!COVERAGE_SKIP_DIRS.has(entry.name.toLowerCase())) listFlowsRecursive(path, out);
      continue;
    }
    // Regular files only: symlinks, FIFOs, and sockets are never flows.
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;
    if (COVERAGE_SKIP_FILES.has(entry.name.toLowerCase())) continue;
    if (!isRunnableFlowFile(path)) continue;
    out.push(path);
  }
  return out;
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

/**
 * The coverage ratchet: source coverage only (does every flow have a
 * statically inspectable, non-draft, non-empty sibling suite?) — never paid
 * verification, so CI can run it for free. The committed baseline is
 * shrink-only: new uncovered flows fail, covered/vanished baseline entries
 * fail as zombies, and nothing here ever mutates the baseline.
 */
export async function inspectEvalCoverage(
  rootDir: string,
  baseline: EvalCoverageBaseline = { schemaVersion: 1, uncovered: {} }
): Promise<EvalCoverageReport> {
  const root = resolve(rootDir);
  const flows = listFlowsRecursive(root).sort();
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const flow of flows) {
    // Per-flow policy repetitions: a suite whose quorum leans on the flow's
    // evolve policy must not read as "uninspectable" under a global default.
    const policyRepetitions = await resolveFlowPolicyRepetitions(flow);
    const inspection = inspectEvalSuiteStatic(flow, policyRepetitions);
    const isCovered =
      inspection.exists &&
      Boolean(inspection.plan) &&
      !inspection.draft &&
      (inspection.plan?.cases.length ?? 0) > 0;
    (isCovered ? covered : uncovered).push(posixRelative(root, flow));
  }

  const baselineEntries = Object.keys(baseline.uncovered ?? {});
  const flowSet = new Set(flows.map((flow) => posixRelative(root, flow)));
  const baselined = uncovered.filter((path) => path in (baseline.uncovered ?? {}));
  const failures: string[] = [];
  const zombies: Array<{ path: string; reason: string }> = [];

  for (const path of uncovered) {
    if (!(path in (baseline.uncovered ?? {}))) {
      failures.push(
        `uncovered flow: ${path} — add a suite (md eval add ${path}) or a deliberate baseline entry`
      );
    }
  }
  for (const path of baselineEntries) {
    if (!flowSet.has(path)) {
      zombies.push({ path, reason: "baseline entry names no scanned flow — remove it" });
    } else if (covered.includes(path)) {
      zombies.push({ path, reason: "flow now has a valid suite — remove its baseline entry" });
    }
  }
  for (const zombie of zombies) failures.push(`zombie baseline entry: ${zombie.path} — ${zombie.reason}`);

  return {
    root,
    scanned: flows.length,
    covered,
    uncovered,
    baselined,
    zombies,
    failures,
    ok: failures.length === 0,
  };
}

export function readEvalCoverageBaseline(path: string): EvalCoverageBaseline {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<EvalCoverageBaseline>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.uncovered !== "object" ||
    raw.uncovered === null ||
    Array.isArray(raw.uncovered)
  ) {
    throw new Error(
      `${basename(path)}: expected {"schemaVersion":1,"uncovered":{"<flow.md>":"<reason>"}}`
    );
  }
  for (const [flow, reason] of Object.entries(raw.uncovered)) {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`${basename(path)}: baseline entry "${flow}" needs a non-empty string reason`);
    }
    const invalid =
      !/\.md$/i.test(flow) ||
      flow.startsWith("/") ||
      /^[A-Za-z]:/.test(flow) ||
      flow.includes("\\") ||
      flow.startsWith("./") ||
      flow.split("/").includes("..");
    if (invalid) {
      throw new Error(
        `${basename(path)}: baseline entry "${flow}" must be a project-relative POSIX .md path ` +
          `(no leading ./, no .., no backslashes, no absolute paths)`
      );
    }
  }
  return { schemaVersion: 1, uncovered: raw.uncovered as Record<string, string> };
}

/** Default baseline location: <dir>/.mdflow-eval-baseline.json */
export function defaultCoverageBaselinePath(rootDir: string): string {
  return resolve(rootDir, ".mdflow-eval-baseline.json");
}

/** Re-exported for callers that only need the sibling-path convention. */
export function evalSuiteForFlow(flowPath: string): string {
  return resolveEvalSuitePath(flowPath);
}

/** Directory a suite's flow lives in (for containment-style messaging). */
export function flowDirectory(flowPath: string): string {
  return dirname(resolve(flowPath));
}
