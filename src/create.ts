/**
 * Create a project flow from plain-language intent.
 *
 * The default path is deliberately the same one used by the Flow Workbench:
 * a canonical `flows/<slug>.md` file plus additive project support files.
 */

import { input } from "@inquirer/prompts";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import yaml from "js-yaml";
import { getUserAgentsDir } from "./cli";
import { openInEditor } from "./file-selector";
import { parseRawFrontmatter } from "./parse";
import { contextualFlowTip } from "./tips";
import {
  applyFlowDraft,
  draftFlowFromIntent,
  resolveWorkbenchTarget,
  slugifyFlowIntent,
} from "./workbench-model";
import type { FlowDraft, WorkbenchTarget } from "./workbench-model";

type CreateLocation = "project" | "cwd" | "user" | "custom";

export interface CreateOptions {
  intent?: string;
  name?: string;
  engine?: string;
  location: CreateLocation;
  customDir?: string;
  content?: string;
  description?: string;
  dryRun: boolean;
  open: boolean;
  help: boolean;
  frontmatter: Record<string, unknown>;
}

export type CreateCommandResult =
  | { status: "help" }
  | { status: "preview"; draft: FlowDraft; flowPath: string }
  | {
      status: "created";
      draft: FlowDraft;
      flowPath: string;
      created: string[];
      skipped: string[];
    }
  | { status: "conflict"; draft: FlowDraft; flowPath: string };

/** Small dependency seam used by tests and other non-process callers. */
export interface CreateRuntime {
  cwd?: string;
  promptIntent?: () => Promise<string>;
  log?: (message: string) => void;
  openFile?: (path: string) => boolean;
}

function flagValue(
  args: readonly string[],
  index: number,
  inlineValue: string | undefined,
  flag: string
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function inferredValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** Parse both the intent-first command and the useful v2 create aliases. */
export function parseCreateArgs(args: readonly string[]): CreateOptions {
  const options: CreateOptions = {
    location: "project",
    dryRun: false,
    open: false,
    help: false,
    frontmatter: {},
  };
  const intentParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw) continue;
    if (raw === "--") {
      intentParts.push(...args.slice(i + 1));
      break;
    }
    if (!raw.startsWith("-")) {
      intentParts.push(raw);
      continue;
    }

    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);

    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--dry-run" || flag === "--preview" || flag === "--_dry-run") {
      options.dryRun = true;
    } else if (flag === "--open") {
      options.open = true;
    } else if (flag === "--yes" || flag === "-y" || flag === "--json") {
      // `create <intent>` is already an explicit apply action. Keep these
      // automation/global-output flags consumable without leaking them into
      // flow frontmatter.
    } else if (flag === "--project" || flag === "-p") {
      options.location = "project";
    } else if (flag === "--global" || flag === "-g") {
      options.location = "user";
    } else if (flag === "--name" || flag === "-n" || flag === "--slug") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.name = parsed.value;
      i = parsed.nextIndex;
    } else if (
      flag === "--engine" ||
      flag === "--command" ||
      flag === "--tool" ||
      flag === "--_command" ||
      flag === "-_c"
    ) {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.engine = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--location" || flag === "-l") {
      const parsed = flagValue(args, i, inlineValue, flag);
      if (!(["cwd", "project", "user"] as string[]).includes(parsed.value)) {
        throw new Error(`Unknown create location: ${parsed.value}`);
      }
      options.location = parsed.value as Exclude<CreateLocation, "custom">;
      i = parsed.nextIndex;
    } else if (flag === "--dir" || flag === "-d") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.location = "custom";
      options.customDir = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--content" || flag === "--body") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.content = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--description") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.description = parsed.value;
      i = parsed.nextIndex;
    } else {
      // Preserve the old create command's convenient "unknown flags become
      // frontmatter" contract.
      const key = flag.replace(/^-+/, "");
      const next = args[i + 1];
      if (inlineValue !== undefined) {
        options.frontmatter[key] = inferredValue(inlineValue);
      } else if (next !== undefined && !next.startsWith("-")) {
        options.frontmatter[key] = inferredValue(next);
        i++;
      } else {
        options.frontmatter[key] = true;
      }
    }
  }

  if (intentParts.length === 1 && /\.md$/i.test(intentParts[0]!) && !options.name) {
    // v2 accepted a filename as its sole positional argument. Treat it as a
    // naming hint while still producing the v3 engine-neutral flow shape.
    options.name = intentParts[0];
  } else if (intentParts.length > 0) {
    options.intent = intentParts.join(" ").trim();
  }

  return options;
}

interface LegacyName {
  intent: string;
  slug: string;
  engine?: string;
  interactive: boolean;
}

function interpretName(name: string): LegacyName {
  const stem = basename(name.trim()).replace(/\.md$/i, "");
  const pieces = stem.split(".").filter(Boolean);
  let engine: string | undefined;
  let interactive = false;
  if (pieces.length > 1) {
    engine = pieces.pop();
    if (pieces.at(-1) === "i") {
      pieces.pop();
      interactive = true;
    }
  }
  const subject = pieces.join(" ") || stem || "new flow";
  return {
    intent: subject.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(),
    slug: slugifyFlowIntent(pieces.join("-") || stem),
    ...(engine ? { engine } : {}),
    interactive,
  };
}

function mergeFrontmatter(draft: FlowDraft, extra: Record<string, unknown>): FlowDraft {
  if (Object.keys(extra).length === 0) return draft;
  const parsed = parseRawFrontmatter(draft.markdown);
  const existing =
    typeof parsed.frontmatter === "object" && parsed.frontmatter !== null && !Array.isArray(parsed.frontmatter)
      ? (parsed.frontmatter as Record<string, unknown>)
      : {};
  const frontmatter = yaml.dump({ ...existing, ...extra }, { lineWidth: -1, noRefs: true }).trimEnd();
  const body = parsed.body.trimEnd();
  return {
    ...draft,
    markdown: `---\n${frontmatter}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`,
  };
}

function previewMessage(draft: FlowDraft, flowPath: string, engine: string | undefined): string {
  return [
    "",
    "Flow preview",
    `  Intent: ${draft.intent}`,
    `  File:   ${flowPath}`,
    `  Engine: ${engine ?? "project default (pi if unset)"}`,
    "  Effect: FREE — no files written",
    "",
    draft.markdown.trimEnd(),
    "",
    `Apply it: md create ${shellQuote(draft.intent)}`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function applyLegacyLocation(draft: FlowDraft, directory: string): "created" | "conflict" {
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(join(directory, draft.filename), draft.markdown, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "conflict";
    throw error;
  }
}

function helpText(): string {
  return `
Usage: md create [intent...] [options]

Create a runnable Markdown flow in the nearest project's flows/ roster.
An intent on the command line applies immediately; --dry-run is read-only.

Options:
  --name, -n <slug>       Override the generated filename
  --engine <name>         Persist an engine choice (default: project config / pi)
  --content, --body       Override the Markdown prompt body
  --description <text>    Override the roster description
  --dry-run, --preview    Print the exact draft and target; write nothing
  --open                  Open the new flow in $EDITOR
  --project, -p           Use the canonical project flows/ roster (default)
  --global, -g            Create a personal flow in ~/.mdflow/ (user scope)
  --dir, -d <path>        Legacy: create directly in a custom directory

Unknown flags are retained as flow frontmatter for compatibility.
Deprecated --_command/-_c and --tool aliases still select --engine.

Examples:
  md create Review staged changes for correctness
  md create "Draft release notes from recent commits" --engine codex
  md create "Turn meeting notes into an action plan" --global
  md create "Summarize this repo" --name repo-summary --dry-run
`;
}

/**
 * Create a flow. The returned receipt is useful to embedded callers; the CLI
 * continues to ignore it and relies on the human-readable output.
 */
export async function runCreate(
  args: string[],
  runtime: CreateRuntime = {}
): Promise<CreateCommandResult> {
  const options = parseCreateArgs(args);
  const log = runtime.log ?? console.log;
  const cwd = resolve(runtime.cwd ?? process.cwd());

  if (options.help) {
    log(helpText());
    return { status: "help" };
  }

  const legacyName = options.name ? interpretName(options.name) : undefined;
  const promptIntent =
    runtime.promptIntent ??
    (() =>
      input({
        message: "What should this flow do?",
        validate: (value) => value.trim().length > 0 || "Describe the flow in a few words",
      }));
  const intent = options.intent?.trim() || legacyName?.intent || (await promptIntent()).trim();
  if (!intent) throw new Error("Flow intent cannot be empty.");

  const engine = options.engine?.trim() || legacyName?.engine;
  if (options.engine !== undefined && !engine) throw new Error("Create engine cannot be empty.");

  let draft = draftFlowFromIntent(intent, {
    ...(legacyName ? { slug: legacyName.slug } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.content !== undefined ? { body: options.content } : {}),
  });
  draft = mergeFrontmatter(draft, {
    ...options.frontmatter,
    ...(engine ? { engine } : {}),
    ...(legacyName?.interactive ? { _interactive: true } : {}),
  });

  const canonical = options.location === "project";
  let target: WorkbenchTarget | undefined;
  let legacyDirectory: string | undefined;
  if (canonical) {
    target = resolveWorkbenchTarget(cwd);
  } else if (options.location === "cwd") {
    legacyDirectory = cwd;
  } else if (options.location === "user") {
    legacyDirectory = getUserAgentsDir();
  } else {
    legacyDirectory = resolve(cwd, options.customDir!);
  }
  const flowPath = canonical
    ? join(target!.flowsDir, draft.filename)
    : join(legacyDirectory!, draft.filename);

  if (options.dryRun) {
    log(previewMessage(draft, flowPath, engine));
    return { status: "preview", draft, flowPath };
  }

  let created: string[];
  let skipped: string[];
  let conflict = false;
  if (canonical) {
    const result = applyFlowDraft(draft, {
      target: target!,
      ...(engine ? { engine } : {}),
    });
    conflict = result.status === "conflict";
    created = result.created;
    skipped = result.skipped;
  } else {
    const status = applyLegacyLocation(draft, legacyDirectory!);
    conflict = status === "conflict";
    created = status === "created" ? [flowPath] : [];
    skipped = [];
  }

  if (conflict) {
    log(`\nFlow already exists: ${flowPath}\nNothing was changed. Choose another name with --name <slug>.`);
    return { status: "conflict", draft, flowPath };
  }

  log(`\nCreated flow: ${flowPath}`);
  const supportFiles = created.filter((path) => path !== flowPath);
  if (supportFiles.length > 0) log(`Added project support: ${supportFiles.join(", ")}`);
  const tip = contextualFlowTip({ cwd, flowPath, created: true });
  if (tip) log(`Tip: ${tip}`);

  if (options.open) (runtime.openFile ?? openInEditor)(flowPath);

  return { status: "created", draft, flowPath, created, skipped };
}
