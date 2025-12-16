---
model: opus
---

# Implementation Plan: Technical Approach

Describe your chosen technology stack and architecture for solving the specification.

## Technology Stack
- **Runtime**: Bun (fast JavaScript/TypeScript runtime)
- **Language**: TypeScript (type safety)
- **Template Engine**: LiquidJS (flexible templating)
- **Validation**: Zod (schema validation)
- **Logging**: Pino (structured logging)
- **CLI**: Commander.js (command framework)

## Architecture Overview

### Core Components
1. **Frontmatter Parser**: Parse YAML from markdown files
2. **Template Engine**: Process LiquidJS templates with variable substitution
3. **Import System**: Handle file imports, globs, and command execution
4. **Command Resolver**: Determine which CLI tool to invoke
5. **Execution Engine**: Execute commands with proper argument passing

### Data Flow
```
.md file 
  → Parse frontmatter (YAML)
  → Load global config
  → Apply defaults
  → Expand imports (@./file.md, !`cmd`)
  → Substitute templates ({{ _varname }})
  → Build CLI args
  → Execute command
```

## Module Structure
```
src/
├── index.ts           # CLI entry point
├── command.ts         # Command resolution and execution
├── config.ts          # Configuration management
├── template.ts        # Template variable substitution
├── imports.ts         # File/glob/command imports
├── env.ts             # Environment loading
├── types.ts           # Type definitions
├── schema.ts          # Validation schemas
├── logger.ts          # Logging setup
└── history.ts         # Frecency and variable history
```

## Key Design Decisions
1. **Markdown + YAML**: Simple, readable, version-controllable
2. **Passthrough architecture**: Only consume system keys, pass rest to CLI tool
3. **Template-first**: Variables are processed before command execution
4. **Modular imports**: Compose agents from multiple files
5. **History-aware**: Learn from previous variable inputs
