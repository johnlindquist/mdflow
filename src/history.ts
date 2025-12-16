/**
 * Frecency (Frequency + Recency) tracking for agent files
 *
 * Uses Mozilla/z-style recency buckets:
 * - <4 hours: 4x multiplier (working memory)
 * - <24 hours: 2x multiplier (daily context)
 * - <1 week: 0.5x multiplier (weekly context)
 * - older: 0.25x multiplier (long-term memory)
 *
 * Frequency uses logarithmic scaling to dampen outliers.
 */

import { join } from "path";
import { homedir } from "os";

interface HistoryEntry {
  count: number;
  lastUsed: number;
  /** Timestamp of last edit/touch (for sorting recently edited files higher) */
  lastTouched?: number;
}

interface HistoryData {
  [path: string]: HistoryEntry;
}

const HISTORY_PATH = join(homedir(), ".mdflow", "history.json");

let historyData: HistoryData | null = null;

/**
 * Load history from disk (cached after first load)
 */
export async function loadHistory(): Promise<HistoryData> {
  if (historyData !== null) return historyData;

  try {
    const file = Bun.file(HISTORY_PATH);
    if (await file.exists()) {
      historyData = await file.json();
    } else {
      historyData = {};
    }
  } catch {
    historyData = {};
  }

  return historyData!;
}

/**
 * Save history to disk (fire-and-forget)
 */
async function saveHistory(): Promise<void> {
  if (!historyData) return;

  try {
    // Ensure directory exists
    const dir = join(homedir(), ".mdflow");
    await Bun.write(join(dir, ".keep"), ""); // Create dir if needed
    await Bun.write(HISTORY_PATH, JSON.stringify(historyData, null, 2));
  } catch {
    // Silently fail - history is not critical
  }
}

/**
 * Calculate frecency score for a path
 *
 * Score = log10(count + 1) * 20 * recencyMultiplier
 *
 * Example scores:
 * - 1 use, <4h ago: ~0 * 4 = 0
 * - 10 uses, <4h ago: 20 * 4 = 80
 * - 100 uses, <4h ago: 40 * 4 = 160
 * - 10 uses, 1 day ago: 20 * 2 = 40
 * - 10 uses, 1 week ago: 20 * 0.5 = 10
 */
export function getFrecencyScore(path: string): number {
  if (!historyData || !historyData[path]) return 0;

  const entry = historyData[path];
  if (!entry) return 0;

  const { count, lastUsed, lastTouched } = entry;

  // Use the most recent timestamp (run or edit) for recency calculation
  // This ensures recently edited files rank higher even if not recently run
  const mostRecentActivity = Math.max(lastUsed, lastTouched ?? 0);

  // Mozilla/z-style recency buckets
  const hours = (Date.now() - mostRecentActivity) / (1000 * 60 * 60);
  let multiplier: number;

  if (hours < 4) {
    multiplier = 4; // Working memory
  } else if (hours < 24) {
    multiplier = 2; // Daily context
  } else if (hours < 168) {
    // 7 days
    multiplier = 0.5; // Weekly context
  } else {
    multiplier = 0.25; // Long-term memory
  }

  // Logarithmic frequency (dampens outliers)
  // 1 use = 0pts, 10 uses = 20pts, 100 uses = 40pts
  return Math.log10(count + 1) * 20 * multiplier;
}

/**
 * Record a file usage (increments count and updates lastUsed)
 */
export async function recordUsage(path: string): Promise<void> {
  await loadHistory();

  if (!historyData![path]) {
    historyData![path] = { count: 0, lastUsed: 0 };
  }

  historyData![path]!.count++;
  historyData![path]!.lastUsed = Date.now();

  // Fire and forget save
  saveHistory().catch(() => {});
}

/**
 * Record a file touch/edit (updates lastTouched without incrementing count)
 * Used when user edits a file from the interactive menu to boost its ranking
 */
export async function recordTouch(path: string): Promise<void> {
  await loadHistory();

  if (!historyData![path]) {
    historyData![path] = { count: 0, lastUsed: 0 };
  }

  historyData![path]!.lastTouched = Date.now();

  // Fire and forget save
  saveHistory().catch(() => {});
}

/**
 * Get history data (for testing)
 */
export function getHistoryData(): HistoryData | null {
  return historyData;
}

/**
 * Reset history data (for testing)
 */
export function resetHistory(): void {
  historyData = null;
}

// =============================================================================
// Variable Persistence
// =============================================================================

/**
 * Structure for storing template variable values per agent file
 * { "/path/to/agent.md": { "_ticket_id": "PROJ-123", "_env": "prod" } }
 */
interface VariableHistoryData {
  [agentPath: string]: Record<string, string>;
}

const VARIABLE_HISTORY_PATH = join(homedir(), ".mdflow", "variable-history.json");

let variableHistoryData: VariableHistoryData | null = null;

/**
 * Load variable history from disk (cached after first load)
 * Handles missing or corrupt files gracefully
 */
export async function loadVariableHistory(): Promise<VariableHistoryData> {
  if (variableHistoryData !== null) return variableHistoryData;

  try {
    const file = Bun.file(VARIABLE_HISTORY_PATH);
    if (await file.exists()) {
      const content = await file.text();
      const parsed = JSON.parse(content);
      // Validate structure: should be an object of objects
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        variableHistoryData = parsed;
      } else {
        variableHistoryData = {};
      }
    } else {
      variableHistoryData = {};
    }
  } catch {
    // Handle corrupt JSON gracefully
    variableHistoryData = {};
  }

  return variableHistoryData!;
}

/**
 * Save variable history to disk
 */
async function saveVariableHistory(): Promise<void> {
  if (!variableHistoryData) return;

  try {
    // Ensure directory exists
    const dir = join(homedir(), ".mdflow");
    await Bun.write(join(dir, ".keep"), ""); // Create dir if needed
    await Bun.write(VARIABLE_HISTORY_PATH, JSON.stringify(variableHistoryData, null, 2));
  } catch {
    // Silently fail - history is not critical
  }
}

/**
 * Get previous variable values for an agent file
 * @param agentPath - Absolute path to the agent file
 * @returns Record of variable names to their previous values, or empty object
 */
export async function getVariableHistory(agentPath: string): Promise<Record<string, string>> {
  await loadVariableHistory();
  return variableHistoryData![agentPath] ?? {};
}

/**
 * Save variable values for an agent file
 * @param agentPath - Absolute path to the agent file
 * @param variables - Record of variable names to their values
 */
export async function saveVariableValues(
  agentPath: string,
  variables: Record<string, string>
): Promise<void> {
  await loadVariableHistory();

  // Merge with existing values (new values override old)
  variableHistoryData![agentPath] = {
    ...(variableHistoryData![agentPath] ?? {}),
    ...variables,
  };

  await saveVariableHistory();
}

/**
 * Get a specific variable's previous value
 * @param agentPath - Absolute path to the agent file
 * @param varName - Variable name (e.g., "_ticket_id")
 * @returns Previous value or undefined
 */
export async function getPreviousVariableValue(
  agentPath: string,
  varName: string
): Promise<string | undefined> {
  const history = await getVariableHistory(agentPath);
  return history[varName];
}

/**
 * Get variable history data (for testing)
 */
export function getVariableHistoryData(): VariableHistoryData | null {
  return variableHistoryData;
}

/**
 * Reset variable history data (for testing)
 */
export function resetVariableHistory(): void {
  variableHistoryData = null;
}

/**
 * Get the path to the variable history file (for testing)
 */
export function getVariableHistoryPath(): string {
  return VARIABLE_HISTORY_PATH;
}
