/**
 * Failure Menu - Auto-Heal Retry Loop
 *
 * Shows a menu when a command fails with non-zero exit code:
 * - [R]etry: Re-run the same command with same arguments
 * - [F]ix with AI: Feed stderr back into context and ask model to fix
 * - [Q]uit: Exit with the original error code
 *
 * Only shown in interactive mode (not print mode).
 */

import {
  createPrompt,
  useState,
  useKeypress,
  isEnterKey,
  isUpKey,
  isDownKey,
  usePrefix,
  makeTheme,
} from "@inquirer/core";

/** Result from the failure menu */
export interface FailureMenuResult {
  action: "retry" | "fix" | "quit";
}

/** Menu option */
interface MenuOption {
  key: string;
  label: string;
  action: FailureMenuResult["action"];
}

interface FailureMenuConfig {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Build a follow-up prompt that includes error context
 * to help the AI fix its mistake
 */
export function buildFixPrompt(
  originalPrompt: string,
  stderr: string,
  stdout: string,
  exitCode: number
): string {
  const parts: string[] = [];

  parts.push("The previous command failed. Please analyze the error and fix your approach.\n");
  parts.push(`Exit code: ${exitCode}\n`);

  if (stderr.trim()) {
    parts.push("\n--- STDERR ---");
    parts.push(stderr.trim());
    parts.push("--- END STDERR ---\n");
  }

  if (stdout.trim()) {
    parts.push("\n--- STDOUT (partial) ---");
    // Limit stdout to avoid context explosion
    const truncatedStdout = stdout.length > 2000
      ? stdout.slice(-2000) + "\n... (truncated)"
      : stdout;
    parts.push(truncatedStdout.trim());
    parts.push("--- END STDOUT ---\n");
  }

  parts.push("\nPlease try again, fixing the issue described above.");
  parts.push("\nOriginal request:");
  parts.push(originalPrompt);

  return parts.join("\n");
}

/**
 * Interactive failure menu prompt
 */
export const failureMenu = createPrompt<FailureMenuResult, FailureMenuConfig>(
  (config, done) => {
    const { exitCode, stderr } = config;
    const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });

    const [cursor, setCursor] = useState(0);

    // Build menu options
    const options: MenuOption[] = [
      { key: "r", label: "Retry - run the same command again", action: "retry" },
      { key: "f", label: "Fix with AI - feed error back and retry", action: "fix" },
      { key: "q", label: "Quit - exit with error code", action: "quit" },
    ];

    useKeypress((key) => {
      if (isEnterKey(key)) {
        const option = options[cursor];
        if (option) {
          done({ action: option.action });
        }
        return;
      }

      if (key.name === "escape" || key.name === "q") {
        done({ action: "quit" });
        return;
      }

      if (isUpKey(key)) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }

      if (isDownKey(key)) {
        setCursor(Math.min(options.length - 1, cursor + 1));
        return;
      }

      // Shortcut keys
      if (key.name === "r") {
        done({ action: "retry" });
        return;
      }
      if (key.name === "f") {
        done({ action: "fix" });
        return;
      }
    });

    // Render
    const lines: string[] = [];

    lines.push("");
    lines.push(`${prefix} \x1b[31m\x1b[1mCommand failed (exit code ${exitCode}).\x1b[0m What would you like to do?`);

    // Show truncated stderr preview if available
    if (stderr.trim()) {
      const preview = stderr.trim().split("\n").slice(0, 3).join("\n");
      const truncated = stderr.trim().split("\n").length > 3 ? "\n  ..." : "";
      lines.push("");
      lines.push(`\x1b[90m  ${preview.replace(/\n/g, "\n  ")}${truncated}\x1b[0m`);
    }

    lines.push("");

    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const isSelected = i === cursor;
      const highlight = isSelected ? "\x1b[7m" : "";
      const reset = isSelected ? "\x1b[27m" : "";
      const keyHint = `\x1b[36m[${opt.key.toUpperCase()}]\x1b[0m`;
      lines.push(`  ${highlight}${keyHint} ${opt.label}${reset}`);
    }

    lines.push("");
    lines.push(`\x1b[90mUse arrow keys to navigate, Enter to select, or press shortcut key\x1b[0m`);

    return lines.join("\n");
  }
);

/**
 * Show the failure menu and return the selected action
 *
 * @param exitCode - The exit code from the failed command
 * @param stderr - Captured stderr from the command
 * @param stdout - Captured stdout from the command
 * @returns The selected action, or "quit" if cancelled
 */
export async function showFailureMenu(
  exitCode: number,
  stderr: string,
  stdout: string
): Promise<FailureMenuResult> {
  // Don't show menu if not a TTY
  if (!process.stdin.isTTY) {
    return { action: "quit" };
  }

  try {
    const result = await failureMenu({
      exitCode,
      stderr,
      stdout,
    });

    return result;
  } catch {
    // User cancelled (Ctrl+C) or other error
    return { action: "quit" };
  }
}
