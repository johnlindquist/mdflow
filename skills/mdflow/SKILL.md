---
name: mdflow
description: Build and maintain a project's ./flows directory, the agent roster. Each flow is one markdown file that runs as an AI agent (frontmatter + prompt body) on claude, codex, pi, cursor-agent, copilot, agy, or any CLI engine, with colocated behavioral evals. Use when the user asks to "create a flow", "add an agent to this repo", "set up ./flows", "make a markdown agent", or wants repeatable AI tasks with evals.
---

# mdflow: the ./flows agent roster

Every repo deserves an agent roster. `./flows` holds one markdown agent per
job: code review, release notes, issue triage. Flows are diffable in PRs,
provable with `md eval`, and new teammates (human or AI) learn how the
project works by reading them.

A flow is one markdown file. Frontmatter is config. The body is the prompt.
mdflow spawns the right engine CLI and passes everything through.

```markdown
# flows/review.md
---
description: review staged changes
---
Review this diff for bugs. Be terse, cite file:line.

!`git diff --cached`
```

**Every real run launches a paid flow invocation.** Provider turns, tokens,
tool calls, and currency vary by engine and task. Say what is known before
running flows for the user. Dry runs are free.

## Step 0: is mdflow installed? (free)

```bash
command -v md || npm i -g mdflow
```

## The roster convention

When a project has no `./flows` yet, scaffold the full convention:

```
flows/
├── README.md          # roster index: one line per flow, what it does, its eval status
├── review.md          # one markdown agent per job
├── review.eval.ts     # colocated proof
└── ...
.mdflow.yaml           # project engine + evolve.mode: suggest
```

Rules:

1. One flow per repeatable job. If the user does a task twice, offer to make
   it a flow.
2. Every flow gets `description:` frontmatter. Frontmatter is what marks a
   file as a flow instead of a document.
3. Every production flow gets a colocated `<name>.eval.ts` before it is
   trusted or evolved. The deterministic starter scaffold creates a generic
   smoke guardrail; replace it with project-specific proof while tailoring.
   The creed: if a guardrail isn't covered by an eval, it's a wish.
4. Keep `flows/README.md` current. It's the index your future self and other
   agents read first.
5. Pin the project's default engine in `.mdflow.yaml` (`engine: pi`,
   `engine: claude`, whatever CLI the user has). Individual flows only pin an
   engine when the job demands a specific one.
6. For an interactive specialist that accepts an optional initial task, choose
   deliberately between a seeded session and a waiting session. A waiting
   session MUST put identity in `_system-prompt`, operating rules plus stable
   trusted context in `_append-system-prompt`, declare `_task: ""`, and use a
   body consisting of exactly `{{ _task }}`. Never add `User task:`, headings,
   imports, placeholder prose, or instructions to that body: any non-empty
   rendered body becomes a submitted first user turn instead of waiting.

The required waiting-specialist shape is:

```markdown
---
description: specialist that waits for the user's task
_interactive: true
_task: ""
_system-prompt: |-
  You are the specialist.
_append-system-prompt: |-
  Put the complete operating contract and stable trusted context here.
---

{{ _task }}
```

Do not move stable agent instructions or migrated contract material into the
user body. If the user supplies `_task`, it becomes the initial user turn; if
they do not, mdflow must launch the configured engine with no positional prompt.

## Engines: the resolution ladder

You usually don't pick an engine per flow. The ladder does, most explicit
first: `--engine` flag, `MDFLOW_ENGINE` env, filename (`review.claude.md`),
frontmatter `engine:`, project `.mdflow.yaml`, then the default (`pi`, which
runs with its ambient extensions and context disabled and bridges the user's
Codex CLI login automatically).
Implicit picks print a dim `review.md → pi (engine: config)` line on stderr.

## Context: go big, then measure

Flows earn their keep through context. A flow that imports the right 30k
tokens of code, conventions, and live command output beats a clever
one-liner every time. Build rich context deliberately:

- `@./src/**/*.ts` globs, `@./file.ts:10-50` line ranges, `@./file.ts#Symbol`
  symbol extraction
- `` !`git log -20` `` live command output, inlined at run time
- `{{ _var }}` template variables, filled via `--_var value`

Target as much context as the job genuinely benefits from, tens of thousands
of tokens is normal for review/audit flows (think up to ~50k). But never
guess at size. Measure, every time:

```bash
md flows/review.md --_context    # context tree: every import with token counts
md flows/review.md --_dry-run    # command plan + prompt; inline commands are skipped
```

Show the user the token number before the first real run. For guardrails,
set `_max_prompt_tokens:` in frontmatter (blocks execution over budget) or
`_context_budget_tokens:` (trims provider output to fit). Oversized globs
fail safe by default; `MDFLOW_FORCE_CONTEXT=1` overrides intentionally.

## Evals: the proof

```ts
// flows/review.eval.ts
import type { EvalCase } from "mdflow/src/evals";

const cases: EvalCase[] = [
  {
    name: "flags the planted bug",
    setup: (dir) => {
      // write fixtures into the sandbox the flow will run in
    },
    check: ({ stdout, dir, exitCode }) => {
      if (exitCode !== 0) return `exit ${exitCode}`;
      return /file:\d+|bug|issue/i.test(stdout) ? null : "review missed the planted bug";
    },
  },
];

export default cases;
```

`md eval flows/review.md` runs each case in an isolated temp workspace and records
content-bound receipts in the trust ledger (`~/.mdflow/eval-results.json`). Run
`md eval flows/review.md --plan` first; repetitions affect the paid invocation
count. Keep the default case array statically resolvable so planning can inspect
names/cost without importing executable suite code. An actual run requires interactive confirmation or `--yes`, so get the
user's go-ahead.
Check invariants (files, numbers, names), not exact wording. When a real run
disappoints, record it with `md feedback`, then add a feedback-linked case.
Nonzero exits fail by default, timeouts are inconclusive, and mixed repeated
trials are flaky rather than clean. The workspace isolation is not a network, process, or
credential sandbox; the selected engine still receives the environment and
capabilities its adapter allows.

## Feedback and proposal-first evolution

Never describe Evolve as self-editing or auto-applying. Follow this sequence:

```bash
md feedback flows/review.md "missed the renamed-file regression"
md feedback show <feedback-id>
md feedback distill <feedback-id>   # private, deliberately failing draft
md feedback forget <feedback-id> --yes  # permanent privacy deletion
md eval flows/review.md --plan
md evolve plan flows/review.md      # free; shows proof, capabilities, cost, writes
md evolve propose flows/review.md   # paid only after consent
md evolve show <run-id>             # inspect decision and prompt/capability diff
md evolve apply <run-id>            # separate explicit source mutation
```

Review generated eval code before copying it into a suite: evals are executable
TypeScript. Set `evidence: ["fb_..."]` on a case that reproduces the report.
Only current-fail/proposal-pass on such a case is a verified improvement. A
green uncovered candidate is only regression-safe.

Proposals and receipts are private/off-path; the canonical flow remains
byte-identical until explicit apply. New command/import/network/file capabilities
are blocked before candidate execution. `evolve: auto` is a compatibility alias
for queued proposal-only work. Prefer this project default:

```yaml
engine: <confirmed engine>
evolve:
  mode: suggest
```

`--no-evolve` or `MDFLOW_EVOLVE=off` disables post-run handling. Do not enable
unattended apply: it is intentionally not available.

## Workflow for "add an agent for X"

1. Scaffold `./flows` if missing (directory, README.md index, `.mdflow.yaml`).
2. Write `flows/<job>.md`: `description:` frontmatter, tight prompt body,
   rich imports for the context the job needs.
   - If it is a waiting interactive specialist, apply the exact shape above;
     keep all stable context in the instruction layers and the body task-only.
3. Measure for free: `md flows/<job>.md --_context` for the token breakdown,
   `--_dry-run` for the command plan and safe prompt preview. Inline commands
   and executable code fences are shown but not executed; file, URL, and
   context-provider imports may still resolve. Report the size.
4. Write `flows/<job>.eval.ts` with 1 to 3 behavioral cases.
5. Update `flows/README.md`.
6. Show `md eval flows/<job>.md --plan`, then offer the separate paid flow and
   eval runs. Never infer consent for one from consent for the other.

For every waiting interactive specialist, also run `md explain <flow>` and
`md <flow> --_interactive --_dry-run`. Reject the generated flow unless both
instruction layers are present, the final prompt is blank without `_task`, and
the command has no empty or placeholder positional prompt. Inspect the source
body too: after frontmatter it must contain only `{{ _task }}`.

## Migrating v2 files

Move loose agent .md files into `./flows`. `tool:` frontmatter becomes
`engine:` (old key warns). `--_command`/`--tool` flags become `--engine`.
`*.gemini.md` becomes `*.agy.md` (Google sunset the gemini CLI; agy is the
successor and `--yolo` is gone there). Bare `task.md` now runs on the
resolved engine instead of erroring; frontmatter-less files print as
documents.
