---
title: Production sweep form and harness fixes
status: blocked
area: settings
owner: sweep-fixes
updated: 2026-10-25
links: []
---

Use the library catalog's @smthrs/ui form controls. Keep Radix serialization selects out of visible Field layout and audit the Your model form at all three mobile-suite widths. Use the target-declared writable stack and a per-run sandbox completion token.

Implemented all three fixes. App and UI typechecks and importRules pass; all 2,646 UI tests pass, with 100% lines/functions on uiCss.ts. The CSS regression fails with the old rules and passes with the fix. Playwright discovers all three viewport cases. Browser execution awaits the baseline VibeLang bundling repair.
