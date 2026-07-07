# mdflow New Features Guide

This guide covers the seven major features added to mdflow that take it from a CLI wrapper to developer infrastructure.

---

## Table of Contents

1. [Portable Agent Spec (Adapters)](#1-portable-agent-spec)
2. [Workflow Engine](#2-workflow-engine)
3. [Structured Outputs](#3-structured-outputs)
4. [Context Providers](#4-context-providers)
5. [Agent Registry](#5-agent-registry)
6. [JSON Output Mode](#6-json-output-mode)
7. [Run Telemetry](#7-run-telemetry)
8. [Automatic Compatibility Stamps](#8-automatic-compatibility-stamps)

---

## 1. Portable Agent Spec

Write agent files once, run them on any AI CLI. Canonical frontmatter keys are automatically translated to provider-specific flags.

### Canonical Keys

| Key | Description |
|-----|-------------|
| `model` | Model name/alias |
| `temperature` | Sampling temperature |
| `max-tokens` | Maximum output tokens (also accepts `max_tokens`, `maxTokens`) |

### Example

```yaml
---
model: sonnet
temperature: 0.7
max-tokens: 4096
---
Explain this codebase.
```

Run with any provider:

```bash
md task.claude.md          # Translates to: claude --model sonnet --print ...
md task.gemini.md          # Translates to: gemini --model sonnet ...
md task.copilot.md         # Translates to: copilot --model sonnet ...
```

### Override Provider at Runtime

Use `--tool` (or `--_command`) to switch providers without renaming the file:

```bash
md task.claude.md --tool gemini
```

Or set it in frontmatter:

```yaml
---
_command: gemini
model: gemini-2.5-pro
---
```

### Supported Adapters

Claude, Codex, Gemini, Copilot, Droid, and OpenCode each have a dedicated adapter that maps canonical keys to their specific CLI flags.

---

## 2. Workflow Engine

Define multi-step agent pipelines as a single `.md` file. Steps run in dependency order with parallel execution for independent steps.

### Basic Workflow

```yaml
---
_steps:
  - id: plan
    run: Plan the implementation for a login page
    tool: claude

  - id: implement
    run: "Implement the plan: {{ steps.plan.stdout }}"
    tool: claude
    needs: [plan]

  - id: test
    run: "Write tests for: {{ steps.implement.stdout }}"
    tool: claude
    needs: [implement]
---
```

### Step Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique step identifier (required) |
| `run` | string | Prompt or agent file path (required) |
| `tool` | string | Override AI CLI for this step |
| `needs` | string[] | Step IDs that must complete first |
| `vars` | object | Extra template variables for this step |
| `outputs` | object | Extract named values from stdout |
| `retry` | number | Max retry attempts on failure |
| `when` | string/boolean | Conditional execution |

### Parallel Execution

Steps without dependencies (or whose dependencies are all satisfied) run in parallel:

```yaml
---
_steps:
  - id: frontend
    run: Review the frontend code
  - id: backend
    run: Review the backend code
  - id: summary
    run: "Summarize: {{ steps.frontend.stdout }} and {{ steps.backend.stdout }}"
    needs: [frontend, backend]
---
```

Here `frontend` and `backend` run in parallel. `summary` waits for both.

### Step Outputs

Extract structured data from step results:

```yaml
---
_steps:
  - id: analyze
    run: List the top 3 bugs as JSON
    outputs:
      bugs: stdout
  - id: fix
    run: "Fix these bugs: {{ steps.analyze.bugs }}"
    needs: [analyze]
---
```

### Caching and Resume

Workflow steps are cached by SHA256 of (prompt + args + tool). Resume a partially completed workflow:

```bash
md workflow.claude.md --_resume
```

Cached results are stored in `.mdflow/.cache/`. Use `--_no-cache` to force re-execution.

### Conditional Steps

```yaml
---
_steps:
  - id: lint
    run: Run the linter
  - id: fix
    run: Fix lint errors
    needs: [lint]
    when: "{{ steps.lint.exitCode != 0 }}"
---
```

---

## 3. Structured Outputs

Process, validate, and act on command output. Extract JSON, validate against Zod schemas, save to files, or apply patches.

### Configuration

Add `_output` to frontmatter:

```yaml
---
_output:
  format: json
  schema: ./schemas/config.ts#ConfigSchema
  save: ./output/result.json
---
Generate a JSON configuration for the project.
```

### Output Formats

| Format | Behavior |
|--------|----------|
| `json` | Extracts JSON from fenced blocks or raw output, validates optionally |
| `text` | Passes through as-is |
| `patch` | Extracts unified diff, optionally applies via `git apply` |

### JSON Extraction

The extractor tolerantly finds JSON in AI output:

```markdown
Here's the config:

\`\`\`json
{"name": "myapp", "version": "1.0"}
\`\`\`
```

It searches for fenced JSON blocks first, then falls back to raw JSON detection.

### Schema Validation

Point to a Zod schema export:

```yaml
---
_output:
  format: json
  schema: ./schemas/task.ts#TaskSchema
---
```

Where `schemas/task.ts` exports:

```typescript
import { z } from "zod";
export const TaskSchema = z.object({
  title: z.string(),
  priority: z.enum(["low", "medium", "high"]),
});
```

If validation fails, mdflow logs a clear error with the Zod issue details.

### Applying Patches

```yaml
---
_output:
  format: patch
  apply: true
---
Generate a unified diff to fix the bug in src/auth.ts.
```

The patch is applied via `git apply` after extraction.

### Post-Run Menu Enhancements

The post-run menu now detects artifacts in output:

- **Unified diffs** (lines with `---`, `+++`, `@@`) &rarr; "Apply patch" option
- **JSON blocks** &rarr; "Copy JSON" / "Save JSON" options
- **Shell commands** in ```bash blocks &rarr; "Run command" option

---

## 4. Context Providers

First-class imports for common developer context. Safer and more portable than shell command imports.

### Syntax

Use `@provider:subcommand` in your markdown body:

```markdown
---
model: sonnet
---
Review the following changes:

@git:diff

Here's the project structure:

@tree

Find all TODO comments:

@rg:TODO
```

### Available Providers

| Provider | Description | Example |
|----------|-------------|---------|
| `@git:diff` | Unstaged changes | `@git:diff` |
| `@git:staged` | Staged changes | `@git:staged` |
| `@git:status` | Porcelain status | `@git:status` |
| `@git:log(N)` | Last N commits (default 20) | `@git:log(10)` |
| `@tree` | File listing (respects .gitignore) | `@tree` |
| `@rg:pattern` | Ripgrep search | `@rg:useEffect` |

### Token Budgeting

Prevent context explosion with `_context_budget_tokens`:

```yaml
---
_context_budget_tokens: 8000
---
Review this diff:

@git:diff
```

When output exceeds the budget, providers truncate intelligently. For example, `@git:diff` falls back to `git diff --stat` instead of the full diff.

### Why Not Shell Commands?

Context providers vs `!` command imports:

| | Context Providers | Shell Commands |
|---|---|---|
| Cross-platform | Yes (spawns binaries directly) | Shell-dependent |
| Token budgeting | Built-in | Manual |
| Security | Sandboxed | Full shell access |
| Error handling | Typed errors | Raw stderr |

---

## 5. Agent Registry

Install, share, and version-pin reusable agents.

### Install an Agent

From a URL:

```bash
md install https://example.com/agents/review.claude.md
```

From GitHub (shorthand):

```bash
md install gh:myorg/agents/code-review.claude.md@v1.2
```

The `gh:` shorthand resolves to `raw.githubusercontent.com`.

### Scopes

| Scope | Location | Use case |
|-------|----------|----------|
| Project | `./.mdflow/registry/` | Team-shared agents, committed to repo |
| User | `~/.mdflow/registry/` | Personal agent library |

Default scope is `project`. Use `--global` for user scope.

### Lockfile

Every install writes to `.mdflow/mdflow.lock.json`:

```json
{
  "review.claude.md": {
    "source": "gh:myorg/agents/review.claude.md@v1.2",
    "resolvedRef": "v1.2",
    "sha256": "a1b2c3...",
    "installedPath": ".mdflow/registry/review.claude.md",
    "installedAt": "2025-01-15T10:30:00Z"
  }
}
```

Commit the lockfile for reproducible CI builds.

### List and Remove

```bash
md list                    # List all installed agents
md list --project          # Project-scoped only
md list --global           # User-scoped only
md remove review.claude.md # Remove an agent
```

---

## 6. JSON Output Mode

Machine-readable output for scripting, CI pipelines, and editor integrations.

### Usage

```bash
md task.claude.md --json
```

### Output Format

A single JSON object on stdout:

```json
{
  "exitCode": 0,
  "command": "claude",
  "args": ["--model", "sonnet", "--print", "Explain this code"],
  "stdout": "This code implements...",
  "stderr": ""
}
```

### Behavior Changes in JSON Mode

- Spinners and progress indicators are suppressed
- Interactive prompts are skipped
- Post-run menu is disabled
- All output is captured and returned in the JSON payload

### Scripting Example

```bash
# Extract just the AI response
md task.claude.md --json | jq -r '.stdout'

# Check exit code programmatically
result=$(md task.claude.md --json)
if [ "$(echo "$result" | jq '.exitCode')" -eq 0 ]; then
  echo "Success"
fi

# Pipe into another tool
md analyze.claude.md --json | jq -r '.stdout' | md fix.claude.md
```

### CI Integration

```yaml
# GitHub Actions example
- name: Run AI review
  run: |
    result=$(md review.claude.md --json)
    echo "$result" | jq -r '.stdout' > review.md
```

---

## 7. Run Telemetry

Track agent execution metrics across runs.

### Automatic Logging

Every `md` run appends a record to `~/.mdflow/runs.jsonl`:

```json
{
  "agentPath": "review.claude.md",
  "tool": "claude",
  "durationMs": 4523,
  "exitCode": 0,
  "outputBytes": 2847,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Budget Enforcement

Set limits in frontmatter to prevent runaway costs:

```yaml
---
_max_prompt_tokens: 50000
_max_runtime_ms: 30000
---
```

| Key | Description |
|-----|-------------|
| `_max_prompt_tokens` | Reject if estimated prompt tokens exceed this |
| `_max_runtime_ms` | Maximum execution time in milliseconds |

If a budget is exceeded, mdflow exits with a clear error before spawning the command.

### Viewing Telemetry

The runs file is newline-delimited JSON (JSONL), easy to query:

```bash
# Recent runs
tail -20 ~/.mdflow/runs.jsonl | jq .

# Slowest runs
cat ~/.mdflow/runs.jsonl | jq -s 'sort_by(-.durationMs) | .[0:5]'

# Failed runs
cat ~/.mdflow/runs.jsonl | jq 'select(.exitCode != 0)'

# Total runs per tool
cat ~/.mdflow/runs.jsonl | jq -s 'group_by(.tool) | map({tool: .[0].tool, count: length})'
```

---

## 8. Automatic Compatibility Stamps

Every flow tracks which mdflow version it works with — you never touch this.

```yaml
---
description: review staged changes
_mdflow_version: 3.0.0   # stamped when md create / md init wrote the file
_compat: 3.1.0           # newest mdflow that ran this flow successfully
---
```

How it works:

- **Creation**: `md create` and `md init` stamp `_mdflow_version` with the
  running mdflow version.
- **Verification**: after any successful local run, mdflow stamps (or
  upgrades) `_compat`. Flows created before this system existed get tagged
  the first time they run cleanly. Upgrades only fire when the recorded
  version is behind on major or minor — mdflow patch releases never touch
  your flows.
- **Skew notice**: if a flow's recorded version and your mdflow disagree on
  major version, a dim one-line notice appears on stderr. Execution is never
  blocked — the next clean run re-verifies automatically.
- **Never noisy**: stamps are surgical single-line frontmatter edits (the
  rest of the file is untouched, byte for byte), remote flows and eval
  sandboxes are never stamped, and a failed stamp never affects the run.
- Neither key is ever passed to the engine as a CLI flag, and a markdown
  file whose frontmatter contains only these stamps is still treated as a
  document, not an executable flow.

---

## Combining Features

These features compose naturally. Here's a complete example using several together:

```yaml
---
model: sonnet
_context_budget_tokens: 10000
_max_runtime_ms: 60000
_output:
  format: json
  schema: ./schemas/review.ts#ReviewSchema
  save: ./reports/review.json
_steps:
  - id: gather
    run: |
      Analyze this diff and list issues:
      @git:staged
    outputs:
      issues: stdout

  - id: review
    run: |
      For each issue, provide a severity and fix suggestion.
      Issues: {{ steps.gather.issues }}
      Format as JSON matching the ReviewSchema.

  - id: report
    run: |
      Generate a markdown summary of: {{ steps.review.stdout }}
    needs: [review]
---
```

Run it:

```bash
# Interactive
md review.i.claude.md

# Print mode with JSON output for CI
md review.claude.md --json | jq -r '.stdout'

# Resume from cache if partially completed
md review.claude.md --_resume
```

---

## Quick Reference

### New Frontmatter Keys

| Key | Type | Feature |
|-----|------|---------|
| `_steps` | array | Workflow engine |
| `_output` | object | Structured outputs |
| `_context_budget_tokens` | number | Context providers |
| `_max_prompt_tokens` | number | Budget enforcement |
| `_max_runtime_ms` | number | Budget enforcement |

### New CLI Flags

| Flag | Feature |
|------|---------|
| `--json` | JSON output mode |
| `--tool <name>` | Override provider |
| `--_resume` | Resume workflow from cache |

### New Subcommands

| Command | Feature |
|---------|---------|
| `md install <spec>` | Agent registry |
| `md remove <name>` | Agent registry |
| `md list` | Agent registry |

### New Import Syntax

| Syntax | Feature |
|--------|---------|
| `@git:diff` | Context provider |
| `@git:staged` | Context provider |
| `@git:status` | Context provider |
| `@git:log(N)` | Context provider |
| `@tree` | Context provider |
| `@rg:pattern` | Context provider |
