---
# Logo image generator — uses the Codex CLI's built-in image_gen tool.
# Runs: codex exec -c features.image_generation=true --sandbox workspace-write "..."
# Usage: md logo-image.codex.md --_concept "Prompt Spark" \
#          --_details "a bold terminal chevron with a spark at its tip" \
#          --_out ./logo.png
_concept: "Prompt Spark"
_details: "a single bold terminal chevron with a tiny spark at its tip, one color"
_brand: mdflow
_purpose: "a CLI tool that runs AI agents defined as markdown files"
_out: ./logo.png
c: features.image_generation=true
sandbox: workspace-write
skip-git-repo-check: true
---

Use the image_gen tool to generate exactly one image, then save the final
image file to {{ _out }} (create parent directories if needed).

The image: a minimal flat vector logo mark named "{{ _concept }}" for
{{ _brand }}, {{ _purpose }}.

The mark: {{ _details }}

Style: clean geometric flat vector, solid shapes, at most 3 colors, solid
white background, mark perfectly centered with generous margin. No text, no
words, no captions — this must read clearly at favicon size (16x16).
App-icon quality, crisp edges.

When done, verify the file exists at {{ _out }} and reply with only the saved
path.
