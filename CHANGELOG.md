# [2.0.0](https://github.com/johnlindquist/markdown-agent/compare/v1.0.0...v2.0.0) (2025-12-06)


### Features

* rename runners to harnesses and implement new unified frontmatter keys ([66ad305](https://github.com/johnlindquist/markdown-agent/commit/66ad305ed8b3df4afb2a010b33513ca284705abd))


### BREAKING CHANGES

* The 'runners' directory is now 'harnesses'. Old names still work via aliases.

New unified frontmatter keys with backward-compatible deprecated aliases:
- `approval`: enum ("ask" | "sandbox" | "yolo") replaces `allow-all-tools`
- `tools`: nested `{ allow, deny }` replaces `allow-tool`/`deny-tool`
- `dirs`: replaces `add-dir`
- `session`: unified `{ resume, fork }` replaces `resume`/`continue`
- `output`: replaces `output-format`

All harnesses (Claude, Codex, Gemini, Copilot) updated with:
- New key handling with `??` fallback to deprecated keys
- Consistent approval mode mapping across backends
- Session resume support via unified object
- Output format standardization

Tests updated with 95 passing tests covering both new and deprecated keys.

# 1.0.0 (2025-12-06)


### Bug Fixes

* **ci:** add Node.js 22 setup for semantic-release ([6a31cf6](https://github.com/johnlindquist/markdown-agent/commit/6a31cf68bf8003152271399f9ce62d3d8c04fd39))
* **copilot:** default --silent flag to on for session metadata suppression ([04f55f7](https://github.com/johnlindquist/markdown-agent/commit/04f55f7bfd610fddb77f7522fdb31b9669c1f7f8))


### Features

* add argument templating with {{ variable }} syntax ([205475b](https://github.com/johnlindquist/markdown-agent/commit/205475b2c3810fcf23bf810f28bca987e9f3c7ff))
* add batch/swarm mode and shell setup wizard ([7320397](https://github.com/johnlindquist/markdown-agent/commit/73203973a5fbc2ca1d2af0e85605d5b8f807b944))
* add dry-run / audit mode ([0c95390](https://github.com/johnlindquist/markdown-agent/commit/0c95390796e5094154c09fd6b16805720c60c044))
* add interactive input schema (wizard mode) ([0d3526d](https://github.com/johnlindquist/markdown-agent/commit/0d3526de51600f3452c51247b6b0f0ae604ddc19))
* add native context globs for file inclusion ([d60965f](https://github.com/johnlindquist/markdown-agent/commit/d60965f6395eafc8e57f156c48b3c45b3896b12b))
* add prerequisite guardrails for binaries and env vars ([bb00f9e](https://github.com/johnlindquist/markdown-agent/commit/bb00f9eb0181831985e007851ac1579a7c53a420))
* add remote execution from URLs (npx style) ([796dea8](https://github.com/johnlindquist/markdown-agent/commit/796dea87050315061cdc354482981b09f8c04015))
* add result caching for expensive LLM calls ([f1923d2](https://github.com/johnlindquist/markdown-agent/commit/f1923d2c600ecf3311aee3240db847366af41601))
* add robust YAML parsing with js-yaml and zod validation ([59aad98](https://github.com/johnlindquist/markdown-agent/commit/59aad98bc13ed5e0fa797c253193318a6b67d2e4))
* add structured output extraction ([56cb733](https://github.com/johnlindquist/markdown-agent/commit/56cb733d479a2bc5a2f9d57e800fdf70dfd40832))
* add true shebang support (#!) ([6093204](https://github.com/johnlindquist/markdown-agent/commit/6093204ee7c9dd10ffe57280d93d79b54b06cf3a))
* enhance CLI with multi-backend support and runner architecture ([86b1eb9](https://github.com/johnlindquist/markdown-agent/commit/86b1eb921db582362b0180d198aec1bbd3948d0f))
* **imports:** add [@file](https://github.com/file) imports and !`cmd` command inlines ([7d2bc2c](https://github.com/johnlindquist/markdown-agent/commit/7d2bc2c3585fa358f85249fd41c18012f64d32d7))
* rename to markdown-agent with ma alias ([ceddcc7](https://github.com/johnlindquist/markdown-agent/commit/ceddcc7f6d5e1f7403d550bc629b66e7e7b907ef))
