---
model: opus
---

# Task Breakdown: Actionable Implementation Steps

Convert the plan into specific, sequenced implementation tasks.

## Phase 1: Core Infrastructure
- [ ] **Task 1.1**: Set up project structure and build tooling
  - Create tsconfig.json
  - Set up Bun package.json with dependencies
  - Configure TypeScript paths

- [ ] **Task 1.2**: Implement type system and schemas
  - Define AgentFrontmatter interface
  - Create Zod validation schemas
  - Add type exports

- [ ] **Task 1.3**: Build frontmatter parser
  - Parse YAML from markdown frontmatter
  - Validate against schema
  - Handle parsing errors gracefully

## Phase 2: Configuration & Templating
- [ ] **Task 2.1**: Implement configuration system
  - Load global config from ~/.mdflow/config.yaml
  - Merge with frontmatter values
  - Implement defaults per command

- [ ] **Task 2.2**: Build template engine
  - Integrate LiquidJS
  - Support variable substitution {{ _varname }}
  - Handle filters and conditionals
  - Validate template syntax

- [ ] **Task 2.3**: Add environment loading
  - Load .env files
  - Parse _env frontmatter key
  - Apply to process.env

## Phase 3: Import System
- [ ] **Task 3.1**: Implement file imports
  - Support @./path.md syntax
  - Handle relative paths
  - Cache imported content

- [ ] **Task 3.2**: Add glob support
  - Support @./src/**/*.ts patterns
  - Respect .gitignore
  - Sort results consistently

- [ ] **Task 3.3**: Implement command execution
  - Support !`command` syntax
  - Capture stdout/stderr
  - Inject command output into templates

## Phase 4: Command Execution
- [ ] **Task 4.1**: Build command resolver
  - Parse command from filename
  - Support MA_COMMAND env override
  - Validate command availability

- [ ] **Task 4.2**: Implement argument builder
  - Convert frontmatter to CLI flags
  - Handle array values
  - Support positional mapping ($1, $2, etc.)

- [ ] **Task 4.3**: Create execution engine
  - Spawn child processes
  - Handle both print and interactive modes
  - Stream output appropriately

## Phase 5: History & State
- [ ] **Task 5.1**: Build history system
  - Calculate frecency scores
  - Track agent usage
  - Store variable history

- [ ] **Task 5.2**: Implement variable persistence
  - Save variable values to ~/.mdflow/variable-history.json
  - Load previous values for prompting
  - Support --_no-history flag

## Phase 6: CLI & Logging
- [ ] **Task 6.1**: Set up logging infrastructure
  - Configure Pino logger
  - Create ~/.mdflow/logs directory
  - Log per-agent activity

- [ ] **Task 6.2**: Build CLI interface
  - Implement `md <file.md>` command
  - Add `md create [name]` subcommand
  - Add `md setup`, `md logs`, `md help`
  - Parse CLI arguments properly

## Phase 7: Testing & Documentation
- [ ] **Task 7.1**: Write unit tests
  - Test parser functionality
  - Test template engine
  - Test command resolution
  - Test argument building

- [ ] **Task 7.2**: Create integration tests
  - End-to-end agent execution
  - Template variable flow
  - Import system behavior

- [ ] **Task 7.3**: Document API and usage
  - Write CLAUDE.md guide
  - Create example agents
  - Document frontmatter keys
