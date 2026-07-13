/**
 * Behavioral eval suite for logo-grid.claude.md — run with:
 *   md eval examples/logo-grid.claude.md --plan   (free)
 *   md eval examples/logo-grid.claude.md --yes    (paid: 2 invocations)
 *
 * Showcases: structured HTML/SVG inspection, exact numeric cardinality,
 * bounded output size, prohibited external dependencies, per-SVG color
 * bounds.
 * Guardrail: catches Markdown-wrapped or incomplete HTML, the wrong number
 * of concepts, duplicate/missing ids, external scripts/images/resources,
 * absent dark mode, missing per-concept favicon previews (each concept's
 * own cell needs its 16px and 32px previews), too many colors,
 * CSS-dependent marks, or text elements inside the icons.
 */
import type { EvalCase } from "mdflow/src/evals";

function svgFragments(html: string): string[] {
  return [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].map((match) => match[0]);
}

function literalColors(svg: string): Set<string> {
  const colors = new Set<string>();
  for (const match of svg.matchAll(/\b(?:fill|stroke)=["']([^"']+)["']/gi)) {
    const value = match[1]!.trim().toLowerCase();
    if (!value || value === "none" || value === "transparent" || value === "currentcolor") continue;
    if (value.startsWith("url(")) continue;
    colors.add(value);
  }
  return colors;
}

const cases: EvalCase[] = [
  {
    name: "renders exactly six addressable SVG concepts in standalone HTML",
    check: ({ stdout }) => {
      const html = stdout.trim();
      const bytes = Buffer.byteLength(html, "utf8");
      if (!/^<!doctype html>/i.test(html)) return "document must start with <!DOCTYPE html>";
      if (html.includes("```")) return "HTML must not be wrapped in a Markdown fence";
      if (bytes < 2_000 || bytes > 120_000) return `unexpected document size: ${bytes} bytes`;
      if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) {
        return "missing html/body document structure";
      }
      if (!/display\s*:\s*grid/i.test(html) || !/grid-template-columns/i.test(html)) {
        return "concepts are not arranged in a responsive CSS grid";
      }
      const ids = [...html.matchAll(/<svg\b[^>]*\bid=["']logo-(\d+)["'][^>]*>/gi)].map((match) =>
        Number(match[1])
      );
      const expected = [1, 2, 3, 4, 5, 6];
      const uniqueSorted = [...new Set(ids)].sort((a, b) => a - b);
      if (JSON.stringify(uniqueSorted) !== JSON.stringify(expected) || ids.length !== 6) {
        return "expected exactly unique ids logo-1 through logo-6, got " + (ids.join(", ") || "none");
      }
      for (const opening of html.matchAll(/<svg\b[^>]*\bid=["']logo-\d+["'][^>]*>/gi)) {
        if (!/\bviewBox=["']0 0 120 120["']/i.test(opening[0])) {
          return 'every primary logo SVG must use viewBox="0 0 120 120"';
        }
      }
      return null;
    },
  },
  {
    name: "keeps every mark self-contained, color-bounded, and previewable",
    check: ({ stdout }) => {
      const html = stdout.trim();
      if (/<script\b/i.test(html)) return "standalone page must not contain scripts";
      if (/<img\b/i.test(html)) return "logo concepts must not depend on image elements";
      if (/@import|url\(\s*["']?https?:|\b(?:src|href)=["']https?:/i.test(html)) {
        return "page contains an external network dependency";
      }
      if (!/@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(html)) {
        return "missing prefers-color-scheme dark-mode support";
      }
      // The flow promises a 16px and 32px preview row under EACH mark, so
      // global token counts are not enough — twelve previews parked under
      // one concept must not pass. Slice the page into per-concept sections
      // (from each primary logo's opening tag to the next one) and require
      // both preview sizes inside every section.
      const anchors = [...html.matchAll(/<svg\b[^>]*\bid=["']logo-(\d+)["']/gi)];
      if (anchors.length !== 6) {
        return `expected six primary logo anchors, got ${anchors.length}`;
      }
      for (const [position, anchor] of anchors.entries()) {
        const next = anchors[position + 1];
        const section = html.slice(anchor.index ?? 0, next?.index ?? html.length);
        const label = anchor[1] ?? String(position + 1);
        if (!/(?:width|height)\s*[:=]\s*["']?16(?:px)?\b/i.test(section)) {
          return `logo-${label} is missing its own 16px favicon preview`;
        }
        if (!/(?:width|height)\s*[:=]\s*["']?32(?:px)?\b/i.test(section)) {
          return `logo-${label} is missing its own 32px favicon preview`;
        }
      }
      const primary = svgFragments(html).filter((svg) => /\bid=["']logo-\d+["']/i.test(svg));
      if (primary.length !== 6) return `expected six primary SVG fragments, got ${primary.length}`;
      let monochrome = false;
      const marks = new Set<string>();
      for (const [index, svg] of primary.entries()) {
        if (/<text\b/i.test(svg)) return `logo-${index + 1} uses an SVG text element`;
        if (/\bclass=["']/i.test(svg)) return `logo-${index + 1} depends on a CSS class`;
        // An empty or decorative-only SVG is not a logo concept: each mark
        // needs at least one real drawing primitive.
        const primitives = svg.match(/<(?:path|circle|rect|polygon|polyline|line|ellipse)\b/gi)?.length ?? 0;
        if (primitives === 0) return `logo-${index + 1} contains no drawing primitives`;
        // Six DISTINCT concepts: the same mark copy-pasted under six ids
        // satisfies cardinality but not the brief.
        const body = svg.replace(/^<svg\b[^>]*>/i, "").replace(/<\/svg>$/i, "").replace(/\s+/g, "");
        if (marks.has(body)) return `logo-${index + 1} duplicates another concept's mark`;
        marks.add(body);
        const colors = literalColors(svg);
        if (colors.size > 3) return `logo-${index + 1} uses ${colors.size} literal colors`;
        if (colors.size <= 1) monochrome = true;
      }
      if (!monochrome) return "expected at least one single-color concept";
      return null;
    },
  },
];

export default cases;
