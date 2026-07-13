/**
 * Canonical global help body.
 *
 * Keep this module dependency-free: src/index.ts imports it before deciding
 * whether the full CLI runner is needed.
 */
export const GLOBAL_HELP_TEXT = `
Usage: md <file.md> [flags for the command]
       md                              # Open the Flow Workbench
       md <command> [options]
       md.COMMAND "prompt" [flags]      # Ad-hoc execution (no file needed)

Commands:
  md init [--guided] [-y]       Safely scaffold a starter flow roster
                                (--guided tailors it with an installed agent CLI)
  md create "<intent>"          Create a project flow (--global works from any directory)
  md explain <agent.md>         Show resolved config without executing
  md render <flow.md>           Render prompt + full config as a shareable HTML page (free)
  md hooks add|list|remove <flow.md> [event…]  Manage the flow's lifecycle hooks file
  md eval <flow.md> [--plan]    Run or cost-preview the executable eval suite
  md eval add|list|remove|coverage  Scaffold suites, show fail-closed verdicts,
                                and run the free coverage ratchet
  md feedback <flow.md> "msg"   Record feedback with a durable ID (free)
  md complain <flow.md> "msg"   Alias for md feedback
  md evolve plan <flow.md>      Show evidence, verification, cost, and writes (free)
  md evolve propose <flow.md>   Create + verify an off-path proposal; source unchanged
  md evolve show <run-id>       Inspect a proposal and verification receipt
  md evolve apply <run-id>      Atomically apply a reviewed proposal
  md evolve rollback <run-id>   Restore the proposal's captured current flow
  md evolve history [flow.md]   List proposal history (use evolve --help for more)
  md install <url|gh:...@ref>   Install a flow into the registry (--global for user scope)
  md remove <name>              Remove an installed registry flow
  md list                       List installed registry flows
  md roster --json              Machine-readable roster of project/global/registry flows
  md setup                      Configure shell (PATH, aliases)
  md logs                       Show agent log directory
  md help                       Show this help

Ad-hoc execution (one-shot mode):
  md.claude "What is 2+2?"                    # Quick prompt to Claude
  md.gemini "Explain quantum computing"       # Quick prompt to Gemini
  md.codex "Write a function"                 # Quick prompt to Codex
  md.copilot "Help me debug"                  # Quick prompt to Copilot
  md.droid "Build an app"                     # Quick prompt to Droid
  md.opencode "Refactor this"                 # Quick prompt to OpenCode
  md.i.claude "Start a chat"                  # Interactive mode
  md.claude "Explain: @error.log" --model opus  # With @imports and flags

Create flows:
  md create "Review staged changes for correctness"        # project: ./flows/
  md create "Turn notes into an action plan" --global       # global: ~/.mdflow/, run anywhere
  md                              Then browse, run, edit, or improve them

Engine resolution (most explicit wins):
  1. --engine flag (deprecated aliases: --_command/-_c, --tool)
  2. MDFLOW_ENGINE environment variable
  3. Filename pattern (e.g., task.claude.md → claude; must name a real engine)
  4. Frontmatter key (engine: claude; deprecated: tool:/_tool:)
  5. Config engine: (project .mdflow.yaml beats ~/.mdflow/config.yaml)
  6. Built-in default: pi
  A file with no frontmatter and no explicit engine is printed as a document.

Agent file discovery (in priority order):
  1. Explicit path:      md ./path/to/agent.md
  2. Project flows:      ./flows/
  3. Legacy project:     ./.mdflow/
  4. Personal flows:     ~/.mdflow/
  5. $PATH directories
  6. Current directory:  ./

All non-system frontmatter keys are passed as CLI flags to the command.
Global defaults can be set in ~/.mdflow/config.yaml

Remote execution:
  md supports running agents from URLs (npx-style).
  On first use, you'll be prompted to trust the domain.
  Trusted domains are stored in ~/.mdflow/known_hosts

Examples:
  md task.claude.md -p "print mode"
  md task.claude.md --model opus --verbose
  md commit.agy.md
  md task.md                      # engine via the ladder (default: pi)
  md task.md --engine claude
  md eval task.md                 # run the flow's eval suite
  md task.claude.md --_dry-run    # Preview without executing
  md https://example.com/agent.claude.md            # Remote execution
  md https://example.com/agent.claude.md --_trust   # Skip trust prompt

Config file example (~/.mdflow/config.yaml):
  commands:
    copilot:
      $1: prompt    # Map body to --prompt flag

md-specific flags (consumed, not passed to command):
  --engine          Specify the engine to run (deprecated aliases: --_command/-_c, --tool)
  --_dry-run        Show command/prompt plan; skip engine and inline commands
                    (--dry-run is an alias — md consumes it, engines never see it)
  --_hooks          Override the flow's hooks file (--_hooks false disables)
  --_edit           Open resolved prompt in $EDITOR before execution
  --_trust          Skip trust prompt for remote URLs (TOFU bypass)
  --_no-cache       Force fresh fetch for remote URLs (bypass cache)
  --raw             Output raw markdown without rendering (for piping)
  --_context        Show context tree and exit (no execution)
  --_quiet          Skip context dashboard display before execution
  --_no-menu        Disable post-run action menu (for scripting/piping)
  --json            Emit a single JSON result object and disable interactive UI
  --events          Stream NDJSON run events on stdout (machine-facing, non-interactive)
  --no-evolve       Disable post-run evolution handling for this run

Without arguments:
  md              Open the Flow Workbench: browse, create, run, and improve flows
`;
