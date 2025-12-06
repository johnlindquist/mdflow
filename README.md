# markdown-agent

**Think in Markdown. Execute Markdown Agents.**

A multi-backend CLI tool for executable markdown prompts. Run the same `.md` file against **Claude Code**, **OpenAI Codex**, **Google Gemini**, or **GitHub Copilot** by combining YAML frontmatter with markdown content.

## Philosophy: Markdown as the Universal Agent Format

The best AI workflows start with markdown. Why?

- **Readable**: Anyone can read and understand what an agent does
- **Versionable**: Track changes in git like any other code
- **Shareable**: Send a `.md` file to a colleague—no setup required
- **Portable**: Run the same agent on Claude today, Gemini tomorrow
- **Composable**: Pipe agents together like Unix commands

**For the best experience:** Create a directory of markdown agents and add it to your PATH. Your agents become available everywhere, just like any other CLI tool.

```bash
# Create your agents directory
mkdir -p ~/agents
cd ~/agents

# Add to PATH in ~/.zshrc
export PATH="$HOME/agents:$PATH"

# Now any agent is runnable from anywhere
REVIEW.md                    # Run code review agent
COMMIT.md "fix auth bug"     # Generate commit message
REFACTOR.md --model opus     # Refactor with specific model
```

## Key Features

- **Executable Markdown**: Your prompts are documentation. Your documentation is executable.
- **Multi-Backend Support**: Run prompts on Claude, Codex, Gemini, or Copilot with automatic backend detection
- **Agent Directories**: Keep agents on PATH for system-wide availability
- **Command Hooks**: Run shell commands before/after AI execution with output piping
- **Remote Execution**: Run prompts directly from URLs (like `npx`)
- **Wizard Mode**: Interactive input prompts with templates
- **Context Globs**: Include files by glob patterns
- **Output Extraction**: Extract JSON, code blocks, or markdown from responses
- **Result Caching**: Cache expensive LLM calls
- **Dry-Run Mode**: Audit what would run before executing

## Installation

```bash
npm install -g markdown-agent
# or
bun install && bun link
```

## Quick Start

```bash
# Auto-detect backend from model
ma task.md --model sonnet           # Uses Claude
ma task.md --model gpt-5            # Uses Codex
ma task.md --model gemini-2.5-pro   # Uses Gemini

# Explicit backend selection
ma task.md --runner claude
ma task.md --runner codex
ma task.md --runner gemini
ma task.md --runner copilot

# Dry-run to see what would execute
ma task.md --dry-run

# Run from URL
ma https://example.com/task.md
```

> **Note:** Both `ma` and `markdown-agent` commands are available.

## Runner Architecture

markdown-agent uses a **Runner Pattern** to normalize execution across backends. Each runner maps universal frontmatter to backend-specific CLI flags.

| Runner | CLI | God Mode Flag | Notes |
|--------|-----|---------------|-------|
| `claude` | `claude` | `--dangerously-skip-permissions` | MCP support |
| `codex` | `codex` | `--full-auto` | Sandbox modes |
| `gemini` | `gemini` | `--yolo` | Extensions, approval modes |
| `copilot` | `copilot` | `--allow-all-tools` | Legacy default |

### Auto-Detection

When no `runner` is specified, markdown-agent detects the appropriate backend from the model name:

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
  --check                 Validate frontmatter without executing
  --json                  Output validation as JSON (with --check)
  --setup                 Configure shell to run .md files directly
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
cat file.txt | ma PROMPT.md
# Prompt receives: <stdin>file contents</stdin>\n\nPrompt body
```

### Remote Execution

```bash
ma https://example.com/task.md
# Downloads, validates, and executes (use --dry-run first!)
```

## Validation & Repair

markdown-agent includes a Unix-pipe-friendly validation system. Use `--check` to validate frontmatter without executing, and `--json` to get machine-readable output for piping to repair agents.

### Human-Readable Validation

```bash
ma --check task.md
# ✅ task.md is valid

ma --check broken.md
# ❌ broken.md has errors:
#    - inputs.0.type: Invalid enum value
```

### JSON Output for Piping

```bash
ma --check task.md --json
```

Output:
```json
{
  "valid": false,
  "file": "task.md",
  "errors": ["inputs.0.type: Invalid enum value"],
  "content": "---\ninputs:\n  - name: x\n    type: string\n..."
}
```

### The Doctor Agent (Auto-Repair)

Pipe validation output to the DOCTOR agent for automatic fixes:

```bash
# Validate, fix, and save in one pipeline
ma --check broken.md --json | ma instructions/DOCTOR.md > fixed.md

# Preview the fix without saving
ma --check broken.md --json | ma instructions/DOCTOR.md
```

The Doctor agent:
- Reads the JSON validation report from stdin
- Fixes common schema violations (invalid types, missing fields)
- Outputs the complete corrected markdown file

### Project-Wide Linting

Validate all markdown files in a directory:

```bash
# Check all instruction files
for f in instructions/*.md; do
  ma --check "$f" || echo "FAILED: $f"
done

# Fix all broken files
for f in instructions/*.md; do
  if ! ma --check "$f" --json > /dev/null 2>&1; then
    ma --check "$f" --json | ma instructions/DOCTOR.md > "${f}.fixed"
    mv "${f}.fixed" "$f"
    echo "Fixed: $f"
  fi
done
```

## Batch/Swarm Mode

markdown-agent supports parallel agent execution using git worktrees for isolation. A "Planner" agent generates a JSON manifest, which `ma --run-batch` distributes across parallel workers.

### Manifest Format

```json
[
  {
    "agent": "agents/CODER.md",
    "branch": "feat/api",
    "vars": { "file": "src/api.ts", "task": "Add REST endpoint" },
    "model": "sonnet"
  },
  {
    "agent": "agents/TEST.md",
    "branch": true,
    "runner": "codex"
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | **Required.** Path to agent markdown file |
| `branch` | string \| boolean | Git branch for isolation. `true` auto-generates name |
| `vars` | object | Template variables to inject |
| `model` | string | Override model for this job |
| `runner` | string | Override runner for this job |

### Usage

```bash
# Planner outputs JSON manifest, batch mode dispatches workers
ma PLANNER.md --request "Add user profile" | ma --run-batch

# Control parallelism
ma --run-batch --concurrency 8 < jobs.json

# Verbose output shows job progress
ma --run-batch --verbose < jobs.json
```

### Git Worktree Isolation

When `branch` is specified:
1. Creates isolated git worktree in `.markdown-agent/worktrees/`
2. Symlinks `node_modules` from root (no reinstall needed)
3. Copies `.env` for secrets
4. Runs agent in isolated directory
5. Auto-commits changes on success
6. Cleans up worktree folder (branch preserved for review)

### Example: Planner + Workers

**PLANNER.md** - Generates the manifest:

```markdown
---
model: o1-preview
extract: json
silent: true
---
Request: "{{ request }}"

Plan 3 parallel tasks. Output JSON array with:
- "agent": path to worker (use "agents/CODER.md")
- "branch": unique branch name
- "vars": { "file": target file, "task": specific task }
```

**agents/CODER.md** - Generic worker:

```markdown
---
model: claude-sonnet-4-20250514
allow-tool: write
silent: true
---
File: {{ file }}
Task: {{ task }}

Implement the code changes.
```

**Run:**

```bash
ma PLANNER.md --request "Add dark mode" | ma --run-batch
```

**Output:**

```xml
<batch_summary total="3" succeeded="3" failed="0">
  <job index="0" agent="agents/CODER.md" status="success" branch="feat/theme-context" duration_ms="12340">
    Created ThemeContext provider...
  </job>
  <job index="1" agent="agents/CODER.md" status="success" branch="feat/dark-styles" duration_ms="8920">
    Added dark mode CSS variables...
  </job>
  <job index="2" agent="agents/CODER.md" status="success" branch="feat/toggle-ui" duration_ms="6540">
    Implemented toggle button...
  </job>
</batch_summary>

🌿 Worktrees committed. To merge:
   git merge feat/theme-context feat/dark-styles feat/toggle-ui
```

## Shell Setup: Treat .md as Agents

### The Power of Zsh Suffix Aliases

Zsh has a hidden superpower: **suffix aliases**. They let you associate file extensions with commands, making any `.md` file directly executable:

```bash
TASK.md                    # Just type the filename
TASK.md --model opus       # With options
TASK.md "focus on tests"   # With arguments
```

No `./`, no `ma` prefix, no shebangs. The shell sees `.md` and knows what to do.

Run the setup wizard to configure this:

```bash
ma --setup
```

### Manual Setup (macOS/Linux)

Add this to `~/.zshrc`:

```bash
# markdown-agent: Treat .md files as executable agents
alias -s md='_handle_md'
_handle_md() {
  local file="$1"
  shift
  # Pass file and any remaining args (--model, --silent, etc.) to handler
  if command -v ma &>/dev/null; then
    ma "$file" "$@"
  else
    echo "markdown-agent not installed. Install with: bun add -g markdown-agent"
    echo "Attempting to install now..."
    if command -v bun &>/dev/null; then
      bun add -g markdown-agent && ma "$file" "$@"
    elif command -v npm &>/dev/null; then
      npm install -g markdown-agent && ma "$file" "$@"
    else
      echo "Neither bun nor npm found. Please install markdown-agent manually."
      return 1
    fi
  fi
}
```

Then reload your shell: `source ~/.zshrc`

### Bash Users

Bash doesn't have suffix aliases, but you can use a function with tab completion:

```bash
# Add to ~/.bashrc
ma() {
  command ma "$@"
}
# Then use: ma TASK.md --model opus
```

### Windows

Windows doesn't have an equivalent to suffix aliases. Current options:

1. **WSL (recommended)**: Use Windows Subsystem for Linux with zsh
2. **Git Bash**: Use the bash approach above
3. **Direct invocation**: Always use `ma TASK.md`

We're exploring better Windows solutions. Contributions welcome!

## Building Your Agent Library

The real power of markdown-agent comes from building a personal library of agents. Create a directory, add it to your PATH, and your agents become first-class CLI tools.

### Recommended Structure

```
~/agents/
├── REVIEW.md          # Code review agent
├── COMMIT.md          # Commit message generator
├── REFACTOR.md        # Refactoring assistant
├── EXPLAIN.md         # Code explainer
├── TEST.md            # Test generator
├── DEBUG.md           # Debugging helper
├── PLAN.md            # Implementation planner
└── project-specific/
    ├── DEPLOY.md      # Your deployment workflow
    └── MIGRATE.md     # Database migration helper
```

### Add to PATH

Add this to your `~/.zshrc` (after running `ma --setup`):

```bash
# Make agents available everywhere
export PATH="$HOME/agents:$PATH"
```

### Usage From Anywhere

Once on PATH, agents work like any CLI command:

```bash
# From any directory
REVIEW.md                           # Review current directory
COMMIT.md "add user auth"           # Generate commit message
EXPLAIN.md src/complex-function.ts  # Explain specific file

# Pipe data through agents
git diff | REVIEW.md                # Review staged changes
cat error.log | DEBUG.md            # Debug from logs

# Chain agents together
PLAN.md "add dark mode" | COMMIT.md # Plan then commit
```

### Example Starter Agents

**REVIEW.md** - Quick code review:
```markdown
---
model: sonnet
context: ["**/*.ts", "!node_modules"]
silent: true
---
Review this code for bugs, security issues, and improvements.
Focus on the most critical issues first.
```

**COMMIT.md** - Generate commit messages:
```markdown
---
model: haiku
before: git diff --cached
silent: true
---
Generate a conventional commit message for these changes.
Be concise. Follow the format: type(scope): description
```

**EXPLAIN.md** - Explain code:
```markdown
---
model: sonnet
silent: true
---
Explain this code clearly and concisely.
Focus on: what it does, why it's designed this way, and any gotchas.

{{ $1 }}
```

## Notes

- If no frontmatter is present, the file is printed as-is
- `before` command output is wrapped in XML tags named after the command
- The first `after` command receives AI output via stdin
- Default `silent: true` suppresses interactive prompts
- Use `--dry-run` to audit remote scripts before execution
