# mdflow

```bash
review.md                        # v3: runs on your default engine (pi)
review.claude.md                 # Pin an engine in the filename
git diff | explain.md            # Pipe through any command
```

**Your markdown files are now executable AI agents.**

```bash
npx mdflow init
```

Your agent CLI (claude, codex, copilot, ...) opens pre-loaded with the mdflow
setup guide: it reads your repo, proposes flows tailored to it, writes
`./flows` + `.mdflow.yaml` once you approve, and verifies everything with free
dry runs. No agent CLI handy — or scripting it? `npx mdflow init --yes`
scaffolds the starter roster with zero engine turns.

---

## New in v3

**Markdown agents that evolve.** One file per agent. Any engine. Evals that
prove behavior. Every run makes them better.

- **`./flows` is your repo's agent roster.** One markdown agent per job:
  code review, release notes, issue triage. Diffable in PRs, provable with
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
- **pi is the default engine**, runs hermetic (no ambient extensions,
  skills, or context files), and bridges your Codex CLI login automatically.
- **New engines:** `cursor-agent` and `agy` (Google Antigravity, the gemini
  CLI successor; the old gemini adapter remains for Code Assist
  Standard/Enterprise).
- **Evals:** `md eval flows/review.md` runs `flows/review.eval.ts`.
  Behavioral cases in hermetic sandboxes, cost printed before running,
  results in a trust ledger. *If a guardrail isn't covered by an eval, it's
  a wish.*
- **Evolution:** `md complain flows/review.md "missed the race condition"`
  records evidence; `md evolve` has a maintainer engine redraft the prompt
  and applies it only if the eval suite scores clean and no worse than the
  ancestor's baseline. Add `evolve: auto` to frontmatter for the full loop —
  gated on a proven-clean suite (`lastCleanAt`), never auto-applying to an
  unproven one. *Benefit is a measurement, not a hope.*

See `docs/V3-FLOWS.md` for the full v3 design and what's coming (distill,
tournament, routing), [`docs/public-api.md`](docs/public-api.md) for the
stable CLI contract, and [`GUIDE-NEW-FEATURES.md`](GUIDE-NEW-FEATURES.md) for
workflows (`_steps`), structured outputs (`_output`), context providers
(`@git:diff`), the flow registry, `--json` mode, and run telemetry.

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

No install needed to start — bootstrap a flow roster in any repo:

```bash
npx mdflow init
```

Keep it installed for daily runs:

```bash
npm install -g mdflow
# or
bun install && bun link
```

mdflow runs on [Bun](https://bun.sh); `npx mdflow` offers to install it if
it's missing.

## Quick Start

```bash
# Initialize a flow roster (an installed agent CLI guides you; -y to scaffold)
npx mdflow init

# Run with filename-inferred engine
mdflow task.claude.md
mdflow task.codex.md

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
|-------|------|-------------|
| `_varname` | string | Template variable with default value (use `{{ _varname }}` in body) |
| `_inputs` | object/array | Interactive form inputs (see above) |
| `_env` | object | Set process environment variables |
| `$1`, `$2`... | string | Map positional args to flags (e.g., `$1: prompt`) |
| `_interactive` / `_i` | boolean | Enable interactive mode (overrides print-mode defaults) |
| `_subcommand` | string/string[] | Prepend subcommand(s) to CLI args |
| `_cwd` | string | Override working directory for inline commands |
| `context_window` | number | Override token limit for context (default: model-based) |

### Auto-Injected Template Variables

| Variable | Description |
|----------|-------------|
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
       md <command> [options]
       md.COMMAND "prompt" [flags]      # Ad-hoc execution (no file needed)

Commands:
  md init [--engine <e>] [-y]   Initialize a flow roster for this project
                                (guided by an installed agent CLI; -y scaffolds)
  md create [name] [flags]      Create a new agent file
  md explain <agent.md>         Show resolved config without executing
  md eval <flow.md>             Run the flow's eval suite (<flow>.eval.ts) — costs engine turns
  md complain <flow.md> "msg"   Record evolution evidence for a flow (free)
  md evolve <flow.md> [--check] Evidence-gated prompt evolution; --check is free
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

Create options:
  md create                     Interactive agent creator
  md create task.claude.md      Create with name (auto-detects command)
  md create -n task -p          Create in project .mdflow/ folder
  md create -g --model gpt-4    Create globally with frontmatter

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
  2. Project agents:     ./.mdflow/
  3. User agents:        ~/.mdflow/
  4. $PATH directories
  5. Current directory:  ./

All non-system frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.mdflow/config.yaml

Remote execution:
  md supports running agents from URLs (npx-style).
  On first use, you'll be prompted to trust the domain.
  Trusted domains are stored in ~/.mdflow/known_hosts

md-specific flags (consumed, not passed to command):
  --engine          Specify the engine to run (deprecated aliases: --_command/-_c, --tool)
  --_dry-run        Show resolved command and prompt without executing
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
  md              Interactive agent picker (from ./.mdflow/, ~/.mdflow/, etc.)
```

### Environment Variables

| Variable | Description |
|----------|-------------|
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
