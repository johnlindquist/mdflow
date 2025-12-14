/**
 * Property-based/fuzz tests for the import parser
 *
 * These tests use fast-check to generate random markdown content
 * and verify the parser never panics and behaves correctly.
 */

import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import {
  parseImports,
  hasImportsInContent,
  findSafeRanges,
} from './imports-parser';

describe('imports-parser fuzz tests', () => {
  describe('parseImports never throws', () => {
    it('handles any random string without throwing', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseImports(input);
          expect(Array.isArray(result)).toBe(true);
        }),
        { numRuns: 1000 }
      );
    });

    it('handles any unicode string without throwing', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'grapheme' }), (input) => {
          const result = parseImports(input);
          expect(Array.isArray(result)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('handles very long strings without throwing', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 10000, maxLength: 50000 }), (input) => {
          const result = parseImports(input);
          expect(Array.isArray(result)).toBe(true);
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('findSafeRanges never throws', () => {
    it('handles any random string without throwing', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = findSafeRanges(input);
          expect(Array.isArray(result)).toBe(true);
        }),
        { numRuns: 1000 }
      );
    });
  });

  describe('hasImportsInContent consistency', () => {
    it('hasImportsInContent matches parseImports.length > 0', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const hasImports = hasImportsInContent(input);
          const parseResult = parseImports(input);
          expect(hasImports).toBe(parseResult.length > 0);
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('random markdown with code fences', () => {
    const markdownWithFencesArb = fc.array(
      fc.oneof(
        fc.string({ minLength: 0, maxLength: 100 }),
        fc.tuple(
          fc.constantFrom('```', '~~~', '````'),
          fc.constantFrom('', 'js', 'ts', 'python'),
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.constantFrom('```', '~~~', '````')
        ).map(([open, lang, content, close]) => `${open}${lang}\n${content}\n${close}`),
        fc.string({ minLength: 1, maxLength: 50 }).map((s) => `\`${s.replace(/`/g, '')}\``),
        fc.constantFrom('@./file.md', '@~/config.yaml', '@/absolute/path.ts'),
        fc.constantFrom('@https://example.com', '@http://localhost:3000/api'),
        fc.string({ minLength: 1, maxLength: 30 }).map((s) => `!\`${s.replace(/`/g, '')}\``),
      ),
      { minLength: 0, maxLength: 10 }
    ).map((parts) => parts.join('\n'));

    it('never throws on random markdown with fences', () => {
      fc.assert(
        fc.property(markdownWithFencesArb, (input) => {
          const result = parseImports(input);
          expect(Array.isArray(result)).toBe(true);
        }),
        { numRuns: 500 }
      );
    });

    it('imports inside code fences are ignored', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 50 }).filter(s => !s.includes('```') && !s.includes('`')),
          (content) => {
            const fenced = '```\n@./inside-fence.md\n' + content + '\n```';
            const result = parseImports(fenced);
            const fileImports = result.filter(r => r.type === 'file' && r.original.includes('inside-fence'));
            expect(fileImports).toHaveLength(0);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('safe range property tests', () => {
    it('safe ranges never overlap', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const ranges = findSafeRanges(input);
          for (let i = 1; i < ranges.length; i++) {
            const prev = ranges[i - 1]!;
            const curr = ranges[i]!;
            expect(prev.end).toBeLessThanOrEqual(curr.start);
          }
        }),
        { numRuns: 500 }
      );
    });

    it('safe ranges stay within content bounds', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const ranges = findSafeRanges(input);
          for (const range of ranges) {
            expect(range.start).toBeGreaterThanOrEqual(0);
            expect(range.end).toBeLessThanOrEqual(input.length);
            expect(range.start).toBeLessThanOrEqual(range.end);
          }
        }),
        { numRuns: 500 }
      );
    });

    it('imports only appear within safe ranges', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const ranges = findSafeRanges(input);
          const imports = parseImports(input);
          for (const imp of imports) {
            if (imp.type === 'executable_code_fence') continue;
            const inSafeRange = ranges.some(
              (range) => imp.index >= range.start && imp.index < range.end
            );
            expect(inSafeRange).toBe(true);
          }
        }),
        { numRuns: 500 }
      );
    });
  });
});
