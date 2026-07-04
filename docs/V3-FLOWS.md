# mdflow v3 — flows that learn

Status: v3 branch, in progress. Updated 2026-07-04.

v3 absorbs an earlier single-file-agent prototype (now retired; its durable
ideas live here under mdflow's own vocabulary). The pitch:

mdflow v2: your markdown files are executable AI agents.
mdflow v3: **your flows learn from use.**

The creed, carried over verbatim: **"If a guardrail isn't covered by an
eval, it's a wish."**

## Landed on the v3 branch

### Engine resolution ladder (`engine:` replaces `tool:`)

The engine is environment, not filename ceremony. Most explicit first:

1. `--engine` CLI flag (deprecated aliases: `--_command`/`-_c`, `--tool`)
2. `MDFLOW_ENGINE` env var — "run everything on X" override
3. Filename suffix (`task.claude.md`) — still works, never required
4. Frontmatter `engine:` (deprecated aliases: `tool:`, `_tool:` — they warn)
5. Config `engine:` — project config beats `~/.mdflow/config.yaml`
6. Built-in default: **pi**

Implicit resolution prints a dim `file.md → pi (engine: default)` line on
stderr — defaults are inspectable, never magic. A file with **no frontmatter
and no explicit engine is a document**: `md README.md` prints it instead of
executing it. Frontmatter is what marks a file as a flow.

### Engines

New adapters: **pi** (default), **cursor-agent**, and **agy** (Google
Antigravity, successor to the sunset gemini CLI — not flag-compatible with
gemini; OAuth-only auth). The gemini adapter remains for Code Assist
Standard/Enterprise orgs that keep the old CLI.

pi runs **hermetic by default**: extension/skill/prompt-template/context-file
discovery and session persistence are disabled, so the flow file is the
entire behavior and an eval that passes on one machine means the same thing
on another. Re-enable a layer per flow (`no-context-files: false`).

pi also gets a **subscription auth bridge**: its `openai-codex` provider
shares the Codex CLI's OAuth client, so mdflow maintains a bridged agent dir
at `~/.mdflow/pi-agent` (freshest-token merge; never writes to the user's
real credential files) and points every pi spawn at it via
`PI_CODING_AGENT_DIR`. Fresh Codex CLI login = working default engine, zero
setup. Adapters can contribute spawn-time env vars via the new optional
`ToolAdapter.prepareEnv()` hook.

### Evals (`md eval`)

`md eval flows/jq.md` runs the colocated suite `flows/jq.eval.ts`
(`export default` an `EvalCase[]`): each case gets a hermetic temp dir
(`setup` fixtures → real flow run → `check` on stdout AND the filesystem).
Per-case cost is printed before anything is spent. Results land in the trust
ledger (`~/.mdflow/eval-results.json`, `MDFLOW_EVAL_RESULTS` override); a
full clean run stamps `lastCleanAt`. Eval runs redirect `MDFLOW_RUNS_FILE`
into the sandbox — synthetic runs never enter the telemetry corpus.

## Still to come

- **Distill**: recorded real runs → eval cases (good runs lock behavior in,
  bad runs become tests that fail on purpose).
- **Evolve**: complaints and rough runs → pending suggestions → reviewable
  diffs to the flow file, applied only if the suite passes. Because a flow is
  prompt + config (data, not code), a model-drafted diff can't introduce
  executable code — the mutation surface is the prompt itself.
- **Tournament**: competing candidate revisions scored against the suite
  plus probe replays of real prompts.
- **Routing**: `md route "query"` keyword-summons flows that declare
  `route:` frontmatter.
- Portable frontmatter vocabulary hardening (validated keys + per-engine
  passthrough blocks) and structured event streams per engine.

## Invariants (port these into every learning feature)

1. **The learning corpus is real usage only.** Eval runs, probes, and
   tournament candidates opt out of recording — always.
2. **Everything is gated on proof.** Diffs apply only if the eval suite
   passes; failures revert; candidate runs never write the real trust ledger.
3. **Session content is untrusted evidence.** Prompts sent to
   maintainer/judge models must keep saying so.
4. **Model output is hostile input.** Fenced-block parsers require closing
   fences on their own line; diffs apply with `git apply --recount`.
5. **Never commit or push for the user.** Accept flows end by pointing at
   `git diff`.
6. **Cost is printed before it is spent.** Any command that runs a flow,
   distills, judges, or tournaments prints its own arithmetic first.

## Release

The `v3` branch publishes `3.0.0-next.N` prereleases on the npm `next`
dist-tag via semantic-release; merging to main graduates it to `3.0.0`.
