# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**mdflow** (`md`) is a CLI tool that executes AI agents defined as markdown files. It parses YAML frontmatter for configuration and passes keys directly as CLI flags to the specified command (claude, codex, gemini, copilot, or any other CLI tool).

## CLI Subcommands

```bash
md <file.md> [flags]     # Run a flow
md init [-e <eng>] [-y]  # Initialize a flow roster (guided by an agent CLI; -y scaffolds)
md create [name]         # Create a new flow file
md explain <flow.md>     # Show resolved config without executing (free)
md hooks add|list|remove <flow.md> [event…]  # Manage the flow's lifecycle hooks file (free)
md eval <flow.md>        # Run the flow's eval suite (costs engine turns)
md complain <flow.md> "msg"  # Record evolution evidence (free)
md evolve <flow.md>      # Evidence-gated prompt evolution (--check is free)
md install <url|gh:...>  # Install a flow into the registry (see src/registry.ts)
md remove <name>         # Remove an installed registry flow
md list                  # List installed registry flows
md setup                 # Configure shell (PATH, aliases)
md logs                  # Show flow log directory
md help                  # Show help
```

## Development Commands

```bash
# Run tests (bail on first failure)
bun test --bail=1

# Run single test file
bun test src/cli.test.ts

# Run a specific test by name
bun test --test-name-pattern "parses command"

# Execute the CLI directly
bun run src/index.ts task.claude.md

# Or using the alias
bun run md task.claude.md
```

## Website (`site/`)

The mdflow.dev landing page lives in `site/` (Vite + React, deployed via
Vercel with Root Directory = `site`). Rules:

- `site/src/facts.json` is **generated** by `scripts/generate-facts.ts` from
  the adapter registry, `DEFAULT_ENGINE`, `cli-runner.ts` subcommands, and
  package.json — never edit it by hand. `bun run facts` regenerates;
  `bun run facts:check` runs in CI and fails on drift. Adding a subcommand to
  `cli-runner.ts` requires a matching `COMMAND_DOCS` entry in the generator.
- Site-only commits use `chore(site):` / `docs(site):` scopes so
  semantic-release never cuts a CLI release for a visual change.
- `site/content/*.md` are article pages (e.g. the auto-evolve deep dive,
  formerly an external here.now URL). `scripts/build-content.mjs` renders
  each to `dist/<slug>/index.html` during `npm run build` so they're hosted
  on mdflow.dev — never link site copy to external here.now pages.
- Factual site copy should render from facts.json; artistic copy (headlines,
  shaders, easter eggs) is hand-written. See `docs/SITE-SYNC.md`.

## Architecture

### Core Flow (`src/index.ts`)
```
.md file → parseFrontmatter() → resolveEngine(ladder, see below)
        → loadFullConfig() → applyDefaults()
        → applyInteractiveMode() → expandImports()
        → substituteTemplateVars() → buildArgs() → runCommand()
```

### Key Modules

- **`command.ts`** - Engine resolution and execution
  - `parseCommandFromFilename()`: Infers engine from `task.claude.md` → `claude`
  - `hasInteractiveMarker()`: Detects `.i.` in filename (e.g., `task.i.claude.md`)
  - `resolveEngine()`: the v3 ladder (see Engine Resolution below); never
    throws for a missing engine — `DEFAULT_ENGINE` (pi) applies
  - `buildArgs()`: Converts frontmatter to CLI flags
  - `extractPositionalMappings()`: Extracts $1, $2, etc. mappings
  - `runCommand()`: Spawns the engine; calls the adapter's optional
    `prepareEnv()` hook (pi uses it for the bridged auth dir)
  - CAUTION: command.ts exports its own `getAdapter` (portable-key layer);
    the registry lookup is imported as `getEngineAdapter`

- **`evals.ts`** - `md eval <flow.md>`: behavioral eval suites
  (`<flow>.eval.ts`, export default EvalCase[]) run in hermetic temp dirs;
  trust ledger at `~/.mdflow/eval-results.json`; prints cost before running;
  eval runs redirect MDFLOW_RUNS_FILE so they never pollute telemetry

- **`init.ts`** - `md init`: project bootstrap. Default path launches an
  installed engine CLI interactively, pre-loaded with `assets/init/guide.md`
  (passed verbatim — never through the import/template pipeline); post-flight
  verifies whatever the session wrote. `--yes`/no-TTY scaffolds
  `assets/init/catalog/` deterministically. `bin/mdflow.mjs` is the
  plain-Node npx launcher that bridges to bun.

- **`evolve.ts`** - `md evolve` / `md complain`: complaints + rough runs →
  maintainer-drafted revision of the prompt BODY only, applied iff the full
  eval suite passes and scores no worse than the ancestor's baseline;
  failures revert byte-identical to `<flow>.pending.md`. Trigger rule is pure
  (`decideEvolve`) and refuses without a suite or fresh evidence; eval runs
  can never trigger it (corpus isolation). `evolve: auto` frontmatter opts a
  flow into post-run auto-evolution (quick re-runs become implicit
  complaints), hard-gated on trust-ledger `lastCleanAt`. Complaints are
  consumed only by evolution; rough runs also by a clean eval. Crash-safe via
  `<flow>.md.evolve-backup`. Verified in `evolve.test.ts`.

- **`adapters/pi-auth.ts`** - Codex-subscription auth bridge for the pi
  engine (`~/.mdflow/pi-agent`, pointed at via PI_CODING_AGENT_DIR); never
  writes the user's real credential files

- **`isolation.ts`** - `_isolated` resolution: adapter-declared
  context-stripping flags layered config defaults < isolation < frontmatter;
  unsupported engines produce a stderr warning (see Isolation table below)

- **`system-prompt.ts`** - `_system-prompt`/`_append-system-prompt`
  extraction and adapter translation (flags, codex `-c` overrides, gemini
  GEMINI_SYSTEM_MD temp file); unsupported engines fail the run

- **`compat.ts`** - Automatic frontmatter version/compatibility stamps:
  `_mdflow_version` written at creation (`md create`/`md init`), `_compat`
  stamped/upgraded after successful local runs (skipped for remote flows and
  `MDFLOW_EVAL_RUN=1`); surgical line-level frontmatter edits, semver-aware,
  major-mismatch prints a dim stderr notice, never blocks execution

- **`hooks.ts` / `hooks-cli.ts`** - Lifecycle hooks by convention:
  `review.codex.md` → sibling `review.codex.hooks.ts` (executable,
  self-contained Bun TS; zero imports) auto-discovered every run and
  translated by the adapter's `applyHooks()` into engine-native config
  (codex: one inline `-c hooks={…}` override + top-level
  `--dangerously-bypass-hook-trust`). `md hooks add/list/remove` scaffolds
  and edits the file surgically via template markers. See Lifecycle Hooks
  below.

- **`config.ts`** - Global configuration
  - Loads defaults from `~/.mdflow/config.yaml`
  - Built-in defaults: All commands default to print mode
  - `getCommandDefaults()`: Get defaults for a command
  - `applyDefaults()`: Merge defaults with frontmatter
  - `applyInteractiveMode()`: Converts print defaults to interactive mode per command

- **`types.ts`** - Core TypeScript interfaces
  - `AgentFrontmatter`: Simple interface with system keys + passthrough
  - System keys: `_varname` (template vars), `env`, `$1`/`$2`/etc.

- **`schema.ts`** - Minimal Zod validation (system keys only, rest passthrough)

- **`imports.ts`** - File imports with advanced features:
  - Basic: `@./path.md` - inline file contents
  - Globs: `@./src/**/*.ts` - multiple files (respects .gitignore)
  - Line ranges: `@./file.ts:10-50` - extract specific lines
  - Symbols: `@./file.ts#InterfaceName` - extract TypeScript symbols
  - Commands: `` !`cmd` `` - inline command output
  - URLs: `@https://example.com/file.md` - fetch remote content

- **`env.ts`** - Environment variable loading from .env files

- **`template.ts`** - LiquidJS-powered template engine for variable substitution

- **`logger.ts`** - Structured logging with pino (logs to `~/.mdflow/logs/<agent>/`)

- **`history.ts`** - Frecency tracking and variable persistence
  - `recordUsage()`: Track agent file usage for frecency sorting
  - `getFrecencyScore()`: Calculate frecency score for a path
  - `getVariableHistory()`: Get previous variable values for an agent
  - `saveVariableValues()`: Save prompted variable values for future runs
  - `getPreviousVariableValue()`: Get a specific variable's previous value

### Engine Resolution (v3)

Engines resolve via the ladder, most explicit first:
1. `--engine` CLI flag (deprecated aliases: `--_command`/`-_c`, `--tool`)
2. `MDFLOW_ENGINE` environment variable
3. Filename pattern: `task.claude.md` → `claude`
4. Frontmatter `engine:` (deprecated aliases `tool:`/`_tool:` warn)
5. Config `engine:` (project config beats `~/.mdflow/config.yaml`)
6. Built-in default: `pi`

Implicit resolution (env/config/default) prints a dim explanation line on
stderr. A file with no frontmatter and only an implicit engine is treated as
a document and printed, not executed.

### Frontmatter Keys

**System keys** (consumed by md, not passed to command):
- `_varname`: Template variables (e.g., `_name: "default"` → `{{ _name }}` in body → `--_name` CLI flag)
- `_stdin`: Auto-injected template variable containing piped input
- `_1`, `_2`, etc.: Auto-injected positional CLI args (e.g., `md task.md "foo"` → `{{ _1 }}` = "foo")
- `_args`: Auto-injected numbered list of all positional args
- `_inputs`: Named positional arguments to consume from CLI (e.g., `_inputs: [_message]`)
- `_env`: Sets process.env before execution
- `$1`, `$2`, etc.: Map positional args to flags
- `_interactive`: Enable interactive mode (overrides print-mode defaults)
- `_subcommand`: Prepend subcommand(s) to CLI args (e.g., `_subcommand: exec`)
- `_cwd`: Override working directory for inline commands (`` !`cmd` ``)
- `_isolated`: Isolation is ON BY DEFAULT — set `false` to opt back into ambient context (skills, MCP, memory/context files, plugins) — see Isolation below
- `_system-prompt` / `_append-system-prompt`: Replace/append the engine's system prompt, translated per engine — see System Prompt below
- `_hooks`: Lifecycle hooks file control — unset = convention discovery (`<flow>.hooks.ts`), `false` disables, a path (relative to the flow file) selects a shared hooks file; `--_hooks <path|false>` is the CLI override — see Lifecycle Hooks below
- `_mdflow_version` / `_compat`: Automatic compatibility stamps (see below) — never set these by hand

**Isolation (`src/isolation.ts` + adapter `getIsolationDefaults()`):**
ON BY DEFAULT for every engine — the flow file is the entire behavior;
skills/MCP/context a flow needs are referenced explicitly in frontmatter
(`mcp-config:`, `plugin-dir:`, `add-dir:`, extension paths), not inherited
from the machine. `_isolated: false` (frontmatter), `--_isolated false`
(CLI), or `commands.<engine>._isolated: false` (config) opts out. The
verified flags layer between config defaults and frontmatter, so an isolated
flow can still re-enable one layer (`safe-mode: false`). Per engine:

| Engine | Flags |
|--------|-------|
| claude | `--safe-mode --no-session-persistence` (the latter is print-only, stripped in interactive; `--bare` deliberately NOT used — it breaks OAuth auth) |
| codex | `--ignore-user-config --ephemeral -c project_doc_max_bytes=0` (first two are exec-only, stripped in interactive) |
| gemini | `--extensions none` (GEMINI.md + settings MCP have no CLI kill-switch) |
| copilot | `--no-custom-instructions --disable-builtin-mcps` (user MCP config still loads) |
| opencode | `--pure` (AGENTS.md still loads) |
| pi | `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-session` |
| droid / cursor-agent / agy | no controls exist — runs ambient; warns only on an explicit `_isolated: true` |

**System prompt (`src/system-prompt.ts` + adapter `applySystemPrompt()`):**
the flow body is always the *user* prompt; `_system-prompt` (replace) and
`_append-system-prompt` (string or list) control the *system* prompt.
Translations: claude/pi → `--system-prompt`/`--append-system-prompt`; codex →
`-c model_instructions_file=<temp file>` / `-c developer_instructions=…`;
gemini → `GEMINI_SYSTEM_MD=<temp file>` env (replace only — append errors).
Engines with no mechanism (copilot, droid, opencode, cursor-agent, agy) fail
the run — a silently dropped system prompt would be a different flow. Never
add a translation from an unverified flag; check the engine's `--help` first.

**Lifecycle hooks (`src/hooks.ts`, `src/hooks-cli.ts` + adapter `applyHooks()`):**
a flow's hooks live in a sibling file named after it — `review.codex.md` →
`review.codex.hooks.ts` — auto-discovered on every run (no frontmatter
needed). The file is an EXECUTABLE, SELF-CONTAINED Bun TypeScript program
(zero imports: flows run where mdflow isn't a dependency) that default-scaffolds
via `md hooks add <flow.md> [event…]`. It exports a `handlers` map keyed by
canonical camelCase events and implements two contracts:
`--mdflow-list-events` (prints its handled events as JSON; used only as a
REAL-RUN fallback when the static text parse fails — passive surfaces never
execute the file) and the stdin/stdout hook protocol
(payload JSON on stdin; a returned string → stdout context, object →
JSON.stringify'd decision, void → nothing, always exit 0).

Canonical events: `sessionStart userPromptSubmit preToolUse postToolUse
permissionRequest preCompact postCompact subagentStart subagentStop stop
sessionEnd`. Adapters map them to engine-native names via `applyHooks()`.

CONSENT BOUNDARIES (audit-hardened; regression-tested in
hooks-integration.test.ts "consent boundaries"):
- Passive surfaces NEVER execute hook code: explain, dry-run, the
  Workbench, and `md hooks list` discover events via
  `listHandledEventsStatic()` (text parse of the template's handlers map).
  Executing `--mdflow-list-events` is allowed ONLY as a real-run fallback —
  the flow is executing anyway, so it adds no privilege.
- Frontmatter `_hooks:` paths are CONTAINED to the flow's own directory
  subtree, and remote flows may not declare `_hooks` paths at all (hook
  programs run on the host OUTSIDE the engine sandbox). `--_hooks` from the
  CLI is unrestricted — the invoking user typed it.
- `md install` downloads only the flow markdown, never sibling hook files.

Codex translation (all facts verified empirically on codex-cli 0.144.1 —
see the probe evidence rules below before changing any of this):
- ONE inline override carries every event: `-c hooks={Event=[{hooks=[{type="command",command="'<bun>' '<file>'",timeout=60,…}]}]}`
  plus top-level `--dangerously-bypass-hook-trust` (without it codex
  SILENTLY skips unreviewed hooks). Event keys MUST be PascalCase —
  snake_case silently registers nothing. The event → group list → `hooks`
  list nesting is mandatory.
- The bypass flag is invocation-wide and hook sources AGGREGATE
  (`--ignore-user-config`/`--ephemeral` do NOT disable `$CODEX_HOME`
  hooks.json). Hooked runs therefore execute against a PREPARED CODEX_HOME
  (`~/.mdflow/codex-hooks-home`, built by adapters/codex-hooks-home.ts:
  auth.json symlink + `[projects]` trust copy + guaranteed-absent
  hooks.json) so the bypass can only authorize mdflow-injected hooks. As a
  consequence, hooks on codex REQUIRE isolation: `_isolated: false` + a
  hooks file is a hard error (HOOKS_REQUIRE_ISOLATION).
- `codex exec` fires SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Stop; SessionEnd never fires. Hook cwd = session cwd; stdin
  payload carries `hook_event_name` (PascalCase), `session_id`, `cwd`, etc.
- EXECUTION-time hook failures fail OPEN (codex continues the run), but
  DISCOVERY failures fail the run loudly (missing/rejected/uninspectable
  hooks file). UserPromptSubmit can block via exit 2 or
  `{"decision":"block"}`; Stop can force continuation.
Engines with no verified hook mechanism FAIL a run whose hooks file exists
(same policy as `_system-prompt`); `_hooks: false` opts out. Never add an
engine translation from guessed config — verify against the engine's own
help/docs first.

**Compatibility stamps (`src/compat.ts`):** every flow tracks which mdflow it
works with, with zero user involvement. `md create`/`md init` stamp
`_mdflow_version` (version created with); after any successful local run,
mdflow stamps/upgrades `_compat` (newest version verified to work) via a
surgical frontmatter edit that preserves the rest of the file byte for byte.
Upgrades only fire on major/minor skew — patch and prerelease bumps never
rewrite flows (no per-release git churn).
Remote flows and eval runs (`MDFLOW_EVAL_RUN=1`) are never stamped. A major
mismatch between the recorded version and the running mdflow prints a dim
stderr notice but never blocks. Frontmatter containing only these keys still
counts as "no frontmatter" for the document-vs-flow rule.

**Note:** `--_varname` CLI flags work without frontmatter declaration. If a `_` prefixed variable is used in the body but not provided, you'll be prompted for it.

**Variable History:** When prompting for missing variables, previous values are shown as defaults (stored in `~/.mdflow/variable-history.json`). Press Enter to accept the previous value or type to override. Use `--_no-history` to skip loading/saving variable history.

**All other keys** are passed directly as CLI flags:

```yaml
---
model: opus                  # → --model opus
dangerously-skip-permissions: true  # → --dangerously-skip-permissions
add-dir:                     # → --add-dir ./src --add-dir ./tests
  - ./src
  - ./tests
_env:                        # Sets process.env (underscore prefix = system key)
  API_KEY: secret
---
```

### Positional Mapping ($N)

Map the body or positional args to specific flags:

```yaml
---
$1: prompt    # Body passed as --prompt <body> instead of positional
---
```

### Print vs Interactive Mode

All commands default to **print mode** (non-interactive). Use `.i.` filename marker or `_interactive: true` for interactive mode.

```bash
task.claude.md      # Print mode: claude --print "..."
task.i.claude.md    # Interactive: claude "..."
task.copilot.md     # Print mode: copilot --silent --prompt "..."
task.i.copilot.md   # Interactive: copilot --silent --interactive "..."
task.codex.md       # Print mode: codex exec "..."
task.i.codex.md     # Interactive: codex "..."
task.gemini.md      # Print mode: gemini "..." (one-shot)
task.i.gemini.md    # Interactive: gemini --prompt-interactive "..."
task.droid.md       # Print mode: droid exec "..."
task.i.droid.md     # Interactive: droid "..."
task.opencode.md    # Print mode: opencode run "..."
task.i.opencode.md  # Interactive: opencode "..."
```

### Supported Models by CLI (December 2025)

**IMPORTANT:** Use these exact model names. Do not guess or use deprecated model names.

> **Staleness note (2026-07):** this table is a December 2025 snapshot and
> newer models have shipped since (e.g. the mdflow.dev examples use
> `gpt-5.5-codex-max` and `gemini-3.1-pro`). When a model name matters,
> verify against the engine CLI's own `--help`/docs instead of this table.

#### Claude Code (`claude`)
| Type | Values |
|------|--------|
| **Aliases** | `sonnet`, `opus`, `haiku`, `opusplan` |
| **Full names** | `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`, `claude-opus-4-1-20250805` |

Environment variables for alias control:
- `ANTHROPIC_DEFAULT_SONNET_MODEL` - Override sonnet alias
- `ANTHROPIC_DEFAULT_OPUS_MODEL` - Override opus alias
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` - Override haiku alias

#### Codex CLI (`codex`)
| Type | Values |
|------|--------|
| **Default** | `codex-mini-latest` (o4-mini optimized for CLI) |
| **Reasoning models** | `o3`, `o4-mini` |
| **GPT models** | `gpt-4.1` |

Codex works with any OpenAI model. Example: `-m o3` or `-c model="o3"`

#### Gemini CLI (`gemini`)
| Type | Values |
|------|--------|
| **Default (free)** | `gemini-2.5-pro` |
| **Preview** | `gemini-3-pro` (requires subscription or paid API key) |

To enable Gemini 3 Pro: run `/settings`, toggle "Preview features" to true.

#### Copilot CLI (`copilot`)
Explicit `--model` choices (from `copilot --help`):
| Category | Models |
|----------|--------|
| **Claude** | `claude-sonnet-4.5`, `claude-haiku-4.5`, `claude-opus-4.5`, `claude-sonnet-4` |
| **GPT** | `gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-5.1-codex-mini`, `gpt-5-mini`, `gpt-4.1` |
| **Gemini** | `gemini-3-pro-preview` |

### Global Config (`~/.mdflow/config.yaml`)

Set default frontmatter per command:

```yaml
commands:
  claude:
    model: sonnet # Default model for claude
```

### Template System (LiquidJS)

Uses [LiquidJS](https://liquidjs.com/) for full template support:

- Variables: `{{ _varname }}` (use `_` prefix for template vars)
- Stdin: `{{ _stdin }}` (auto-injected from piped input)
- Conditionals: `{% if _force %}--force{% endif %}`
- Filters: `{{ _name | upcase }}`, `{{ _value | default: "fallback" }}`
- CLI override: `--_varname value` matches `_varname` in frontmatter

## Testing Patterns

Tests use Bun's test runner with `describe`/`it` blocks:

```typescript
import { describe, it, expect } from "bun:test";

describe("parseCliArgs", () => {
  it("parses command flag", () => {
    const result = parseCliArgs(["node", "script", "file.md"]);
    expect(result.filePath).toBe("file.md");
  });
});
```
