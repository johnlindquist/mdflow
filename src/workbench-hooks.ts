/**
 * Async lifecycle-hook summaries for the Flow Workbench.
 *
 * Discovery and stat calls are synchronous and cheap enough for first paint.
 * Executing a hooks program to list its events is not, so callers render the
 * loading state immediately and hydrate in an effect. Hydrated results are
 * cached by hooks path + mtime and are therefore reused until the file changes.
 */

import { statSync } from "node:fs";
import type { AgentFile } from "./cli";
import {
  listHandledEventsStatic,
  resolveHooksFile,
  type CanonicalHookEvent,
} from "./hooks";

export type WorkbenchHooksStatus =
  | { state: "none" }
  | { state: "loading"; path: string; mtimeMs: number }
  | { state: "ready"; path: string; mtimeMs: number; events: CanonicalHookEvent[] }
  | { state: "error"; path: string; mtimeMs: number; error: string };

type HydratedHooksStatus = Extract<WorkbenchHooksStatus, { state: "ready" | "error" }>;

interface HooksCacheEntry {
  mtimeMs: number;
  status?: HydratedHooksStatus;
  promise?: Promise<HydratedHooksStatus>;
}

const hooksStatusCache = new Map<string, HooksCacheEntry>();

type ListEvents = (
  path: string
) => Promise<{ ok: true; events: CanonicalHookEvent[] } | { ok: false; error: string }>;

export function getWorkbenchHooksStatus(file: AgentFile): WorkbenchHooksStatus {
  const resolved = resolveHooksFile({ flowPath: file.path });
  if (resolved.kind !== "file" || resolved.missing) return { state: "none" };

  try {
    const mtimeMs = statSync(resolved.path).mtimeMs;
    const cached = hooksStatusCache.get(resolved.path);
    if (cached?.mtimeMs === mtimeMs && cached.status) return cached.status;
    return { state: "loading", path: resolved.path, mtimeMs };
  } catch (error) {
    return {
      state: "error",
      path: resolved.path,
      mtimeMs: -1,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function hydrateHooks(
  initial: Extract<WorkbenchHooksStatus, { state: "loading" }>,
  listEvents: ListEvents,
): Promise<HydratedHooksStatus> {
  const cached = hooksStatusCache.get(initial.path);
  if (cached?.mtimeMs === initial.mtimeMs) {
    if (cached.status) return cached.status;
    if (cached.promise) return cached.promise;
  }

  const entry: HooksCacheEntry = { mtimeMs: initial.mtimeMs };
  const promise = listEvents(initial.path)
    .then<HydratedHooksStatus>((listed) => listed.ok
      ? {
          state: "ready",
          path: initial.path,
          mtimeMs: initial.mtimeMs,
          events: listed.events,
        }
      : {
          state: "error",
          path: initial.path,
          mtimeMs: initial.mtimeMs,
          error: listed.error,
        })
    .catch<HydratedHooksStatus>((error) => ({
      state: "error",
      path: initial.path,
      mtimeMs: initial.mtimeMs,
      error: error instanceof Error ? error.message : String(error),
    }));
  entry.promise = promise;
  hooksStatusCache.set(initial.path, entry);

  const status = await promise;
  if (hooksStatusCache.get(initial.path) === entry) {
    entry.status = status;
    entry.promise = undefined;
  }
  return status;
}

/**
 * Hydrate one selected flow. Discovery is STATIC — browsing the Workbench
 * must never execute a hooks program; an uninspectable file shows an error
 * status instead.
 */
export async function hydrateWorkbenchHooksStatus(
  file: AgentFile,
  options: { listEvents?: ListEvents } = {},
): Promise<WorkbenchHooksStatus> {
  const listEvents =
    options.listEvents ?? (async (path: string) => listHandledEventsStatic(path));
  const initial = getWorkbenchHooksStatus(file);
  return initial.state === "loading"
    ? hydrateHooks(initial, listEvents)
    : initial;
}

/** Tests and CLI refreshes can explicitly drop cached hook summaries. */
export function clearWorkbenchHooksStatusCache(path?: string): void {
  if (path) hooksStatusCache.delete(path);
  else hooksStatusCache.clear();
}
