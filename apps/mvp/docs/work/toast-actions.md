---
title: Keep toast overlays clear of page actions
status: done
area: notifications
owner: Codex GPT-6.1 Sol toast-actions
updated: 2026-11-01
links: [../decisions/0137-toasts-overlay-the-page.md, ../features/notifications.md]
---

Regress New TODO and header controls at 1190x785, 1440x900 and 390x844 with
Add your model visible, preserving af88f72a's pinned-message anchor.
Catalog entry: Render UI, @smthrs/ui ToastStack/Toast. Core overlay layout.
Validation runs only on the Mac mini. No deployment.

Before: all six Chromium cases failed on af88f72a: click interception at all
three sizes, plus rectangle/center-hit failures (including phone filters).
Astra: no findings. Fable found transcript-button chasing, excess measurement
and normal toast clipping; addressed by excluding transcript content, frame
coalescing/attribute filtering, and scrolling only when constrained. A real
pending-question/Answer scrolling regression is included.

Validation on the Mac mini:

- All 12 requested Chromium/WebKit click and page audits pass on the three
  requested viewports, covering home, conversations, repository, issues, pulls,
  stack, runs, settings and branch. The landing page deliberately has no toast.
- All six pin cases pass. Model setup, keyboard Hide, and the chat/branch
  no-shift journeys pass in both browsers: 30 unique browser checks in total.
- The broad run passed 27 tests and exposed four fixture assumptions: the
  pending question's button reads Answer, its real scroller is the viewport
  child, and an offscreen header cannot supply a nearby-placement upper bound.
  The corrected final run passed all 17 selected tests, including all four
  previously failing cases and the complete page-action matrix. Exact bounds
  and layout-shift assertions remain strict.
- 80 SDK tests pass with 100% executed lines in both new layout modules;
  the final 48-test SDK/DOM run additionally exercises zero-room Alt+T.
  Two integration/render tests pass. No mocks or request interception.
- Changed-file ESLint passes, including the final browser-test files.
  Full `pnpm typecheck` (app, worker, infra and evals) passes after syncing
  main's concurrent TODO-crash fix.
- Astra final: no findings. Fable's concrete findings are fixed, including
  its follow-up scroller-selector finding; the real scrolling case passes
  in both browsers. Body primary actions remain obstacles intentionally.

The combined runner's first integration attempt pointed a slot-private
Postgres schema at the shared Electric port. Its 400 shape diagnostics
identified the mismatch; selecting the matching test Electric port fixed the
fixture. No product behavior was bypassed. No deployment.
