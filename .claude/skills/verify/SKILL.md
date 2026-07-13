---
name: verify
summary: Run and visually verify the mdflow.dev website.
---

# Verify mdflow.dev

1. Start the Vite site from the repository root:
   `bun run --cwd site dev:raw -- --host 127.0.0.1 --port 4178`
2. Open `http://127.0.0.1:4178/` with `agent-browser`.
3. Capture the affected UI at desktop (`1440x900`) and mobile (`390x844` and `320x568`) widths.
4. Use accessibility snapshots and DOM evaluation to verify visible text, CTA hrefs/order, section order, and horizontal overflow.
5. Enable reduced motion with `agent-browser set media dark reduced-motion` and confirm the affected content remains visible and usable.
6. Click changed links in a new tab and confirm the resulting URL. Do not make third-party availability a CI dependency.
7. Save screenshots under `.artifacts/` and stop the browser/server when finished.
