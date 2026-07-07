#!/usr/bin/env node
/**
 * npx-compatible launcher for mdflow.
 *
 * mdflow runs on Bun (the source uses Bun APIs directly), but `npx mdflow`
 * executes bins under Node. This launcher bridges the gap: find bun, exec the
 * real entry through it, and if bun is missing offer to install it (TTY) or
 * print the one-liner (non-TTY). It must stay plain Node ESM with zero
 * dependencies — it is the one file that runs before Bun exists.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "src", "index.ts");

function findBun() {
  const names = process.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const fallback = join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

async function offerBunInstall() {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  console.error("mdflow runs on Bun, which isn't on your PATH.");
  if (!interactive) {
    console.error("Install it and re-run:  npm install -g bun");
    console.error("               or:  curl -fsSL https://bun.sh/install | bash");
    return null;
  }

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Install bun now via `npm install -g bun`? (Y/n) ")).trim().toLowerCase();
  rl.close();
  if (answer === "n" || answer === "no") {
    console.error("OK. Install bun (https://bun.sh) and re-run mdflow.");
    return null;
  }

  const result = spawnSync("npm", ["install", "-g", "bun"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error("bun install failed. Install it manually (https://bun.sh) and re-run mdflow.");
    return null;
  }
  return findBun();
}

let bun = findBun();
if (!bun) {
  bun = await offerBunInstall();
  if (!bun) process.exit(1);
}

const run = spawnSync(bun, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
if (run.error) {
  console.error(`Failed to launch bun: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
