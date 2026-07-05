---
name: mdflow
description: Build and maintain a project's ./flows directory, the agent roster. Each flow is one markdown file that runs as an AI agent (frontmatter + prompt body) on claude, codex, pi, cursor-agent, copilot, agy, or any CLI engine, with colocated evals that prove behavior. Use when the user asks to "create a flow", "add an agent to this repo", "set up ./flows", "make a markdown agent", or wants repeatable AI tasks with evals.
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

**Every real run costs one engine turn.** Say so before running flows for
the user. Dry runs are free.

## Step 0: is mdflow installed? (free)

```bash
command -v md || npm i -g mdflow@next   # v3 prerelease; drop @next once 3.0 ships
```

## The roster convention

When a project has no `./flows` yet, scaffold the full convention:

```
flows/
├── README.md          # roster index: one line per flow, what it does, its eval status
├── review.md          # one markdown agent per job
├── review.eval.ts     # colocated proof
└── ...
.mdflow.yaml           # project config: engine: <default for this repo>
```

Rules:

1. One flow per repeatable job. If the user does a task twice, offer to make
   it a flow.
2. Every flow gets `description:` frontmatter. Frontmatter is what marks a
   file as a flow instead of a document.
3. Every flow gets a colocated `<name>.eval.ts` at birth. The creed: if a
   guardrail isn't covered by an eval, it's a wish.
4. Keep `flows/README.md` current. It's the index your future self and other
   agents read first.
5. Pin the project's default engine in `.mdflow.yaml` (`engine: pi`,
   `engine: claude`, whatever CLI the user has). Individual flows only pin an
   engine when the job demands a specific one.

## Engines: the resolution ladder

You usually don't pick an engine per flow. The ladder does, most explicit
first: `--engine` flag, `MDFLOW_ENGINE` env, filename (`review.claude.md`),
frontmatter `engine:`, project `.mdflow.yaml`, then the default (`pi`, which
runs hermetic and bridges the user's Codex CLI login automatically).
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
md flows/review.md --_dry-run    # full resolved prompt + estimated tokens
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

`md eval flows/review.md` runs each case in a hermetic temp dir and records
results in the trust ledger (`~/.mdflow/eval-results.json`). It prints the
cost (one engine turn per case) before running; get the user's go-ahead.
Check invariants (files, numbers, names), not exact wording. When a real run
disappoints, write the failing eval case first, then edit the flow until
`md eval` passes.

## Workflow for "add an agent for X"

1. Scaffold `./flows` if missing (directory, README.md index, `.mdflow.yaml`).
2. Write `flows/<job>.md`: `description:` frontmatter, tight prompt body,
   rich imports for the context the job needs.
3. Measure for free: `md flows/<job>.md --_context` for the token breakdown,
   `--_dry-run` for the exact command and resolved prompt. Report the size.
4. Write `flows/<job>.eval.ts` with 1 to 3 behavioral cases.
5. Update `flows/README.md`.
6. Offer the paid steps: `md flows/<job>.md` (one turn) and
   `md eval flows/<job>.md` (one turn per case).

## Migrating v2 files

Move loose agent .md files into `./flows`. `tool:` frontmatter becomes
`engine:` (old key warns). `--_command`/`--tool` flags become `--engine`.
`*.gemini.md` becomes `*.agy.md` (Google sunset the gemini CLI; agy is the
successor and `--yolo` is gone there). Bare `task.md` now runs on the
resolved engine instead of erroring; frontmatter-less files print as
documents.
