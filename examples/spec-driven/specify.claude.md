---
model: opus
---

# Specification: What We're Building

Describe what you want to build, focusing on the **what** and **why**, not the technical details.

## Feature Name
[e.g., "Markdown Agent Executor"]

## User Stories

### As a developer, I want to...
Define clear user-focused outcomes that the feature should enable.

**Story 1: Create and run markdown-based agents**
- Define AI agents as simple markdown files
- Configure behavior with YAML frontmatter
- Execute agents from the command line
- Get results in print or interactive mode

**Story 2: Use template variables and imports**
- Reference dynamic values in markdown content
- Import external files or command outputs
- Use conditional logic in templates
- Access command-line arguments

**Story 3: Manage configuration globally**
- Set command defaults in `~/.mdflow/config.yaml`
- Override defaults per agent
- Store and recall variable history
- Track usage frequency

## Success Criteria
- [ ] Agents can be defined and executed via markdown files
- [ ] Template variables work correctly
- [ ] File imports and command outputs integrate seamlessly
- [ ] Configuration management works as expected
- [ ] All core CLI commands are functional

## Out of Scope
- GUI interface
- Complex build processes
- Non-markdown agent definitions
