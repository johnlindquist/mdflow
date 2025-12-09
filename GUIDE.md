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

**Concept:** *Hijacked Flags & Defaults*
Variables starting with `$` define defaults that can be overridden by CLI flags.

**File:** `02-config.gemini.md`

```markdown
---
model: gemini-1.5-flash
# Default values
$env: development
$port: 8080
# Pass-through flags for Gemini
temperature: 0.1
json: true
---
Generate a JSON configuration for a server running in **{{ env }}** mode on port **{{ port }}**.
Return ONLY the raw JSON.
```

**Run it:**

```bash
# Use defaults
md 02-config.gemini.md

# Override with flags
md 02-config.gemini.md --env production --port 3000
```

---

## 3. The Logic Gate

**Concept:** *Conditionals & Args*
Use `args` to map positional arguments, and LiquidJS tags to change the prompt dynamically.

**File:** `03-deploy.copilot.md`

```markdown
---
args: [service_name, platform]
model: gpt-4
---
Generate a deployment script for {{ service_name }}.

{% if platform == 'k8s' %}
Generate a Kubernetes Deployment YAML. Include liveness probes.
{% elsif platform == 'aws' %}
Generate an AWS Lambda SAM template.
{% else %}
Generate a simple Dockerfile.
{% endif %}
```

**Run it:**

```bash
md 03-deploy.copilot.md "auth-service" "k8s"
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
`md` automatically wraps piped input in `<stdin>` tags, allowing agents to act as filters in Unix pipes.

**File:** `07-describe-changes.claude.md`

```markdown
---
model: haiku
---
Generate a concise PR description for the changes in <stdin>.
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
Summarize the file content in <stdin> into a high-level architecture description.
```

**File:** `08b-critique.claude.md`

```markdown
---
model: opus
---
You are a Principal Engineer. Critique the architecture description provided in <stdin>.
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
args: [task]
model: sonnet
---
You are a worker bee. Implement this task in the current directory: {{ task }}
Write the code to a file named `implementation.ts`.
```

**The Architect:** `10-architect.claude.md`

```markdown
---
args: [goal]
model: opus
---
You are a Fleet Commander. Break down the goal "{{ goal }}" into 2 parallel sub-tasks.

Generate a BASH script that:
1. Creates 2 git worktrees (`wt-frontend` and `wt-backend`) on new branches.
2. Inside each worktree, runs `md ../10-worker.claude.md "sub-task description"`.
3. Runs them in the background (`&`) and `wait`s for them to finish.

Output ONLY the raw bash script.
```

**Run the Swarm:**

```bash
# 1. The Architect creates the plan and script
# 2. We pipe the script to sh to execute the swarm immediately
md 10-architect.claude.md "Build a login page with a fastify backend" | sh
```

---

# Part 2: The UX Tour

While Part 1 focused on power and complexity, Part 2 focuses on **User Experience (UX)**. These examples demonstrate features designed to make working with AI agents safe, interactive, and easy to understand for your team.

---

## 11. The Interactive Wizard

**Concept:** *Variable Recovery*
**UX Problem:** You wrote a prompt with variables, but you don't want to memorize the argument order.
**Solution:** If you forget to provide variables, `md` detects them and turns the CLI into an interactive form.

**File:** `11-onboarding.claude.md`

```markdown
---
model: sonnet
---
Welcome to the team, {{ name }}!

Please generate a warm onboarding email for a new engineer joining the {{ department }} team.
Mention that their manager is {{ manager }}.
```

**Run it (without arguments):**

```bash
md 11-onboarding.claude.md
```

**`md` responds:**

```text
Missing required variables. Please provide values:
? name: Alice
? department: Platform
? manager: Bob
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

**Concept:** *Hijacked Configuration ($vars)*
**UX Problem:** You want to expose configuration settings (defaults) that users can easily override via flags.
**Solution:** Variables starting with `$` in the frontmatter define defaults that are "hijacked" (consumed) by the template system.

**File:** `14-translator.gpt.md`

```markdown
---
command: openai
model: gpt-4o
# Default configuration
$lang: Spanish
$tone: Professional
---
Translate the following text into {{ lang }}. Keep the tone {{ tone }}.

<text>
{{ $1 }}
</text>
```

**Run it:**

```bash
# Use defaults
md 14-translator.gpt.md "Hello World"

# Tweak the knobs via flags
md 14-translator.gpt.md "Hello World" --lang "Pirate" --tone "Aggressive"
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
args: [goal]
model: sonnet
---
I want to create a new markdown-agent file.
Goal: {{ goal }}

Write the full content of a `.md` file that accomplishes this.
Include appropriate frontmatter defaults (model, args).
Use standard `md` features like `@imports` if the goal implies reading code.

Output ONLY the raw markdown code block.
```

**Run it:**

```bash
md 20-agent-smith.claude.md "Review my rust code" > review-rust.claude.md
```

*UX Benefit: The tool helps you build the tool.*
