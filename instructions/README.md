---
model: claude-haiku-4.5
silent: true
---

# Copilot Prompt Agents

Drop `.md` files here with YAML frontmatter to create reusable copilot prompts.

## Usage

Just type the filename in your terminal:

```bash
CHECK_ACTIONS.md
DEMO.md
```

## Frontmatter Options

| Field | Type | Description |
|-------|------|-------------|
| `pre` | string | Command to run first, output prepended to prompt |
| `model` | enum | AI model (claude-haiku-4.5, claude-opus-4.5, gpt-5, etc.) |
| `agent` | string | Custom agent name |
| `silent` | bool | Only output response, no stats |
| `interactive` | bool | Start interactive mode |
| `allow-all-tools` | bool | Auto-approve all tools |
| `allow-all-paths` | bool | Allow access to any file path |
| `allow-tool` | string | Allow specific tools |
| `deny-tool` | string | Deny specific tools |
| `add-dir` | string | Additional allowed directory |

## Example

```markdown
---
pre: gh run list --limit 5
model: claude-haiku-4.5
silent: true
---

Analyze the CI output above and summarize any failures.
```
