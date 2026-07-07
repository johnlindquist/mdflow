---
# Logo grid generator — proposes a grid of SVG logo concepts as a standalone HTML page
# Usage: md logo-grid.claude.md > grid.html
# Override: md logo-grid.claude.md --_direction "geometric monograms" --_count 6 > grid.html
_brand: mdflow
_tagline: "run AI agents defined as markdown files"
_direction: "varied exploration — mix monograms, abstract marks, and pictorial ideas"
_count: 6
model: sonnet
print: true
---

You are a senior brand identity designer. Propose {{ _count }} distinct logo
concepts for "{{ _brand }}" — {{ _tagline }}.

Design direction for this batch: {{ _direction }}

Requirements for every concept:

- A self-contained inline `<svg>` with `viewBox="0 0 120 120"`, no external
  fonts, images, scripts, or CSS classes. Use only shapes, paths, and inline
  fills so each mark can be lifted out verbatim and used as a favicon.
- Must stay legible at 16x16. Prefer bold, simple geometry over fine detail.
- Use at most 2-3 colors per mark. Include at least one concept that works in
  a single color.
- No text-heavy wordmarks; these are icon marks. Letterforms (e.g. an "m" or
  "md" monogram) are fine if drawn as simple geometry.

Output a complete standalone HTML page and NOTHING else — no markdown fences,
no commentary before or after. The page must:

- Start with `<!DOCTYPE html>`.
- Render a responsive CSS grid of the {{ _count }} concepts.
- In each cell: the SVG at 120px, a short concept name, and a one-line
  rationale. Give each `<svg>` an `id` like `logo-1`, `logo-2`, ...
- Include a small preview row under each mark showing it at 16px and 32px so
  favicon legibility is visible at a glance.
- Use a clean neutral page style (system font, light background, subtle card
  borders) with dark-mode support via `prefers-color-scheme`.
