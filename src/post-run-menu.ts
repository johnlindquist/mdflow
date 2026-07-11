/**
 * Post-Run Action Menu
 *
 * Shows a transient menu after command execution with options:
 * - Copy output to clipboard
 * - Save output to file
 * - Run suggested command (extracted from code blocks)
 * - Exit (default, auto-selected after timeout)
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
  type KeypressEvent,
} from "@inquirer/core";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  detectJsonOutput,
  detectUnifiedDiff,
  extractStructured,
  sinkApplyPatch,
} from "./output";

// Extended key event type (runtime has more properties than type declares)
interface ExtendedKeyEvent extends KeypressEvent {
  sequence?: string;
  meta?: boolean;
  shift?: boolean;
}

/** Result from the post-run menu */
export interface PostRunMenuResult {
  action:
  | "copy"
  | "save"
  | "copy-json"
  | "save-json"
  | "apply-patch"
  | "run-command"
  | "feedback"
  | "exit";
  /** For save action: the filename to save to */
  filename?: string;
  /** For run-command action: the command to run */
  command?: string;
}

/** Extracted command from output */
export interface ExtractedCommand {
  command: string;
  language: string;
}

/**
 * Extract executable commands from markdown code blocks
 * Looks for ```bash, ```sh, ```shell, or ```zsh blocks
 */
export function extractCommands(output: string): ExtractedCommand[] {
  const commands: ExtractedCommand[] = [];

  // Match code blocks with shell-like languages
  const codeBlockRegex = /```(bash|sh|shell|zsh|console)\n([\s\S]*?)```/gi;
  let match;

  while ((match = codeBlockRegex.exec(output)) !== null) {
    const language = match[1]?.toLowerCase() ?? "bash";
    const content = match[2]?.trim() ?? "";

    // Skip empty blocks
    if (!content) continue;

    // For console blocks, extract just the commands (lines starting with $ or without output markers)
    if (language === "console") {
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("$ ")) {
          commands.push({ command: trimmed.slice(2), language: "bash" });
        }
      }
    } else {
      // Split multi-line commands and add each as a separate entry
      const lines = content.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
      if (lines.length === 1) {
        commands.push({ command: lines[0]!, language });
      } else if (lines.length > 1) {
        // For multi-line, add the whole block as one command
        commands.push({ command: content, language });
      }
    }
  }

  return commands;
}

/**
 * Copy text to clipboard using platform-native commands
 */
export function copyToClipboard(text: string): boolean {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      // macOS
      const result = spawnSync("pbcopy", [], {
        input: text,
        encoding: "utf-8",
      });
      return result.status === 0;
    } else if (platform === "linux") {
      // Linux - try xclip first, then xsel
      let result = spawnSync("xclip", ["-selection", "clipboard"], {
        input: text,
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        result = spawnSync("xsel", ["--clipboard", "--input"], {
          input: text,
          encoding: "utf-8",
        });
      }
      return result.status === 0;
    } else if (platform === "win32") {
      // Windows
      const result = spawnSync("clip", [], {
        input: text,
        encoding: "utf-8",
        shell: true,
      });
      return result.status === 0;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Save text to a file
 */
export function saveToFile(text: string, filename: string): boolean {
  try {
    writeFileSync(filename, text, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Menu option */
interface MenuOption {
  key: string;
  label: string;
  action: PostRunMenuResult["action"];
  disabled?: boolean;
  command?: string;
}

interface PostRunMenuConfig {
  output: string;
  extractedCommands: ExtractedCommand[];
  hasJson: boolean;
  hasPatch: boolean;
}

/**
 * Interactive post-run action menu
 */
export const postRunMenu = createPrompt<PostRunMenuResult, PostRunMenuConfig>(
  (config, done) => {
    const { extractedCommands, hasJson, hasPatch } = config;
    const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });

    const [cursor, setCursor] = useState(0);
    const [inputMode, setInputMode] = useState<"menu" | "filename" | "command-select">("menu");
    const [saveTarget, setSaveTarget] = useState<"output" | "json">("output");
    const [filename, setFilename] = useState("");
    const [commandCursor, setCommandCursor] = useState(0);

    // Build menu options
    const options: MenuOption[] = [
      { key: "c", label: "Copy output to clipboard", action: "copy" },
      { key: "s", label: "Save output to file...", action: "save" },
      { key: "f", label: "Report this result as feedback...", action: "feedback" },
    ];

    if (hasJson) {
      options.push(
        { key: "j", label: "Copy JSON to clipboard", action: "copy-json" },
        { key: "n", label: "Save JSON to file...", action: "save-json" },
      );
    }

    if (hasPatch) {
      options.push({ key: "a", label: "Apply patch", action: "apply-patch" });
    }

    if (extractedCommands.length > 0) {
      options.push({
        key: "r",
        label: `Run suggested command (${extractedCommands.length} found)`,
        action: "run-command",
      });
    }

    options.push({ key: "q", label: "Exit", action: "exit" });

    useKeypress((key, readline) => {
      const extKey = key as ExtendedKeyEvent;

      if (key.name === "tab") {
        // readline inserts a literal tab before keypress handlers run. Keep it
        // out of filename buffers and use Tab as wraparound navigation in the
        // two choice screens instead.
        readline.clearLine(0);
        if (inputMode === "filename") return;

        const direction = extKey.shift || extKey.sequence === "\x1b[Z" ? -1 : 1;
        if (inputMode === "command-select") {
          setCommandCursor(
            (commandCursor + direction + extractedCommands.length) % extractedCommands.length,
          );
        } else {
          setCursor((cursor + direction + options.length) % options.length);
        }
        return;
      }

      if (inputMode === "filename") {
        if (isEnterKey(key)) {
          if (filename.trim()) {
            const action = saveTarget === "json" ? "save-json" : "save";
            done({ action, filename: filename.trim() });
          } else {
            setInputMode("menu");
          }
          return;
        }
        if (key.name === "escape") {
          setInputMode("menu");
          setSaveTarget("output");
          setFilename("");
          return;
        }
        if (key.name === "backspace") {
          setFilename(filename.slice(0, -1));
          return;
        }
        // Add character
        if (extKey.sequence && extKey.sequence.length === 1 && !extKey.ctrl && !extKey.meta) {
          setFilename(filename + extKey.sequence);
        }
        return;
      }

      if (inputMode === "command-select") {
        if (isEnterKey(key)) {
          const cmd = extractedCommands[commandCursor];
          if (cmd) {
            done({ action: "run-command", command: cmd.command });
          }
          return;
        }
        if (key.name === "escape") {
          setInputMode("menu");
          return;
        }
        if (isUpKey(key)) {
          setCommandCursor(Math.max(0, commandCursor - 1));
          return;
        }
        if (isDownKey(key)) {
          setCommandCursor(Math.min(extractedCommands.length - 1, commandCursor + 1));
          return;
        }
        return;
      }

      // Menu mode
      if (isEnterKey(key)) {
        const option = options[cursor];
        if (option) {
          if (option.action === "save") {
            setSaveTarget("output");
            setInputMode("filename");
            return;
          }
          if (option.action === "save-json") {
            setSaveTarget("json");
            setInputMode("filename");
            return;
          }
          if (option.action === "run-command" && extractedCommands.length > 1) {
            setInputMode("command-select");
            return;
          }
          if (option.action === "run-command" && extractedCommands.length === 1) {
            done({ action: "run-command", command: extractedCommands[0]!.command });
            return;
          }
          done({ action: option.action });
        }
        return;
      }

      if (key.name === "escape" || key.name === "q") {
        done({ action: "exit" });
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
      if (key.name === "c") {
        done({ action: "copy" });
        return;
      }
      if (key.name === "s") {
        setSaveTarget("output");
        setInputMode("filename");
        return;
      }
      if (key.name === "j" && hasJson) {
        done({ action: "copy-json" });
        return;
      }
      if (key.name === "n" && hasJson) {
        setSaveTarget("json");
        setInputMode("filename");
        return;
      }
      if (key.name === "a" && hasPatch) {
        done({ action: "apply-patch" });
        return;
      }
      if (key.name === "r" && extractedCommands.length > 0) {
        if (extractedCommands.length === 1) {
          done({ action: "run-command", command: extractedCommands[0]!.command });
        } else {
          setInputMode("command-select");
        }
        return;
      }
    });

    // Render
    const lines: string[] = [];

    if (inputMode === "filename") {
      const label = saveTarget === "json" ? "Save JSON to file:" : "Save output to file:";
      lines.push(`${prefix} ${label}`);
      lines.push(`  Filename: ${filename}_`);
      lines.push("");
      lines.push(`\x1b[90mPress Enter to save, Escape to cancel\x1b[0m`);
      return lines.join("\n");
    }

    if (inputMode === "command-select") {
      lines.push(`${prefix} Select command to run:`);
      lines.push("");

      for (let i = 0; i < extractedCommands.length; i++) {
        const cmd = extractedCommands[i]!;
        const isSelected = i === commandCursor;
        const prefix = isSelected ? "\x1b[7m" : "";
        const suffix = isSelected ? "\x1b[27m" : "";
        const truncated = cmd.command.length > 60
          ? cmd.command.slice(0, 57) + "..."
          : cmd.command;
        lines.push(`  ${prefix}${truncated}${suffix}`);
      }

      lines.push("");
      lines.push(`\x1b[90mUse arrows or Tab/Shift+Tab, Enter to run, Escape to go back\x1b[0m`);
      return lines.join("\n");
    }

    // Menu mode
    lines.push("");
    lines.push(`${prefix} \x1b[1mCommand completed.\x1b[0m What would you like to do?`);
    lines.push("");

    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const isSelected = i === cursor;
      const prefix = isSelected ? "\x1b[7m" : "";
      const suffix = isSelected ? "\x1b[27m" : "";
      const keyHint = `\x1b[36m[${opt.key}]\x1b[0m`;
      lines.push(`  ${prefix}${keyHint} ${opt.label}${suffix}`);
    }

    lines.push("");
    lines.push(`\x1b[90mUse arrows or Tab/Shift+Tab, Enter to select, or press shortcut key\x1b[0m`);

    return lines.join("\n");
  }
);

/**
 * Show the post-run action menu and handle the selected action
 *
 * @param output - The captured command output
 * @returns The result of the selected action, or undefined if exited
 */
export async function showPostRunMenu(
  output: string
): Promise<PostRunMenuResult | undefined> {
  // Don't show menu if no output or not a TTY (stdin AND stdout)
  // Checking stdout enables piping: foo.md | bar.md
  if (!output.trim() || !process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const extractedCommands = extractCommands(output);
  const hasJson = detectJsonOutput(output);
  const hasPatch = detectUnifiedDiff(output);

  try {
    const result = await postRunMenu({
      output,
      extractedCommands,
      hasJson,
      hasPatch,
    });

    return result;
  } catch {
    // User cancelled
    return undefined;
  }
}

/**
 * Execute the post-run menu action
 *
 * @param result - The menu result
 * @param output - The command output
 * @returns True if action was successful
 */
export async function executePostRunAction(
  result: PostRunMenuResult,
  output: string
): Promise<boolean> {
  switch (result.action) {
    case "feedback":
      // The caller owns flow identity and prompts for the feedback message.
      return false;
    case "copy": {
      const copied = copyToClipboard(output);
      if (copied) {
        console.log("\x1b[32mOutput copied to clipboard.\x1b[0m");
      } else {
        console.error("\x1b[31mFailed to copy to clipboard.\x1b[0m");
      }
      return copied;
    }

    case "save":
      if (result.filename) {
        const saved = saveToFile(output, result.filename);
        if (saved) {
          console.log(`\x1b[32mOutput saved to ${result.filename}\x1b[0m`);
        } else {
          console.error(`\x1b[31mFailed to save to ${result.filename}\x1b[0m`);
        }
        return saved;
      }
      return false;

    case "copy-json": {
      try {
        const parsed = extractStructured(output, "json");
        const json = JSON.stringify(parsed, null, 2);
        const copied = copyToClipboard(json);

        if (copied) {
          console.log("\x1b[32mJSON copied to clipboard.\x1b[0m");
        } else {
          console.error("\x1b[31mFailed to copy JSON to clipboard.\x1b[0m");
        }

        return copied;
      } catch {
        console.error("\x1b[31mFailed to extract JSON from output.\x1b[0m");
        return false;
      }
    }

    case "save-json":
      if (result.filename) {
        try {
          const parsed = extractStructured(output, "json");
          const json = `${JSON.stringify(parsed, null, 2)}\n`;
          const saved = saveToFile(json, result.filename);
          if (saved) {
            console.log(`\x1b[32mJSON saved to ${result.filename}\x1b[0m`);
          } else {
            console.error(`\x1b[31mFailed to save JSON to ${result.filename}\x1b[0m`);
          }
          return saved;
        } catch {
          console.error("\x1b[31mFailed to extract JSON from output.\x1b[0m");
          return false;
        }
      }
      return false;

    case "apply-patch":
      try {
        const patch = extractStructured(output, "patch");
        if (typeof patch !== "string") {
          console.error("\x1b[31mExtracted patch output was not text.\x1b[0m");
          return false;
        }

        sinkApplyPatch(patch);
        console.log("\x1b[32mPatch applied with git apply.\x1b[0m");
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown patch apply error";
        console.error(`\x1b[31mFailed to apply patch: ${message}\x1b[0m`);
        return false;
      }

    case "run-command":
      if (result.command) {
        console.log(`\x1b[36mRunning: ${result.command}\x1b[0m\n`);
        const cmdResult = spawnSync(result.command, [], {
          shell: true,
          stdio: "inherit",
        });
        return cmdResult.status === 0;
      }
      return false;

    case "exit":
    default:
      return true;
  }
}
