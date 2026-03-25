/**
 * Global and project-level configuration for mdflow
 * Loads defaults from ~/.mdflow/config.yaml
 * Cascades with project configs: global → git root → CWD (later overrides earlier)
 *
 * This module uses pure functions without module-level state.
 * Configuration is explicitly passed through the call chain via RunContext.
 *
 * ============================================================================
 * CONFIGURATION PRECEDENCE (later entries override earlier ones)
 * ============================================================================
 *
 * 1. Built-in defaults
 *    - Hardcoded defaults from tool adapters (e.g., claude defaults to --print)
 *    - Defined in src/adapters/*.ts via getDefaults()
 *
 * 2. Global config (~/.mdflow/config.yaml)
 *    - User-wide defaults for all projects
 *    - Sets default flags per command
 *
 * 3. Project config (git root or CWD)
 *    - mdflow.config.yaml, .mdflow.yaml, or .mdflow.json
 *    - Git root config loads first, then CWD config overrides
 *
 * 4. Agent frontmatter
 *    - YAML block at the top of the .md file
 *    - Specific to this agent
 *
 * 5. CLI flags (passthrough args)
 *    - Flags passed after the agent file: `md task.md --model opus`
 *    - Highest precedence for explicit flags
 *
 * 6. Interactive prompts (template vars)
 *    - When a template variable ({{ _name }}) is missing and stdin is TTY
 *    - User is prompted for the value at runtime
 *
 * Example precedence resolution:
 *   Built-in: { print: true }
 *   + Global config: { model: "sonnet" }
 *   + Project config: { model: "opus" }
 *   + Frontmatter: { verbose: true }
 *   + CLI: --model haiku
 *   = Final: { print: true, model: "haiku", verbose: true }
 *
 * ============================================================================
 */

import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { existsSync, statSync } from "fs";
import yaml from "js-yaml";
import type { AgentFrontmatter, GlobalConfig, CommandDefaults, RunContext } from "./types";
import { getAdapter, buildBuiltinDefaults } from "./adapters";
import { safeParseConfig } from "./schema";

// Re-export types for convenience
export type { GlobalConfig, CommandDefaults } from "./types";

const CONFIG_DIR = join(homedir(), ".mdflow");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

/** Project config file names (checked in order) */
const PROJECT_CONFIG_NAMES = ["mdflow.config.yaml", ".mdflow.yaml", ".mdflow.json"];

/**
 * Built-in defaults (used when no config file exists)
 * All tools default to PRINT mode (non-interactive)
 *
 * Generated dynamically from registered tool adapters
 */
export const BUILTIN_DEFAULTS: GlobalConfig = {
  commands: buildBuiltinDefaults(),
};

/**
 * Apply _interactive mode transformations to frontmatter
 * Converts print defaults to interactive mode per command
 *
 * Uses the tool adapter registry to delegate tool-specific transformations.
 *
 * @param frontmatter - The frontmatter after defaults are applied
 * @param command - The resolved command name
 * @param interactiveFromFilename - Whether .i. was detected in filename
 * @returns Transformed frontmatter for interactive mode
 */
export function applyInteractiveMode(
  frontmatter: AgentFrontmatter,
  command: string,
  interactiveFromExternal: boolean = false
): AgentFrontmatter {
  // Check if _interactive or _i is enabled
  // Can be: true, empty string (YAML key with no value), null (YAML key with explicit null), or external trigger
  // NOTE: We check key existence separately because ?? treats null as "nullish" and skips to next value
  const hasInteractiveKey = "_interactive" in frontmatter;
  const hasIKey = "_i" in frontmatter;
  const interactiveValue = hasInteractiveKey ? frontmatter._interactive : frontmatter._i;
  const interactiveMode = interactiveFromExternal ||
    interactiveValue === true ||
    interactiveValue === "" ||
    (hasInteractiveKey && interactiveValue === null) ||
    (hasIKey && interactiveValue === null) ||
    (interactiveValue !== undefined && interactiveValue !== false);

  if (!interactiveMode) {
    return frontmatter;
  }

  // Remove _interactive and _i from output (they're meta-keys, not CLI flags)
  const result = { ...frontmatter };
  delete result._interactive;
  delete result._i;

  // Delegate to the appropriate tool adapter for tool-specific transformations
  const adapter = getAdapter(command);
  return adapter.applyInteractiveMode(result);
}

// NOTE: Module-level caching has been removed to enable parallel testing.
// Use loadGlobalConfig(), loadProjectConfig(), and loadFullConfig() which
// are now pure functions that return fresh config instances each call.
// For performance-sensitive code paths, cache the result in a RunContext.

/**
 * Find the git root directory starting from a given path
 * Walks up the directory tree looking for .git
 * @returns The git root path, or null if not in a git repo
 */
export function findGitRoot(startPath: string): string | null {
  let current = resolve(startPath);
  let previous = "";

  // Walk up until we hit the filesystem root (when dirname returns the same path)
  while (current !== previous) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      // Check if .git is a directory (normal repo) or file (worktree)
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory() || stat.isFile()) {
          return current;
        }
      } catch {
        // Continue searching if stat fails
      }
    }
    previous = current;
    current = dirname(current);
  }

  return null;
}

/**
 * Find project config file in a directory
 * Checks for mdflow.config.yaml, .mdflow.yaml, .mdflow.json
 * @returns The config file path if found, null otherwise
 */
function findProjectConfigFile(dir: string): string | null {
  for (const name of PROJECT_CONFIG_NAMES) {
    const configPath = join(dir, name);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

/**
 * Load and validate config from a file (yaml or json)
 * Validates against the globalConfigSchema to ensure type safety
 *
 * @param filePath - Path to the config file
 * @param throwOnInvalid - If true, throws on validation errors; if false, logs warning and returns null
 * @returns Validated config or null if file doesn't exist or is invalid
 */
async function loadConfigFile(filePath: string, throwOnInvalid: boolean = false): Promise<GlobalConfig | null> {
  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) {
      return null;
    }
    const content = await file.text();

    let parsed: unknown;
    if (filePath.endsWith(".json")) {
      parsed = JSON.parse(content);
    } else {
      parsed = yaml.load(content);
    }

    // Validate with Zod schema
    const validation = safeParseConfig(parsed);
    if (!validation.success) {
      const errorMsg = `Invalid config file ${filePath}:\n  ${validation.errors?.join("\n  ")}`;
      if (throwOnInvalid) {
        throw new Error(errorMsg);
      }
      console.warn(`Warning: ${errorMsg}`);
      return null;
    }

    return validation.data as GlobalConfig;
  } catch (err) {
    if (throwOnInvalid) throw err;
    // Log parse errors instead of failing silently
    console.warn(`Warning: Failed to parse config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Load project-level config with cascade: git root → CWD
 * Returns merged config from both locations (CWD takes priority)
 *
 * This is a pure function - no caching. For performance-sensitive code,
 * store the result in RunContext.config.
 */
export async function loadProjectConfig(cwd: string): Promise<GlobalConfig> {
  const resolvedCwd = resolve(cwd);
  let projectConfig: GlobalConfig = {};

  // 1. Load from git root (if different from CWD)
  const gitRoot = findGitRoot(resolvedCwd);
  if (gitRoot && gitRoot !== resolvedCwd) {
    const gitRootConfigFile = findProjectConfigFile(gitRoot);
    if (gitRootConfigFile) {
      const gitRootConfig = await loadConfigFile(gitRootConfigFile);
      if (gitRootConfig) {
        projectConfig = gitRootConfig;
      }
    }
  }

  // 2. Load from CWD (overrides git root)
  const cwdConfigFile = findProjectConfigFile(resolvedCwd);
  if (cwdConfigFile) {
    const cwdConfig = await loadConfigFile(cwdConfigFile);
    if (cwdConfig) {
      projectConfig = mergeConfigs(projectConfig, cwdConfig);
    }
  }

  return projectConfig;
}

/**
 * Load global config from ~/.mdflow/config.yaml
 * Falls back to built-in defaults if file doesn't exist
 *
 * This is a pure function - no caching. For performance-sensitive code,
 * store the result in RunContext.config.
 *
 * Always returns a fresh copy to ensure isolation between callers.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      const content = await file.text();
      const parsed = yaml.load(content) as GlobalConfig;
      // Merge with built-in defaults (user config takes priority)
      return mergeConfigs(BUILTIN_DEFAULTS, parsed);
    }
  } catch (err) {
    // Log error and fall back to built-in defaults
    console.warn(`Warning: Failed to load global config ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Return a deep clone to ensure callers get an independent copy
  return mergeConfigs(BUILTIN_DEFAULTS, {});
}

/**
 * Load fully merged config: built-in defaults → global → git root → CWD
 * This is the main entry point for loading config with project-level overrides
 */
export async function loadFullConfig(cwd: string = process.cwd()): Promise<GlobalConfig> {
  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(cwd);

  // Merge: global → project (project takes priority)
  return mergeConfigs(globalConfig, projectConfig);
}

/**
 * Deep clone a GlobalConfig object
 * This ensures modifications to the returned config don't affect the source.
 */
function deepCloneConfig(config: GlobalConfig): GlobalConfig {
  const result: GlobalConfig = {};

  if (config.commands) {
    result.commands = {};
    for (const [cmd, defaults] of Object.entries(config.commands)) {
      result.commands[cmd] = { ...defaults };
    }
  }

  return result;
}

/**
 * Deep merge two configs (second takes priority)
 * Returns a new object - does not modify either input.
 *
 * Per-command merging delegates to concatFrontmatter, so the same
 * right-biased merge operation is used at every level of the
 * precedence chain.
 */
export function mergeConfigs(base: GlobalConfig, override: GlobalConfig): GlobalConfig {
  // Start with a deep clone of base
  const result = deepCloneConfig(base);

  if (override.commands) {
    result.commands = result.commands ? { ...result.commands } : {};
    for (const [cmd, defaults] of Object.entries(override.commands)) {
      result.commands[cmd] = concatFrontmatter(
        (result.commands[cmd] || {}) as AgentFrontmatter,
        defaults as AgentFrontmatter,
      ) as CommandDefaults;
    }
  }

  return result;
}

/**
 * Get defaults for a specific command
 */
export async function getCommandDefaults(command: string): Promise<CommandDefaults | undefined> {
  const config = await loadGlobalConfig();
  return config.commands?.[command];
}

/**
 * Right-biased merge for AgentFrontmatter objects.
 *
 * This is the monoid operation for the frontmatter merge chain:
 *   built-in ⊕ global ⊕ git-root ⊕ cwd ⊕ frontmatter ⊕ CLI flags
 *
 * Laws:
 *   Identity:      concatFrontmatter({}, x) ≡ x
 *                  concatFrontmatter(x, {}) ≡ x
 *   Right-bias:    for any key k in both a and b, result[k] === b[k]
 *   Associativity: concatFrontmatter(a, concatFrontmatter(b, c))
 *                  ≡ concatFrontmatter(concatFrontmatter(a, b), c)
 *
 * Returns a new object; does not modify either input.
 */
export function concatFrontmatter(
  base: AgentFrontmatter,
  override: AgentFrontmatter
): AgentFrontmatter {
  return { ...base, ...override };
}

/**
 * Apply command defaults to frontmatter
 * Frontmatter values take priority over defaults
 *
 * Thin wrapper around concatFrontmatter for backward compatibility.
 */
export function applyDefaults(
  frontmatter: AgentFrontmatter,
  defaults: CommandDefaults | undefined
): AgentFrontmatter {
  if (!defaults) {
    return frontmatter;
  }
  return concatFrontmatter(defaults as AgentFrontmatter, frontmatter);
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Get the config file path
 */
export function getConfigFile(): string {
  return CONFIG_FILE;
}

/**
 * Clear the cached config (for testing)
 * @deprecated No-op function kept for backward compatibility.
 * Module-level caching has been removed - config functions are now pure.
 */
export function clearConfigCache(): void {
  // No-op: caching has been removed from this module
}

/**
 * Clear only the project config cache (for testing)
 * @deprecated No-op function kept for backward compatibility.
 * Module-level caching has been removed - config functions are now pure.
 */
export function clearProjectConfigCache(): void {
  // No-op: caching has been removed from this module
}

// ============================================================================
// Aliases for backward compatibility
// All config functions are now pure (no caching), so these are simple aliases.
// ============================================================================

/**
 * Load global config from ~/.mdflow/config.yaml (no caching)
 * @deprecated Use loadGlobalConfig() instead - all functions are now pure.
 */
export const loadGlobalConfigFresh = loadGlobalConfig;

/**
 * Load project-level config with cascade: git root → CWD (no caching)
 * @deprecated Use loadProjectConfig() instead - all functions are now pure.
 */
export const loadProjectConfigFresh = loadProjectConfig;

/**
 * Load fully merged config: built-in defaults → global → git root → CWD (no caching)
 * @deprecated Use loadFullConfig() instead - all functions are now pure.
 */
export const loadFullConfigFresh = loadFullConfig;

/**
 * Get defaults for a specific command from a config object
 * This is the pure function version that works with RunContext
 */
export function getCommandDefaultsFromConfig(
  config: GlobalConfig,
  command: string
): CommandDefaults | undefined {
  return config.commands?.[command];
}
