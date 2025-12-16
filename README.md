# mdflow

```bash
review.claude.md                 # Run with Claude
commit.gemini.md "fix auth bug"  # Run with Gemini
git diff | explain.claude.md     # Pipe through any command
```

**Your markdown files are now executable AI agents.**

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
task.gemini.md    # Runs gemini
task.codex.md     # Runs codex
task.copilot.md   # Runs copilot (print mode by default)
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

```bash
npm install -g mdflow
# or
bun install && bun link
```

## Quick Start

```bash
# Run with filename-inferred command
mdflow task.claude.md
mdflow task.gemini.md

# Override command via --_command flag
mdflow task.md --_command claude
mdflow task.md -_c gemini

# Pass additional flags to the command
mdflow task.claude.md --verbose --debug
```

> **Note:** Both `mdflow` and `md` commands are available.

---

## Command Resolution

Commands are resolved in this priority order:

1. **CLI flag**: `--_command claude` or `-_c claude`
2. **Filename pattern**: `task.claude.md` → `claude`

If no command can be resolved, you'll get an error with instructions.

---

## Flag Hijacking

Some CLI flags are "hijacked" by mdflow—they're consumed and never passed to the underlying command. This allows generic markdown files without command names to be executed.

### `--_command` / `-_c`

Override the command for any markdown file:

```bash
# Run a generic .md file with any command
mdflow task.md --_command claude
mdflow task.md -_c gemini

# Override the filename-inferred command
mdflow task.claude.md --_command gemini  # Runs gemini, not claude
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

The `--_feature_name` and `--_target_dir` flags are consumed by mdflow for template substitution—they won't be passed to the command.

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

## Global Configuration

Set default frontmatter per command in `~/.mdflow/config.yaml`:

```yaml
commands:
  claude:
    model: sonnet # Default model for claude
  copilot:
    silent: true  # Always use --silent for copilot
```

**Built-in defaults:** All commands default to print mode with appropriate flags per CLI tool.

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

Imports are recursive—imported files can have their own `@` imports.

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

Commands:
  md create [name]        Create a new agent file (opens in $EDITOR)
  md explain <agent.md>   Show resolved config without executing
  md setup                Configure shell (PATH, aliases)
  md logs                 Show agent log directory
  md help                 Show this help

Command resolution:
  1. --_command flag (e.g., md task.md --_command claude)
  2. Filename pattern (e.g., task.claude.md → claude)

All frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.mdflow/config.yaml

md-specific flags (consumed, not passed to command):
  --_command, -_c     Specify command to run
  --_dry-run          Preview without executing
  --_interactive, -_i Enable interactive mode
  --_edit             Open resolved prompt in $EDITOR before execution
  --_no-cache         Force fresh fetch for remote URLs (bypass cache)
  --_trust            Bypass TOFU prompts for remote URLs
  --_context          Show context tree and exit (no execution)
  --_quiet            Skip context dashboard display before execution
  --raw               Output raw markdown without rendering (for piping)

Examples:
  md task.claude.md -p "print mode"
  md task.claude.md --model opus --verbose
  md commit.gemini.md
  md task.md --_command claude
  md task.md -_c gemini
  md task.claude.md --_dry-run    # Preview without executing
  md task.claude.md --_edit       # Edit prompt before running
  md https://example.com/agent.claude.md  # Remote execution

Without arguments:
  md              Interactive agent picker (frecency-sorted)
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MDFLOW_FORCE_CONTEXT` | Set to `1` to disable the 100k token limit for glob imports |
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

- If no frontmatter is present, the file is printed as-is (unless command inferred from filename)
- Template system uses [LiquidJS](https://liquidjs.com/) - supports conditionals, loops, and filters
- Logs are always written to `~/.mdflow/logs/<agent-name>/` for debugging
- Use `md logs` to show the log directory
- Piped input is available as `{{ _stdin }}` template variable
- Template variables use `_` prefix: `_name` in frontmatter → `{{ _name }}` in body → `--_name` CLI flag
- Remote URLs are cached at `~/.mdflow/cache/` with 1-hour TTL (use `--_no-cache` to bypass)
- Imports inside code blocks (``` or `) are ignored by the parser
- Interactive file picker sorts by frecency (frequency + recency) for quick access to common agents
