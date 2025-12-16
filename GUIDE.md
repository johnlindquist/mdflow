# The `mdflow` Examples Tour

This guide demonstrates 10 progressively more impressive ways to use `mdflow` (`md`). We start with basic scripts and end with a self-orchestrating swarm that works in parallel across multiple git worktrees.

---

## 1. The "Hello World"

**Concept:** *Command Inference*
The command to run (`claude`) is inferred automatically from the filename.

**File:** `01-hello.claude.md`

```markdown
---
model: haiku
---
Say "Hello! I am an executable markdown file." and nothing else.
```

**Run it:**

```bash
md 01-hello.claude.md
```

---

## 2. The Configurator

**Concept:** *Template Variables & Defaults*
Variables starting with `_` define defaults that can be overridden by CLI flags.

**File:** `02-config.gemini.md`

```markdown
---
model: gemini-1.5-flash
# Template variables with defaults
_env: development
_port: 8080
# Pass-through flags for Gemini
temperature: 0.1
json: true
---
Generate a JSON configuration for a server running in **{{ _env }}** mode on port **{{ _port }}**.
Return ONLY the raw JSON.
```

**Run it:**

```bash
# Use defaults
md 02-config.gemini.md

# Override with flags
md 02-config.gemini.md --_env production --_port 3000
```

---

## 3. The Logic Gate

**Concept:** *Conditionals & Template Variables*
Use `_varname` to define template variables, and LiquidJS tags to change the prompt dynamically.

**File:** `03-deploy.copilot.md`

```markdown
---
_service_name: ""
_platform: docker
model: gpt-4
---
Generate a deployment script for {{ _service_name }}.

{% if _platform == 'k8s' %}
Generate a Kubernetes Deployment YAML. Include liveness probes.
{% elsif _platform == 'aws' %}
Generate an AWS Lambda SAM template.
{% else %}
Generate a simple Dockerfile.
{% endif %}
```

**Run it:**

```bash
md 03-deploy.copilot.md --_service_name "auth-service" --_platform "k8s"
```

---

## 4. The Live Context

**Concept:** *Command Inlines*
Execute shell commands *inside* the prompt to inject the current system state.

**File:** `04-debug.claude.md`

```markdown
---
model: sonnet
---
I am seeing an error. Here is my current system state:

**Git Status:**
!`git status --short`

**Recent Logs:**
!`tail -n 5 error.log 2>/dev/null || echo "No logs found"`

Based on this, what should I check first?
```

**Run it:**

```bash
md 04-debug.claude.md
```

---

## 5. The Surgeon

**Concept:** *Symbol Extraction*
Import specific TypeScript interfaces or functions instead of wasting tokens on entire files.

**File:** `05-mock-gen.claude.md`

```markdown
---
model: sonnet
---
Generate a JSON mock object that satisfies this TypeScript interface:

@./src/types.ts#UserSession

Output only the JSON.
```

**Run it:**

```bash
md 05-mock-gen.claude.md > mock-user.json
```

---

## 6. The Auditor

**Concept:** *Glob Imports & Environment Config*
Import entire directory trees. We set `MDFLOW_FORCE_CONTEXT` in `env` to override the default token safety limit for large imports.

**File:** `06-audit.gemini.md`

```markdown
---
model: gemini-1.5-pro
env:
  MDFLOW_FORCE_CONTEXT: "1"
---
You are a Security Auditor. Scan the following files for hardcoded secrets or unsafe regex:

@./src/**/*.ts

List any vulnerabilities found.
```

**Run it:**

```bash
md 06-audit.gemini.md
```

---

## 7. The Unix Filter

**Concept:** *Standard Input (Stdin)*
Piped input is available as the `_stdin` template variable, allowing agents to act as filters in Unix pipes.

**File:** `07-describe-changes.claude.md`

```markdown
---
model: haiku
---
Generate a concise PR description for these changes:
{{ _stdin }}

Include a "Summary" and "Key Changes" section.
```

**Run it:**

```bash
git diff --staged | md 07-describe-changes.claude.md
```

---

## 8. The Architecture Review

**Concept:** *Agent Chaining*
Pipe the output of one agent (The Summarizer) into another (The Critic).

**File:** `08a-summarize.claude.md`

```markdown
---
model: haiku
---
Summarize the file content into a high-level architecture description:
{{ _stdin }}
```

**File:** `08b-critique.claude.md`

```markdown
---
model: opus
---
You are a Principal Engineer. Critique this architecture description:
{{ _stdin }}

Identify bottlenecks and suggest scalability improvements.
```

**Run it:**

```bash
cat src/*.ts | md 08a-summarize.claude.md | md 08b-critique.claude.md
```

---

## 9. The Remote Agent

**Concept:** *Remote Execution*
Run an agent directly from a URL without downloading it. Perfect for sharing team SOPs.

**Run it:**

```bash
md https://raw.githubusercontent.com/johnlindquist/mdflow/main/examples/hello.claude.md
```

Remote URLs are cached locally for 1 hour. Use `--no-cache` to force a fresh fetch:

```bash
md https://example.com/agent.claude.md --no-cache
```

---

## 10. The Grand Finale: Worktree Swarm

**Concept:** *Multi-Agent Worktree Orchestration*
An "Architect" agent generates a shell script that spawns multiple "Worker" agents, each running in a purely isolated git worktree.

**The Worker:** `10-worker.claude.md`

```markdown
---
_task: ""
model: sonnet
---
You are a worker bee. Implement this task in the current directory: {{ _task }}
Write the code to a file named `implementation.ts`.
```

**The Architect:** `10-architect.claude.md`

```markdown
---
_goal: ""
model: opus
---
You are a Fleet Commander. Break down the goal "{{ _goal }}" into 2 parallel sub-tasks.

Generate a BASH script that:
1. Creates 2 git worktrees (`wt-frontend` and `wt-backend`) on new branches.
2. Inside each worktree, runs `md ../10-worker.claude.md --_task "sub-task description"`.
3. Runs them in the background (`&`) and `wait`s for them to finish.

Output ONLY the raw bash script.
```

**Run the Swarm:**

```bash
# 1. The Architect creates the plan and script
# 2. We pipe the script to sh to execute the swarm immediately
md 10-architect.claude.md --_goal "Build a login page with a fastify backend" | sh
```

---

# Part 2: The UX Tour

While Part 1 focused on power and complexity, Part 2 focuses on **User Experience (UX)**. These examples demonstrate features designed to make working with AI agents safe, interactive, and easy to understand for your team.

---

## 11. The Interactive Wizard

**Concept:** *Variable Recovery*
**UX Problem:** You wrote a prompt with variables, but you don't want to memorize the flags.
**Solution:** If you forget to provide variables, `md` detects them and turns the CLI into an interactive form.

**File:** `11-onboarding.claude.md`

```markdown
---
_name: ""
_department: ""
_manager: ""
model: sonnet
---
Welcome to the team, {{ _name }}!

Please generate a warm onboarding email for a new engineer joining the {{ _department }} team.
Mention that their manager is {{ _manager }}.
```

**Run it (without flags):**

```bash
md 11-onboarding.claude.md
```

**`md` responds:**

```text
Missing required variables. Please provide values:
? _name: Alice
? _department: Platform
? _manager: Bob
```

*UX Benefit: Turns static scripts into interactive tools automatically.*

---

## 12. The Safety Net (Dry Run)

**Concept:** *Trust & Verification*
**UX Problem:** You are about to run an agent on your entire codebase, but you're nervous about token costs or context size.
**Solution:** Use `--dry-run` to see exactly what *would* happen—the command, the expanded files, and the token count—without executing anything.

**File:** `12-refactor.gemini.md`

```markdown
---
model: gemini-1.5-pro
---
Refactor every file in this directory:
@./src/**/*.ts
```

**Run it:**

```bash
md 12-refactor.gemini.md --dry-run
```

**Output:**

```text
DRY RUN - Command will NOT be executed
Command: gemini --model gemini-1.5-pro ...
Final Prompt: (Shows full expanded content of all files)
Estimated tokens: ~15,420
```

*UX Benefit: Verify expensive operations before spending money.*

---

## 13. The Native Binary

**Concept:** *Shebang Support*
**UX Problem:** Typing `md filename.md` feels like running a script. You want it to feel like a native system command.
**Solution:** Add a standard Unix shebang line.

**File:** `daily-report` (no extension needed)

```markdown
#!/usr/bin/env md
---
command: claude
model: haiku
---
Generate a "Daily Standup" update based on my git activity:
!`git log --since="24 hours ago" --oneline`
```

**Run it:**

```bash
chmod +x daily-report
./daily-report
```

*UX Benefit: Abstracts away the tool entirely. It just behaves like a binary.*

---

## 14. The "Knobs & Dials" Interface

**Concept:** *Template Variables with Defaults*
**UX Problem:** You want to expose configuration settings (defaults) that users can easily override via flags.
**Solution:** Variables starting with `_` in the frontmatter define defaults that can be overridden via `--_varname` flags.

**File:** `14-translator.gpt.md`

```markdown
---
command: openai
model: gpt-4o
# Default configuration
_lang: Spanish
_tone: Professional
_text: ""
---
Translate the following text into {{ _lang }}. Keep the tone {{ _tone }}.

<text>
{{ _text }}
</text>
```

**Run it:**

```bash
# Use defaults
md 14-translator.gpt.md --_text "Hello World"

# Tweak the knobs via flags
md 14-translator.gpt.md --_text "Hello World" --_lang "Pirate" --_tone "Aggressive"
```

*UX Benefit: Creates a stable CLI interface for your prompts.*

---

## 15. The Context Surgeon

**Concept:** *Symbol Extraction*
**UX Problem:** Importing entire files is wasteful and distracting when you only need one specific interface.
**Solution:** Use the `#Symbol` syntax to extract specific code blocks (Functions, Classes, Interfaces).

**File:** `15-test-gen.claude.md`

```markdown
---
model: sonnet
---
Write a unit test for this specific function:

@./src/utils.ts#calculateTax

Ensure it returns a type matching:

@./src/types.ts#TaxResult
```

*UX Benefit: Precision context reduces hallucinations and token costs.*

---

## 16. The "Context Pack"

**Concept:** *Recursive Imports*
**UX Problem:** You constantly have to import the same 5 files (auth, database, types) for every task.
**Solution:** Create a "Context Pack"—a markdown file that just imports other files—and import *that*.

> **Note:** Import statements inside code blocks (``` or \`) are now properly ignored by the parser.

**File:** `_context-auth.md`

```markdown
# Auth System Context
@./src/auth/session.ts
@./src/auth/types.ts
@./src/auth/login.ts
```

**File:** `16-security-audit.claude.md`

```markdown
---
model: opus
---
Review the authentication flow for security holes.
@./_context-auth.md
```

*UX Benefit: Build a library of "mental models" that are easy to drop into any agent.*

---

## 17. The Secret Keeper

**Concept:** *Environment Isolation*
**UX Problem:** You need API keys in your prompts but can't commit them to Git.
**Solution:** `md` automatically loads `.env` files from the markdown file's directory.

**Structure:**

```text
/my-agents/
  ├── .env          (Contains: API_URL=https://api.staging.com)
  └── 17-api-check.claude.md
```

**File:** `17-api-check.claude.md`

```markdown
---
model: sonnet
---
Write a curl command to check the health of:
!`echo $API_URL`
```

*UX Benefit: Safe, zero-config secret management that works with Git.*

---

## 18. The Chameleon (Polymorphism)

**Concept:** *Command Override*
**UX Problem:** You want to A/B test a prompt against different models without creating multiple files.
**Solution:** Override the inferred command using the `-c` flag.

**File:** `18-story.md` (No command in filename)

```markdown
Write a two-sentence horror story about a compiler.
```

**Run it:**

```bash
# Test with Claude
md 18-story.md -c claude --model haiku

# Test with Gemini
md 18-story.md -c gemini --model gemini-1.5-flash
```

*UX Benefit: Decouple your prompt logic from specific providers.*

---

## 19. The Black Box Recorder

**Concept:** *Structured Logging*
**UX Problem:** An agent hallucinated or failed, and you need to see exactly what was sent to the API.
**Solution:** `md` logs every execution to `~/.mdflow/logs/`.

**File:** `19-mystery.claude.md`

```markdown
---
model: opus
---
(Some complex prompt with dynamic imports...)
```

**Run it:**

```bash
md 19-mystery.claude.md
```

**Debug it:**

```bash
md logs
# Agent logs:
#   /Users/me/.mdflow/logs/19-mystery-claude/
```

*UX Benefit: Instant forensic debugging without cluttering your terminal.*

---

## 20. The "Meta" Agent

**Concept:** *Self-Replication*
**UX Problem:** Creating new agents takes time.
**Solution:** Use an agent to write your agents.

**File:** `20-agent-smith.claude.md`

```markdown
---
_goal: ""
model: sonnet
---
I want to create a new markdown-agent file.
Goal: {{ _goal }}

Write the full content of a `.md` file that accomplishes this.
Include appropriate frontmatter defaults (model, _varname template variables).
Use standard `md` features like `@imports` if the goal implies reading code.

Output ONLY the raw markdown code block.
```

**Run it:**

```bash
md 20-agent-smith.claude.md --_goal "Review my rust code" > review-rust.claude.md
```

*UX Benefit: The tool helps you build the tool.*

---

# Part 3: New Features Tour

These examples demonstrate the latest features added to mdflow.

---

## 21. The Form Builder

**Concept:** *Typed Interactive Inputs*
**UX Problem:** You want a proper form with different input types, not just text prompts.
**Solution:** Use the new `_inputs` object format with typed fields.

**File:** `21-deploy-wizard.claude.md`

```markdown
---
model: sonnet
_inputs:
  _service:
    type: text
    description: "Service name"
    default: "api"
  _environment:
    type: select
    options: [development, staging, production]
  _replicas:
    type: number
    description: "Number of replicas"
  _dry_run:
    type: confirm
    description: "Dry run only?"
---
Generate a deployment manifest for {{ _service }} in {{ _environment }}.
{% if _replicas > 1 %}Use {{ _replicas }} replicas for high availability.{% endif %}
{% if _dry_run %}This is a dry run - just show what would happen.{% endif %}
```

**Run it:**

```bash
md 21-deploy-wizard.claude.md
```

*UX Benefit: Type-safe forms with select dropdowns, number inputs, and confirmations.*

---

## 22. The Inspector

**Concept:** *Configuration Debugging*
**UX Problem:** Your agent isn't running as expected, and you need to see what's actually being sent.
**Solution:** Use `md explain` to see the fully resolved configuration.

**Run it:**

```bash
md explain review.claude.md
```

**Output:**

```text
╭─ Agent Analysis ──────────────────────────────────────────────╮
│ Command:        claude (from filename: review.claude.md)      │
│ Interactive:    false (default: print mode)                   │
│                                                               │
│ Config Chain:                                                 │
│   ✓ Built-in defaults                                         │
│   ✓ ~/.mdflow/config.yaml                                     │
│   ✗ ./mdflow.config.yaml (not found)                          │
│   ✓ Frontmatter                                               │
│                                                               │
│ Final Flags:    --model opus --print                          │
│ Token Usage:    ~12,450 / 100,000 (12.4%)                    │
╰───────────────────────────────────────────────────────────────╯
```

*UX Benefit: Understand exactly what md will do before running it.*

---

## 23. The Preflight Check

**Concept:** *Context Visualization*
**UX Problem:** You're importing many files and want to verify the context before sending to the LLM.
**Solution:** Use `--_context` to see the context tree and exit.

**File:** `23-review-all.claude.md`

```markdown
---
model: opus
---
Review this entire codebase:
@./src/**/*.ts
@./tests/**/*.ts
```

**Run it:**

```bash
md 23-review-all.claude.md --_context
```

**Output:**

```text
┌─ Pre-Flight ──────────────────────────────────────────────────┐
│  📄 23-review-all.claude.md                            0.2 KB │
│  ├── 📁 @./src/**/*.ts                     (24 files) 48.3 KB │
│  └── 📁 @./tests/**/*.ts                   (12 files) 22.1 KB │
│                                                               │
│  Total: 70.6 KB (~17,650 tokens)                             │
└───────────────────────────────────────────────────────────────┘
```

*UX Benefit: Know your token budget before committing to an expensive API call.*

---

## 24. The Editor's Cut

**Concept:** *Edit Before Execute*
**UX Problem:** You want to tweak the final prompt after all imports are resolved.
**Solution:** Use `--_edit` to open the fully resolved prompt in your editor.

**File:** `24-summarize.claude.md`

```markdown
---
model: haiku
---
Summarize this code:
@./src/main.ts
```

**Run it:**

```bash
md 24-summarize.claude.md --_edit
```

Your `$EDITOR` opens with the fully expanded prompt. Make any changes, save, and close. The edited version is then sent to the LLM.

*UX Benefit: Last-chance editing for context-sensitive adjustments.*

---

## 25. The Pretty Printer

**Concept:** *Rich Terminal Output*
**UX Problem:** LLM output with code blocks looks ugly in the terminal.
**Solution:** mdflow now renders markdown with syntax highlighting by default.

**Run it:**

```bash
md explain-code.claude.md  # Beautiful syntax-highlighted output
```

For piping to other tools, use `--raw`:

```bash
md generate-json.claude.md --raw | jq .
```

*UX Benefit: Professional-looking output that's easy to read.*

---

## 26. The History Buff

**Concept:** *Frecency-Based File Picker*
**UX Problem:** You have many agents and finding the right one takes time.
**Solution:** The interactive picker now sorts by frecency (frequency + recency).

**Run it:**

```bash
md   # No arguments - opens the picker
```

Files you use often and recently appear at the top. The algorithm uses Mozilla/z-style recency buckets:
- Used in last 4 hours: 4x multiplier
- Used in last 24 hours: 2x multiplier
- Used in last week: 0.5x multiplier
- Older: 0.25x multiplier

*UX Benefit: Your most-used agents are always a keystroke away.*
