/**
 * Behavioral evals for flows — `md eval <flow.md>`.
 *
 * Creed: "If a guardrail isn't covered by an eval, it's a wish." A flow's
 * prompt promises behavior; an eval suite is the only proof. Each case runs
 * the flow for real (one paid invocation per trial — cost is printed before
 * anything runs) inside an isolated temp workspace, then a check function asserts on
 * stdout AND the resulting filesystem. Write checks on invariants (files,
 * numbers, names), not exact wording.
 *
 * Suites are colocated with their flow: flows/jq.md → flows/jq.eval.ts,
 * exporting `default` an EvalCase[]. Results land in the trust ledger
 * (~/.mdflow/eval-results.json, override MDFLOW_EVAL_RESULTS) — a full clean
 * run stores a content-bound verification receipt. `lastCleanAt` remains only
 * as compatibility/history metadata; Evolve gates on the exact fingerprint.
 *
 * Eval runs are synthetic, not real usage: the runner points MDFLOW_RUNS_FILE
 * into the sandbox so they never pollute the run-telemetry corpus that
 * learning features feed on. The child also receives MDFLOW_CONFIG_CWD so it
 * loads the FLOW's project configuration even though its cwd is the sandbox —
 * without it, the run and the fingerprint would see different configs.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync, statSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname, resolve, basename, relative, sep } from "path";
import { listEffectiveConfigFiles, loadFullConfig } from "./config";
import { isRegistryPath, resolveProjectRoot } from "./project-root";
import { resolveEngine } from "./command";
import { atomicWriteJson, withAtomicFileLock } from "./evolution-store";
import { canonicalFlowPath, findRepositoryRoot, identifyFlow, resolveEvolutionPolicy, sha256, splitFlowDocument } from "./evolution-core";
import { parseImports } from "./imports-parser";
import { parseFrontmatter } from "./parse";
import { resolveHooksFile } from "./hooks";
import type * as TypeScript from "typescript";

/**
 * The TypeScript compiler costs ~1s to import and is needed ONLY when a suite
 * is statically planned or fingerprinted. Importing it at module scope would
 * put it on the CLI COLD PATH — init, create, explain, and the Workbench all
 * reach this module through the convention layer — so it is loaded lazily and
 * memoized. Keep every `ts` reference behind this accessor.
 */
let typescriptModule: typeof TypeScript | undefined;
function ts(): typeof TypeScript {
  return (typescriptModule ??= require("typescript") as typeof TypeScript);
}

/** Version stamped on every machine-readable eval.* object on stdout. */
export const EVAL_PROTOCOL_VERSION = 1;

export interface EvalContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  failureClass?: "provider" | "auth" | "environment" | "cancelled" | "unknown";
  /** The isolated temporary workspace the flow ran in. */
  dir: string;
}

export interface EvalCase {
  name: string;
  /** Extra prompt appended to the flow's body (like asking it a question). */
  prompt?: string;
  /** Piped stdin content. */
  stdin?: string;
  /**
   * Where the flow runs. Default: a fresh isolated temp workspace per case.
   * Repo-bound flows (project rosters that inspect the live repository) set
   * this to a path relative to the flow file (e.g. ".." for the repo root);
   * no cleanup happens for an explicit cwd.
   */
  cwd?: string;
  /** Prepare fixtures inside the temporary workspace before the flow runs. */
  setup?: (dir: string) => void | Promise<void>;
  /** Return null on pass, or a human-readable failure reason. */
  check: (ctx: EvalContext) => string | null | Promise<string | null>;
  timeoutMs?: number;
  /** Feedback IDs this case reproduces. Required for verified-improvement claims. */
  evidence?: string[];
  /** Non-zero exit is a harness failure unless a case explicitly opts out. */
  allowNonZero?: boolean;
  kind?: "deterministic" | "stochastic" | "networked" | "repo-mutating";
  /** Independent trials. Defaults to one. */
  repetitions?: number;
  /** Required passing trials. Defaults to repetitions. Mixed results are flagged as flaky. */
  quorum?: number;
  /**
   * Marks a scaffolded draft case (must be a STATIC boolean literal). Paid
   * runs are refused while any draft case remains — a scaffold can never
   * mint a hollow receipt.
   */
  draft?: boolean;
}

export interface EvalCasePlan {
  name: string;
  evidence: string[];
  repetitions: number;
  quorum: number;
  draft: boolean;
}

export interface EvalSuitePlan {
  cases: EvalCasePlan[];
  invocations: number;
}

/**
 * Thrown (or matched by name / an `INCONCLUSIVE:` message prefix, so
 * dependency-free suites can participate) by setup()/check() to mark a trial
 * environment-inconclusive instead of a behavioral failure — e.g. git being
 * unavailable for a fixture.
 */
export class EvalInconclusiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalInconclusiveError";
  }
}

function isInconclusiveError(err: unknown): boolean {
  if (err instanceof EvalInconclusiveError) return true;
  if (err instanceof Error) {
    return err.name === "EvalInconclusiveError" || /^INCONCLUSIVE:/i.test(err.message);
  }
  return typeof err === "string" && /^INCONCLUSIVE:/i.test(err);
}

/** Raised when a fingerprint cannot be computed within safe bounds. */
export class EvalFingerprintUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalFingerprintUnavailableError";
  }
}

function unwrapExpression(node: TypeScript.Expression, bindings: Map<string, TypeScript.Expression>): TypeScript.Expression {
  let current = node;
  const seen = new Set<TypeScript.Expression>();
  while (true) {
    if (seen.has(current)) return current;
    seen.add(current);
    if (ts().isIdentifier(current) && bindings.has(current.text)) {
      current = bindings.get(current.text)!;
      continue;
    }
    if (ts().isParenthesizedExpression(current) || ts().isAsExpression(current) || ts().isTypeAssertionExpression(current) || ts().isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function propertyKey(name: TypeScript.PropertyName): string | undefined {
  if (ts().isIdentifier(name) || ts().isStringLiteral(name) || ts().isNumericLiteral(name)) return name.text;
  return undefined;
}

function staticValue(node: TypeScript.Expression): unknown {
  if (ts().isStringLiteral(node) || ts().isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts().isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts().SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts().SyntaxKind.FalseKeyword) return false;
  if (ts().isArrayLiteralExpression(node)) return node.elements.map((item) => staticValue(item as TypeScript.Expression));
  return undefined;
}

/** Read eval cost/coverage without executing the suite's top-level code. */
export function inspectEvalSuitePlan(suitePath: string, policyRepetitions = 1): EvalSuitePlan {
  const source = readFileSync(suitePath, "utf8");
  const file = ts().createSourceFile(suitePath, source, ts().ScriptTarget.Latest, true, ts().ScriptKind.TS);
  const bindings = new Map<string, TypeScript.Expression>();
  let exported: TypeScript.Expression | undefined;
  for (const statement of file.statements) {
    if (ts().isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts().isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts().isExportAssignment(statement) && !statement.isExportEquals) {
      exported = statement.expression;
    }
  }
  if (!exported) throw new Error(`${suitePath}: static plan requires an export default EvalCase[]`);
  const expression = unwrapExpression(exported, bindings);
  if (!ts().isArrayLiteralExpression(expression)) {
    throw new Error(`${suitePath}: static plan requires export default to resolve to an array literal`);
  }

  const cases = expression.elements.map((element, index): EvalCasePlan => {
    const value = unwrapExpression(element as TypeScript.Expression, bindings);
    if (!ts().isObjectLiteralExpression(value)) {
      throw new Error(`${suitePath}: case ${index + 1} must be an object literal for safe planning`);
    }
    const properties = new Map<string, TypeScript.Expression>();
    for (const property of value.properties) {
      if (!ts().isPropertyAssignment(property)) continue;
      const key = propertyKey(property.name);
      if (key) properties.set(key, property.initializer);
    }
    const name = properties.has("name") ? staticValue(properties.get("name")!) : undefined;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`${suitePath}: case ${index + 1} needs a static string name for safe planning`);
    }
    const repetitionsValue = properties.has("repetitions") ? staticValue(properties.get("repetitions")!) : policyRepetitions;
    const repetitions = typeof repetitionsValue === "number" ? repetitionsValue : Number.NaN;
    const quorumValue = properties.has("quorum") ? staticValue(properties.get("quorum")!) : repetitions;
    const quorum = typeof quorumValue === "number" ? quorumValue : Number.NaN;
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
      throw new Error(`${suitePath}: ${name} repetitions must be a static integer from 1 to 100`);
    }
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > repetitions) {
      throw new Error(`${suitePath}: ${name} quorum must be a static integer from 1 to repetitions`);
    }
    const evidenceValue = properties.has("evidence") ? staticValue(properties.get("evidence")!) : [];
    if (!Array.isArray(evidenceValue) || !evidenceValue.every((item) => typeof item === "string")) {
      throw new Error(`${suitePath}: ${name} evidence must be a static string array for safe planning`);
    }
    const draftValue = properties.has("draft") ? staticValue(properties.get("draft")!) : false;
    if (typeof draftValue !== "boolean") {
      throw new Error(`${suitePath}: ${name} draft must be a static boolean for safe planning`);
    }
    return { name, evidence: evidenceValue as string[], repetitions, quorum, draft: draftValue };
  });
  if (cases.length === 0) throw new Error(`${suitePath} has no cases (export default an EvalCase[])`);
  return { cases, invocations: cases.reduce((total, item) => total + item.repetitions, 0) };
}

export interface FlowRunSpec {
  flowPath: string;
  prompt?: string;
  stdin?: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export type FlowRunner = (spec: FlowRunSpec) => Promise<Omit<EvalContext, "dir">>;

export interface EvalSuiteOutcome {
  pass: number;
  fail: number;
  total: number;
  failures: string[];
  inconclusive: number;
  flaky: number;
  invocations: number;
  cases: EvalCaseOutcome[];
  /** True when the eval inputs changed while the suite ran (receipt withheld). */
  inputsChanged?: boolean;
}

export interface EvalTrialOutcome {
  trial: number;
  status: "pass" | "fail" | "inconclusive";
  reason?: string;
  exitCode?: number;
  timedOut?: boolean;
  failureClass?: EvalContext["failureClass"];
}

export interface EvalCaseOutcome {
  name: string;
  status: "pass" | "fail" | "inconclusive";
  reason?: string;
  exitCode?: number;
  timedOut?: boolean;
  evidence: string[];
  repetitions: number;
  quorum: number;
  passCount: number;
  flaky: boolean;
  trials: EvalTrialOutcome[];
}

export interface VerificationFingerprint {
  fingerprint: string;
  flowHash: string;
  suiteHash: string;
  configHash: string;
  mdflowVersion: string;
  engine: string;
  engineSource: string;
  model?: string;
  caseIds: string[];
  createdAt: string;
}

export type VerificationEnvironmentFingerprint = Omit<VerificationFingerprint, "fingerprint" | "caseIds" | "createdAt">;

/**
 * Everything about WHERE and HOW a flow's evals run, resolved exactly once
 * per invocation so planning, consent disclosure, child-process config,
 * hooks discovery, and fingerprinting all describe the same run.
 */
export interface ResolvedEvalEnvironment {
  /** Absolute path as invoked — symlinks preserved (engine names resolve from it). */
  logicalFlowPath: string;
  suitePath: string;
  /** Directory whose project config governs the run (the flow's home, not the sandbox). */
  configCwd: string;
  engine: string;
  engineSource: string;
  model?: string;
  policyRepetitions: number;
  /** `_hooks` value after config command defaults are applied (what execution sees). */
  effectiveHooksValue: unknown;
  config: Awaited<ReturnType<typeof loadFullConfig>>;
}

export async function resolveEvalEnvironment(flowPath: string): Promise<ResolvedEvalEnvironment> {
  const logicalFlowPath = resolve(flowPath);
  const suitePath = resolveEvalSuitePath(logicalFlowPath);
  // The nearest project marker (config file, flows/ roster, git boundary)
  // governs the run — dirname(flow) alone would miss /project/.mdflow.yaml
  // for a flow at /project/flows/x.md in a non-git project (loadProjectConfig
  // only cascades git root → exact cwd).
  const configCwd = resolveProjectRoot(logicalFlowPath).projectRoot;
  const config = await loadFullConfig(configCwd);
  const frontmatter = parseFrontmatter(readFileSync(logicalFlowPath, "utf8")).frontmatter;
  // Engine resolution must see the path the user actually runs — a symlinked
  // `task.claude.md` selects claude even when its target is `task.md`.
  // Canonicalization is reserved for byte identity, never engine selection.
  const resolvedEngine = resolveEngine(logicalFlowPath, frontmatter, { configEngine: config.engine });
  const commandDefaults = config.commands?.[resolvedEngine.engine] as Record<string, unknown> | undefined;
  const frontmatterRecord = frontmatter as Record<string, unknown>;
  const configuredModel = frontmatterRecord.model ?? commandDefaults?.model;
  const effectiveHooksValue = frontmatterRecord._hooks !== undefined
    ? frontmatterRecord._hooks
    : commandDefaults?.["_hooks"];
  const policyRepetitions = resolveEvolutionPolicy(
    (frontmatterRecord.evolve ?? config.evolve) as Parameters<typeof resolveEvolutionPolicy>[0]
  ).repetitions;
  return {
    logicalFlowPath,
    suitePath,
    configCwd,
    engine: resolvedEngine.engine,
    engineSource: resolvedEngine.source,
    model: typeof configuredModel === "string" ? configuredModel : undefined,
    policyRepetitions,
    effectiveHooksValue,
    config,
  };
}

export interface EvalLedgerEntry {
  /** Additive entry-format marker (1 = latestRun/lastFullRunAt split). */
  schemaVersion?: number;
  flow: string;
  /** Stable identity used to find this receipt after a checkout moves. */
  flowId?: string;
  pass: number;
  fail: number;
  total: number;
  lastRunAt: string;
  /** True when the run covered every case in the suite (no --filter). */
  full: boolean;
  /** Last time a FULL run of this suite completed (filtered runs never move it). */
  lastFullRunAt?: string;
  /** Last time a FULL run of this suite passed every case. */
  lastCleanAt?: string;
  /** True only when the most recent full result for this exact fingerprint is clean. */
  currentClean?: boolean;
  verification?: VerificationFingerprint;
  lastRunFingerprint?: string;
  inconclusive?: number;
  flaky?: number;
  cases?: EvalCaseOutcome[];
  /** The most recent run of ANY shape (full or filtered) — display only. */
  latestRun?: EvalRunSummary;
}

export interface EvalRunSummary {
  at: string;
  pass: number;
  fail: number;
  total: number;
  inconclusive?: number;
  flaky?: number;
  full: boolean;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** flows/jq.md → flows/jq.eval.ts (any .md flow, engine-suffixed or bare). */
export function resolveEvalSuitePath(flowPath: string): string {
  return flowPath.replace(/\.md$/i, ".eval.ts");
}

export function evalLedgerPath(): string {
  const override = process.env.MDFLOW_EVAL_RESULTS?.trim();
  return override ? override : join(homedir(), ".mdflow", "eval-results.json");
}

/**
 * Fail-closed ledger read: only ENOENT means "no ledger yet". Unreadable or
 * corrupt content throws so a writer can never silently overwrite eval
 * history with a fresh object.
 */
export function readEvalLedger(path = evalLedgerPath()): Record<string, EvalLedgerEntry> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `eval trust ledger unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `eval trust ledger corrupt at ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Fix or remove the file — refusing to silently discard eval history.`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`eval trust ledger corrupt at ${path}: expected a JSON object`);
  }
  // Schema-closed, not just syntax-closed: a well-formed JSON object whose
  // entries are structurally wrong for the eval protocol must also refuse —
  // a later writer would otherwise reinterpret or replace history.
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const corrupt = (detail: string): never => {
      throw new Error(
        `eval trust ledger corrupt at ${path}: entry "${key}" ${detail}. ` +
          `Fix or remove the file — refusing to silently discard eval history.`
      );
    };
    if (typeof value !== "object" || value === null || Array.isArray(value)) corrupt("is not an object");
    const entry = value as Record<string, unknown>;
    if (typeof entry.flow !== "string") corrupt("has no string flow path");
    for (const field of ["pass", "fail", "total"] as const) {
      if (typeof entry[field] !== "number" || !Number.isFinite(entry[field] as number)) {
        corrupt(`has a non-numeric "${field}"`);
      }
    }
    if (typeof entry.lastRunAt !== "string") corrupt('has no string "lastRunAt"');
    for (const field of ["full", "currentClean"] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") corrupt(`has a non-boolean "${field}"`);
    }
    for (const field of ["inconclusive", "flaky", "schemaVersion"] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== "number") corrupt(`has a non-numeric "${field}"`);
    }
    for (const field of ["flowId", "lastFullRunAt", "lastCleanAt", "lastRunFingerprint"] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== "string") corrupt(`has a non-string "${field}"`);
    }
    if (entry.verification !== undefined) {
      const verification = entry.verification;
      if (typeof verification !== "object" || verification === null || Array.isArray(verification)) {
        corrupt('has a malformed "verification" receipt');
      }
      if (typeof (verification as Record<string, unknown>).fingerprint !== "string") {
        corrupt('has a verification receipt without a string "fingerprint"');
      }
    }
    if (entry.cases !== undefined && !Array.isArray(entry.cases)) corrupt('has a non-array "cases"');
  }
  return parsed as Record<string, EvalLedgerEntry>;
}

export function getEvalLedgerEntry(
  suitePath: string,
  ledger = readEvalLedger()
): EvalLedgerEntry | undefined {
  const flowPath = suitePath.replace(/\.eval\.ts$/i, ".md");
  const flowId = identifyFlow(flowPath).id;
  if (ledger[`flow:${flowId}`]) return ledger[`flow:${flowId}`];
  const canonical = canonicalFlowPath(suitePath);
  if (ledger[canonical]) return ledger[canonical];
  const absolute = resolve(suitePath);
  if (ledger[absolute]) return ledger[absolute];
  for (const [key, entry] of Object.entries(ledger)) {
    if (canonicalFlowPath(key) === canonical) return entry;
  }
  return undefined;
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function logicalPath(root: string, path: string): string {
  return relative(root, path).split("\\").join("/") || basename(path);
}

/**
 * Fingerprint graph bounds. Generous for real flows, but a hard stop for
 * pathological or hostile graphs — a breach makes the fingerprint
 * UNAVAILABLE (freshness cannot be established), never partially computed.
 */
const GRAPH_MAX_FILES = 512;
const GRAPH_MAX_BYTES = 32 * 1024 * 1024;

interface GraphBudget {
  files: number;
  bytes: number;
}

function consumeGraphBudget(budget: GraphBudget, path: string, bytes: number): void {
  budget.files += 1;
  budget.bytes += bytes;
  if (budget.files > GRAPH_MAX_FILES || budget.bytes > GRAPH_MAX_BYTES) {
    throw new EvalFingerprintUnavailableError(
      `fingerprint graph exceeds safe bounds (${GRAPH_MAX_FILES} files / ${GRAPH_MAX_BYTES} bytes) at ${path}`
    );
  }
}

function withinDir(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function canonicalOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * stat → budget → read: the byte budget is charged from stat metadata BEFORE
 * any bytes are read, so a pathological file can never be pulled into memory
 * just to discover it breaches the limit. Only regular files participate.
 */
function consumeAndReadGraphFile(path: string, budget: GraphBudget): Buffer {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new EvalFingerprintUnavailableError(`${path} is not a regular file; freshness cannot be established`);
  }
  consumeGraphBudget(budget, path, stat.size);
  return readFileSync(path);
}

/**
 * Collect every LOCAL module reference from real TypeScript syntax: static
 * imports (including bare side-effect `import "./x"`), `export … from`,
 * `import()` and `require()` calls, and import-equals. AST-based so a quoted
 * relative string in ordinary code never pulls files into the hash graph —
 * and a real side-effect import can never hide from it.
 */
function collectLocalModuleSpecifiers(source: string, filePath: string): string[] {
  const file = ts().createSourceFile(filePath, source, ts().ScriptTarget.Latest, true, ts().ScriptKind.TS);
  const specifiers: string[] = [];
  const record = (expression: TypeScript.Expression | undefined) => {
    if (expression && ts().isStringLiteralLike(expression) && /^\.{1,2}\//.test(expression.text)) {
      specifiers.push(expression.text);
    }
  };
  const visit = (node: TypeScript.Node): void => {
    if (ts().isImportDeclaration(node) || ts().isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts().isImportEqualsDeclaration(node) && ts().isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression);
    } else if (ts().isCallExpression(node)) {
      if (
        node.expression.kind === ts().SyntaxKind.ImportKeyword ||
        (ts().isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        record(node.arguments[0]);
      }
    }
    ts().forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

const MODULE_RESOLUTION_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];

function hashLocalModuleGraph(
  entryPath: string,
  seen = new Set<string>(),
  labelRoot = dirname(resolve(entryPath)),
  budget: GraphBudget = { files: 0, bytes: 0 },
  containRoot = findRepositoryRoot(entryPath) ?? dirname(resolve(entryPath))
): string {
  // Everything is compared canonical-to-canonical: an in-root symlink must
  // not smuggle out-of-root code into (or hide it from) the fingerprint, and
  // platform path aliases (/tmp → /private/tmp) must not fake an escape.
  const absolute = canonicalOr(resolve(entryPath));
  if (seen.has(absolute) || !existsSync(absolute)) return "";
  seen.add(absolute);
  const canonicalRoot = canonicalOr(containRoot);
  if (!withinDir(canonicalRoot, absolute)) {
    throw new EvalFingerprintUnavailableError(
      `${logicalPath(labelRoot, absolute)} resolves outside ${containRoot}; ` +
        `freshness cannot be established for files outside the flow's root`
    );
  }
  const content = consumeAndReadGraphFile(absolute, budget).toString("utf8");
  const pieces = [JSON.stringify([logicalPath(labelRoot, absolute), sha256(content)])];
  for (const specifier of collectLocalModuleSpecifiers(content, absolute)) {
    const base = resolve(dirname(absolute), specifier);
    if (!withinDir(canonicalRoot, base)) {
      throw new EvalFingerprintUnavailableError(
        `${logicalPath(labelRoot, absolute)} imports ${specifier}, which escapes ${containRoot}; ` +
          `freshness cannot be established for files outside the flow's root`
      );
    }
    const candidates = [
      base,
      ...MODULE_RESOLUTION_SUFFIXES.map((suffix) => `${base}${suffix}`),
      join(base, "index.ts"),
      join(base, "index.tsx"),
      join(base, "index.js"),
    ];
    const dependency = candidates.find((candidate) => existsSync(candidate));
    if (dependency) pieces.push(hashLocalModuleGraph(dependency, seen, labelRoot, budget, containRoot));
  }
  return pieces.join("\n");
}

function hashFlowGraph(
  flowPath: string,
  seen = new Set<string>(),
  graphRoot = findRepositoryRoot(flowPath) ?? dirname(canonicalFlowPath(flowPath)),
  budget: GraphBudget = { files: 0, bytes: 0 },
  /** Effective `_hooks` value for the ROOT flow (config defaults applied). */
  rootHooksValue?: { value: unknown }
): string {
  const absolute = canonicalFlowPath(flowPath);
  if (seen.has(absolute) || !existsSync(absolute)) return "";
  seen.add(absolute);
  const content = consumeAndReadGraphFile(absolute, budget).toString("utf8");
  const pieces = [JSON.stringify([logicalPath(graphRoot, absolute), sha256(content)])];
  // Lifecycle hooks are part of the flow's behavior: a changed hook program
  // must invalidate eval receipts exactly like a changed body would.
  try {
    const frontmatterHooks = (parseFrontmatter(content).frontmatter as Record<string, unknown>)?.["_hooks"];
    const hooksResolved = resolveHooksFile({
      // Hooks are discovered from the LOGICAL path (the one execution uses):
      // a symlinked task.claude.md finds its hooks beside the symlink, not
      // beside the canonical target.
      flowPath: resolve(flowPath),
      // The root flow hashes the EFFECTIVE hooks value (config command
      // defaults applied) so the fingerprint sees the same hook program the
      // run will execute; imported documents fall back to their own bytes.
      frontmatterValue: rootHooksValue ? rootHooksValue.value : frontmatterHooks,
    });
    if (hooksResolved.kind === "file" && !hooksResolved.missing && !hooksResolved.rejected) {
      // Walk the hook program's local import graph, not just its entry file:
      // a hook that imports a project helper changes behavior when that
      // helper changes, so the receipt must invalidate too. Hook files are
      // dependency-free by convention, so this usually hashes one file.
      pieces.push(hashLocalModuleGraph(hooksResolved.path, seen, graphRoot, budget, graphRoot));
    }
  } catch (error) {
    if (error instanceof EvalFingerprintUnavailableError) throw error;
    // Unparseable frontmatter: the flow hash above already covers the bytes.
  }
  for (const action of parseImports(splitFlowDocument(content).body)) {
    if (action.type === "file" || action.type === "symbol") {
      const path = resolve(dirname(absolute), action.path);
      if (!existsSync(path)) continue;
      if (/\.md(?:own)?$/i.test(path)) pieces.push(hashFlowGraph(path, seen, graphRoot, budget));
      else {
        const bytes = consumeAndReadGraphFile(path, budget);
        pieces.push(JSON.stringify([logicalPath(graphRoot, canonicalFlowPath(path)), sha256(bytes)]));
      }
    } else if (action.type === "glob") {
      const glob = new Bun.Glob(action.pattern);
      const matches: string[] = [];
      for (const file of glob.scanSync({ cwd: dirname(absolute), absolute: true })) {
        matches.push(file);
        // Enforce the file budget while enumerating — a hostile glob must not
        // materialize an unbounded match list before the limit fires.
        if (budget.files + matches.length > GRAPH_MAX_FILES) {
          throw new EvalFingerprintUnavailableError(
            `fingerprint graph exceeds safe bounds (${GRAPH_MAX_FILES} files / ${GRAPH_MAX_BYTES} bytes) at glob ${action.pattern}`
          );
        }
      }
      for (const file of matches.sort()) {
        if (existsSync(file)) {
          const bytes = consumeAndReadGraphFile(file, budget);
          pieces.push(JSON.stringify([logicalPath(graphRoot, canonicalFlowPath(file)), sha256(bytes)]));
        }
      }
    }
  }
  return pieces.join("\n");
}

export async function buildVerificationEnvironmentFingerprint(
  flowPath: string,
  suitePath: string,
  environment?: ResolvedEvalEnvironment
): Promise<VerificationEnvironmentFingerprint> {
  const env = environment ?? await resolveEvalEnvironment(flowPath);
  const suite = canonicalFlowPath(suitePath);
  // ONE budget spans the whole eval input graph (flow + imports + hooks +
  // suite) — separate budgets would double the documented bound.
  const budget: GraphBudget = { files: 0, bytes: 0 };
  const flowHash = sha256(hashFlowGraph(resolve(flowPath), new Set(), undefined, budget, { value: env.effectiveHooksValue }));
  const suiteHash = sha256(hashLocalModuleGraph(suite, new Set(), undefined, budget));
  // Receipts bind to the exact BYTES of every effective config file, not just
  // the parsed shape — a config edit the parser normalizes away must still
  // invalidate the receipt (the stated contract is exact-byte binding).
  let configFileManifest: Array<{ role: string; hash: string }>;
  try {
    configFileManifest = listEffectiveConfigFiles(env.configCwd).map(({ role, path }) => ({
      role,
      hash: sha256(readFileSync(path)),
    }));
  } catch (error) {
    throw new EvalFingerprintUnavailableError(
      `cannot read an effective config file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const configHash = sha256(JSON.stringify({ resolved: env.config, files: configFileManifest }));
  return {
    flowHash,
    suiteHash,
    configHash,
    mdflowVersion: packageVersion(),
    engine: env.engine,
    engineSource: env.engineSource,
    model: env.model,
  };
}

export async function buildVerificationFingerprint(
  flowPath: string,
  suitePath: string,
  cases: Array<EvalCase | EvalCasePlan>,
  environment?: ResolvedEvalEnvironment
): Promise<VerificationFingerprint> {
  const env = await buildVerificationEnvironmentFingerprint(flowPath, suitePath, environment);
  const caseIds = cases.map((item) => sha256(JSON.stringify({
    name: item.name,
    evidence: item.evidence ?? [],
    repetitions: item.repetitions ?? 1,
    quorum: item.quorum ?? item.repetitions ?? 1,
  })).slice(0, 20));
  return {
    ...env,
    fingerprint: sha256(JSON.stringify({ ...env, caseIds })),
    caseIds,
    createdAt: new Date().toISOString(),
  };
}

export async function isVerificationCurrent(
  flowPath: string,
  suitePath: string,
  cases: EvalCase[],
  entry = getEvalLedgerEntry(suitePath)
): Promise<boolean> {
  if (!entry?.currentClean || !entry.verification) return false;
  const current = await buildVerificationFingerprint(flowPath, suitePath, cases);
  return current.fingerprint === entry.verification.fingerprint;
}

export function recordEvalResult(
  suite: string,
  result: Omit<EvalLedgerEntry, "lastCleanAt" | "lastFullRunAt" | "latestRun" | "schemaVersion">,
  path = evalLedgerPath()
): void {
  withAtomicFileLock(path, () => {
    // readEvalLedger throws on unreadable/corrupt content — a broken ledger
    // must abort the write, never be replaced by a fresh empty object.
    const all = readEvalLedger(path);
    const flowId = identifyFlow(result.flow).id;
    // Alias-aware: a full receipt recorded under a legacy/symlinked suite key
    // must be found here, or a filtered run would shadow it with a partial
    // entry under the exact keys.
    const prev = all[`flow:${flowId}`] ?? all[suite] ?? getEvalLedgerEntry(suite, all);
    const latestRun: EvalRunSummary = {
      at: result.lastRunAt,
      pass: result.pass,
      fail: result.fail,
      total: result.total,
      inconclusive: result.inconclusive,
      flaky: result.flaky,
      full: result.full,
    };

    let entry: EvalLedgerEntry;
    if (!result.full && prev?.full) {
      // A filtered run is display data only — it must never overwrite the
      // full-run receipt (counts, fingerprints, verification, case list).
      entry = { ...prev, schemaVersion: 1, flowId, latestRun };
    } else {
      // Fail-closed clean predicate: any failure, flake, or inconclusive trial
      // disqualifies the receipt from "clean" — the fingerprint still binds
      // the (non-clean) outcome to the exact content that produced it.
      const clean =
        result.full &&
        result.total > 0 &&
        result.pass === result.total &&
        result.fail === 0 &&
        (result.inconclusive ?? 0) === 0 &&
        (result.flaky ?? 0) === 0 &&
        Boolean(result.verification);
      const lastCleanAt = clean ? result.lastRunAt : prev?.lastCleanAt;
      const lastFullRunAt = result.full ? result.lastRunAt : prev?.lastFullRunAt;
      entry = {
        ...result,
        schemaVersion: 1,
        flowId,
        currentClean: clean,
        verification: result.verification ?? prev?.verification,
        latestRun,
        ...(lastCleanAt ? { lastCleanAt } : {}),
        ...(lastFullRunAt ? { lastFullRunAt } : {}),
      };
    }
    all[suite] = entry;
    all[`flow:${flowId}`] = entry;
    atomicWriteJson(path, all);
  });
}

/**
 * Default runner: spawn the md CLI on the flow inside the sandbox.
 * MDFLOW_RUNS_FILE is redirected into the sandbox so synthetic eval runs
 * never enter the real telemetry corpus.
 */
export function makeCliFlowRunner(cliPath: string): FlowRunner {
  return async ({ flowPath, prompt, stdin, cwd, timeoutMs, env }) => {
    const args = [cliPath, resolve(flowPath)];
    if (prompt) args.push(prompt);

    const proc = Bun.spawn(["bun", "run", ...args], {
      cwd,
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
        MDFLOW_RUNS_FILE: join(cwd, ".mdflow-eval-runs.jsonl"),
        MDFLOW_EVAL_RUN: "1",
      },
      detached: process.platform !== "win32",
    });

    const killTree = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32") {
        try { process.kill(-proc.pid, signal); return; } catch {}
      }
      try { proc.kill(signal); } catch {}
    };

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killTree("SIGTERM");
        killTimer = setTimeout(() => {
          killTree("SIGKILL");
        }, 2_000);
      } catch {}
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);

    const failureText = `${stderr}\n${stdout}`;
    const failureClass: EvalContext["failureClass"] = timedOut
      ? undefined
      : /(?:unauthori[sz]ed|authentication|invalid api key|missing api key|\b401\b|\b403\b)/i.test(failureText)
        ? "auth"
        : /(?:rate.?limit|too many requests|overloaded|service unavailable|\b429\b|ECONN|network error)/i.test(failureText)
          ? "provider"
          : exitCode === 127 || /(?:command not found|module not found|dependency)/i.test(failureText)
            ? "environment"
            : exitCode === 130 ? "cancelled"
            : exitCode === 0 ? undefined : "unknown";
    return { stdout, stderr, exitCode, timedOut, failureClass };
  };
}

export interface RunEvalSuiteOptions {
  flowPath: string;
  cases: EvalCase[];
  runFlow: FlowRunner;
  filter?: string;
  log?: (line: string) => void;
  suiteKey?: string;
  ledgerPath?: string;
  /** Skip ledger writes entirely (used by unit tests). */
  noLedger?: boolean;
  env?: Record<string, string>;
  /** Pre-resolved environment (resolved once by the CLI). */
  environment?: ResolvedEvalEnvironment;
  /**
   * Fingerprint sealed BEFORE the suite module was imported. When set, the
   * post-run fingerprint must match or no receipt is recorded
   * (EVAL_INPUTS_CHANGED) — suite code cannot rewrite the flow mid-run and
   * keep a clean receipt for bytes the trials never exercised.
   */
  sealedFingerprint?: string;
}

export function applyPolicyRepetitions(cases: EvalCase[], repetitions: number): EvalCase[] {
  return cases.map((item) => item.repetitions === undefined
    ? { ...item, repetitions, quorum: item.quorum ?? repetitions }
    : item);
}

/**
 * Materialize suite cases into frozen plain objects, reading every property
 * exactly once. A hostile suite could otherwise use getters to announce one
 * cost/plan and execute another — after this, the announced values ARE the
 * executed values.
 */
export function materializeEvalCases(rawCases: unknown, source: string): EvalCase[] {
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error(`${source} has no cases (export default an EvalCase[])`);
  }
  return rawCases.map((raw, index) => {
    const label = `${source}: case ${index + 1}`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${label} is not an object`);
    const record = raw as Record<string, unknown>;
    // Read each field ONCE — getters run here and never again.
    const name = record.name;
    const prompt = record.prompt;
    const stdin = record.stdin;
    const cwd = record.cwd;
    const setup = record.setup;
    const check = record.check;
    const timeoutMs = record.timeoutMs;
    const evidence = record.evidence;
    const allowNonZero = record.allowNonZero;
    const kind = record.kind;
    const repetitions = record.repetitions;
    const quorum = record.quorum;
    const draft = record.draft;
    if (typeof name !== "string" || !name.trim()) throw new Error(`${label} needs a non-empty string name`);
    if (typeof check !== "function") throw new Error(`${label} ("${name}") needs a check function`);
    if (setup !== undefined && typeof setup !== "function") throw new Error(`${label} ("${name}") setup must be a function`);
    for (const [key, value] of Object.entries({ prompt, stdin, cwd })) {
      if (value !== undefined && typeof value !== "string") throw new Error(`${label} ("${name}") ${key} must be a string`);
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`${label} ("${name}") timeoutMs must be a positive number`);
    }
    if (evidence !== undefined && (!Array.isArray(evidence) || !evidence.every((item) => typeof item === "string"))) {
      throw new Error(`${label} ("${name}") evidence must be a string array`);
    }
    for (const [key, value] of Object.entries({ repetitions, quorum })) {
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
        throw new Error(`${label} ("${name}") ${key} must be an integer`);
      }
    }
    if (allowNonZero !== undefined && typeof allowNonZero !== "boolean") throw new Error(`${label} ("${name}") allowNonZero must be a boolean`);
    if (draft !== undefined && typeof draft !== "boolean") throw new Error(`${label} ("${name}") draft must be a boolean`);
    const materialized: EvalCase = {
      name,
      prompt: prompt as string | undefined,
      stdin: stdin as string | undefined,
      cwd: cwd as string | undefined,
      setup: setup as EvalCase["setup"],
      check: check as EvalCase["check"],
      timeoutMs: timeoutMs as number | undefined,
      evidence: evidence ? Object.freeze([...(evidence as string[])]) as unknown as string[] : undefined,
      allowNonZero: allowNonZero as boolean | undefined,
      kind: kind as EvalCase["kind"],
      repetitions: repetitions as number | undefined,
      quorum: quorum as number | undefined,
      draft: draft as boolean | undefined,
    };
    return Object.freeze(materialized);
  });
}

/** Typed refusal from the shared paid-suite preparation boundary. */
export class EvalSuitePreparationError extends Error {
  constructor(
    public readonly reasonCode: "SUITE_IMPORT_FAILED" | "SUITE_INVALID" | "SUITE_PLAN_CHANGED" | "DRAFT_SUITE",
    message: string
  ) {
    super(message);
    this.name = "EvalSuitePreparationError";
  }
}

/**
 * The ONE way paid callers may turn a suite module into runnable cases.
 * Imports (post-consent only!), materializes and freezes every case, applies
 * policy repetitions, refuses drafts, and verifies the runtime shape matches
 * the announced static plan. `md eval` and `md evolve` both run through this
 * boundary — a second raw import path would reopen every getter/draft hole.
 */
export async function importPreparedEvalSuite(options: {
  suitePath: string;
  policyRepetitions: number;
  staticPlan: EvalSuitePlan;
}): Promise<EvalCase[]> {
  const suitePath = resolve(options.suitePath);
  let mod: Record<string, unknown>;
  try {
    mod = await import(`${suitePath}?eval=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  } catch (error) {
    throw new EvalSuitePreparationError(
      "SUITE_IMPORT_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }
  let cases: EvalCase[];
  try {
    cases = applyPolicyRepetitions(
      materializeEvalCases(mod.default, suitePath),
      options.policyRepetitions
    ).map((item) => Object.freeze(item));
  } catch (error) {
    throw new EvalSuitePreparationError(
      "SUITE_INVALID",
      error instanceof Error ? error.message : String(error)
    );
  }
  const runtimePlan: EvalCasePlan[] = cases.map((item) => ({
    name: item.name,
    evidence: item.evidence ?? [],
    repetitions: item.repetitions ?? 1,
    quorum: item.quorum ?? item.repetitions ?? 1,
    draft: item.draft === true,
  }));
  if (JSON.stringify(runtimePlan) !== JSON.stringify(options.staticPlan.cases)) {
    throw new EvalSuitePreparationError(
      "SUITE_PLAN_CHANGED",
      "eval suite runtime metadata differs from the announced static plan; refusing flow invocations"
    );
  }
  const draftCaseIds = runtimePlan.filter((item) => item.draft).map((item) => item.name);
  if (draftCaseIds.length > 0) {
    throw new EvalSuitePreparationError(
      "DRAFT_SUITE",
      `${suitePath} still contains draft case(s): ${draftCaseIds.join(", ")}. ` +
        `Replace their draft assertions (and remove \`draft: true\`) before a paid run.`
    );
  }
  return cases;
}

function trialPlan(evalCase: EvalCase): { repetitions: number; quorum: number } {
  const repetitions = evalCase.repetitions ?? 1;
  const quorum = evalCase.quorum ?? repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error(`${evalCase.name}: repetitions must be an integer from 1 to 100`);
  }
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > repetitions) {
    throw new Error(`${evalCase.name}: quorum must be an integer from 1 to repetitions`);
  }
  return { repetitions, quorum };
}

export function evalInvocationCount(cases: EvalCase[]): number {
  return cases.reduce((total, item) => total + trialPlan(item).repetitions, 0);
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<EvalSuiteOutcome> {
  const { flowPath, runFlow, filter } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const selected = filter
    ? options.cases.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : options.cases;

  // The eval child runs in a sandbox cwd; config must still come from the
  // flow's own project. MDFLOW_CONFIG_CWD tells the child where to look.
  const configCwd = options.environment?.configCwd ?? resolveProjectRoot(resolve(flowPath)).projectRoot;
  // The injected pointer is an internal trust bridge and always wins — a
  // caller-supplied override would let suite-adjacent code point the child at
  // a different project than the one the receipt fingerprints.
  const childEnv = { ...options.env, MDFLOW_CONFIG_CWD: configCwd };

  // Re-verify the sealed fingerprint at the paid boundaries of every trial:
  // right before the child spawns and right after check() returns. Without
  // this, setup() could swap the flow's bytes, let the child run the swap,
  // and have check() restore the originals — the post-run hash would match
  // the seal and a clean receipt would describe bytes no trial exercised.
  const suitePathForSeal = canonicalFlowPath(options.suiteKey ?? resolveEvalSuitePath(resolve(flowPath)));
  let sealBroken = false;
  const sealIntact = async (): Promise<boolean> => {
    if (options.sealedFingerprint === undefined) return true;
    try {
      const now = await buildVerificationFingerprint(flowPath, suitePathForSeal, options.cases, options.environment);
      return now.fingerprint === options.sealedFingerprint;
    } catch {
      return false; // unfingerprintable mid-run = cannot prove integrity — fail closed
    }
  };

  const outcome: EvalSuiteOutcome = {
    pass: 0,
    fail: 0,
    inconclusive: 0,
    flaky: 0,
    invocations: 0,
    total: selected.length,
    failures: [],
    cases: [],
  };

  for (const evalCase of selected) {
    let plan: { repetitions: number; quorum: number };
    try {
      plan = trialPlan(evalCase);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome.fail++;
      outcome.failures.push(reason);
      outcome.cases.push({
        name: evalCase.name,
        status: "fail",
        reason,
        evidence: evalCase.evidence ?? [],
        repetitions: 0,
        quorum: 0,
        passCount: 0,
        flaky: false,
        trials: [],
      });
      log(`  ✗ ${reason}`);
      continue;
    }

    const trials: EvalTrialOutcome[] = [];
    for (let trial = 1; trial <= plan.repetitions; trial++) {
      const usingSandbox = !evalCase.cwd;
      const dir = usingSandbox
        ? mkdtempSync(join(tmpdir(), "mdflow-eval-"))
        : resolve(dirname(resolve(flowPath)), evalCase.cwd!);
      try {
        try {
          await evalCase.setup?.(dir);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A failed fixture is not a paid invocation and, when marked
          // inconclusive, not a behavioral verdict either.
          trials.push(isInconclusiveError(err)
            ? { trial, status: "inconclusive", reason: `setup inconclusive: ${message}` }
            : { trial, status: "fail", reason: `setup failed: ${message}` });
          continue;
        }
        if (!(await sealIntact())) {
          sealBroken = true;
          break;
        }
        // Paid work begins here — count the invocation only once the flow
        // is actually about to run.
        outcome.invocations++;
        const run = await runFlow({
          flowPath,
          prompt: evalCase.prompt,
          stdin: evalCase.stdin,
          cwd: dir,
          timeoutMs: evalCase.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: childEnv,
        });
        if (run.timedOut) {
          trials.push({ trial, status: "inconclusive", reason: `timed out after ${evalCase.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, exitCode: run.exitCode, timedOut: true });
        } else if (run.exitCode !== 0 && run.failureClass && run.failureClass !== "unknown" && !evalCase.allowNonZero) {
          trials.push({ trial, status: "inconclusive", reason: `${run.failureClass} failure (exit ${run.exitCode})`, exitCode: run.exitCode, failureClass: run.failureClass });
        } else if (run.exitCode !== 0 && !evalCase.allowNonZero) {
          trials.push({ trial, status: "fail", reason: `flow exited ${run.exitCode}`, exitCode: run.exitCode });
        } else {
          const verdict = await evalCase.check({ ...run, dir });
          if (!(await sealIntact())) {
            sealBroken = true;
            break;
          }
          trials.push(verdict === null
            ? { trial, status: "pass", exitCode: run.exitCode }
            : { trial, status: "fail", reason: verdict, exitCode: run.exitCode });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trials.push(isInconclusiveError(err)
          ? { trial, status: "inconclusive", reason: message }
          : { trial, status: "fail", reason: message });
      } finally {
        // Only ever delete dirs this run created. An explicit cwd is the
        // user's real directory and must never be cleaned up.
        if (usingSandbox) {
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
        }
      }
    }

    if (sealBroken) {
      outcome.inputsChanged = true;
      outcome.failures.push(
        "EVAL_INPUTS_CHANGED: the flow, suite, imports, hooks, or config changed while the suite ran — receipt withheld"
      );
      log("  ! eval inputs changed during the run — aborting; receipt withheld");
      break;
    }

    const passCount = trials.filter((item) => item.status === "pass").length;
    const failCount = trials.filter((item) => item.status === "fail").length;
    const inconclusiveCount = trials.filter((item) => item.status === "inconclusive").length;
    const flaky = passCount > 0 && failCount > 0;
    if (flaky) outcome.flaky++;
    let status: EvalCaseOutcome["status"];
    let reason: string | undefined;
    if (passCount >= plan.quorum) {
      status = "pass";
      outcome.pass++;
      if (flaky) reason = `quorum met (${passCount}/${plan.repetitions}) but results were flaky`;
    } else if (passCount + inconclusiveCount < plan.quorum) {
      // Quorum-reachability first: when the failed trials alone make the
      // quorum unreachable, inconclusive trials cannot rescue the case —
      // it is a behavioral fail, not a "retry later".
      status = "fail";
      reason = plan.repetitions === 1
        ? trials[0]?.reason ?? "case failed"
        : `quorum missed (${passCount}/${plan.repetitions}, needed ${plan.quorum})`;
      outcome.fail++;
    } else {
      status = "inconclusive";
      reason = `${inconclusiveCount}/${plan.repetitions} trial(s) inconclusive`;
      outcome.inconclusive++;
    }
    const representative = trials.find((item) => item.status !== "pass");
    const caseOutcome: EvalCaseOutcome = {
      name: evalCase.name,
      status,
      reason,
      exitCode: representative?.exitCode,
      timedOut: representative?.timedOut,
      evidence: evalCase.evidence ?? [],
      repetitions: plan.repetitions,
      quorum: plan.quorum,
      passCount,
      flaky,
      trials,
    };
    outcome.cases.push(caseOutcome);
    for (const trial of trials) {
      if (trial.status !== "pass" && trial.reason) {
        outcome.failures.push(plan.repetitions === 1
          ? `${evalCase.name}: ${trial.reason}`
          : `${evalCase.name} [trial ${trial.trial}]: ${trial.reason}`);
      }
    }
    const symbol = status === "pass" && !flaky ? "✓" : status === "fail" ? "✗" : "?";
    log(`  ${symbol} ${evalCase.name}${plan.repetitions > 1 ? `: ${passCount}/${plan.repetitions} passed (quorum ${plan.quorum})` : reason ? `: ${reason}` : ""}${flaky ? " — FLAKY" : ""}`);
  }

  if (!options.noLedger) {
    const suitePath = canonicalFlowPath(options.suiteKey ?? resolveEvalSuitePath(resolve(flowPath)));
    // Every FULL run gets a fingerprint — including flaky and inconclusive
    // outcomes — so their verdicts stay bound to the exact content that
    // produced them (a first-ever flaky run must classify as current Flaky).
    // This never marks such runs clean; recordEvalResult's predicate does that.
    let verification: VerificationFingerprint | undefined;
    if (!filter && outcome.total > 0 && !outcome.inputsChanged) {
      try {
        verification = await buildVerificationFingerprint(flowPath, suitePath, options.cases, options.environment);
      } catch {
        // Unfingerprintable inputs: record the outcome without a receipt —
        // never a partially-computed fingerprint.
        verification = undefined;
      }
      if (verification && options.sealedFingerprint !== undefined && verification.fingerprint !== options.sealedFingerprint) {
        outcome.inputsChanged = true;
        verification = undefined;
        outcome.failures.push(
          "EVAL_INPUTS_CHANGED: the flow, suite, imports, hooks, or config changed while the suite ran — receipt withheld"
        );
        log("  ! eval inputs changed during the run — receipt withheld");
      }
    }
    recordEvalResult(
      suitePath,
      {
        flow: resolve(flowPath),
        pass: outcome.pass,
        fail: outcome.fail,
        total: outcome.total,
        lastRunAt: new Date().toISOString(),
        full: !filter,
        currentClean:
          Boolean(verification) &&
          outcome.fail === 0 &&
          outcome.inconclusive === 0 &&
          outcome.flaky === 0 &&
          outcome.pass === outcome.total &&
          outcome.total > 0,
        verification,
        lastRunFingerprint: verification?.fingerprint,
        inconclusive: outcome.inconclusive,
        flaky: outcome.flaky,
        cases: outcome.cases,
      },
      options.ledgerPath
    );
  }

  return outcome;
}

export interface RunEvalCliOptions {
  cliPath?: string;
  cwd?: string;
}

interface ParsedEvalRunArgs {
  flow?: string;
  planOnly: boolean;
  yes: boolean;
  json: boolean;
  filter?: string;
  help: boolean;
  error?: { code: string; message: string };
}

const EVAL_RUN_USAGE = "Usage: md eval <flow.md> [--plan] [--yes] [--filter <substring>] [--json]";

/**
 * Strict argument grammar for the PAID runner: consent context cannot afford
 * best-effort parsing. Unknown flags, extra positionals, and a valueless
 * --filter are hard errors — never silently reinterpreted as a full run.
 */
function parseEvalRunArgs(args: string[]): ParsedEvalRunArgs {
  const parsed: ParsedEvalRunArgs = { planOnly: false, yes: false, json: false, help: false };
  const extras: string[] = [];
  // The first error wins, but scanning continues so output-shaping flags
  // (--json) seen later still take effect for reporting that error.
  const recordError = (code: string, message: string) => {
    parsed.error ??= { code, message };
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--plan") parsed.planOnly = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--filter" || arg.startsWith("--filter=")) {
      let value: string | undefined;
      if (arg.startsWith("--filter=")) {
        value = arg.slice("--filter=".length);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i++;
        }
      }
      if (!value) {
        recordError(
          "FILTER_VALUE_REQUIRED",
          "--filter requires a value: --filter <substring> or --filter=<substring>"
        );
      } else {
        parsed.filter = value;
      }
    } else if (arg.startsWith("-")) {
      recordError("UNKNOWN_OPTION", `unknown option for md eval: ${arg}\n${EVAL_RUN_USAGE}`);
    } else if (parsed.flow === undefined) {
      parsed.flow = arg;
    } else {
      extras.push(arg);
    }
  }
  if (extras.length > 0) {
    recordError(
      "UNEXPECTED_ARGUMENT",
      `unexpected argument(s): ${extras.join(" ")} — md eval runs exactly one flow\n${EVAL_RUN_USAGE}`
    );
  }
  return parsed;
}

/**
 * In --json mode, executable suite code (import, setup, check) shares the
 * process with the protocol stream. Route console output AND direct
 * process.stdout.write to stderr while it can run — protocol objects are
 * emitted through a raw write handle captured before this patch, so nothing
 * a suite prints can corrupt the JSONL stream.
 */
function redirectConsoleToStderr(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    write: process.stdout.write,
  };
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.debug = (...args: unknown[]) => console.error(...args);
  process.stdout.write = ((chunk: never, ...rest: never[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    process.stdout.write = original.write;
  };
}

/** `md eval <flow.md> [--plan] [--yes] [--filter <substr>] [--json]` */
export async function runEvalCli(args: string[], options?: RunEvalCliOptions | string): Promise<number> {
  const opts: RunEvalCliOptions = typeof options === "string" ? { cliPath: options } : options ?? {};
  const parsed = parseEvalRunArgs(args);
  const json = parsed.json;
  // Bind the protocol writer BEFORE suite code can run. Bun's console.log
  // writes to fd 1 natively (it does not call process.stdout.write), so
  // while redirectConsoleToStderr() below reroutes BOTH console output and
  // process.stdout.write during suite execution, protocol objects emitted
  // through this bound handle keep flowing to the real stdout channel.
  const entryLog = console.log.bind(console);
  const emit = (payload: Record<string, unknown>) =>
    entryLog(JSON.stringify({ protocolVersion: EVAL_PROTOCOL_VERSION, ...payload }));

  if (parsed.help) {
    console.log(`${EVAL_RUN_USAGE}

Run the flow's behavioral eval suite. The suite is a colocated TypeScript
file: <flow>.md is paired with <flow>.eval.ts (flows/review.md ->
flows/review.eval.ts) that default-exports an EvalCase[]:

  export default [
    {
      name: "answers with a number",
      prompt: "What is 2+2?",
      check: ({ stdout }) => (/4/.test(stdout) ? null : "expected a 4 in the answer"),
    },
  ];

Steps and cost:
  md eval flow.md --plan   FREE - static plan only: case names and the paid
                           invocation count; never imports executable suite code
  md eval flow.md          PAID - runs each case against the engine; prints the
                           cost first and asks for confirmation in a TTY

Options:
  --yes, -y                Skip the confirmation (REQUIRED when stdin is not a
                           TTY - agents and CI must pass --yes to spend)
  --filter <substring>     Run only cases whose name contains the substring
  --json                   Machine-readable plan/results on stdout
                           (each object carries protocolVersion ${EVAL_PROTOCOL_VERSION})

Example (agent-safe sequence):
  md eval flows/review.md --plan
  md eval flows/review.md --yes --json`);
    return 0;
  }

  const fail = (reasonCode: string, message: string): number => {
    if (json) emit({ type: "eval.error", reasonCode, message });
    else console.error(message);
    return 1;
  };

  if (parsed.error) return fail(parsed.error.code, parsed.error.message);
  if (!parsed.flow) return fail("FLOW_REQUIRED", EVAL_RUN_USAGE);

  const cwd = opts.cwd ?? process.cwd();
  const flowPath = resolve(cwd, parsed.flow);
  if (!existsSync(flowPath)) {
    return fail("FLOW_NOT_FOUND", `flow not found: ${flowPath}`);
  }

  const suitePath = resolveEvalSuitePath(flowPath);
  if (!existsSync(suitePath)) {
    return fail("SUITE_NOT_FOUND", `no eval suite for ${flowPath}; expected: ${suitePath} (export default an EvalCase[])`);
  }

  // Registry-installed flows carry remote provenance: `md install` never
  // installs eval programs, so a convention sidecar next to one was planted
  // AFTER installation and was never consented to. Realpath-based — invoking
  // the flow through a symlink cannot launder its provenance.
  if (isRegistryPath(flowPath) || isRegistryPath(suitePath)) {
    return fail(
      "UNTRUSTED_SIDECAR",
      `${suitePath} sits next to a registry-installed flow; md install never installs eval programs, ` +
        `so this sidecar was not consented to and will not be executed. ` +
        `Copy the flow into your project to author a suite for it.`
    );
  }

  // One resolved environment governs everything downstream: the static plan's
  // policy repetitions, consent disclosure, the child's config cwd, and the
  // verification fingerprint. Planning with one environment and running with
  // another would make receipts describe a run that never happened.
  let environment: ResolvedEvalEnvironment;
  try {
    environment = await resolveEvalEnvironment(flowPath);
  } catch (error) {
    return fail("ENVIRONMENT_UNRESOLVED", error instanceof Error ? error.message : String(error));
  }

  let staticPlan: EvalSuitePlan;
  try {
    staticPlan = inspectEvalSuitePlan(suitePath, environment.policyRepetitions);
  } catch (error) {
    return fail("UNSAFE_DYNAMIC_SUITE", error instanceof Error ? error.message : String(error));
  }
  const filter = parsed.filter;
  const selectedPlan = filter
    ? staticPlan.cases.filter((item) => item.name.toLowerCase().includes(filter.toLowerCase()))
    : staticPlan.cases;
  const selectedCount = selectedPlan.length;
  if (selectedCount === 0) {
    return fail("FILTER_EMPTY", `no cases match --filter "${filter}" (suite has: ${staticPlan.cases.map((c) => c.name).join(", ")})`);
  }
  const plannedInvocations = selectedPlan.reduce((total, item) => total + item.repetitions, 0);
  // Draft detection is static (never imports the suite): `draft: true` case
  // metadata from the plan, plus the textual MDFLOW_DRAFT_CASE sentinel
  // scoped to managed case blocks. Planning stays free; spending engine
  // invocations on a known always-fail draft is refused.
  const { detectDraftCaseIds } = await import("./eval-convention");
  const sentinelDraftIds = detectDraftCaseIds(readFileSync(suitePath, "utf8"));
  const staticDraftIds = staticPlan.cases.filter((item) => item.draft).map((item) => item.name);
  const draftCaseIds = [...new Set([...staticDraftIds, ...sentinelDraftIds])];
  if (!json) {
    console.log(
      `${basename(flowPath)}: ${selectedCount} case${selectedCount === 1 ? "" : "s"}, ${plannedInvocations} paid invocation${plannedInvocations === 1 ? "" : "s"} including repetitions`
    );
    console.log(`engine: ${environment.engine} (${environment.engineSource})${environment.model ? `, model: ${environment.model}` : ""}`);
    if (draftCaseIds.length > 0) {
      console.log(`draft case(s) remain: ${draftCaseIds.join(", ")} — a paid run is refused until they are replaced`);
    }
  }
  if (parsed.planOnly) {
    if (json) {
      emit({
        type: "eval.plan",
        flowPath: resolve(flowPath),
        suitePath: resolve(suitePath),
        engine: environment.engine,
        engineSource: environment.engineSource,
        model: environment.model ?? null,
        filter: filter ?? null,
        selectedCount,
        plannedInvocations,
        cases: selectedPlan,
        draft: draftCaseIds.length > 0,
        draftCaseIds,
        runnable: draftCaseIds.length === 0,
      });
    }
    return 0;
  }
  if (draftCaseIds.length > 0) {
    return fail(
      "DRAFT_SUITE",
      `${suitePath} still contains draft case(s): ${draftCaseIds.join(", ")}. ` +
        `Replace their draft assertions with real invariants before a paid run.`
    );
  }

  // Seal the verification inputs BEFORE any suite code can run. If this
  // cannot be computed, the run could never produce a bound receipt — refuse
  // rather than spend on unverifiable work.
  let sealedFingerprint: VerificationFingerprint;
  try {
    sealedFingerprint = await buildVerificationFingerprint(flowPath, suitePath, staticPlan.cases, environment);
  } catch (error) {
    return fail(
      "FINGERPRINT_UNAVAILABLE",
      `cannot fingerprint the eval inputs (${error instanceof Error ? error.message : String(error)}); ` +
        `refusing a paid run that could not record a content-bound receipt`
    );
  }

  if (!parsed.yes) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (json || !interactive) {
      if (json) emit({ type: "eval.refused", reasonCode: "CONSENT_REQUIRED", plannedInvocations });
      else console.error("refusing paid eval work without --yes in a non-interactive session.");
      return 1;
    }
    const { confirm } = await import("@inquirer/prompts");
    if (!(await confirm({ message: "Run this executable eval suite?", default: false }))) {
      if (json) emit({ type: "eval.cancelled", plannedInvocations });
      else console.log("cancelled. No flow invocations spent.");
      return 0;
    }
  }

  // Executable suite code can run from here on. In --json mode, keep the
  // protocol stream on stdout clean by routing console output to stderr.
  const restoreConsole = json ? redirectConsoleToStderr() : undefined;
  try {
    // Import only after consent, and only through the ONE shared paid-suite
    // preparation boundary (materialize + freeze + policy repetitions +
    // draft refusal + static-plan equality). md evolve uses the same
    // boundary — a second raw import path would reopen the getter holes.
    let cases: EvalCase[];
    try {
      cases = await importPreparedEvalSuite({
        suitePath,
        policyRepetitions: environment.policyRepetitions,
        staticPlan,
      });
    } catch (error) {
      if (error instanceof EvalSuitePreparationError) return fail(error.reasonCode, error.message);
      return fail("SUITE_INVALID", error instanceof Error ? error.message : String(error));
    }
    // Importing the suite executed its top level — verify it did not rewrite
    // the very inputs the receipt would bind before spending anything.
    try {
      const postImport = await buildVerificationFingerprint(flowPath, suitePath, staticPlan.cases, environment);
      if (postImport.fingerprint !== sealedFingerprint.fingerprint) {
        return fail(
          "EVAL_INPUTS_CHANGED",
          "the flow, suite, imports, hooks, or config changed while the suite module loaded; refusing flow invocations"
        );
      }
    } catch (error) {
      return fail("FINGERPRINT_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }

    const runFlow = makeCliFlowRunner(opts.cliPath ?? join(import.meta.dir, "index.ts"));
    const outcome = await runEvalSuite({
      flowPath,
      cases,
      runFlow,
      filter,
      environment,
      sealedFingerprint: sealedFingerprint.fingerprint,
      log: json ? () => {} : undefined,
    });

    const cleanExit =
      outcome.fail === 0 &&
      outcome.inconclusive === 0 &&
      outcome.flaky === 0 &&
      !outcome.inputsChanged;
    if (json) {
      emit({
        type: "eval.result",
        flowPath: resolve(flowPath),
        suitePath: resolve(suitePath),
        engine: environment.engine,
        model: environment.model ?? null,
        filter: filter ?? null,
        full: !filter,
        plannedInvocations,
        // Child processes ATTEMPTED — a child can still fail before its
        // engine spawns (config, parse, engine resolution), so this is an
        // upper bound on paid engine invocations, not a receipt for them.
        attemptedRuns: outcome.invocations,
        inputsChanged: outcome.inputsChanged ?? false,
        outcome,
      });
      return cleanExit ? 0 : 1;
    }

    console.log(
      `${outcome.pass}/${outcome.total} passed${outcome.fail ? ` — ${outcome.fail} failed` : ""}`
    );
    if (outcome.inputsChanged) {
      console.log("eval inputs changed during the run — no receipt recorded (EVAL_INPUTS_CHANGED)");
    } else if (cleanExit && !filter && outcome.total > 0) {
      console.log(`clean run recorded in trust ledger: ${evalLedgerPath()}`);
    }
    return cleanExit ? 0 : 1;
  } finally {
    restoreConsole?.();
  }
}
