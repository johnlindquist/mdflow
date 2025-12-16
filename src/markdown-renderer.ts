/**
 * Rich terminal markdown rendering using marked + marked-terminal
 *
 * Provides syntax highlighting for code blocks and visual structure for headers
 * in LLM output. Supports streaming output by buffering until complete markdown
 * blocks are ready for rendering.
 */

import { Marked } from "marked";
// @ts-expect-error no types available
import { markedTerminal } from "marked-terminal";

// Lazily create marked instance to avoid initialization errors during module load
let _marked: Marked | null = null;

function getMarked(): Marked {
  if (!_marked) {
    _marked = new Marked();
    _marked.use(markedTerminal());
  }
  return _marked;
}

/**
 * Render markdown string to terminal-formatted output
 * Uses marked-terminal for syntax highlighting and visual structure
 *
 * @param markdown - Raw markdown string to render
 * @returns Terminal-formatted string with ANSI codes
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  try {
    const marked = getMarked();
    // marked.parse returns string synchronously with default options
    const result = marked.parse(markdown);
    // Remove trailing newlines that marked adds
    return typeof result === "string" ? result.trimEnd() : "";
  } catch {
    // On parse error, return raw markdown
    return markdown;
  }
}

/**
 * StreamingMarkdownRenderer - Buffers streaming output and renders complete blocks
 *
 * Since LLM output arrives in chunks, we need to buffer content and detect when
 * complete markdown blocks (code blocks, paragraphs, etc.) are ready to render.
 *
 * Strategy:
 * 1. Buffer incoming chunks
 * 2. Detect complete blocks (ended by double newline or end of code block)
 * 3. Render complete blocks immediately
 * 4. Keep incomplete content in buffer for next chunk
 */
export class StreamingMarkdownRenderer {
  private buffer: string = "";
  private inCodeBlock: boolean = false;
  private codeBlockDelimiter: string = "";
  private renderEnabled: boolean;

  constructor(options?: { enabled?: boolean }) {
    this.renderEnabled = options?.enabled ?? true;
  }

  /**
   * Process a chunk of streaming output
   * Returns rendered content that's ready for display
   *
   * @param chunk - New content to process
   * @returns Content ready to write to terminal (may be empty if buffering)
   */
  processChunk(chunk: string): string {
    if (!this.renderEnabled) {
      // Raw mode - pass through without rendering
      return chunk;
    }

    this.buffer += chunk;

    // Track code block state for proper rendering
    this.updateCodeBlockState(chunk);

    // If we're in a code block, wait for it to complete
    if (this.inCodeBlock) {
      return "";
    }

    // Look for complete blocks to render
    return this.flushCompleteBlocks();
  }

  /**
   * Flush any remaining content (call at end of stream)
   * @returns Final rendered content
   */
  flush(): string {
    if (!this.renderEnabled) {
      const remaining = this.buffer;
      this.buffer = "";
      return remaining;
    }

    if (!this.buffer.trim()) {
      this.buffer = "";
      return "";
    }

    const rendered = renderMarkdown(this.buffer);
    this.buffer = "";
    this.inCodeBlock = false;
    this.codeBlockDelimiter = "";
    return rendered;
  }

  /**
   * Reset the renderer state
   */
  reset(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    this.codeBlockDelimiter = "";
  }

  /**
   * Track whether we're inside a code block
   */
  private updateCodeBlockState(chunk: string): void {
    // Check for code block delimiters in the new chunk
    const lines = (this.buffer).split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for opening code fence
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!this.inCodeBlock) {
          // Opening a code block
          this.inCodeBlock = true;
          this.codeBlockDelimiter = fenceMatch[1]![0]!.repeat(fenceMatch[1]!.length);
        } else if (trimmed === this.codeBlockDelimiter || trimmed.startsWith(this.codeBlockDelimiter)) {
          // Closing the code block
          this.inCodeBlock = false;
          this.codeBlockDelimiter = "";
        }
      }
    }
  }

  /**
   * Extract and render complete blocks from buffer
   * Keeps incomplete content in buffer
   */
  private flushCompleteBlocks(): string {
    // Look for paragraph breaks (double newline)
    const paragraphBreak = this.buffer.lastIndexOf("\n\n");

    if (paragraphBreak === -1) {
      // No complete blocks yet
      return "";
    }

    // Extract complete content up to the last paragraph break
    const completeContent = this.buffer.slice(0, paragraphBreak + 2);
    this.buffer = this.buffer.slice(paragraphBreak + 2);

    // Render the complete blocks
    return renderMarkdown(completeContent);
  }
}

/**
 * Check if terminal supports rich rendering
 * Returns false if stdout is not a TTY or NO_COLOR is set
 */
export function supportsRichRendering(): boolean {
  // Check for NO_COLOR environment variable (standard)
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  // Check for TERM=dumb
  if (process.env.TERM === "dumb") {
    return false;
  }

  // Must be a TTY
  return Boolean(process.stdout.isTTY);
}

/**
 * Create a streaming renderer based on environment
 * Automatically disables rendering for non-TTY or when piping
 *
 * @param forceRaw - Force raw output (--raw flag)
 * @returns Configured StreamingMarkdownRenderer
 */
export function createStreamingRenderer(forceRaw: boolean = false): StreamingMarkdownRenderer {
  const enabled = !forceRaw && supportsRichRendering();
  return new StreamingMarkdownRenderer({ enabled });
}
