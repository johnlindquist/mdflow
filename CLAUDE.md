# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**markdown-agent** (`ma`) is a CLI tool that executes AI agents defined as markdown files. It parses YAML frontmatter for configuration and passes keys directly as CLI flags to the specified command (claude, codex, gemini, copilot, or any other CLI tool).

## Commands

```bash
# Run tests (bail on first failure)
bun test --bail=1

# Run single test file
bun test src/cli.test.ts

# Run a specific test by name
bun test --test-name-pattern "parses command"

# Execute the CLI directly
bun run src/index.ts task.claude.md

# Or using the alias
bun run ma task.claude.md
```

## Architecture

### Core Flow (`src/index.ts`)
```
.md file → parseFrontmatter() → mergeFrontmatter(cli overrides)
        → expandImports() → substituteTemplateVars()
        → resolveCommand() → buildArgs() → runCommand()
```

### Key Modules

- **`command.ts`** - Command resolution and execution
  - `parseCommandFromFilename()`: Infers command from `task.claude.md` → `claude`
  - `resolveCommand()`: Priority: CLI > frontmatter > filename
  - `buildArgs()`: Converts frontmatter to CLI flags
  - `runCommand()`: Spawns the command with prompt as argument

- **`types.ts`** - Core TypeScript interfaces
  - `AgentFrontmatter`: Simple interface with system keys + passthrough
  - System keys: `command`, `inputs`, `context`, `cache`, `requires`

- **`schema.ts`** - Minimal Zod validation (system keys only, rest passthrough)

- **`imports.ts`** - File imports (`@./path.md`) and command inlines (`` !`cmd` ``)

- **`template.ts`** - LiquidJS-powered template engine for variable substitution

### Command Resolution

Commands are resolved in priority order:
1. CLI flag: `--command claude` or `-c claude`
2. Frontmatter: `command: claude`
3. Filename: `task.claude.md` → `claude`

### Frontmatter → CLI Flags

All non-system frontmatter keys are passed directly to the command:

```yaml
---
command: claude
model: opus                  # → --model opus
dangerously-skip-permissions: true  # → --dangerously-skip-permissions
add-dir:                     # → --add-dir ./src --add-dir ./tests
  - ./src
  - ./tests
---
```

### Template System (LiquidJS)

Uses [LiquidJS](https://liquidjs.com/) for full template support:

- Variables: `{{ variable }}`
- Conditionals: `{% if force %}--force{% endif %}`
- Filters: `{{ name | upcase }}`, `{{ value | default: "fallback" }}`
- CLI args: `--varname value` (unknown flags become template vars)
- `inputs:` frontmatter for wizard mode (interactive prompts)

## Testing Patterns

Tests use Bun's test runner with `describe`/`it` blocks:

```typescript
import { describe, it, expect } from "bun:test";

describe("parseCliArgs", () => {
  it("parses command flag", () => {
    const result = parseCliArgs(["node", "script", "file.md", "--command", "claude"]);
    expect(result.command).toBe("claude");
  });
});
```
