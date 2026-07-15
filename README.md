# mdflow

```bash
review.md                        # Runs on your resolved engine (default: pi)
review.claude.md                 # Pin an engine in the filename
git diff | explain.md            # Pipe through any command
```

**A Git-native control plane for repeatable agent work.** Define each job as
markdown, run it on the CLI engine you already use, inspect its inputs, and
gate prompt revisions with behavioral evals.

```bash
npx mdflow init
```

One command safely creates a starter `./flows` roster and `.mdflow.yaml` with
zero engine invocations; repeat runs leave an existing roster untouched. Then
bare `md` opens the Flow Workbench — and on a machine with no flows at all, it
offers first-run setup instead of an empty screen: guided setup with an
installed agent CLI, a deterministic scaffold, or a printed setup prompt to
paste into any agent. Want the repo-tailored setup conversation directly? Run
`md init --guided` (or `md init --print-guide` to copy the same guide into
your own agent session).

Prefer flows as the primary way agents work in your repo? Opt in with
`md roster sync --agents`: it maintains one marker-managed mdflow block in
`AGENTS.md` and `CLAUDE.md` so coding agents discover the roster and hand
matching tasks off to flows, and it never touches your text outside the
markers. Guided setup asks this as an explicit question.

## For coding agents

Use the CLI as the source of truth instead of reconstructing project state from
long prose:

```bash
command -v md || npm install -g mdflow
md doctor --json                 # FREE, static, read-only project diagnosis
npx mdflow init --yes            # LOCAL WRITE, deterministic starter roster
md doctor --json
md explain flows/<name>.md --json
md eval flows/<name>.md --plan   # FREE; a real eval needs separate approval
```

`flows/README.md` contains a managed operator card; update only that marked
block with `md roster sync`. Eval and hook sidecars are executable local code.
Registry install adds one flow, not trusted sidecars. Engine context isolation
is not a host filesystem, network, process, environment, or credential sandbox.

---

## The agent control plane in your repo

**Git-native agent workflows.** One file per job. Any engine. Evals that
guard declared behavior. Feedback can drive reviewable, regression-gated prompt proposals.

- **`./flows` is your repo's agent roster.** One markdown agent per job:
  code review, release notes, issue triage. Diffable in PRs, checked with
  `md eval`, readable by every teammate, human or AI. Start one with
  `npx mdflow init`; the installable skill
  (`npx skills add johnlindquist/mdflow`) teaches your coding agent to build
  and maintain it.
- **Engines are environment, not filename ceremony.** Bare `review.md` runs
  on the resolved engine: `--engine` flag > `MDFLOW_ENGINE` env > filename >
  frontmatter `engine:` > config `engine:` > built-in default (**pi**).
  Implicit choices print a dim `review.md → pi (engine: default)` line.
  Inspectable, never magic. Files with no frontmatter and no explicit engine
  are documents: `md README.md` prints instead of executing. The frontmatter
  key is now `engine:` (`tool:`/`_tool:` still work, with a warning).
- **pi is the default engine**, runs without ambient extensions, skills, or
  context files, and bridges your Codex CLI login automatically.
- **Engine context isolation is the default, where supported.** Flows run with the
  engine's ambient context stripped using its own verified flags — claude
  `--safe-mode --no-session-persistence`, codex `--ignore-user-config
  --ephemeral -c project_doc_max_bytes=0`, gemini `--extensions none`,
  copilot `--no-custom-instructions --disable-builtin-mcps`, opencode
  `--pure`, pi its context-isolation flags. Skills/MCP/context a flow needs are
  declared explicitly in frontmatter; `_isolated: false` opts back into
  ambient. Engines with no controls (droid, cursor-agent, agy) run ambient
  and warn only on an explicit `_isolated: true` — never pretending. This
  does not sandbox the host filesystem, network, environment, or inline shell
  commands; those remain explicit capabilities of the flow.
- **System prompt as a first-class key:** `_system-prompt:` replaces the
  engine's system prompt, `_append-system-prompt:` appends (string or list).
  Translated per engine (claude/pi flags, codex `model_instructions_file` /
  `developer_instructions` config, gemini `GEMINI_SYSTEM_MD`). Engines with
  no mechanism fail the run instead of silently dropping your prompt.
  Interactive specialists that should wait for a task use `_task: ""` and a
  body of exactly `{{ _task }}`; identity/rules belong in the two instruction
  keys. Static `User task:` wrappers or body-level context would become an
  immediately submitted first turn.
- **New engines:** `cursor-agent` and `agy` (Google Antigravity, the gemini
  CLI successor; the old gemini adapter remains for Code Assist
  Standard/Enterprise).
- **Evals:** `md eval flows/review.md` runs `flows/review.eval.ts`.
  Behavioral cases in isolated temporary workspaces, cost printed before running,
  results in a trust ledger. *If a guardrail isn't covered by an eval, it's
  a wish.*
- **Evolution is proposal-first:** `md feedback flows/review.md "missed the
  race condition"` records durable evidence. `md evolve plan` previews proof,
  capabilities, writes, and bounded invocation cost for free; `md evolve
  propose` drafts and evaluates private off-path snapshots. The source stays
  byte-identical until a separate `md evolve apply <run-id>`. mdflow says
  “verified improvement” only when a feedback-linked case fails on current and
  passes on the proposal; otherwise a green candidate is merely
  “regression-safe.” Legacy `evolve: auto` now means queued proposal-only work,
  never unattended application.

See [`docs/evolve.md`](docs/evolve.md) for the normative change-with-proof
protocol, `docs/V3-FLOWS.md` for the historical v3 design record, [`docs/public-api.md`](docs/public-api.md) for the
stable CLI contract, and [`GUIDE-NEW-FEATURES.md`](GUIDE-NEW-FEATURES.md) for
workflows (`_steps`), structured outputs (`_output`), context providers
(`@git:diff`), the flow registry, `--json` mode, and run telemetry.

Security-sensitive behavior is documented in [`SECURITY.md`](SECURITY.md).
Contributions are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## What Is This?

Markdown files become first-class CLI commands. Write a prompt in markdown, run it like a script. The command is inferred from the filename.

```markdown
# review.claude.md
---
model: opus
---
Review this code for bugs and suggest improvements.

@./src/**/*.ts
```

```bash
review.claude.md                 # Runs: claude --model opus <prompt>
review.claude.md --verbose       # Pass extra flags
```

---

## How It Works

### 1. Filename → Command

Name your file `task.COMMAND.md` and the command is inferred:

```bash
task.claude.md    # Runs claude
task.codex.md     # Runs codex
task.copilot.md   # Runs copilot (print mode by default)
task.agy.md       # Runs agy (Google Antigravity, the gemini CLI successor)
task.gemini.md    # Runs gemini (Code Assist Standard/Enterprise only — sunset for individuals)
```

### 2. Frontmatter → CLI Flags

Every YAML key becomes a CLI flag passed to the command:

```yaml
---
model: opus              # → --model opus
dangerously-skip-permissions: true  # → --dangerously-skip-permissions
mcp-config: ./mcp.json   # → --mcp-config ./mcp.json
add-dir:                 # → --add-dir ./src --add-dir ./tests
  - ./src
  - ./tests
---
```

### 3. Body → Prompt

The markdown body is passed as the final argument to the command.

---

## Unix Philosophy

mdflow embraces the Unix philosophy:

- **No magic mapping** - Frontmatter keys pass directly to the command
- **Stdin/stdout** - Pipe data in and out
- **Composable** - Chain agents together
- **Transparent** - See what runs in logs

```bash
# Pipe input
git diff | mdflow review.claude.md

# Chain agents
mdflow plan.claude.md | mdflow implement.codex.md
```

---

## Installation

Start through `npx` to bootstrap a flow roster in any repo:

```bash
npx mdflow init
```

Keep it installed for daily runs:

```bash
npm install -g mdflow
# or
bun install && bun link
```

mdflow runs on [Bun](https://bun.sh). If Bun is missing, the interactive
launcher offers to install it; non-interactive environments must install Bun
first.

## Quick Start

```bash
# Safely scaffold a starter roster (`--guided` for a repo-tailored session)
npx mdflow init

# Open the Flow Workbench
md

# Or create and run a project flow directly
md create "Review staged changes for bugs"
md review-staged-changes-for-bugs

# Create a personal flow you can run from any project
md create "Turn meeting notes into an action plan" --global
md turn-meeting-notes-into-an-action-plan

# Preview without spending an engine invocation
md review-staged-changes-for-bugs --_dry-run

# Override the engine explicitly
mdflow task.md --engine claude
MDFLOW_ENGINE=codex mdflow task.md

# One-shot ad-hoc mode (no file required)
md.claude "Summarize: !`git diff --staged`"
md.i.codex "Help me debug this test failure"

# Pass additional flags to the command
mdflow task.claude.md --verbose --debug
```

> **Note:** Both `mdflow` and `md` commands are available.
>
> For the full command and frontmatter contract, see [`docs/public-api.md`](docs/public-api.md).

### The Flow Workbench

Run bare `md` for the everyday surface. It works in a new project with zero
flows and in an established project with a full roster:

- Browse and filter flows with a live Markdown and lifecycle preview.
- Press `Enter` to run, `d` to dry-run for free, or `e` to edit in `$EDITOR`.
- Press `n` to turn a plain-language outcome into a new `flows/<slug>.md`.
- Press `f` to save durable feedback, then `i` to move through evidence → eval
  → proposal → an explicit apply or rollback decision.

Every action displays its exact shell equivalent and whether it is free,
invokes an engine, or writes locally. The Workbench never auto-applies a prompt
revision. `a` and `r` open a dedicated `LOCAL WRITE` confirmation screen;
`Enter`/`c` confirms the displayed command and `Esc` returns without writing.

---

## Engine Resolution

Engines are resolved by a ladder, most explicit first:

1. **CLI flag**: `--engine claude` (deprecated aliases: `--_command`/`-_c`, `--tool`)
2. **Environment variable**: `MDFLOW_ENGINE`
3. **Filename pattern**: `task.claude.md` → `claude` (must name a real engine)
4. **Frontmatter**: `engine: claude` (deprecated aliases `tool:`/`_tool:` warn)
5. **Config** `engine:` (project config beats `~/.mdflow/config.yaml`)
6. **Built-in default**: `pi`

Resolution never fails — the default always applies. Implicit choices print a
dim explanation line on stderr. A file with no frontmatter and no explicit
engine is a document: `md README.md` prints it instead of executing it.

Bundled engines: `claude`, `codex`, `copilot`, `gemini`, `droid`, `opencode`,
`pi` (default), `cursor-agent`, `agy` (Google Antigravity).

---

## Flag Hijacking

Some CLI flags are "hijacked" by mdflow: they're consumed and never passed to the underlying command. This allows generic markdown files without command names to be executed.

### `--engine`

Override the engine for any markdown file (deprecated aliases: `--_command`,
`-_c`, `--tool` — they still work but warn):

```bash
# Run a generic .md file on any engine
mdflow task.md --engine claude

# Override the filename-inferred engine
mdflow task.claude.md --engine gemini  # Runs gemini, not claude
```

### `_varname` Template Variables

Frontmatter fields starting with `_` (except internal keys like `_interactive`, `_cwd`, `_subcommand`) define template variables:

```yaml
---
_feature_name: Authentication   # Default value
_target_dir: src/features       # Default value
---
Build {{ _feature_name }} in {{ _target_dir }}.
```

```bash
# Use defaults
mdflow create.claude.md

# Override with CLI flags (consumed by mdflow, not passed to command)
mdflow create.claude.md --_feature_name "Payments" --_target_dir "src/billing"
```

The `--_feature_name` and `--_target_dir` flags are consumed by mdflow for template substitution. They won't be passed to the command.

**No frontmatter declaration required:** You can pass `--_varname` flags without declaring them in frontmatter. If the variable is used in the body but not provided, you'll be prompted for it:

```yaml
---
print: true
---
{% if _verbose == "yes" %}Detailed analysis:{% endif %}
Review this code: {{ _target }}
```

```bash
mdflow review.claude.md --_verbose yes --_target "./src"
```

### Positional Arguments as Template Variables

CLI positional arguments are available as `{{ _1 }}`, `{{ _2 }}`, etc.:

```yaml
---
print: true
---
Translate "{{ _1 }}" to {{ _2 }}.
```

```bash
mdflow translate.claude.md "hello world" "French"
# → Translate "hello world" to French.
```

Use `{{ _args }}` to get all positional args as a numbered list:

```yaml
---
print: true
---
Process these items:
{{ _args }}
```

```bash
mdflow process.claude.md "apple" "banana" "cherry"
# → Process these items:
# → 1. apple
# → 2. banana
# → 3. cherry
```

### `_stdin` - Piped Input

When you pipe content to mdflow, it's available as the `_stdin` template variable:

```yaml
---
model: haiku
---
Summarize this: {{ _stdin }}
```

```bash
cat README.md | md summarize.claude.md
```

### Interactive Form Inputs

Use `_inputs` to define typed interactive prompts with validation:

```yaml
---
model: sonnet
_inputs:
  _name:
    type: text
    description: "Enter your name"
    default: "World"
  _env:
    type: select
    options: [dev, staging, prod]
  _count:
    type: number
    description: "How many items?"
  _confirm:
    type: confirm
    description: "Are you sure?"
  _secret:
    type: password
    description: "API key"
---
Hello {{ _name }}! Deploying to {{ _env }} with {{ _count }} items.
```

**Input types:**

- `text` - Free text input (default if no type specified)
- `select` - Choose from a list of options
- `number` - Numeric input
- `confirm` - Yes/no boolean
- `password` - Hidden input for secrets

**Legacy format:** `_inputs: [_name, _value]` (array of variable names) still works.

---

## Frontmatter Reference

### System Keys (handled by md)

| Field | Type | Description |
| ------- | ------ | ------------- |
| `_varname` | string | Template variable with default value (use `{{ _varname }}` in body) |
| `_inputs` | object/array | Interactive form inputs (see above) |
| `_env` | object | Set process environment variables |
| `$1`, `$2`... | string | Map positional args to flags (e.g., `$1: prompt`) |
| `_interactive` / `_i` | boolean | Enable interactive mode (overrides print-mode defaults) |
| `_subcommand` | string/string[] | Prepend subcommand(s) to CLI args |
| `_cwd` | string | Override working directory for inline commands |
| `_hooks` | boolean/string | Lifecycle hooks file: unset = auto-discover `<flow>.hooks.ts`, `false` = disable, path = shared hooks file (see Lifecycle Hooks) |
| `context_window` | number | Override token limit for context (default: model-based) |

### Auto-Injected Template Variables

| Variable | Description |
| ---------- | ------------- |
| `{{ _stdin }}` | Content piped to mdflow |
| `{{ _1 }}`, `{{ _2 }}`... | Positional CLI arguments |
| `{{ _args }}` | All positional args as numbered list (1. arg1, 2. arg2, ...) |

### All Other Keys → CLI Flags

Every other frontmatter key is passed directly to the command:

```yaml
---
model: opus                           # → --model opus
dangerously-skip-permissions: true    # → --dangerously-skip-permissions
mcp-config: ./mcp.json                # → --mcp-config ./mcp.json
p: true                               # → -p (single char = short flag)
---
```

**Value conversion:**

- `key: "value"` → `--key value`
- `key: true` → `--key`
- `key: false` → (omitted)
- `key: [a, b]` → `--key a --key b`

---

## Lifecycle Hooks

A flow's hooks live in a TypeScript file **named after the flow** — that's
the whole wiring:

```
review.codex.md          # the flow
review.codex.hooks.ts    # its hooks — discovered and wired automatically
```

Scaffold one (or pick events interactively by omitting them):

```bash
md hooks add review.codex.md stop userPromptSubmit
md hooks list review.codex.md
md hooks remove review.codex.md stop
```

The generated file is an executable, dependency-free Bun program exporting
handlers keyed by canonical event names:

```ts
#!/usr/bin/env bun
const handlers: Record<string, HookHandler> = {
  userPromptSubmit: async (payload) => {
    // return a string to inject context;
    // return { decision: "block", reason: "…" } to reject the prompt
  },
  stop: async (payload) => {
    // return { decision: "block", reason: "…" } to force the turn to continue
  },
};
```

On every run, mdflow reads which events the file handles (from its text —
inspection never executes it) and translates them into the engine's native
hook mechanism. **codex** and **claude** are supported today (the same hooks
file works unchanged on both — its dispatcher normalizes event names):

- **codex** — an inline `-c hooks={…}` override plus a prepared, hooks-free
  codex home under `~/.mdflow/`, so your own codex config and credentials
  are never modified.
- **claude** — an inline `--settings` blob plus `--setting-sources ""` to
  exclude your ambient settings hooks. Claude's `--safe-mode` disables
  injected hooks, so a hooked claude run drops it and prints a one-line
  disclosure that CLAUDE.md/skills/plugins/MCP are no longer isolated for
  that run (your ambient settings hooks still are).
Debug a hook standalone by piping a payload to it:

```bash
echo '{"hook_event_name":"Stop"}' | ./review.codex.hooks.ts
```

Events: `sessionStart`, `userPromptSubmit`, `preToolUse`, `postToolUse`,
`permissionRequest`, `preCompact`, `postCompact`, `subagentStart`,
`subagentStop`, `stop`, `sessionEnd`. In print mode, codex fires
`sessionStart`/`userPromptSubmit`/`preToolUse`/`postToolUse`/`stop`, and
claude additionally fires `sessionEnd`; the rest are registered but
scenario-dependent. Once a run is underway, a hook that crashes or times out
fails open (the engine continues) — except that the scaffolded dispatcher
fails **closed** for guard events (`userPromptSubmit`, `preToolUse`,
`permissionRequest`): if one of those handlers throws, mdflow emits the
engine's block/deny response rather than letting the guarded action through.
Discovery problems are the opposite: a hooks file that exists but can't be
used (missing, uninspectable, escaping path) fails the run loudly, because
silently dropping declared hooks would change the flow.

Consent and containment rules:

- **Inspection never executes.** `md explain`, `md hooks list`, dry runs,
  and the Workbench read the handlers map from the file's text; only a real
  run may execute the hook program (it's about to run anyway).
- **Hooks run isolated.** Hooked runs exclude your ambient hooks so mdflow's
  injected hooks are the only ones that fire — on codex via a prepared,
  hooks-free codex home (its trust bypass can never enable hooks you haven't
  reviewed), on claude via `--setting-sources ""`. `_isolated: false`
  combined with a hooks file is an error on both.
- **Paths are contained.** A flow's `_hooks:` may only point inside the
  flow's own directory, and remote flows can't declare `_hooks` paths at
  all. Only `--_hooks` typed on the command line escapes containment.
- **`md install` fetches only the flow markdown** — hook files are never
  downloaded from a registry.

Control: `_hooks: false` disables discovery; `_hooks: ./shared.hooks.ts`
points several flows at one file (within the flow's directory);
`--_hooks <path|false>` overrides from the CLI. Engines without a verified
hook mechanism fail a run whose hooks file exists — disable with
`_hooks: false` or switch engines.

---

## Print vs Interactive Mode

All commands run in **print mode by default** (non-interactive, exit after completion). Use the `.i.` filename marker, `_interactive` frontmatter, or CLI flags to enable interactive mode.

### Print Mode (Default)

```bash
task.claude.md      # Runs: claude --print "..."
task.copilot.md     # Runs: copilot --silent --prompt "..."
task.codex.md       # Runs: codex exec "..."
task.gemini.md      # Runs: gemini "..." (one-shot)
```

### Interactive Mode

Add `.i.` before the command name in the filename:

```bash
task.i.claude.md    # Runs: claude "..." (interactive session)
task.i.copilot.md   # Runs: copilot --silent --interactive "..."
task.i.codex.md     # Runs: codex "..." (interactive session)
task.i.gemini.md    # Runs: gemini --prompt-interactive "..."
```

Or use `_interactive` (or `_i`) in frontmatter:

```yaml
---
_interactive: true   # or _interactive: (empty), or _i:
model: opus
---
Review this code with me interactively.
```

Or use CLI flags:

```bash
mdflow task.claude.md --_interactive  # Enable interactive mode
mdflow task.claude.md -_i             # Short form
```

---

## Configuration Layers

mdflow resolves configuration in this order (later entries override earlier ones):

1. Built-in command defaults
2. Global config (`~/.mdflow/config.yaml`)
3. Project config at git root (`mdflow.config.yaml`, `.mdflow.yaml`, `.mdflow.json`)
4. Project config at current working directory (`mdflow.config.yaml`, `.mdflow.yaml`, `.mdflow.json`)
5. Agent frontmatter
6. CLI passthrough flags

Set global defaults per command in `~/.mdflow/config.yaml`:

```yaml
commands:
  claude:
    model: sonnet # Default model for claude
  copilot:
    silent: true  # Always use --silent for copilot
```

Set project defaults in your repository root:

```yaml
# mdflow.config.yaml
commands:
  claude:
    model: opus
```

**Built-in defaults:** All commands default to print mode with tool-specific defaults.

---

## Examples

### Claude with MCP Server

```markdown
# db.claude.md
---
model: opus
mcp-config: ./postgres-mcp.json
dangerously-skip-permissions: true
---
Analyze the database schema and suggest optimizations.
```

### Gemini YOLO Mode

```markdown
# refactor.gemini.md
---
model: gemini-3-pro-preview
yolo: true
---
Refactor the authentication module to use async/await.
```

### Codex with Sandbox

```markdown
# analyze.codex.md
---
model: o3
sandbox: workspace-write
full-auto: true
---
Analyze this codebase and suggest improvements.
```

### Copilot (no frontmatter needed!)

```markdown
# task.copilot.md
Explain this code.
```

This runs: `copilot --silent --prompt "Explain this code."` (print mode)

For interactive mode, use `.i.` in the filename:

```markdown
# task.i.copilot.md
Explain this code.
```

This runs: `copilot --silent --interactive "Explain this code."`

### Template Variables

```markdown
# create-feature.claude.md
---
_feature_name: ""
_target_dir: src/features
model: sonnet
---
Create a new feature called "{{ _feature_name }}" in {{ _target_dir }}.
```

```bash
mdflow create-feature.claude.md --_feature_name "Auth"
```

### Environment Variables

Use `_env` (underscore prefix) to set environment variables for the command:

```markdown
# api-test.claude.md
---
_env:
  API_URL: https://api.example.com
  DEBUG: "true"
---
Test the API at !`echo $API_URL`
```

---

## Imports & Command Inlines

Inline content from other files or command output directly in your prompts.

### File Imports

Use `@` followed by a path to inline file contents:

```markdown
---
model: claude
---
Follow these coding standards:
@~/.config/coding-standards.md

Now review this code:
@./src/api.ts
```

- `@~/path` - Expands `~` to home directory
- `@./path` - Relative to current markdown file
- `@/path` - Absolute path

Imports are recursive. Imported files can have their own `@` imports.

### Glob Imports

Use glob patterns to include multiple files at once:

```markdown
Review all TypeScript files in src:
@./src/**/*.ts
```

Glob imports:

- Respect `.gitignore` automatically
- Include common exclusions (`node_modules`, `.git`, etc.)
- Are limited to ~100,000 tokens by default
- Set `MDFLOW_FORCE_CONTEXT=1` to override the token limit

Files are formatted as XML with path attributes:

```xml
<api path="src/api.ts">
...file content...
</api>

<utils path="src/utils.ts">
...file content...
</utils>
```

### Line Range Imports

Extract specific lines from a file:

```markdown
@./src/api.ts:10-50
```

This imports only lines 10-50 from the file.

### Symbol Extraction

Extract specific TypeScript/JavaScript symbols (interfaces, types, functions, classes, etc.):

```markdown
@./src/types.ts#UserInterface
@./src/api.ts#fetchUser
```

Supported symbols:

- `interface Name { ... }`
- `type Name = ...`
- `function Name(...) { ... }`
- `class Name { ... }`
- `const/let/var Name = ...`
- `enum Name { ... }`

### Command Inlines

Use `` !`command` `` to execute a shell command and inline its output:

```markdown
Current branch: !`git branch --show-current`
Recent commits:
!`git log --oneline -5`

Based on the above, suggest what to work on next.
```

### URL Imports

Fetch content from URLs (markdown and JSON only):

```markdown
@https://raw.githubusercontent.com/user/repo/main/README.md
```

**Caching:** Remote URLs are cached locally at `~/.mdflow/cache/` with a 1-hour TTL. Use `--_no-cache` to force a fresh fetch:

```bash
mdflow agent.claude.md --_no-cache
```

**URL policy controls:** Restrict allowed URL imports with environment variables:

```bash
export MDFLOW_IMPORT_URL_ALLOWLIST="raw.githubusercontent.com,docs.example.com"
export MDFLOW_IMPORT_URL_BLOCKLIST="*.internal.example.com"
```

Both variables accept comma-separated or newline-separated host rules.
`MDFLOW_URL_ALLOWLIST` and `MDFLOW_URL_BLOCKLIST` are legacy aliases.

---

## Environment Variables

mdflow automatically loads `.env` files from the markdown file's directory.

### Loading Order

Files are loaded in order (later files override earlier):

1. `.env` - Base environment
2. `.env.local` - Local overrides (not committed)
3. `.env.development` / `.env.production` - Environment-specific
4. `.env.development.local` / `.env.production.local` - Environment-specific local

### Example

```
my-agents/
├── .env                    # API_KEY=default
├── .env.local              # API_KEY=my-secret (gitignored)
└── review.claude.md
```

Environment variables are available:

- In command inlines: `` !`echo $API_KEY` ``
- In the spawned command's environment

---

## CLI Options

```
Usage: md <file.md> [flags for the command]
       md                              # Open the Flow Workbench
       md <command> [options]
       md.COMMAND "prompt" [flags]      # Ad-hoc execution (no file needed)

Commands:
  md init [--guided] [-y]       Safely scaffold a starter flow roster
                                (--guided tailors it with an installed agent CLI)
  md create "<intent>"          Create a project flow (--global for a personal flow)
  md explain <agent.md>         Show resolved config without executing
  md eval <flow.md> [--plan]    Run or cost-preview the flow's eval suite
  md feedback <flow.md> "msg"   Record durable evolution evidence (free)
  md complain <flow.md> "msg"   Alias for md feedback
  md evolve plan|propose <flow> Plan for free or create a private proposal
  md evolve show|apply <run-id> Review or explicitly apply a proposal
  md evolve history [flow.md]   List proposal history (use evolve --help for more)
  md install <url|gh:...@ref>   Install a flow into the registry (--global for user scope)
  md remove <name>              Remove an installed registry flow
  md list                       List installed registry flows
  md setup                      Configure shell (PATH, aliases)
  md logs                       Show agent log directory
  md help                       Show this help

Ad-hoc execution (one-shot mode):
  md.claude "What is 2+2?"                    # Quick prompt to Claude
  md.codex "Write a function"                 # Quick prompt to Codex
  md.copilot "Help me debug"                  # Quick prompt to Copilot
  md.droid "Build an app"                     # Quick prompt to Droid
  md.opencode "Refactor this"                 # Quick prompt to OpenCode
  md.i.claude "Start a chat"                  # Interactive mode
  md.claude "Explain: @error.log" --model opus  # With @imports and flags

Create flows:
  md create "Review staged changes for bugs"               # project: ./flows/
  md create "Turn notes into an action plan" --global       # personal: ~/.mdflow/
  md                              Then browse, run, edit, or improve them

Engine resolution (most explicit wins):
  1. --engine flag (deprecated aliases: --_command/-_c, --tool)
  2. MDFLOW_ENGINE environment variable
  3. Filename pattern (e.g., task.claude.md → claude; must name a real engine)
  4. Frontmatter key (engine: claude; deprecated: tool:/_tool:)
  5. Config engine: (project .mdflow.yaml beats ~/.mdflow/config.yaml)
  6. Built-in default: pi
  A file with no frontmatter and no explicit engine is printed as a document.

Agent file discovery (in priority order):
  1. Explicit path:      md ./path/to/agent.md
  2. Project flows:      ./flows/
  3. Legacy project:     ./.mdflow/
  4. Personal flows:     ~/.mdflow/
  5. $PATH directories
  6. Current directory:  ./

All non-system frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.mdflow/config.yaml

Remote execution:
  md supports running agents from URLs (npx-style).
  On first use, you'll be prompted to trust the domain.
  Trusted domains are stored in ~/.mdflow/known_hosts

md-specific flags (consumed, not passed to command):
  --engine          Specify the engine to run (deprecated aliases: --_command/-_c, --tool)
  --_dry-run        Show command/prompt plan; skip engine and inline commands
  --_edit           Open resolved prompt in $EDITOR before execution
  --_trust          Skip trust prompt for remote URLs (TOFU bypass)
  --_no-cache       Force fresh fetch for remote URLs (bypass cache)
  --raw             Output raw markdown without rendering (for piping)
  --_context        Show context tree and exit (no execution)
  --_quiet          Skip context dashboard display before execution
  --_no-menu        Disable post-run action menu (for scripting/piping)
  --json            Emit a single JSON result object and disable interactive UI

Examples:
  md task.claude.md -p "print mode"
  md task.claude.md --model opus --verbose
  md commit.agy.md
  md task.md                      # engine via the ladder (default: pi)
  md task.md --engine claude
  md eval task.md                 # run the flow's eval suite
  md task.claude.md --_dry-run    # Preview without executing
  md https://example.com/agent.claude.md            # Remote execution
  md https://example.com/agent.claude.md --_trust   # Skip trust prompt

Without arguments:
  md              Open the Flow Workbench: browse, create, run, and improve flows
```

### Environment Variables

| Variable | Description |
| ---------- | ------------- |
| `MDFLOW_FORCE_CONTEXT` | Set to `1` to disable the 100k token limit for glob imports |
| `MDFLOW_IMPORT_URL_ALLOWLIST` | Comma/newline-separated allowlist rules for URL imports |
| `MDFLOW_IMPORT_URL_BLOCKLIST` | Comma/newline-separated blocklist rules for URL imports |
| `MDFLOW_URL_ALLOWLIST` | Legacy alias for `MDFLOW_IMPORT_URL_ALLOWLIST` |
| `MDFLOW_URL_BLOCKLIST` | Legacy alias for `MDFLOW_IMPORT_URL_BLOCKLIST` |
| `MDFLOW_FETCH_TIMEOUT` | HTTP fetch timeout in milliseconds (default: `10000`) |
| `MDFLOW_COMMAND_TIMEOUT` | Inline command timeout in milliseconds (default: `30000`) |
| `MDFLOW_AGENT_TIMEOUT` | Agent process timeout in milliseconds (default: `0` = disabled) |
| `NODE_ENV` | Controls which `.env.[NODE_ENV]` file is loaded (default: `development`) |

---

## Shell Setup

Make `.md` files directly executable:

```bash
mdflow setup   # One-time setup
```

Then run agents directly:

```bash
task.claude.md                   # Just type the filename
task.claude.md --verbose         # With passthrough args
```

### Manual Setup (zsh)

Add to `~/.zshrc`:

```bash
alias -s md='mdflow'
export PATH="$HOME/agents:$PATH"  # Your agent library
```

---

## Installing Shared Flows

Install versioned flows from a URL or GitHub into the registry:

```bash
md install gh:myorg/agents/code-review.claude.md@v1.2   # project scope (./.mdflow/registry/)
md install https://example.com/agents/review.claude.md --global  # user scope (~/.mdflow/registry/)
md list                     # list installed flows
md remove review.claude.md  # remove one
```

Every install is pinned in `.mdflow/mdflow.lock.json` (source, resolved ref,
sha256) — commit it for reproducible CI runs.

---

## Building Your Agent Library

Create a directory of agents and add it to PATH:

```
~/agents/
├── review.claude.md     # Code review
├── commit.gemini.md     # Commit messages
├── explain.claude.md    # Code explainer
├── test.codex.md        # Test generator
└── debug.claude.md      # Debugging helper
```

```bash
export PATH="$HOME/agents:$PATH"
```

Now use them from anywhere:

```bash
review.claude.md                 # Review current directory
commit.gemini.md "add auth"      # Generate commit message
git diff | review.claude.md      # Review staged changes
```

---

## Rich Output Rendering

By default, LLM output is rendered with syntax highlighting and visual markdown structure (headers, code blocks, etc.). This uses `marked-terminal` for beautiful terminal output.

To bypass rendering (e.g., for piping to other commands):

```bash
md task.claude.md --raw | jq .
```

---

## Context Dashboard

Before execution, md shows a pre-flight dashboard with your context tree and token estimates:

```
┌─ Pre-Flight ──────────────────────────────────────────────────┐
│  📄 review.claude.md                                   1.2 KB │
│  ├── 📁 @./src/**/*.ts                     (12 files) 24.5 KB │
│  └── 📄 @./README.md                                   3.1 KB │
│                                                               │
│  Total: 28.8 KB (~7,200 tokens)                              │
└───────────────────────────────────────────────────────────────┘
```

Use `--_quiet` to skip the dashboard, or `--_context` to show it and exit without executing.

---

## The `md explain` Command

Inspect what an agent will do without running it:

```bash
md explain review.claude.md
```

Shows:

- Resolved command and source (filename, flag, etc.)
- Final flags after config merging (built-in → global → project → frontmatter)
- Expanded prompt preview with token count
- Trust status for remote URLs
- Environment variables that will be set

---

## Edit Before Execute

Use `--_edit` to open the fully resolved prompt in your `$EDITOR` before execution:

```bash
md task.claude.md --_edit
```

This lets you review and tweak the final prompt (after template substitution and import expansion) before sending it to the LLM.

---

## Notes

- On typed failures, mdflow emits a stable error code prefix like `[CONFIG_FILE_PARSE_FAILED]`.
- See [`docs/public-api.md#error-codes`](docs/public-api.md#error-codes) for the full error-code catalog.
- If no frontmatter is present, the file is printed as-is (unless command inferred from filename)
- Template system uses [LiquidJS](https://liquidjs.com/) - supports conditionals, loops, and filters
- Logs are always written to `~/.mdflow/logs/<agent-name>/` for debugging
- Use `md logs` to show the log directory
- Piped input is available as `{{ _stdin }}` template variable
- Template variables use `_` prefix: `_name` in frontmatter → `{{ _name }}` in body → `--_name` CLI flag
- Remote URLs are cached at `~/.mdflow/cache/` with 1-hour TTL (use `--_no-cache` to bypass)
- Imports inside code blocks (``` or `) are ignored by the parser
- Interactive file picker sorts by frecency (frequency + recency) for quick access to common agents
