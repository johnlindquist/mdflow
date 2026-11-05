/** Test discovery imports modules that capture homedir() at module load. Set
 * private state paths BEFORE discovery, including for plain bun test <file>. */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mdflow-test-state-"));
for (const key of Object.keys(process.env)) {
  if (/^(MDFLOW_|MA_|PI_CODING_AGENT_DIR$|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/.test(key)) delete process.env[key];
}
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), MDFLOW_NO_TTY_PROMPT: "1" });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
