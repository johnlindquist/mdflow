import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareCodexHooksHome,
  trustedProjectsConfig,
} from "./codex-hooks-home";

let root: string;
let source: string;
let prepared: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mdflow-codex-home-"));
  source = join(root, "codex");
  prepared = join(root, "prepared");
  mkdirSync(source, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("trustedProjectsConfig", () => {
  it("keeps only project trust blocks and drops everything else", () => {
    const config = [
      'model = "gpt-5"',
      "[mcp_servers.evil]",
      'command = "curl"',
      '[projects."/Users/u/dev/app"]',
      'trust_level = "trusted"',
      "[hooks.state.\"/Users/u/.codex/hooks.json:stop:0:0\"]",
      'trusted_hash = "sha256:abc"',
      '[projects."/Users/u/dev/other"]',
      'trust_level = "untrusted"',
    ].join("\n");
    expect(trustedProjectsConfig(config)).toBe(
      '[projects."/Users/u/dev/app"]\ntrust_level = "trusted"\n\n' +
        '[projects."/Users/u/dev/other"]\ntrust_level = "untrusted"\n'
    );
  });

  it("returns empty for configs with no trusted projects", () => {
    expect(trustedProjectsConfig('model = "gpt-5"\n')).toBe("");
  });
});

describe("prepareCodexHooksHome", () => {
  it("symlinks auth, copies only trust blocks, and guarantees no hooks.json", () => {
    writeFileSync(join(source, "auth.json"), '{"token":"t"}');
    writeFileSync(
      join(source, "config.toml"),
      '[projects."/p"]\ntrust_level = "trusted"\n[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:zzz"\n'
    );
    writeFileSync(join(source, "hooks.json"), '{"hooks":{}}');

    const dir = prepareCodexHooksHome({ sourceHome: source, preparedHome: prepared });

    expect(dir).toBe(prepared);
    expect(lstatSync(join(prepared, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(prepared, "auth.json"))).toBe(join(source, "auth.json"));
    const config = readFileSync(join(prepared, "config.toml"), "utf8");
    expect(config).toContain('trust_level = "trusted"');
    expect(config).not.toContain("hooks.state");
    // The source's ambient hooks.json must never be carried over.
    expect(existsSync(join(prepared, "hooks.json"))).toBe(false);
  });

  it("removes a hooks.json that appeared in the prepared home", () => {
    mkdirSync(prepared, { recursive: true });
    writeFileSync(join(prepared, "hooks.json"), '{"hooks":{}}');
    prepareCodexHooksHome({ sourceHome: source, preparedHome: prepared });
    expect(existsSync(join(prepared, "hooks.json"))).toBe(false);
  });

  it("refreshes trust on every call and tolerates a missing source home", () => {
    prepareCodexHooksHome({ sourceHome: join(root, "nope"), preparedHome: prepared });
    expect(readFileSync(join(prepared, "config.toml"), "utf8")).toBe("");
    writeFileSync(
      join(source, "config.toml"),
      '[projects."/new"]\ntrust_level = "trusted"\n'
    );
    prepareCodexHooksHome({ sourceHome: source, preparedHome: prepared });
    expect(readFileSync(join(prepared, "config.toml"), "utf8")).toContain('"/new"');
  });
});

describe("re-audit regressions", () => {
  it("self-referential source (stale env) never destroys the prepared home's auth", () => {
    mkdirSync(prepared, { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"token":"real"}');
    prepareCodexHooksHome({ sourceHome: source, preparedHome: prepared });
    expect(lstatSync(join(prepared, "auth.json")).isSymbolicLink()).toBe(true);
    // Second call in the same process where the source now points AT the
    // prepared home (env leaked from the first run).
    prepareCodexHooksHome({ sourceHome: prepared, preparedHome: prepared });
    expect(existsSync(join(prepared, "auth.json"))).toBe(true);
    expect(readFileSync(join(prepared, "auth.json"), "utf8")).toBe('{"token":"real"}');
  });

  it("keeps a rotated regular auth.json instead of clobbering it with a symlink", () => {
    mkdirSync(prepared, { recursive: true });
    writeFileSync(join(source, "auth.json"), '{"token":"old"}');
    writeFileSync(join(prepared, "auth.json"), '{"token":"rotated"}');
    prepareCodexHooksHome({ sourceHome: source, preparedHome: prepared });
    expect(lstatSync(join(prepared, "auth.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(prepared, "auth.json"), "utf8")).toBe('{"token":"rotated"}');
  });
});
