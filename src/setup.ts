import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { select, confirm } from "@inquirer/prompts";

const SHELL_SNIPPET = `
# mdflow: Treat .md files as executable agents
alias -s md='_handle_md'
_handle_md() {
  local input="$1"
  shift

  # Resolve input: URLs pass through, files check multiple locations
  # Priority: 1) as-is, 2) ./.mdflow/, 3) ~/.mdflow/, 4) PATH
  local resolved=""
  if [[ "$input" =~ ^https?:// ]]; then
    # URL - pass through as-is
    resolved="$input"
  elif [[ -f "$input" ]]; then
    # Found as-is (absolute or relative path)
    resolved="$input"
  elif [[ -f ".mdflow/$input" ]]; then
    # Found in project .mdflow/ directory
    resolved=".mdflow/$input"
  elif [[ -f "$HOME/.mdflow/$input" ]]; then
    # Found in user ~/.mdflow/ directory
    resolved="$HOME/.mdflow/$input"
  else
    # Search PATH for the .md file
    local dir
    for dir in \${(s/:/)PATH}; do
      if [[ -f "$dir/$input" ]]; then
        resolved="$dir/$input"
        break
      fi
    done
  fi

  if [[ -z "$resolved" ]]; then
    echo "File not found: $input (checked cwd, .mdflow/, ~/.mdflow/, and PATH)"
    return 1
  fi

  # Pass resolved file/URL and any remaining args to handler
  if command -v mdflow &>/dev/null; then
    mdflow "$resolved" "$@"
  else
    echo "mdflow not installed."
    read -q "REPLY?Would you like to run \\\`bun add -g mdflow\\\` now? [y/N] "
    echo
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      bun add -g mdflow
      echo
      read -q "REPLY?Would you like to attempt to run this again? [y/N] "
      echo
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        mdflow "$resolved" "$@"
      fi
    else
      return 1
    fi
  fi
}
`.trim();

const MD_ALIAS_SNIPPET = `
# mdflow: Short alias for mdflow command
alias md='mdflow'
`.trim();

const PATH_SNIPPET = `
# mdflow: Add agent directories to PATH
# User agents (~/.mdflow) - run agents by name from anywhere
export PATH="$HOME/.mdflow:$PATH"

# Project agents (.mdflow) - auto-add local .mdflow/ to PATH when entering directories
# This function runs on each directory change to update PATH dynamically
_mdflow_chpwd() {
  # Remove project .mdflow paths from PATH, but keep ~/.mdflow (user agents)
  # Project paths: /path/to/project/.mdflow (4+ segments)
  # User path: /Users/name/.mdflow (3 segments) - keep this one
  PATH=$(echo "$PATH" | tr ':' '\\n' | grep -vE '^(/[^/]+){4,}/\\.mdflow$' | tr '\\n' ':' | sed 's/:$//')
  # Add current directory's .mdflow if it exists
  if [[ -d ".mdflow" ]]; then
    export PATH="$PWD/.mdflow:$PATH"
  fi
}

# Hook into directory change (zsh)
if [[ -n "$ZSH_VERSION" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _mdflow_chpwd
fi

# Hook into directory change (bash)
if [[ -n "$BASH_VERSION" ]]; then
  PROMPT_COMMAND="_mdflow_chpwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

# Run once on shell start
_mdflow_chpwd
`.trim();

type SetupFeature = "alias" | "path" | "both";

interface ShellConfig {
  name: string;
  path: string;
  exists: boolean;
}

interface MdCommandInfo {
  exists: boolean;
  type: "binary" | "alias" | "function" | "builtin" | "unknown";
  location?: string;
}

/**
 * Check if 'md' command is already bound to something else
 */
async function checkMdCommand(): Promise<MdCommandInfo> {
  try {
    // Use interactive shell (-i) to detect aliases from .zshrc/oh-my-zsh
    // The command checks type and also gets alias definition if it's an alias
    const proc = Bun.spawn(["zsh", "-ic", "type -a md 2>/dev/null; echo '---ALIAS---'; alias md 2>/dev/null"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Split output into type info and alias definition
    const [typeOutput, aliasOutput] = output.split("---ALIAS---").map(s => s?.trim() ?? "");

    if (!typeOutput) {
      return { exists: false, type: "unknown" };
    }

    const lines = typeOutput.split("\n").filter(l => !l.includes("can't change option"));
    const firstLine = (lines[0] ?? "").toLowerCase();

    // Check if it's our mdflow alias
    if (firstLine.includes("mdflow") || (firstLine.includes("alias") && typeOutput.includes("mdflow"))) {
      return { exists: false, type: "alias" }; // It's ours, treat as not conflicting
    }

    // Determine the type - check for alias first (aliases take precedence)
    if (firstLine.includes("is an alias") || firstLine.includes("is aliased to")) {
      // Extract alias definition for better display
      // Format: "md is an alias for mkdir -p" or from alias cmd: "md='mkdir -p'"
      let aliasValue = "";
      const aliasMatch = firstLine.match(/is (?:an alias for|aliased to) (.+)/);
      if (aliasMatch) {
        aliasValue = aliasMatch[1];
      } else if (aliasOutput) {
        // Parse alias output like "md='mkdir -p'" or "md=mkdir -p"
        const aliasDefMatch = aliasOutput.match(/md=["']?(.+?)["']?$/);
        if (aliasDefMatch) {
          aliasValue = aliasDefMatch[1];
        }
      }
      return {
        exists: true,
        type: "alias",
        location: aliasValue ? `alias md='${aliasValue}'` : firstLine
      };
    }
    if (firstLine.includes("is a shell function") || firstLine.includes("is a function")) {
      return { exists: true, type: "function", location: "shell function" };
    }
    if (firstLine.includes("is a shell builtin")) {
      return { exists: true, type: "builtin", location: "shell builtin" };
    }
    if (firstLine.includes("is /") || firstLine.includes("is a")) {
      // Extract the path
      const match = firstLine.match(/is\s+(\S+)/);
      return { exists: true, type: "binary", location: match?.[1] || typeOutput };
    }

    return { exists: true, type: "unknown", location: typeOutput };
  } catch {
    return { exists: false, type: "unknown" };
  }
}

/**
 * Check if md alias is already installed in a config file (pointing to mdflow)
 */
async function isMdAliasInstalled(configPath: string): Promise<boolean> {
  try {
    const content = await Bun.file(configPath).text();
    return content.includes("alias md='mdflow'") || content.includes('alias md="mdflow"');
  } catch {
    return false;
  }
}

/**
 * Find potential shell config files
 */
function findShellConfigs(): ShellConfig[] {
  const home = homedir();
  const candidates = [
    { name: ".zshrc", path: join(home, ".zshrc") },
    { name: ".config/zsh/.zshrc", path: join(home, ".config", "zsh", ".zshrc") },
    { name: ".zprofile", path: join(home, ".zprofile") },
    { name: ".bashrc", path: join(home, ".bashrc") },
    { name: ".bash_profile", path: join(home, ".bash_profile") },
    { name: ".config/fish/config.fish", path: join(home, ".config", "fish", "config.fish") },
  ];

  return candidates.map((c) => ({
    ...c,
    exists: existsSync(c.path),
  }));
}

/**
 * Check if alias snippet is already installed in a config file
 */
async function isAliasInstalled(configPath: string): Promise<boolean> {
  try {
    const content = await Bun.file(configPath).text();
    return content.includes("alias -s md=") || content.includes("_handle_md");
  } catch {
    return false;
  }
}

/**
 * Check if PATH snippet is already installed in a config file
 */
async function isPathInstalled(configPath: string): Promise<boolean> {
  try {
    const content = await Bun.file(configPath).text();
    return content.includes("_mdflow_chpwd") || content.includes('$HOME/.mdflow:$PATH');
  } catch {
    return false;
  }
}

/**
 * Append snippet to config file
 */
async function appendToConfig(configPath: string, snippet: string): Promise<void> {
  const file = Bun.file(configPath);
  const existing = (await file.exists()) ? await file.text() : "";
  const newContent = existing.endsWith("\n")
    ? `${existing}\n${snippet}\n`
    : `${existing}\n\n${snippet}\n`;
  await Bun.write(configPath, newContent);
}

/**
 * Interactive setup wizard
 */
export async function runSetup(): Promise<void> {
  console.log("\n📝 mdflow Shell Setup\n");

  const configs = findShellConfigs();
  const existingConfigs = configs.filter((c) => c.exists);

  if (existingConfigs.length === 0) {
    console.log("No shell config files found. Will create ~/.zshrc\n");
    existingConfigs.push({ name: ".zshrc", path: join(homedir(), ".zshrc"), exists: false });
  }

  // Check what's already installed
  const primaryConfig = existingConfigs[0]!;
  const aliasInstalled = await isAliasInstalled(primaryConfig.path);
  const pathInstalled = await isPathInstalled(primaryConfig.path);
  const mdAliasInstalled = await isMdAliasInstalled(primaryConfig.path);

  // Build feature choices based on what's not installed
  type FeatureChoice = { name: string; value: SetupFeature; description: string };
  const featureChoices: FeatureChoice[] = [];

  if (!aliasInstalled && !pathInstalled) {
    featureChoices.push({
      name: "Both (recommended)",
      value: "both",
      description: "Run ./file.md directly + run agents by name",
    });
  }

  if (!pathInstalled) {
    featureChoices.push({
      name: "PATH setup only",
      value: "path",
      description: "Add ~/.mdflow and .mdflow/ to PATH - run agents by name",
    });
  }

  if (!aliasInstalled) {
    featureChoices.push({
      name: "Alias setup only",
      value: "alias",
      description: "Run ./file.md instead of mdflow file.md",
    });
  }

  if (featureChoices.length === 0) {
    console.log("✅ Both features are already installed in " + primaryConfig.name);
    console.log("\nTo apply changes, run: source ~/" + primaryConfig.name);
    return;
  }

  // Let user choose what to install
  const feature = await select<SetupFeature>({
    message: "What would you like to set up?",
    choices: featureChoices,
  });

  // Build the snippet based on selection
  let snippet = "";
  if (feature === "alias" || feature === "both") {
    snippet += SHELL_SNIPPET;
  }
  if (feature === "path" || feature === "both") {
    if (snippet) snippet += "\n\n";
    snippet += PATH_SNIPPET;
  }

  // Check if md command is already bound and offer to create alias
  let addMdAlias = false;
  if (!mdAliasInstalled) {
    const mdCommand = await checkMdCommand();

    if (mdCommand.exists) {
      console.log(`\n⚠️  The 'md' command is already in use:`);
      console.log(`   ${mdCommand.location || `(${mdCommand.type})`}`);

      if (mdCommand.type === "alias") {
        console.log(`\n   This alias is commonly set by oh-my-zsh (common-aliases plugin).`);
        console.log(`   Adding 'alias md=mdflow' will override it.\n`);
      } else if (mdCommand.type === "binary") {
        console.log(`\n   This binary may be from a previous mdflow install or another tool.`);
        console.log(`   Adding an alias will take precedence over the binary.\n`);
      } else {
        console.log(`\n   You can still use 'mdflow' directly, or override with an alias.\n`);
      }

      addMdAlias = await confirm({
        message: "Would you like to add 'alias md=mdflow' to override it?",
        default: false,
      });
    } else {
      // md is not bound, offer to add the alias
      addMdAlias = await confirm({
        message: "Would you like to add 'md' as a short alias for 'mdflow'?",
        default: true,
      });
    }

    if (addMdAlias) {
      snippet += "\n\n" + MD_ALIAS_SNIPPET;
    }
  }

  // Show what will be added
  console.log("\nThe following will be added to your shell config:\n");
  console.log("─".repeat(60));
  console.log(snippet);
  console.log("─".repeat(60));
  console.log();

  // Let user choose config file
  const configChoices = [
    ...existingConfigs.map((c) => ({
      name: c.name + (c.exists ? "" : " (will create)"),
      value: c.path,
    })),
    { name: "Copy to clipboard (manual install)", value: "clipboard" },
  ];

  const selectedPath = await select({
    message: "Where should we add this?",
    choices: configChoices,
  });

  if (selectedPath === "clipboard") {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    proc.stdin.write(snippet);
    proc.stdin.end();
    await proc.exited;
    console.log("\n✅ Copied to clipboard!");
    console.log("Paste into your shell config file and run: source ~/.zshrc");
    return;
  }

  // Confirm before writing
  const proceed = await confirm({
    message: `Add to ${selectedPath}?`,
    default: true,
  });

  if (!proceed) {
    console.log("Setup cancelled.");
    return;
  }

  // Append to selected config
  await appendToConfig(selectedPath, snippet);
  const configName = existingConfigs.find((c) => c.path === selectedPath)?.name || selectedPath;
  console.log(`\n✅ Added to ${configName}`);
  console.log(`\nTo apply changes now, run:\n  source ${selectedPath}`);

  if (feature === "path" || feature === "both") {
    console.log("\nNow you can:");
    console.log("  • Run agents from ~/.mdflow/ by name: my-agent.claude.md");
    console.log("  • Run project agents from .mdflow/: task.claude.md");
  }
  if (feature === "alias" || feature === "both") {
    console.log("\nTry: ./examples/auto-detect.md --_dry-run");
  }
  if (addMdAlias) {
    console.log("\n💡 You can now use 'md' as a shorthand for 'mdflow'");
  }
}

/**
 * Get the alias shell snippet for display or manual copy
 */
export function getShellSnippet(): string {
  return SHELL_SNIPPET;
}

/**
 * Get the PATH shell snippet for display or manual copy
 */
export function getPathSnippet(): string {
  return PATH_SNIPPET;
}

/**
 * Get the md alias snippet for display or manual copy
 */
export function getMdAliasSnippet(): string {
  return MD_ALIAS_SNIPPET;
}
