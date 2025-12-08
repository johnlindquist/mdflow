import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { select, confirm } from "@inquirer/prompts";

const SHELL_SNIPPET = `
# markdown-agent: Treat .md files as executable agents
alias -s md='_handle_md'
_handle_md() {
  local file="$1"
  shift
  # Pass file and any remaining args (--model, --silent, etc.) to handler
  if command -v ma &>/dev/null; then
    ma "$file" "$@"
  else
    echo "markdown-agent not installed. Install with: bun add -g markdown-agent"
    echo "Attempting to install now..."
    if command -v bun &>/dev/null; then
      bun add -g markdown-agent && ma "$file" "$@"
    elif command -v npm &>/dev/null; then
      npm install -g markdown-agent && ma "$file" "$@"
    else
      echo "Neither bun nor npm found. Please install markdown-agent manually."
      return 1
    fi
  fi
}
`.trim();

const PATH_SNIPPET = `
# markdown-agent: Add agent directories to PATH
# User agents (~/.ma) - run agents by name from anywhere
export PATH="$HOME/.ma:$PATH"

# Project agents (.ma) - auto-add local .ma/ to PATH when entering directories
# This function runs on each directory change to update PATH dynamically
_ma_chpwd() {
  # Remove any previous .ma paths from PATH
  PATH=$(echo "$PATH" | tr ':' '\\n' | grep -v '/\\.ma$' | tr '\\n' ':' | sed 's/:$//')
  # Add current directory's .ma if it exists
  if [[ -d ".ma" ]]; then
    export PATH="$PWD/.ma:$PATH"
  fi
}

# Hook into directory change (zsh)
if [[ -n "$ZSH_VERSION" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _ma_chpwd
fi

# Hook into directory change (bash)
if [[ -n "$BASH_VERSION" ]]; then
  PROMPT_COMMAND="_ma_chpwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

# Run once on shell start
_ma_chpwd
`.trim();

type SetupFeature = "alias" | "path" | "both";

interface ShellConfig {
  name: string;
  path: string;
  exists: boolean;
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
    return content.includes("_ma_chpwd") || content.includes('$HOME/.ma:$PATH');
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
  console.log("\n📝 markdown-agent Shell Setup\n");

  const configs = findShellConfigs();
  const existingConfigs = configs.filter((c) => c.exists);

  if (existingConfigs.length === 0) {
    console.log("No shell config files found. Will create ~/.zshrc\n");
    existingConfigs.push({ name: ".zshrc", path: join(homedir(), ".zshrc"), exists: false });
  }

  // Check what's already installed
  const primaryConfig = existingConfigs[0];
  const aliasInstalled = await isAliasInstalled(primaryConfig.path);
  const pathInstalled = await isPathInstalled(primaryConfig.path);

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
      description: "Add ~/.ma and .ma/ to PATH - run agents by name",
    });
  }

  if (!aliasInstalled) {
    featureChoices.push({
      name: "Alias setup only",
      value: "alias",
      description: "Run ./file.md instead of ma file.md",
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
    console.log("  • Run agents from ~/.ma/ by name: my-agent.claude.md");
    console.log("  • Run project agents from .ma/: task.claude.md");
  }
  if (feature === "alias" || feature === "both") {
    console.log("\nTry: ./examples/auto-detect.md --dry-run");
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
