# md-agent

A multi-backend CLI tool for executable markdown prompts. Run the same `.md` file against **Claude Code**, **OpenAI Codex**, **Google Gemini**, or **GitHub Copilot** by combining YAML frontmatter with markdown content.

## Key Features

- **Multi-Backend Support**: Run prompts on Claude, Codex, Gemini, or Copilot with automatic backend detection
- **Executable Markdown**: Drop `.md` files with frontmatter to run AI prompts
- **Command Hooks**: Run shell commands before/after AI execution with output piping
- **Remote Execution**: Run prompts directly from URLs (like `npx`)
- **Wizard Mode**: Interactive input prompts with templates
- **Context Globs**: Include files by glob patterns
- **Output Extraction**: Extract JSON, code blocks, or markdown from responses
- **Result Caching**: Cache expensive LLM calls
- **Dry-Run Mode**: Audit what would run before executing

## Installation

```bash
bun install
bun link
```

## Quick Start

```bash
# Auto-detect backend from model
md-agent task.md --model sonnet           # Uses Claude
md-agent task.md --model gpt-5            # Uses Codex
md-agent task.md --model gemini-2.5-pro   # Uses Gemini

# Explicit backend selection
md-agent task.md --runner claude
md-agent task.md --runner codex
md-agent task.md --runner gemini
md-agent task.md --runner copilot

# Dry-run to see what would execute
md-agent task.md --dry-run

# Run from URL
md-agent https://example.com/task.md
```

## Runner Architecture

md-agent uses a **Runner Pattern** to normalize execution across backends. Each runner maps universal frontmatter to backend-specific CLI flags.

| Runner | CLI | God Mode Flag | Notes |
|--------|-----|---------------|-------|
| `claude` | `claude` | `--dangerously-skip-permissions` | MCP support |
| `codex` | `codex` | `--full-auto` | Sandbox modes |
| `gemini` | `gemini` | `--yolo` | Extensions, approval modes |
| `copilot` | `copilot` | `--allow-all-tools` | Legacy default |

### Auto-Detection

When no `runner` is specified, md-agent detects the appropriate backend from the model name:

| Model Pattern | Detected Runner |
|---------------|-----------------|
| `claude-*`, `sonnet`, `opus`, `haiku` | `claude` |
| `gpt-*`, `o1`, `o3`, `codex` | `codex` |
| `gemini-*` | `gemini` |
| (fallback) | `copilot` |

## Frontmatter Reference

### Universal Fields

| Field | Type | Description |
|-------|------|-------------|
| `runner` | string | Backend: `claude`, `codex`, `gemini`, `copilot`, `auto` |
| `model` | string | AI model name |
| `silent` | boolean | Non-interactive mode (default: true) |
| `interactive` | boolean | Force TTY session |
| `allow-all-tools` | boolean | Maps to each backend's "god mode" |
| `allow-all-paths` | boolean | Allow any file path |
| `allow-tool` | string | Allow specific tools |
| `deny-tool` | string | Deny specific tools |
| `add-dir` | string \| string[] | Additional directories to include |
| `before` | string \| string[] | Commands to run before, output prepended |
| `after` | string \| string[] | Commands to run after, piped with output |
| `context` | string \| string[] | Glob patterns for files to include |
| `extract` | string | Output mode: `json`, `code`, `markdown`, `raw` |
| `cache` | boolean | Enable result caching |
| `inputs` | InputField[] | Wizard mode interactive prompts |
| `requires` | object | Prerequisites: `bin`, `env` arrays |

### Backend-Specific Escape Hatches

Each backend has a config object for backend-specific flags:

#### Claude (`claude:`)

```yaml
claude:
  dangerously-skip-permissions: true
  mcp-config: ./postgres-mcp.json
  allowed-tools: Read,Write
```

#### Codex (`codex:`)

```yaml
codex:
  sandbox: workspace-write  # read-only | workspace-write | danger-full-access
  approval: on-failure      # untrusted | on-failure | on-request | never
  full-auto: true
  oss: true                 # Local models via Ollama
  local-provider: ollama
  cd: ./src
```

#### Gemini (`gemini:`)

```yaml
gemini:
  sandbox: true
  yolo: true
  approval-mode: auto_edit  # default | auto_edit | yolo
  allowed-tools: [tool1, tool2]
  extensions: [ext1, ext2]
  resume: latest
  allowed-mcp-server-names: [server1]
```

#### Copilot (`copilot:`)

```yaml
copilot:
  agent: my-custom-agent
```

## Examples

### Claude with MCP Server

```markdown
---
runner: claude
model: sonnet
silent: true
claude:
  mcp-config: ./postgres-mcp.json
---

Analyze the database schema and suggest optimizations.
```

### Codex Full-Auto Refactor

```markdown
---
runner: codex
allow-all-tools: true
codex:
  cd: ./src
---

Refactor the authentication middleware to use async/await.
```

### Gemini YOLO Mode

```markdown
---
runner: gemini
model: gemini-2.5-pro
allow-all-tools: true
gemini:
  approval-mode: yolo
---

Analyze this codebase and suggest improvements.
```

### Local LLM via Codex OSS

```markdown
---
runner: codex
codex:
  oss: true
  local-provider: ollama
---

Summarize this private document without external APIs.
```

### With Command Hooks

```markdown
---
before:
  - git log --oneline -5
  - git status
after:
  - tee commit-message.txt
---

Generate a commit message based on recent changes.
```

### Wizard Mode with Inputs

```markdown
---
inputs:
  - name: branch
    type: text
    message: "Target branch?"
    default: main
  - name: force
    type: confirm
    message: "Force push?"
    default: false
---

Create a PR to {{ branch }}{% if force %} with force push{% endif %}.
```

### Context Globs

```markdown
---
context:
  - src/**/*.ts
  - "!**/*.test.ts"
---

Review the TypeScript files above for potential issues.
```

## CLI Options

```
Usage: <file.md> [text] [options] [-- passthrough-args]

Options:
  --runner, -r <runner>   Select backend: claude, codex, copilot, gemini
  --model, -m <model>     Override AI model
  --silent, -s            Enable silent mode
  --no-silent             Disable silent mode
  --interactive, -i       Enable interactive mode
  --allow-all-tools       Allow all tools without confirmation
  --allow-all-paths       Allow access to any file path
  --allow-tool <pattern>  Allow specific tool
  --deny-tool <pattern>   Deny specific tool
  --add-dir <dir>         Add directory to allowed list
  --no-cache              Skip cache and force fresh execution
  --dry-run               Show what would be executed
  --help, -h              Show help

Passthrough:
  --                      Everything after -- is passed to the runner

Examples:
  task.md "focus on error handling"
  task.md --runner claude --model sonnet
  task.md --runner codex --model gpt-5
  task.md --runner gemini --model gemini-2.5-pro
  task.md -- --verbose --debug
```

## How It Works

1. **Parse**: Reads markdown file and extracts YAML frontmatter
2. **Resolve Runner**: Determines backend from CLI flag, frontmatter, or model heuristic
3. **Prerequisites**: Validates required binaries and environment variables
4. **Context**: Resolves glob patterns and includes file contents
5. **Inputs**: Prompts for wizard mode variables if defined
6. **Before**: Runs `before` commands, captures output in XML tags
7. **Execute**: Sends prompt to selected runner with mapped flags
8. **Extract**: Optionally extracts JSON/code/markdown from response
9. **After**: Pipes response to `after` commands
10. **Cache**: Stores result if caching enabled

### Stdin Support

```bash
cat file.txt | md-agent PROMPT.md
# Prompt receives: <stdin>file contents</stdin>\n\nPrompt body
```

### Remote Execution

```bash
md-agent https://example.com/task.md
# Downloads, validates, and executes (use --dry-run first!)
```

## Zsh Suffix Alias

```bash
# Add to ~/.zshrc
alias -s md='_handle_md'
_handle_md() {
  local file="$1"
  shift
  if [[ ! -f "$file" && -f "$HOME/agents/instructions/$file" ]]; then
    file="$HOME/agents/instructions/$file"
  fi
  bun run ~/agents/src/index.ts "$file" "$@"
}
```

Then run prompts directly:

```bash
./PROMPT.md
ANALYZE.md --runner claude --model opus
```

## Notes

- If no frontmatter is present, the file is printed as-is
- `before` command output is wrapped in XML tags named after the command
- The first `after` command receives AI output via stdin
- Default `silent: true` suppresses interactive prompts
- Use `--dry-run` to audit remote scripts before execution
