/**
 * `md hooks` — manage a flow's lifecycle hooks file.
 *
 *   md hooks add <flow.md> [event…]     scaffold or extend <flow>.hooks.ts
 *   md hooks list <flow.md>             show the resolved hooks file + events
 *   md hooks remove <flow.md> [event…]  remove handlers (or the whole file)
 *
 * The hooks file is the convention: an executable, self-contained Bun
 * TypeScript program named after the flow. This command only performs LOCAL
 * WRITES next to the flow file — it never calls an engine. Interactive
 * prompts appear only on a TTY; every path is scriptable with explicit
 * arguments (`--yes` replaces the confirm prompt).
 *
 * Extending/removing handlers edits the file surgically using the template's
 * stable markers. A hand-rewritten file that no longer matches the markers
 * fails loudly with an "edit it manually" pointer instead of guessing.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  CANONICAL_HOOK_EVENTS,
  CODEX_HOOK_EVENT_NAMES,
  HANDLERS_OPEN_MARKER,
  hooksFileForFlow,
  listHandledEventsStatic,
  renderHooksTemplate,
  resolveHooksFile,
  type CanonicalHookEvent,
} from "./hooks";
import { parseRawFrontmatter } from "./parse";
import { parseCommandFromFilename } from "./command";
import { getAdapter as getEngineAdapter, hasAdapter } from "./adapters";

const EVENT_DESCRIPTIONS: Record<CanonicalHookEvent, string> = {
  sessionStart: "session begins — inject startup context",
  userPromptSubmit: "prompt submitted — inject context or block",
  preToolUse: "before a tool call — deny or rewrite input",
  postToolUse: "after a tool call — observe results",
  permissionRequest: "approval requested — allow or deny",
  preCompact: "before history compaction",
  postCompact: "after history compaction",
  subagentStart: "subagent begins",
  subagentStop: "subagent finishes — block to continue it",
  stop: "turn finishes — block to force continuation",
  sessionEnd: "session ends (not fired by codex exec today)",
};

export interface HooksCliRuntime {
  cwd?: string;
  isTTY?: boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
  /** Injected for tests; defaults to the real inquirer prompts. */
  promptEvents?: () => Promise<CanonicalHookEvent[]>;
  promptConfirm?: (message: string) => Promise<boolean>;
}

function isCanonicalEvent(value: string): value is CanonicalHookEvent {
  return (CANONICAL_HOOK_EVENTS as readonly string[]).includes(value);
}

/** Render one handler block exactly as renderHooksTemplate does. */
function renderHandlerBlocks(events: CanonicalHookEvent[]): string {
  const full = renderHooksTemplate(events);
  const open = full.indexOf(HANDLERS_OPEN_MARKER);
  const close = full.indexOf("\n};", open);
  return full.slice(open + HANDLERS_OPEN_MARKER.length + 1, close + 1);
}

function validEventsLine(): string {
  return `Valid events: ${CANONICAL_HOOK_EVENTS.join(", ")}`;
}

export function hooksUsage(): string {
  return `Usage: md hooks <add|list|remove> <flow.md> [event…]

Manage the flow's lifecycle hooks file (<flow>.hooks.ts — an executable,
self-contained Bun TypeScript program discovered by name). LOCAL WRITE only;
never calls an engine.

  md hooks add review.codex.md stop userPromptSubmit
  md hooks add review.codex.md            # interactive event picker (TTY)
  md hooks list review.codex.md
  md hooks remove review.codex.md stop    # remove one handler
  md hooks remove review.codex.md --yes   # delete the whole hooks file

${validEventsLine()}`;
}

async function defaultPromptEvents(): Promise<CanonicalHookEvent[]> {
  const { checkbox } = await import("@inquirer/prompts");
  return checkbox<CanonicalHookEvent>({
    message: "Which lifecycle events should this flow hook?",
    choices: CANONICAL_HOOK_EVENTS.map((event) => ({
      value: event,
      name: `${event} — ${EVENT_DESCRIPTIONS[event]}`,
    })),
    required: true,
  });
}

async function defaultPromptConfirm(message: string): Promise<boolean> {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: false });
}

/** Warn (never block) when the flow's engine has no hook translation yet. */
function engineSupportNote(flowPath: string): string | undefined {
  const engine = parseCommandFromFilename(basename(flowPath));
  if (!engine || !hasAdapter(engine)) {
    return `Note: this flow's filename names no known engine; hooks currently run on codex — the run fails on engines without hook support.`;
  }
  const adapter = getEngineAdapter(engine);
  if (!adapter.applyHooks) {
    return `Note: engine "${engine}" has no verified hook mechanism yet — running this flow WITH a hooks file will fail. Hooks currently work on: codex.`;
  }
  return undefined;
}

export async function runHooksCli(
  args: string[],
  runtime: HooksCliRuntime = {}
): Promise<number> {
  const log = runtime.log ?? ((m: string) => console.log(m));
  const error = runtime.error ?? ((m: string) => console.error(m));
  const isTTY = runtime.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const cwd = runtime.cwd ?? process.cwd();

  const positionals: string[] = [];
  let yes = false;
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--help" || arg === "-h") {
      log(hooksUsage());
      return 0;
    } else positionals.push(arg);
  }

  const [action, flowArg, ...eventArgs] = positionals;
  if (!action || !["add", "list", "remove"].includes(action)) {
    error(hooksUsage());
    return 1;
  }
  if (!flowArg) {
    error(`md hooks ${action}: missing <flow.md> argument.\n\n${hooksUsage()}`);
    return 1;
  }

  const flowPath = resolve(cwd, flowArg);
  if (!existsSync(flowPath)) {
    error(`Flow file not found: ${flowPath}`);
    return 1;
  }
  if (!/\.md$/i.test(flowPath)) {
    error(`Not a markdown flow file: ${flowPath}`);
    return 1;
  }

  const requested: CanonicalHookEvent[] = [];
  for (const eventArg of eventArgs) {
    if (!isCanonicalEvent(eventArg)) {
      error(`Unknown hook event "${eventArg}". ${validEventsLine()}`);
      return 1;
    }
    requested.push(eventArg);
  }

  const hooksPath = hooksFileForFlow(flowPath);

  if (action === "list") {
    // Honor the flow's own `_hooks:` override so list reports the file a
    // run would actually use, not just the naming convention.
    let frontmatterValue: unknown;
    try {
      const fm = parseRawFrontmatter(readFileSync(flowPath, "utf8")).frontmatter as
        | Record<string, unknown>
        | null;
      frontmatterValue = fm?.["_hooks"];
    } catch {
      // Unparseable frontmatter: fall back to convention discovery.
    }
    const resolved = resolveHooksFile({ flowPath, frontmatterValue });
    if (resolved.kind === "disabled") {
      log(`Hooks are disabled for ${basename(flowPath)} (_hooks: false).`);
      return 0;
    }
    // A rejected declaration must fail even when its target doesn't exist —
    // reporting "No hooks file" for an escaping path would hide the policy
    // violation the run itself will refuse.
    if (resolved.kind === "file" && resolved.rejected) {
      error(`Hooks error: ${resolved.rejected}`);
      return 1;
    }
    if (resolved.kind !== "file" || resolved.missing) {
      log(`No hooks file for ${basename(flowPath)}.`);
      log(`Expected: ${hooksPath}`);
      log(`Create one: md hooks add ${flowArg} <event…>`);
      return 0;
    }
    // Static inspection only: `md hooks list` advertises inspection, so it
    // must never execute the hook program.
    const listed = listHandledEventsStatic(resolved.path);
    if (!listed.ok) {
      error(`Hooks file found but not statically inspectable: ${listed.error}`);
      return 1;
    }
    log(`Hooks file: ${resolved.path}${resolved.source === "frontmatter" ? " (from _hooks:)" : ""}`);
    log(`Events:`);
    for (const event of listed.events) {
      log(`  ${event} → codex ${CODEX_HOOK_EVENT_NAMES[event]}`);
    }
    const note = engineSupportNote(flowPath);
    if (note) log(note);
    return 0;
  }

  if (action === "add") {
    let events = [...new Set(requested)];
    if (events.length === 0) {
      if (!isTTY) {
        error(`md hooks add: no events given and no TTY to prompt.\n${validEventsLine()}`);
        return 1;
      }
      events = await (runtime.promptEvents ?? defaultPromptEvents)();
      if (events.length === 0) {
        error("No events selected; nothing to do.");
        return 1;
      }
    }

    if (!existsSync(hooksPath)) {
      writeFileSync(hooksPath, renderHooksTemplate(events), { mode: 0o755 });
      log(`Created ${hooksPath}`);
      log(`Handlers: ${events.join(", ")}`);
      log(`It runs automatically on every \`md ${flowArg}\` run.`);
      log(`Test it standalone: echo '{"hook_event_name":"${CODEX_HOOK_EVENT_NAMES[events[0]!]}"}' | ${basename(hooksPath)}`);
      const note = engineSupportNote(flowPath);
      if (note) log(note);
      return 0;
    }

    const existing = listHandledEventsStatic(hooksPath);
    if (!existing.ok) {
      error(
        `Cannot extend ${hooksPath}: ${existing.error}\n` +
          `Fix the file (or delete it and re-run md hooks add).`
      );
      return 1;
    }
    const fresh = events.filter((event) => !existing.events.includes(event));
    if (fresh.length === 0) {
      log(`${basename(hooksPath)} already handles: ${events.join(", ")}. Nothing to do.`);
      return 0;
    }
    const source = readFileSync(hooksPath, "utf8");
    const markerIdx = source.indexOf(HANDLERS_OPEN_MARKER);
    if (markerIdx === -1) {
      error(
        `${hooksPath} no longer matches the md hooks template (missing handlers marker); ` +
          `add the ${fresh.join(", ")} handler(s) manually.`
      );
      return 1;
    }
    const insertAt = markerIdx + HANDLERS_OPEN_MARKER.length + 1;
    const updated =
      source.slice(0, insertAt) + renderHandlerBlocks(fresh) + source.slice(insertAt);
    writeFileSync(hooksPath, updated);
    chmodSync(hooksPath, 0o755);
    log(`Extended ${basename(hooksPath)} with: ${fresh.join(", ")}`);
    log(`Now handles: ${[...existing.events, ...fresh].join(", ")}`);
    return 0;
  }

  // action === "remove"
  if (!existsSync(hooksPath)) {
    log(`No hooks file for ${basename(flowPath)} (${hooksPath}); nothing to remove.`);
    return 0;
  }

  if (requested.length === 0) {
    if (!yes) {
      if (!isTTY) {
        error(`md hooks remove: deleting the whole hooks file needs --yes when not on a TTY.`);
        return 1;
      }
      const confirmed = await (runtime.promptConfirm ?? defaultPromptConfirm)(
        `Delete ${hooksPath}?`
      );
      if (!confirmed) {
        log("Cancelled.");
        return 1;
      }
    }
    unlinkSync(hooksPath);
    log(`Deleted ${hooksPath}`);
    return 0;
  }

  const source = readFileSync(hooksPath, "utf8");
  let updated = source;
  const removed: CanonicalHookEvent[] = [];
  for (const event of requested) {
    // Match the template's exact handler block shape at two-space depth.
    const pattern = new RegExp(
      `^  ${event}: async \\([\\s\\S]*?^  \\},\\n`,
      "m"
    );
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, "");
      removed.push(event);
    }
  }
  if (removed.length === 0) {
    error(
      `No removable handler(s) for ${requested.join(", ")} in ${basename(hooksPath)} ` +
        `(not present, or the file diverged from the md hooks template — edit it manually).`
    );
    return 1;
  }
  writeFileSync(hooksPath, updated);
  const remaining = listHandledEventsStatic(hooksPath);
  log(`Removed ${removed.join(", ")} from ${basename(hooksPath)}`);
  if (remaining.ok) {
    log(`Still handles: ${remaining.events.join(", ")}`);
  } else {
    log(`No handlers remain — delete the file with: md hooks remove ${flowArg} --yes`);
  }
  return 0;
}
