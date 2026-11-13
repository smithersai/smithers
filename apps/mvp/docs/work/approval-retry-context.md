---
title: Preserve approval context after a failed submission
status: done
area: ui
owner: codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5006]
---

Use the catalog's Render UI library, `@smthrs/ui`. The shared
`ConfirmationRequest` must remain visible in `failed-submission`, alongside
the existing retry actions. Keep the summary, proposed actions, resources and
reviewer note available for the next decision.

The regression tests fail on the unchanged component: the primitive request
body and both failed decision summaries are absent (59 passed, 3 failed).
The card tests also edit the saved note before retrying, check the submitted
note and wait token, and retain the new-wait reset and settlement assertions.

Validation:

- Focused regressions: 62 passed, 0 failed after the fix.
- `pnpm --filter @smthrs/ui test`: 2,897 passed, 0 failed, including
  Chromium keyboard-focus tests.
- `pnpm --filter @smthrs/ui check`: passed.
- `node --test packages/smithers/ui/scripts/reference-docs.test.mjs`:
  passed, including after rebasing the API reference.
- This package declares no lint script or lint target.
- Codex Astra review: no findings. Fable review was unavailable.
