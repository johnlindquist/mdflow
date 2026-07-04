/**
 * Tool Adapter Registry
 *
 * Central registry for tool adapters. Adapters define tool-specific behavior
 * for default configuration and interactive mode transformations.
 *
 * Adding a new tool requires:
 * 1. Creating a new adapter file (e.g., src/adapters/mytool.ts)
 * 2. Registering it in this file
 *
 * The registry provides a fallback "default" adapter for unknown tools.
 */

import type { ToolAdapter, CommandDefaults, AgentFrontmatter } from "../types";

// Import built-in adapters
import { claudeAdapter } from "./claude";
import { copilotAdapter } from "./copilot";
import { codexAdapter } from "./codex";
import { geminiAdapter } from "./gemini";
import { droidAdapter } from "./droid";
import { opencodeAdapter } from "./opencode";
import { piAdapter } from "./pi";
import { cursorAgentAdapter } from "./cursor-agent";
import { agyAdapter } from "./agy";

/**
 * Default adapter for unknown tools
 * Provides no defaults and no-op interactive transformation
 */
const defaultAdapter: ToolAdapter = {
  name: "default",

  getDefaults(): CommandDefaults {
    return {};
  },

  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter {
    // Unknown command - no special transformations needed
    return { ...frontmatter };
  },
};

/**
 * Registry of tool adapters indexed by tool name
 */
const adapterRegistry: Map<string, ToolAdapter> = new Map();

/**
 * Register a tool adapter
 * @param adapter - The adapter to register
 */
export function registerAdapter(adapter: ToolAdapter): void {
  adapterRegistry.set(adapter.name, adapter);
}

/**
 * Get the adapter for a specific tool
 * Returns the default adapter if no specific adapter is registered
 *
 * @param toolName - The name of the tool (e.g., "claude", "copilot")
 * @returns The tool adapter
 */
export function getAdapter(toolName: string): ToolAdapter {
  return adapterRegistry.get(toolName) ?? defaultAdapter;
}

/**
 * Check if an adapter is registered for a tool
 * @param toolName - The name of the tool
 * @returns true if a specific adapter exists (not the default)
 */
export function hasAdapter(toolName: string): boolean {
  return adapterRegistry.has(toolName);
}

/**
 * Get all registered adapter names
 * @returns Array of registered tool names
 */
export function getRegisteredAdapters(): string[] {
  return Array.from(adapterRegistry.keys());
}

/**
 * Get the default adapter (for unknown tools)
 * @returns The default adapter
 */
export function getDefaultAdapter(): ToolAdapter {
  return defaultAdapter;
}

/**
 * Build the BUILTIN_DEFAULTS object from all registered adapters
 * This generates the same structure as the previous hardcoded BUILTIN_DEFAULTS
 *
 * @returns GlobalConfig-compatible commands object
 */
export function buildBuiltinDefaults(): Record<string, CommandDefaults> {
  const commands: Record<string, CommandDefaults> = {};

  for (const [name, adapter] of adapterRegistry) {
    const defaults = adapter.getDefaults();
    // Only include adapters that have non-empty defaults
    if (Object.keys(defaults).length > 0) {
      commands[name] = defaults;
    }
  }

  return commands;
}

/**
 * Clear the registry (for testing)
 */
export function clearAdapterRegistry(): void {
  adapterRegistry.clear();
}

/**
 * Initialize the registry with built-in adapters
 * Called automatically on module load
 */
function initializeBuiltinAdapters(): void {
  registerAdapter(claudeAdapter);
  registerAdapter(copilotAdapter);
  registerAdapter(codexAdapter);
  registerAdapter(geminiAdapter);
  registerAdapter(droidAdapter);
  registerAdapter(opencodeAdapter);
  registerAdapter(piAdapter);
  registerAdapter(cursorAgentAdapter);
  registerAdapter(agyAdapter);
}

// Initialize built-in adapters on module load
initializeBuiltinAdapters();

// Re-export for convenience
export { defaultAdapter };
export type { ToolAdapter } from "../types";
