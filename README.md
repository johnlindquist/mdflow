# markdown-agent

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

markdown-agent embraces the Unix philosophy:

- **No magic mapping** - Frontmatter keys pass directly to the command
- **Stdin/stdout** - Pipe data in and out
- **Composable** - Chain agents together
- **Transparent** - See what runs in logs

```bash
# Pipe input
git diff | ma review.claude.md

# Chain agents
ma plan.claude.md | ma implement.codex.md
```

---

## Installation

```bash
npm install -g markdown-agent
# or
bun install && bun link
```

## Quick Start

```bash
# Run with filename-inferred command
ma task.claude.md
ma task.gemini.md

# Override command via --command flag
ma task.md --command claude
ma task.md -c gemini

# Pass additional flags to the command
ma task.claude.md --verbose --debug
```

> **Note:** Both `ma` and `markdown-agent` commands are available.

---

## Command Resolution

Commands are resolved in this priority order:

1. **CLI flag**: `--command claude` or `-c claude`
2. **Filename pattern**: `task.claude.md` → `claude`

If no command can be resolved, you'll get an error with instructions.

---

## Flag Hijacking

Some CLI flags are "hijacked" by markdown-agent—they're consumed and never passed to the underlying command. This allows generic markdown files without command names to be executed.

### `--command` / `-c`

Override the command for any markdown file:

```bash
# Run a generic .md file with any command
ma task.md --command claude
ma task.md -c gemini

# Override the filename-inferred command
ma task.claude.md --command gemini  # Runs gemini, not claude
```

### `$varname` Fields

Frontmatter fields starting with `$` (except `$1`, `$2`...) hijack their corresponding CLI flags:

```yaml
---
$feature_name: Authentication   # Default value
$target_dir: src/features       # Default value
---
Build {{ feature_name }} in {{ target_dir }}.
```

```bash
# Use defaults
ma create.claude.md

# Override with CLI flags (hijacked, not passed to command)
ma create.claude.md --feature_name "Payments" --target_dir "src/billing"
```

The `--feature_name` and `--target_dir` flags are consumed by markdown-agent for template substitution—they won't be passed to the command.

---

## Frontmatter Reference

### System Keys (handled by markdown-agent)

| Field | Type | Description |
|-------|------|-------------|
| `args` | string[] | Named positional arguments for template variables |
| `env` | object | Set process environment variables |
| `env` | string[] | Pass as `--env` flags to command |
| `$1`, `$2`... | string | Map positional args to flags (e.g., `$1: prompt`) |
| `_interactive` | boolean | Enable interactive mode (overrides print-mode defaults) |
| `_subcommand` | string/string[] | Prepend subcommand(s) to CLI args |

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

All commands run in **print mode by default** (non-interactive, exit after completion). Use the `.i.` filename marker or `_interactive: true` to enable interactive mode.

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

Or use `_interactive: true` in frontmatter:

```yaml
---
_interactive: true
model: opus
---
Review this code with me interactively.
```

---

## Global Configuration

Set default frontmatter per command in `~/.markdown-agent/config.yaml`:

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

### Template Variables with Args

```markdown
# create-feature.claude.md
---
args: [feature_name, target_dir]
model: sonnet
---
Create a new feature called "{{ feature_name }}" in {{ target_dir }}.
```

```bash
ma create-feature.claude.md "Auth" "src/features"
```

### Environment Variables

```markdown
# api-test.claude.md
---
env:
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
- Set `MA_FORCE_CONTEXT=1` to override the token limit

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

---

## Environment Variables

markdown-agent automatically loads `.env` files from the markdown file's directory.

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
Usage: ma <file.md> [any flags for the command]
       ma <file.md> --command <cmd>
       ma --setup
       ma --logs
       ma --help

Command resolution:
  1. --command flag (e.g., ma task.md --command claude)
  2. Filename pattern (e.g., task.claude.md → claude)

All frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.markdown-agent/config.yaml

Examples:
  ma task.claude.md -p "print mode"
  ma task.claude.md --model opus --verbose
  ma commit.gemini.md
  ma task.md --command claude
  ma task.md -c gemini

Without a file:
  ma --setup    Configure shell to run .md files directly
  ma --logs     Show log directory
  ma --help     Show this help
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MA_FORCE_CONTEXT` | Set to `1` to disable the 100k token limit for glob imports |
| `NODE_ENV` | Controls which `.env.[NODE_ENV]` file is loaded (default: `development`) |

---

## Shell Setup

Make `.md` files directly executable:

```bash
ma --setup   # One-time setup
```

Then run agents directly:

```bash
task.claude.md                   # Just type the filename
task.claude.md --verbose         # With passthrough args
```

### Manual Setup (zsh)

Add to `~/.zshrc`:

```bash
alias -s md='ma'
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

## Notes

- If no frontmatter is present, the file is printed as-is (unless command inferred from filename)
- Template system uses [LiquidJS](https://liquidjs.com/) - supports conditionals, loops, and filters
- Logs are always written to `~/.markdown-agent/logs/<agent-name>/` for debugging
- Use `--logs` to show the log directory
- Stdin is wrapped in `<stdin>` tags and prepended to the prompt
