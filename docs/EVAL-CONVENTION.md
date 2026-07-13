# The Eval Convention (2026-07-11)

Status: IMPLEMENTED and hardened. Layers: `src/eval-convention.ts` (template,
markers, static inspection, classifier, coverage), `src/evals-cli.ts`
(management surface), runner hardening in `src/evals.ts`, create/init/
explain/workbench integration, and nine shipped example suites. Design
iterated with Oracle (session `mdflow-eval-convention-design`, archived at
`.artifacts/2026-07-11-eval-convention-oracle.md`), then hardened through
two audits (`.artifacts/2026-07-11-eval-implementation-critique-oracle.md`
and `.artifacts/2026-07-11-eval-hardening-audit-oracle.md`). Brainstorm
source: the Script Kit × mdflow "Quality Eval Bars" page (fail-closed
classifiers, hash-bound receipts, coverage ratchet, two-sided bands, no
silent caps).

This document describes CURRENT behavior; the section below headed
"Historical framing" preserves the original proposal context.

## Historical framing (as designed, 2026-07-11)

Before this work, the eval RUNNER (`src/evals.ts`) was already mature —
static `--plan`, consent before paid runs, hermetic workspaces,
repetitions/quorum, failure-class triage, fingerprint-bound trust ledger —
but the repo shipped zero `.eval.ts` files and had no CONVENTION LAYER
making evals feel like hooks (`md hooks add|list|remove`). The old
`starterEvalSource()` length-check stub in `src/init.ts` was deleted as part
of this work; `md init` now copies real catalog suites.

## The headline loop (the shippable slice)

```
md create "review staged changes"
  → flows/review.md + flows/review.eval.ts   (draft suite)
md eval list flows/review.md                 → Unverified (draft remains)
  → edit the invariant
md eval flows/review.md --plan               (free)
md eval flows/review.md --yes                (paid)
md eval list flows/review.md                 → Verified
  → edit flow / import / hooks / config / engine / model / suite
md eval list flows/review.md                 → Stale
```

## Decisions

### 1. Keep the `md eval` noun — no separate `md evals`

The existing command owns the whole lifecycle:

```
md eval <flow.md> [--plan] [--yes] [--filter <text>] [--json]     PAID (existing)
md eval add <flow.md> [output|stdin|prompt|fixture|stochastic|nonzero]…   LOCAL WRITE
md eval list [<flow.md>|<flows-dir>] [--json]                     FREE, read-only
md eval remove <flow.md> [case-id…] [--yes]                       LOCAL WRITE
md eval coverage [<flows-dir>] [--baseline <path>] [--json]       FREE, read-only
```

`add`/`remove` never call an engine (same contract as `md hooks`). `list`,
`coverage`, `--plan`, and `md explain` never import suite code (static AST /
marker parse only — the eval parallel of `listHandledEventsStatic`).

### 2. Recipe-based scaffold with stable markers, fail-closed drafts

New `src/eval-convention.ts` mirrors `renderHooksTemplate` + surgical marker
edits from `src/hooks-cli.ts`:

```ts
export const EVAL_CASES_OPEN_MARKER = "const cases: EvalCase[] = [";
export const EVAL_INSERT_MARKER   = "  // mdflow:case:insert";
export const EVAL_CASE_START_PREFIX = "  // mdflow:case:start ";
export const EVAL_CASE_END_PREFIX   = "  // mdflow:case:end ";
export const EVAL_DRAFT_MARKER    = "MDFLOW_DRAFT_CASE";
```

Six recipes, each a teaching block: `output` (default), `stdin`, `prompt`
(positional `_1`/`_args`), `fixture` (`setup()` + `ctx.dir`), `stochastic`
(repetitions+quorum), `nonzero` (`allowNonZero` + `failureClass` inspection).
`inferEvalRecipes(flowSource)` picks recipes deterministically: `{{ _stdin`
→ stdin, `{{ _1`/`{{ _args` → prompt, `` !` `` → fixture, else output.

**The scaffold cannot mint a hollow receipt**: every draft case carries
STATIC `draft: true` metadata (the primary mechanism, read by the free
planner) AND returns `"MDFLOW_DRAFT_CASE: …"` (i.e. always fails). Paid
execution — `md eval` and `md evolve` alike — is refused while either
signal remains (`DRAFT_SUITE` error; `--plan` stays free and reports
`"draft": true`). Un-drafting a case therefore takes BOTH edits: replace the
assertion with a real invariant and delete the `draft: true` line. The
sentinel scan is scoped to the managed cases array, so mentioning
MDFLOW_DRAFT_CASE in docs or comments does not poison a suite. Surgical
edit rules: insert only at
the single exact insert marker; duplicate recipe = no-op; missing/duplicate/
unbalanced markers fail loudly ("edit it manually"); hand-written suites stay
runnable/listable, just not recipe-editable; preserve CRLF.

### 3. One fail-closed verdict classifier, used everywhere

`classifyEvalVerdict()` in `src/eval-convention.ts` is the single source for
`Verified | Stale | Flaky | Failing | Unverified` — consumed by `md eval
list`, `md explain`, `src/workbench-status.ts` (delete its independent
verdict logic), and Script Kit via `md eval list --json` (protocolVersion 1).

Precedence (fail-closed): missing/draft/uninspectable suite → **Unverified**;
fingerprint mismatch → **Stale** (old bytes, regardless of old outcome);
current mixed trials → **Flaky**; current behavioral failures → **Failing**;
current inconclusive (provider/auth/env) → **Unverified**; only a full,
current, fingerprint-bound, all-pass run → **Verified**. Filtered runs never
produce a clean receipt. Legacy non-fingerprinted passes → Unverified.

Required ledger change in `src/evals.ts`: record a fingerprint for **every**
full run (today it's skipped when flaky/inconclusive, so a first-ever flaky
run can't classify as current Flaky), and tighten the `clean` predicate to
also require `pass === total`, zero inconclusive, zero flaky. Coordinate with
Script Kit before release. Also fix the `md eval --help` example (shows a
boolean-returning `check(output)`; real contract is `check(ctx) → string | null`).

### 4. `md create` scaffolds the suite by default; `md init` ships real ones

- `src/create.ts`: `withEval: boolean` (default true), `--no-eval` opt-out,
  dry-run previews both files, orphaned sibling suite = conflict, roll back
  the flow if the suite write fails.
- `src/init.ts`: delete `starterEvalSource()`; `CatalogEntry.evalContent`
  loads a real sibling `assets/init/catalog/<name>.eval.ts`, falling back to
  the draft template only when absent.
- `src/explain.ts`: new BEHAVIORAL EVAL section (static planner + ledger
  only): suite path, cases, paid invocations, verdict + reason, fingerprints,
  next command. Eval-suite edits do NOT change `configFingerprint` (execution
  config is separate from proof state).

### 5. Coverage ratchet: `md eval coverage` (free, CI-safe)

Asks only "does every flow have a statically inspectable, non-draft,
non-empty sibling suite?" — never requires Verified (CI must not need paid
calls). Committed shrink-only baseline: new uncovered flow not in baseline →
fail; baseline entry whose flow gained a suite or vanished → zombie → fail;
never auto-widen; project-relative POSIX paths; print scanned/returned counts
(no silent caps).

### New/changed files

| File | Change |
|------|--------|
| `src/eval-convention.ts` | NEW: template, markers, recipes, static inspection, classifier, coverage |
| `src/evals-cli.ts` | NEW: `runEvalCommand` routes add/list/remove/coverage vs paid run |
| `src/evals.ts` | fingerprint-on-every-full-run, tighter clean predicate, draft refusal, help fix |
| `src/cli-runner.ts` | route `eval` through `runEvalCommand` (cwd + TTY state) |
| `src/create.ts`, `src/workbench-model.ts` | paired suite creation, rollback |
| `src/init.ts` | delete stub; copy real catalog suites |
| `src/explain.ts`, `src/workbench-status.ts` | canonical verdict surface |
| `src/eval-convention.test.ts`, `src/evals-cli.test.ts`, `src/shipped-evals.test.ts` | NEW tests (mirror hooks-cli.test.ts) |

## The 9 shipped example suites

20 cases, 22 paid invocations total (only pr-description repeats: 3 trials,
quorum 2; audit gained a CLEAN case in the post-critique hardening pass —
see `.artifacts/2026-07-11-eval-implementation-critique-oracle.md`). The
original ready-to-land code for all nine is in the archived Oracle design
answer (`.artifacts/2026-07-11-eval-convention-oracle.md`, section 3). Every
check is invariant-based (structure, counts, bounds, file existence) — never
exact wording. Each teaches one distinct EvalCase capability:

| # | Suite | Capability showcased | Guardrail → real failure caught |
|---|-------|---------------------|--------------------------------|
| 1 | `examples/commit.claude.eval.ts` | stdin piping; two-sided bounds | prose/multi-line output, non-conventional format, ≥72 chars, vague (<12 chars), commit hashes, description that ignores the diff (anchor regexes per fixture diff) |
| 2 | `assets/init/catalog/review.eval.ts` | `setup()` git fixtures; staged-diff review | misses a planted `<=` off-by-one or `=` vs `===` authorization bug, no `file:line` citation, not terse (>220 words) or too thin (<12 words) |
| 3 | `assets/init/catalog/changelog.eval.ts` | git-history fixtures; structural section parsing | no feature/fix/chore grouping, leaked commit hashes, copied `feat(scope):` subjects verbatim, misses ≥2 of the actual changes, too thin/bloated |
| 4 | `assets/init/catalog/onboard.eval.ts` | filesystem assertions via `ctx.dir` | **hallucinated file paths** (every cited path must exist in the fixture), <3 real files cited, never points into `src/`, doesn't explain the fixture's purpose |
| 5 | `assets/init/catalog/pr-description.eval.ts` | repetitions: 3 + quorum: 2 (stochastic) | unstable writer, ≥200 words, hashes, missing why/verification, outcome buried (first 3 content lines must hit an anchor) |
| 6 | `assets/init/catalog/fix-tests.eval.ts` | repo-mutating kind; check() re-runs `bun test` | agent edits/disables the test instead of the code (`.skip`/`.only` ban, test bytes must equal original), source unchanged, suite still red, timeout |
| 7 | `examples/multi-agent/audit.claude.eval.ts` | positional prompt; strict JSON validation; CLEAN no-findings contract; `allowNonZero` + `failureClass` | prose-wrapped/malformed JSON, no valid line numbers, missing a separate finding for EITHER planted exposure (SQL injection, credential logging), invented findings on a safe file, silent success on a missing input file |
| 8 | `examples/multi-agent/patch.claude.eval.ts` | prompt + stdin together; output must transpile (`Bun.Transpiler`) | code wrapped in fences/prose, invalid TS, removed public API, SQL still interpolated, no bound parameter, clean-file no-op regression |
| 9 | `examples/logo-grid.claude.eval.ts` | structured HTML/SVG inspection; exact cardinality | wrong count of `logo-1..6` ids, wrong viewBox, `<script>`/`<img>`/external URLs, missing dark-mode/16px/32px previews, >3 literal colors per mark, `<text>` elements, CSS-class-dependent marks |

(1, 7, 8, 9 target claude via filename; 2–6 are engine-agnostic catalog flows
that double as the `md init` scaffolds — replacing the length-check stub.)

## Risks called out

- **Missing git** in catalog fixtures: RESOLVED — `setup()`/`check()` can
  throw `EvalInconclusiveError` (or any error whose message starts with
  `INCONCLUSIVE:`, so dependency-free suites participate) to mark a trial
  environment-inconclusive instead of a behavioral failure. The git-fixture
  catalog suites use exactly this.
- **`allowNonZero` is broad**: cases must inspect `failureClass` themselves
  (audit suite shows the pattern); later replace with `expectedExitCodes`.
- **Ledger compat**: additive fields only, never reinterpret old
  non-fingerprinted passes as Verified, never rewrite on read; coordinate the
  fingerprint-on-flaky change with Script Kit.
- **Windows**: POSIX paths for comparison only, native for fs; CRLF-preserving
  surgical edits; git via argv arrays, never shell strings.
- **Threshold calibration**: the numeric bands are guardrails; first real
  runs may need loosening — adjust bounds, never replace with prose snapshots.

## Verification sequence

1. `bun test --bail=1` (plus new focused test files).
2. Free static sweep: `bun run src/index.ts eval "$flow" --plan --json` for
   all nine — expect aggregate 9 suites / 20 cases / 22 invocations
   (`src/shipped-evals.test.ts` locks this so cost creep is visible in review).
3. `md eval list … --json`, `md explain … --json`, `md eval coverage examples --json`.
4. One real paid end-to-end: `md eval examples/commit.claude.md --yes` →
   `md eval list` reports **Verified**; unit tests prove any edit to flow,
   suite, imports, hooks, config, engine, or model flips it to **Stale**.
