---
title: Framework-free Smithers component CSS
status: implemented
area: ui
owner: Codex vl-uicss
updated: 2026-11-07
links:
  - ../../../../packages/smithers/ui/ui-css/README.md
---

Extract the UI library catalog entry's styles into `@smthrs/ui-css` for Foldkit
and other frameworks. Keep `@smthrs/ui` exports and stylesheet bytes unchanged.
The only dependency is the existing catalog entry `@smthrs/ui-styleguide`.

Validation: ui-css has 152 passing tests with 100% coverage; the React UI has
2,828 passing tests, including stylesheet parity via React's server renderer.
All four app typecheck projects pass. Node, Bun, Chromium and Cloudflare workerd
load the framework-free root. All 35 CSS source modules retain their original
stylesheet content. Full app-suite receipts and any failures are recorded in
`~/vl/vl-uicss.REPORT.md` by this lane.
