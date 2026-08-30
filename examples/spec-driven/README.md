# Spec-Driven Development with mdflow

A lightweight, spec-driven development workflow using markdown agents. Inspired by GitHub's Spec Kit, optimized for mdflow.

## The Pattern

Five interconnected markdown agents that guide you from vision to implementation:

```
constitution.claude.md
        ↓
    specify.claude.md
        ↓
      plan.claude.md
        ↓
      tasks.claude.md
        ↓
   implement.claude.md
```

## Quick Start

### 1. Establish Principles
```bash
md constitution.claude.md --_project "MyFeature" --_team "TeamName"
```
Defines project values, engineering standards, and team agreements.

### 2. Define Requirements
```bash
md specify.claude.md --_project "MyFeature"
```
Interactive session to clarify what you're building (what & why).

### 3. Plan Architecture
```bash
md plan.claude.md --_project "MyFeature" --_tech_stack "Node.js + React"
```
Creates technical approach with design decisions and risk assessment.

### 4. Break Into Tasks
```bash
md tasks.claude.md --_project "MyFeature"
```
Converts plan into sequenced, actionable tasks with owners and estimates.

### 5. Execute Work
```bash
md implement.claude.md --_project "MyFeature" --_task "1.1"
```
Interactive guidance for implementing individual tasks with validation.

## mdflow Features Used

Each agent demonstrates mdflow capabilities:

### Variables (`--_varname`)
```yaml
_project: "{{ _project | default: 'MyProject' }}"
_team: "{{ _team | default: 'Engineering Team' }}"
```
Pass dynamic values: `md constitution.claude.md --_project "Auth Feature"`

### File Imports (`@./path`)
```markdown
@./package.json
@./src/**/*.ts
@./tsconfig.json:1-20
```
Reference actual project files directly in the agent.

### Inline Commands (`` !`cmd` ``)
```markdown
!git status
!npm test
!npm list --depth=0
```
Execute commands and inject output into the agent prompt.

### File References
```markdown
**Reference**: @./specify.claude.md
**Plan**: @./plan.claude.md
```
Cross-reference other phase documents.

### Interactive Mode (`_interactive: true`)
```yaml
_interactive: true
```
Agents use `.i.` variant (or frontmatter flag) for live conversation.

## Agent Composition

Agents can pipe together for analysis:

```bash
# Security analysis flows into planning
md security-scan.claude.md | md plan.claude.md
```

## Real-World Example

For an authentication feature:

```bash
# 1. What's our principle on auth security?
md constitution.claude.md --_project "Auth" --_team "Security"

# 2. What do we need to build?
md specify.claude.md --_project "Auth"

# 3. What's our tech approach?
md plan.claude.md --_project "Auth" --_tech_stack "OAuth2 + JWT"

# 4. What are the concrete tasks?
md tasks.claude.md --_project "Auth"

# 5. Help me implement task 1.1
md implement.claude.md --_project "Auth" --_task "1.1"
```

## Why mdflow + Spec-Driven?

### Lightweight
- No extra frameworks or CLI tools
- Just markdown files + mdflow
- Works with any AI assistant (claude, gemini, codex, etc.)

### Composable
- Agents reference each other via `@./` imports
- Share data through stdout/stdin piping
- Build workflows from simple, focused agents

### Version-controllable
- Keep specs in git alongside code
- Review changes like code
- Track evolution of requirements

### AI-native
- YAML frontmatter configures agent behavior
- Markdown is easy to parse and modify
- Template variables parameterize reuse

## Customization

Copy these files as templates for your project. Customize:

1. **Add project-specific variables**:
   ```yaml
   _database: "{{ _database | default: 'PostgreSQL' }}"
   _framework: "{{ _framework | default: 'Express' }}"
   ```

2. **Import your conventions**:
   ```markdown
   @./ENGINEERING_STANDARDS.md
   @./ARCHITECTURE.md
   @./TESTING_GUIDELINES.md
   ```

3. **Run project checks**:
   ```markdown
   !./scripts/validate-env.sh
   !npm run lint
   !npm audit
   ```

## Key Differences from Spec Kit

| Aspect | Spec Kit | mdflow Pattern |
|--------|----------|----------------|
| Framework | Full CLI framework | Simple markdown files |
| Dependencies | Python + Specify CLI | mdflow only |
| Agent selection | Slash commands | Filename inference |
| File imports | Limited | Full glob + symbol extraction |
| Piping | Not primary | Built-in (stdout/stdin) |
| Execution | Specialized workflows | Open-ended, composable |

## Tips

- **Start simple**: Use templates as-is, customize gradually
- **Keep specs updated**: Treat them as living documents
- **Reference actual code**: Use imports to ground specs in reality
- **Iterate visually**: Use `.i.` variants for interactive refinement
- **Compose agents**: Chain multiple agents for complex workflows
- **Reuse templates**: Save project-specific versions to `~/.mdflow/`

## Examples

See `/examples/spec-driven/` for complete template files with all mdflow features demonstrated.
