import { describe, it, expect, beforeEach } from "bun:test";
import {
  renderMarkdown,
  StreamingMarkdownRenderer,
  supportsRichRendering,
  createStreamingRenderer,
} from "./markdown-renderer";

describe("markdown-renderer", () => {
  describe("renderMarkdown", () => {
    it("renders empty string for empty input", () => {
      expect(renderMarkdown("")).toBe("");
      expect(renderMarkdown("   ")).toBe("");
    });

    it("renders plain text", () => {
      const result = renderMarkdown("Hello world");
      // Should contain the text (possibly with ANSI codes)
      expect(result).toContain("Hello world");
    });

    it("renders headings with formatting", () => {
      const result = renderMarkdown("# Heading 1\n\nSome text");
      // Should contain heading text
      expect(result).toContain("Heading 1");
    });

    it("renders code blocks", () => {
      const result = renderMarkdown("```javascript\nconst x = 1;\n```");
      // Should contain the code
      expect(result).toContain("const");
      expect(result).toContain("x");
    });

    it("renders inline code", () => {
      const result = renderMarkdown("Use `console.log` for debugging");
      expect(result).toContain("console.log");
    });

    it("renders bold and italic", () => {
      const result = renderMarkdown("**bold** and *italic*");
      expect(result).toContain("bold");
      expect(result).toContain("italic");
    });

    it("renders lists", () => {
      const result = renderMarkdown("- item 1\n- item 2\n- item 3");
      expect(result).toContain("item 1");
      expect(result).toContain("item 2");
      expect(result).toContain("item 3");
    });

    it("handles malformed markdown gracefully", () => {
      // Should not throw
      const result = renderMarkdown("```\nunclosed code block");
      expect(typeof result).toBe("string");
    });
  });

  describe("StreamingMarkdownRenderer", () => {
    let renderer: StreamingMarkdownRenderer;

    beforeEach(() => {
      renderer = new StreamingMarkdownRenderer({ enabled: true });
    });

    describe("with rendering enabled", () => {
      it("buffers content until paragraph breaks", () => {
        // Single chunk without paragraph break should buffer
        const result1 = renderer.processChunk("Hello ");
        const result2 = renderer.processChunk("world");

        // No paragraph break yet, should be buffering
        expect(result1 + result2).toBe("");

        // Flush should return the content
        const flushed = renderer.flush();
        expect(flushed).toContain("Hello");
        expect(flushed).toContain("world");
      });

      it("renders content at paragraph breaks", () => {
        const result = renderer.processChunk("First paragraph.\n\nSecond paragraph.");

        // Should have rendered up to the paragraph break
        expect(result).toContain("First paragraph");

        // Flush the rest
        const flushed = renderer.flush();
        expect(flushed).toContain("Second paragraph");
      });

      it("buffers code blocks until complete", () => {
        // Start a code block
        renderer.processChunk("```javascript\n");
        renderer.processChunk("const x = 1;\n");

        // Code block not closed, should still be buffering
        const result = renderer.processChunk("```\n\n");

        // Now it should be processed
        expect(result).toBeDefined();
      });

      it("reset clears the buffer", () => {
        renderer.processChunk("Some content");
        renderer.reset();
        const flushed = renderer.flush();
        expect(flushed).toBe("");
      });
    });

    describe("with rendering disabled (raw mode)", () => {
      beforeEach(() => {
        renderer = new StreamingMarkdownRenderer({ enabled: false });
      });

      it("passes through content unchanged", () => {
        const result1 = renderer.processChunk("# Heading\n\n");
        const result2 = renderer.processChunk("Some **bold** text");

        expect(result1).toBe("# Heading\n\n");
        expect(result2).toBe("Some **bold** text");
      });

      it("flush returns empty since raw mode passes through immediately", () => {
        // In raw mode, processChunk passes through immediately, so nothing is buffered
        const result = renderer.processChunk("partial");
        expect(result).toBe("partial");
        // Buffer should be empty since we passed through
        const flushed = renderer.flush();
        expect(flushed).toBe("");
      });
    });
  });

  describe("supportsRichRendering", () => {
    it("returns a boolean", () => {
      const result = supportsRichRendering();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("createStreamingRenderer", () => {
    it("creates a renderer", () => {
      const renderer = createStreamingRenderer();
      expect(renderer).toBeInstanceOf(StreamingMarkdownRenderer);
    });

    it("creates raw renderer when forceRaw is true", () => {
      const renderer = createStreamingRenderer(true);
      // In raw mode, content should pass through unchanged
      const result = renderer.processChunk("# Test");
      expect(result).toBe("# Test");
    });
  });
});
