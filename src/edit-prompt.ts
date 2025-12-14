/**
 * Edit-before-execute functionality
 *
 * Opens the fully resolved prompt in the user's $EDITOR before execution,
 * allowing last-minute tweaks to the prompt.
 */

import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";

/**
 * Result of the edit-before-execute flow
 */
export interface EditPromptResult {
  /** The modified prompt content, or null if cancelled */
  prompt: string | null;
  /** Whether the user confirmed execution */
  confirmed: boolean;
}

/**
 * Get the editor command to use
 * Priority: $EDITOR > $VISUAL > vim > nano
 */
export function getEditor(): string {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (editor) return editor;

  // Fallback to common editors
  // Check if vim exists
  if (Bun.which("vim")) return "vim";
  if (Bun.which("nano")) return "nano";
  if (Bun.which("vi")) return "vi";

  // Last resort
  return "vim";
}

/**
 * Generate a unique temp file path for editing
 */
export function getTempFilePath(prefix: string = "mdflow-edit"): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return join(tmpdir(), `${prefix}-${timestamp}-${random}.md`);
}

/**
 * Open a file in the user's editor and wait for it to close
 */
export async function openInEditor(filePath: string): Promise<boolean> {
  const editor = getEditor();

  // Parse editor command (might include args like "code --wait")
  const parts = editor.split(/\s+/);
  const cmd = parts[0];
  const args = [...parts.slice(1), filePath];

  if (!cmd) {
    console.error("No editor command found");
    return false;
  }

  const proc = Bun.spawn([cmd, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Prompt the user to confirm running the modified prompt
 */
export async function confirmExecution(
  promptFn?: () => Promise<string>
): Promise<boolean> {
  // If a custom prompt function is provided (for testing), use it
  if (promptFn) {
    const answer = await promptFn();
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  }

  // Use readline for simple y/N prompt
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Run this modified prompt? [y/N] ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Edit a prompt before execution
 *
 * 1. Writes the resolved prompt to a temp file with .md extension
 * 2. Opens the file in $EDITOR (or vim/nano as fallback)
 * 3. Waits for editor to close
 * 4. Reads the modified content
 * 5. Prompts user: "Run this modified prompt? [y/N]"
 * 6. Returns the modified prompt or null if cancelled
 *
 * @param prompt The resolved prompt to edit
 * @param options Options for the edit flow
 * @returns The modified prompt and confirmation status
 */
export async function editPrompt(
  prompt: string,
  options: {
    /** Custom confirm function for testing */
    confirmFn?: () => Promise<string>;
    /** Skip confirmation prompt (auto-confirm) */
    skipConfirm?: boolean;
  } = {}
): Promise<EditPromptResult> {
  const tempPath = getTempFilePath();

  try {
    // Write prompt to temp file
    await writeFile(tempPath, prompt, "utf-8");

    // Open in editor
    const editorSuccess = await openInEditor(tempPath);
    if (!editorSuccess) {
      console.error("Editor exited with non-zero status");
      return { prompt: null, confirmed: false };
    }

    // Read modified content
    const modifiedPrompt = await readFile(tempPath, "utf-8");

    // Confirm execution
    let confirmed: boolean;
    if (options.skipConfirm) {
      confirmed = true;
    } else {
      confirmed = await confirmExecution(options.confirmFn);
    }

    if (!confirmed) {
      console.log("Execution cancelled.");
      return { prompt: null, confirmed: false };
    }

    return { prompt: modifiedPrompt, confirmed: true };
  } finally {
    // Clean up temp file
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
