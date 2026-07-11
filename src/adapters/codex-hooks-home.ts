/**
 * Prepared CODEX_HOME for hooked codex runs.
 *
 * mdflow injects flow hooks with `--dangerously-bypass-hook-trust`, and that
 * flag is invocation-wide: against the user's real `~/.codex` it would also
 * un-gate ambient, not-yet-reviewed hooks from `$CODEX_HOME/hooks.json`
 * (verified: hook sources AGGREGATE and no flag disables the ambient file —
 * docs/codex-hooks-probe-2026-07.md). Hooked runs therefore execute against
 * a prepared home that contains NO ambient hooks, so the bypass can only
 * ever authorize the hooks mdflow itself injected:
 *
 *   ~/.mdflow/codex-hooks-home/
 *     auth.json    → symlink to the real home's auth.json (login reuse)
 *     config.toml  → only the `[projects."…"] trust_level` blocks copied
 *                    from the real config (workspace trust parity)
 *     hooks.json   → guaranteed ABSENT (removed if anything created one)
 *
 * The user's real credential and config files are never written. Pattern
 * matches the pi adapter's bridged auth dir (see pi-auth.ts).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * CODEX_HOME as it was when mdflow started. Captured once at import: a run
 * merges the prepared home into the process env (extractEnvVars mutates it),
 * so reading process.env.CODEX_HOME later in the SAME process would make a
 * second hooked run treat the prepared home as its own source — and the
 * refresh would then unlink its own auth symlink with nothing to relink to.
 */
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

export function sourceCodexHome(codexHomeEnv: string | undefined = ORIGINAL_CODEX_HOME): string {
  return codexHomeEnv && codexHomeEnv.trim() !== ""
    ? codexHomeEnv
    : join(homedir(), ".codex");
}

export function preparedCodexHooksHome(): string {
  return join(homedir(), ".mdflow", "codex-hooks-home");
}

/**
 * Extract only the `[projects."<path>"] trust_level = "…"` blocks from a
 * codex config.toml. Everything else (MCP servers, profiles, model config,
 * hook trust state) is deliberately dropped — the prepared home must carry
 * workspace trust and nothing more.
 */
export function trustedProjectsConfig(configToml: string): string {
  const blocks: string[] = [];
  let currentHeader: string | undefined;
  let currentBody: string[] = [];

  const flush = () => {
    if (!currentHeader) return;
    const trustMatch = currentBody
      .join("\n")
      .match(/^trust_level\s*=\s*"(trusted|untrusted)"\s*$/m);
    if (trustMatch) {
      blocks.push(`${currentHeader}\ntrust_level = "${trustMatch[1]}"`);
    }
  };

  for (const line of configToml.split(/\r?\n/)) {
    const projectHeader = line.match(/^\[projects\."((?:\\.|[^"\\])*)"\]\s*$/);
    if (projectHeader) {
      flush();
      currentHeader = `[projects."${projectHeader[1]}"]`;
      currentBody = [];
      continue;
    }
    if (/^\[/.test(line)) {
      flush();
      currentHeader = undefined;
      currentBody = [];
      continue;
    }
    if (currentHeader) currentBody.push(line);
  }
  flush();

  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/**
 * Build (or refresh) the prepared home and return its path. Idempotent and
 * cheap: called once per hooked run. Refreshes the trust copy every call so
 * newly trusted projects work immediately; re-points the auth symlink if the
 * source home moved; deletes any hooks.json that appeared.
 */
export function prepareCodexHooksHome(
  opts: { sourceHome?: string; preparedHome?: string } = {}
): string {
  const source = opts.sourceHome ?? sourceCodexHome();
  const prepared = opts.preparedHome ?? preparedCodexHooksHome();
  mkdirSync(prepared, { recursive: true });

  // Ambient hooks must never exist here — that is the whole point.
  const hooksJson = join(prepared, "hooks.json");
  if (existsSync(hooksJson)) rmSync(hooksJson, { force: true });

  // Self-reference guard: if the source IS the prepared home (a stale env,
  // or a caller passing the prepared path), refreshing auth/trust from it
  // would be a no-op at best and could destroy the auth link at worst.
  // Keep whatever the home already has.
  let selfReferential = false;
  try {
    selfReferential = realpathSync(source) === realpathSync(prepared);
  } catch {
    selfReferential = resolve(source) === resolve(prepared);
  }
  if (selfReferential) return prepared;

  const authSrc = join(source, "auth.json");
  const authDst = join(prepared, "auth.json");
  // A REGULAR auth.json in the prepared home is kept as-is: codex may
  // rotate credentials by atomically replacing the file, and that rotated
  // token is fresher than the source copy. Only (re)point symlinks.
  let dstIsLink = false;
  try {
    dstIsLink = lstatSync(authDst).isSymbolicLink();
  } catch {}
  if (dstIsLink) unlinkSync(authDst);
  if (existsSync(authSrc) && !existsSync(authDst)) {
    symlinkSync(authSrc, authDst);
  }

  const configSrc = join(source, "config.toml");
  const trusted = existsSync(configSrc)
    ? trustedProjectsConfig(readFileSync(configSrc, "utf8"))
    : "";
  writeFileSync(join(prepared, "config.toml"), trusted, "utf8");

  return prepared;
}
