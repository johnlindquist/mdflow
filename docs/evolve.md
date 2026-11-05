# Evolve: change with proof

Evolve turns feedback into a reviewable prompt proposal. It is proposal-first:
the canonical flow stays byte-identical while mdflow drafts, capability-checks,
and evaluates a candidate in private, off-path workspaces. Applying the result
is a separate explicit command.

The trust loop is:

```text
feedback -> reviewed eval -> plan -> private proposal -> verification
         -> review -> explicit apply or reject -> optional rollback
```

## Quick start

```bash
md feedback flows/review.md "missed the renamed-file regression"
md feedback show <feedback-id>
md feedback distill <feedback-id>       # private, untrusted eval draft

md eval flows/review.md --plan          # free cost preview
md eval flows/review.md --yes           # paid, executable suite

md evolve plan flows/review.md          # free readiness/cost preview
md evolve propose flows/review.md        # asks before paid work
md evolve show <run-id>                  # decision, capability diff, prompt diff
md evolve apply <run-id>                 # atomic compare-and-swap
md evolve rollback <run-id>              # only if source still matches
md evolve prune --days 30 --yes           # remove old private attempts/logs
```

`md complain` remains an alias for `md feedback`. `md evolve --check` remains a
deprecated alias for `md evolve plan`. Machine use can select `--json`; proposal
runs also support `--events` for NDJSON progress. The lifecycle also includes
`md evolve status`, `history`, `reject`, and `retry`.

## What the outcome means

| Outcome | Claim mdflow can make | Source changed? |
| --- | --- | --- |
| `verified_improvement` | A feedback-linked case failed on current, passed on the proposal, and all proposal guardrails were clean and non-flaky. | No |
| `regression_safe` | Declared guardrails passed, but the reported problem was not proved red/green. | No |
| `rejected` | At least one proposal guardrail failed. Evidence remains open. | No |
| `inconclusive` | Timeout, infrastructure uncertainty, or flake prevented a trustworthy result. | No |
| `capability_rejected` | The proposal added an import, command, URL, provider, executable fence, or broader file capability forbidden by policy. | No |

A regression-safe proposal is useful, but it is not a proven fix. Distill helps
turn feedback into a draft case. The draft deliberately fails and lives under
`~/.mdflow/evolution/drafts/`; a human must review its executable assertion and
copy it into the colocated suite before it can become trusted.

## Durable evidence

Feedback receives a stable `fb_...` ID and moves through:

```text
open -> targeted -> resolved | dismissed
```

Rejected and inconclusive attempts do not consume the problem. Evidence is an
append-only private log, messages are limited to 4,000 bytes, and run artifacts
live outside the repository by default. Use:

```bash
md feedback list [flow.md]
md feedback show <feedback-id>
md feedback dismiss <feedback-id>
md feedback reopen <feedback-id>
md feedback forget <feedback-id> --yes  # explicit permanent privacy deletion
```

Normal status changes append records. `forget` is the deliberate exception: it
compacts the private evidence log and removes that item, its status history,
associated drafts/run receipts, and matching background-job logs.

`md evolve prune` provides retention control for old private attempts and
completed/failed job logs. It requires confirmation (or `--yes`) and retains
applied runs because their rollback lineage is still live.

Quick reruns are ambiguous. When enabled as a trigger they create only a
low-confidence observation and suggestion; they never authorize paid work or a
source edit.

## Policy

Set policy in flow frontmatter or project/global config:

```yaml
evolve:
  mode: propose             # off | observe | suggest | propose | apply
  triggers:
    - explicit-feedback
    - classified-failure
  maintainer:
    engine: claude
    model: opus
    isolated: true
    timeout-ms: 180000
  budget:
    max-invocations: 9
    max-per-day: 2
    cooldown-ms: 86400000
  gate:
    require-feedback-eval: true
    allow-capability-delta: false
    repetitions: 1
  apply: review
```

Modes are deliberately conservative:

- `off`: no automatic observation or work.
- `observe`: retain enabled evidence without notifications or paid work.
- `suggest`: surface the next free action. Workflow runs can capture evidence,
  but proposal planning refuses them until step-level attribution exists.
- `propose`: after explicit actionable feedback and a content-current receipt,
  print the bounded plan and queue a background proposal. The receipt may be
  clean or may contain only failures linked to the targeted feedback. The
  source remains unchanged.
- `apply`: reserved policy tier. It currently retains proposal-only automatic
  behavior; unattended source application is not enabled.

Legacy `evolve: auto` maps to `propose`. `MDFLOW_EVOLVE=off` and `--no-evolve`
are immediate escape hatches. Automatic proposals have a per-flow job queue,
cooldown, daily limit, and invocation ceiling. Their private log path is printed
before the job starts.

Workflow runs receive the same feedback affordances, but proposal generation
currently refuses with `WORKFLOW_UNSUPPORTED`. Safe workflow evolution needs
step-level attribution so one complaint cannot rewrite the wrong agent node.

## Verification receipts

An eval suite is executable TypeScript. Review it before running it. Paid evals
require interactive confirmation or `--yes`; `--plan` is free and accounts for
repeated trials by statically inspecting the suite without importing or running
its top-level code. Suites use a statically resolvable default array so cost and
feedback coverage cannot change after consent without a refusal.

Each case may declare:

```ts
{
  name: "cites the renamed file",
  kind: "stochastic",
  repetitions: 3,
  quorum: 3,
  evidence: ["fb_..."],
  check: ({ stdout }) => /renamed-file\.ts:\d+/.test(stdout)
    ? null
    : "missing renamed file citation",
}
```

Unknown nonzero exits fail unless `allowNonZero: true`. Recognized provider,
authentication, environment, and cancellation failures—and timeouts—are
inconclusive rather than behavioral failures.
Mixed pass/fail repetitions are marked flaky and cannot mint a clean receipt,
even if their quorum passes.

Receipts bind the flow and execution-relevant imports, the suite and its local
module graph, merged config, resolved engine/model, mdflow version, and case
definitions. A later edit invalidates the receipt instead of relying on a
wall-clock `lastCleanAt` claim.

## Proposal transaction

Every paid proposal gets an `evr_...` run with immutable inputs, JSON results,
an append-only event journal, prompt and capability diffs, planned/actual
invocation counts, and a durable decision. Current and proposal evals execute
from separate repository snapshots under the private run directory. Keep `MDFLOW_EVOLUTION_HOME` outside the source tree. A Git snapshot uses tracked and non-ignored files; a non-Git directory uses filesystem traversal. Both omit common credential names and refuse escaping symlinks. This is not a secret scanner. The maintainer reads its configuration from the project but starts in a temporary working directory, not the live checkout.

Apply acquires a per-flow lock and uses compare-and-swap against the exact base
hash. Writes use same-directory temp files, fsync, and rename. A human edit made
after proposal creation is never overwritten. Rollback has the same hash guard,
and the proposal and rollback artifact bytes must match the recorded hashes before writing. Interrupted apply/rollback states recover from content hashes rather than
guessing from backup filenames.

## Security boundary

Off-path workspaces prevent candidate verification from changing the canonical
checkout. They are not host sandboxes. Eval modules and selected engines still
have the filesystem, network, credentials, and process access granted to the
current user. Symlinks escaping a snapshot are rejected and timed-out process
groups receive TERM then KILL, but untrusted suites must not be executed.

Automatic proposals cannot apply changes. New capabilities are blocked before
candidate evaluation unless an explicit policy permits the private experiment.
There is currently no unattended apply, canary, or auto-commit behavior.

Private proposal snapshots can contain repository context. `md evolve prune`
provides an explicit retention control for old terminal runs and completed job
logs; applied lineage is retained so rollback provenance is not silently lost.
