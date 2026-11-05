import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseRawFrontmatter } from "./parse";
import { parseImports } from "./imports-parser";
import type { AgentFrontmatter, FrontmatterValue } from "./types";

export type EvolutionMode = "off" | "observe" | "suggest" | "propose" | "apply";

export interface EvolutionPolicy {
  mode: EvolutionMode;
  triggers: Array<"explicit-feedback" | "classified-failure" | "quick-rerun">;
  engine?: string;
  model?: string;
  isolated: boolean;
  timeoutMs: number;
  maxInvocations: number;
  maxPerDay: number;
  cooldownMs: number;
  requireFeedbackEval: boolean;
  allowCapabilityDelta: boolean;
  repetitions: number;
  apply: "review" | "automatic";
}

export const DEFAULT_EVOLUTION_POLICY: EvolutionPolicy = {
  mode: "off",
  triggers: ["explicit-feedback", "classified-failure"],
  timeoutMs: 180_000,
  isolated: true,
  maxInvocations: 9,
  maxPerDay: 2,
  cooldownMs: 24 * 60 * 60 * 1000,
  requireFeedbackEval: true,
  allowCapabilityDelta: false,
  repetitions: 1,
  apply: "review",
};

function numberFrom(value: FrontmatterValue, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArray(value: FrontmatterValue): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value as string[];
}

/** Parse the validated evolve frontmatter into one predictable runtime policy. */
export function resolveEvolutionPolicy(value: FrontmatterValue): EvolutionPolicy {
  if (value === undefined || value === null || value === false) return { ...DEFAULT_EVOLUTION_POLICY };
  if (value === "auto") {
    return { ...DEFAULT_EVOLUTION_POLICY, mode: "propose" };
  }
  if (typeof value === "string") {
    if (["off", "observe", "suggest", "propose", "apply"].includes(value)) {
      return {
        ...DEFAULT_EVOLUTION_POLICY,
        mode: value as EvolutionMode,
        apply: value === "apply" ? "automatic" : "review",
      };
    }
    throw new Error(`Invalid evolve mode '${value}'. Expected off, observe, suggest, propose, or apply.`);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid evolve policy. Expected a mode string or policy object.");
  }

  const raw = value as Record<string, FrontmatterValue>;
  const modeValue = raw.mode ?? "propose";
  if (typeof modeValue !== "string" || !["off", "observe", "suggest", "propose", "apply"].includes(modeValue)) {
    throw new Error("Invalid evolve.mode. Expected off, observe, suggest, propose, or apply.");
  }
  const budget = typeof raw.budget === "object" && raw.budget !== null && !Array.isArray(raw.budget)
    ? raw.budget as Record<string, FrontmatterValue>
    : {};
  const maintainer = typeof raw.maintainer === "object" && raw.maintainer !== null && !Array.isArray(raw.maintainer)
    ? raw.maintainer as Record<string, FrontmatterValue>
    : {};
  const gate = typeof raw.gate === "object" && raw.gate !== null && !Array.isArray(raw.gate)
    ? raw.gate as Record<string, FrontmatterValue>
    : {};
  const triggers = stringArray(raw.triggers)?.filter((item): item is EvolutionPolicy["triggers"][number] =>
    item === "explicit-feedback" || item === "classified-failure" || item === "quick-rerun"
  ) ?? DEFAULT_EVOLUTION_POLICY.triggers;
  const apply = raw.apply === "automatic" || modeValue === "apply" ? "automatic" : "review";

  return {
    ...DEFAULT_EVOLUTION_POLICY,
    mode: modeValue as EvolutionMode,
    triggers,
    engine: typeof maintainer.engine === "string" ? maintainer.engine : undefined,
    model: typeof maintainer.model === "string" ? maintainer.model : undefined,
    isolated: maintainer.isolated !== false,
    timeoutMs: numberFrom(maintainer["timeout-ms"], DEFAULT_EVOLUTION_POLICY.timeoutMs),
    maxInvocations: numberFrom(budget["max-invocations"], DEFAULT_EVOLUTION_POLICY.maxInvocations),
    maxPerDay: numberFrom(budget["max-per-day"], DEFAULT_EVOLUTION_POLICY.maxPerDay),
    cooldownMs: numberFrom(budget["cooldown-ms"], DEFAULT_EVOLUTION_POLICY.cooldownMs),
    requireFeedbackEval: gate["require-feedback-eval"] !== false,
    allowCapabilityDelta: gate["allow-capability-delta"] === true,
    repetitions: Math.max(1, Math.floor(numberFrom(gate.repetitions, DEFAULT_EVOLUTION_POLICY.repetitions))),
    apply,
  };
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function canonicalFlowPath(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function findRepositoryRoot(startPath: string): string | undefined {
  let current = existsSync(startPath) ? canonicalFlowPath(startPath) : resolve(startPath);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function normalizedRemote(root: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "-C", root, "config", "--get", "remote.origin.url"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().trim()
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "")
      .toLowerCase();
  } catch {
    return undefined;
  }
}

export interface FlowIdentity {
  id: string;
  path: string;
  repository?: string;
  relativePath: string;
}

export function identifyFlow(path: string): FlowIdentity {
  const canonical = canonicalFlowPath(path);
  let embeddedId: string | undefined;
  if (existsSync(canonical)) {
    try {
      const prefix = splitFlowDocument(readFileSync(canonical, "utf8")).prefix;
      embeddedId = prefix.match(/^_flow_id:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/m)?.[1];
    } catch {}
  }
  const root = findRepositoryRoot(canonical);
  const repository = root ? normalizedRemote(root) ?? canonicalFlowPath(root) : undefined;
  const relativePath = root ? relative(root, canonical).split(sep).join("/") : canonical;
  const identity = `${repository ?? "file"}:${relativePath}`;
  return { id: embeddedId ?? `flow_${sha256(identity).slice(0, 20)}`, path: canonical, repository, relativePath };
}

export interface FlowDocument {
  prefix: string;
  body: string;
  lineEnding: "\n" | "\r\n";
  hadTrailingNewline: boolean;
}

/** Split a flow without normalizing its BOM, shebang, frontmatter, or separator bytes. */
export function splitFlowDocument(content: string): FlowDocument {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  let offset = content.startsWith("\uFEFF") ? 1 : 0;
  if (content.slice(offset).startsWith("#!")) {
    const end = content.indexOf("\n", offset);
    offset = end === -1 ? content.length : end + 1;
  }

  const remaining = content.slice(offset);
  if (/^---(?:\r?\n)/.test(remaining)) {
    const closing = /^---[ \t]*\r?$/gm;
    closing.lastIndex = remaining.indexOf("\n") + 1;
    const match = closing.exec(remaining);
    if (match) {
      let bodyStart = offset + match.index + match[0].length;
      if (content.slice(bodyStart, bodyStart + 2) === "\r\n") bodyStart += 2;
      else if (content[bodyStart] === "\n") bodyStart += 1;
      while (content.slice(bodyStart, bodyStart + 2) === "\r\n" || content[bodyStart] === "\n") {
        bodyStart += content.slice(bodyStart, bodyStart + 2) === "\r\n" ? 2 : 1;
      }
      return {
        prefix: content.slice(0, bodyStart),
        body: content.slice(bodyStart),
        lineEnding,
        hadTrailingNewline: content.endsWith("\n"),
      };
    }
  }

  return {
    prefix: content.slice(0, offset),
    body: content.slice(offset),
    lineEnding,
    hadTrailingNewline: content.endsWith("\n"),
  };
}

export function replaceFlowBody(original: string, nextBody: string): string {
  const doc = splitFlowDocument(original);
  const normalized = nextBody.replace(/\r?\n/g, doc.lineEnding).replace(/[\t ]+$/gm, "").replace(/(?:\r?\n)+$/, "");
  const proposal = `${doc.prefix}${normalized}${doc.hadTrailingNewline ? doc.lineEnding : ""}`;
  const parsed = parseRawFrontmatter(proposal);
  if (parsed.unclosedFrontmatter || splitFlowDocument(proposal).prefix !== doc.prefix ||
      !isDeepStrictEqual(parsed.frontmatter, parseRawFrontmatter(original).frontmatter)) {
    throw new Error("Body-only evolution cannot add or alter a shebang or frontmatter");
  }
  return proposal;
}

/** Give newly created flows a stable identity that survives rename and clone. */
export function ensureFlowIdentity(content: string, id = `flow_${randomUUID().replaceAll("-", "")}`): string {
  const document = splitFlowDocument(content);
  if (/^_flow_id:[ \t]*[A-Za-z0-9_-]+[ \t]*$/m.test(document.prefix)) return content;
  const lineEnding = document.lineEnding;
  let offset = content.startsWith("\uFEFF") ? 1 : 0;
  if (content.slice(offset).startsWith("#!")) {
    const end = content.indexOf("\n", offset);
    offset = end === -1 ? content.length : end + 1;
  }
  if (/^---(?:\r?\n)/.test(content.slice(offset))) {
    const firstLineEnd = content.indexOf("\n", offset);
    const insertion = firstLineEnd === -1 ? content.length : firstLineEnd + 1;
    return `${content.slice(0, insertion)}_flow_id: ${id}${lineEnding}${content.slice(insertion)}`;
  }
  return `${content.slice(0, offset)}---${lineEnding}_flow_id: ${id}${lineEnding}---${lineEnding}${lineEnding}${content.slice(offset)}`;
}

export interface CapabilityManifest {
  entries: string[];
}

function capabilityEntry(action: ReturnType<typeof parseImports>[number]): string {
  switch (action.type) {
    case "command": return `command:${action.command.trim()}`;
    case "executable_code_fence": return `executable:${action.shebang}:${sha256(action.code)}`;
    case "url": return `url:${action.url}`;
    case "provider": return `provider:${action.provider}:${action.argument ?? ""}`;
    case "glob": return `glob:${action.pattern}`;
    case "symbol": return `symbol:${action.path}#${action.symbol}`;
    case "file": {
      const scope = isAbsolute(action.path) ? "absolute" : action.path.split(/[\\/]/).includes("..") ? "parent" : "local";
      const nested = /\.md(?:own)?$/i.test(action.path) ? ":flow" : "";
      return `file:${scope}:${action.path}${nested}`;
    }
  }
}

export function capabilityManifest(content: string): CapabilityManifest {
  const body = splitFlowDocument(content).body;
  return { entries: [...new Set(parseImports(body).map(capabilityEntry))].sort() };
}

export interface CapabilityDiff {
  added: string[];
  removed: string[];
  safe: boolean;
}

export function diffCapabilities(current: CapabilityManifest, proposal: CapabilityManifest): CapabilityDiff {
  const before = new Set(current.entries);
  const after = new Set(proposal.entries);
  const added = proposal.entries.filter((entry) => !before.has(entry));
  const removed = current.entries.filter((entry) => !after.has(entry));
  return { added, removed, safe: added.length === 0 };
}

export function redactedFrontmatter(frontmatter: AgentFrontmatter): Record<string, FrontmatterValue> {
  const hidden = /(?:token|secret|password|auth|key|credential|env)/i;
  return Object.fromEntries(Object.entries(frontmatter).map(([key, value]) => [key, hidden.test(key) ? "[redacted]" : value]));
}
