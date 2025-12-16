# Spec-Driven Development Example

This folder demonstrates spec-driven development using mdflow—a lightweight, markdown-based approach inspired by GitHub's Spec Kit.

## The Pattern

Instead of complex frameworks, use simple markdown files with YAML frontmatter to guide development through phases:

1. **constitution.claude.md** - Define project principles and values
2. **specify.claude.md** - Write user stories and requirements
3. **plan.claude.md** - Create technical architecture and design
4. **tasks.claude.md** - Break down into actionable tasks
5. **implement.claude.md** - Execute and validate implementation

## How to Use

Run each phase in order:

```bash
# Define principles
md constitution.claude.md

# Write requirements
md specify.claude.md

# Plan technical approach
md plan.claude.md

# Break into tasks
md tasks.claude.md

# Execute implementation
md implement.claude.md
```

## Why This Approach?

- **Lightweight**: Just markdown files, no complex frameworks
- **AI-friendly**: YAML frontmatter + structured content works well with AI assistants
- **Versionable**: Keep specifications in git alongside code
- **Incremental**: Each phase builds on previous work
- **Reusable**: Copy these files as templates for new projects

## Key Difference from Spec Kit

Spec Kit is a **full framework** with CLI tools and specialized agents. This mdflow pattern is a **lightweight alternative** that:
- Uses mdflow's `.md` agent files directly
- Relies on your AI assistant's capabilities
- Requires no additional tooling beyond mdflow
- Focuses on the spec-driven mindset over tooling

## Example Workflow

1. Start with `constitution.claude.md` to establish your team's values
2. Use `specify.claude.md` to clarify what you're building
3. Have Claude create a technical `plan.claude.md` 
4. Use `tasks.claude.md` to decompose the work
5. Execute `implement.claude.md` to guide implementation

Each file is standalone but references the previous phases, creating a coherent narrative of your feature development.
