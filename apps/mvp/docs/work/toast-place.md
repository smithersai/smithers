---
title: Keep toast overlays clear of pinned message controls
status: done
area: notifications
owner: Codex GPT-6.1 Sol toast-place
updated: 2026-10-31
links: [../decisions/0137-toasts-overlay-the-page.md, ../features/notifications.md]
---

The home conversation receives the existing `Notices` as a view slot immediately
after its pin, in a zero-height positioned box. The pin's actual size sets the
overlay's top, including collapse and expand, without measured offsets or space
reserved for notices. Other page owners and notification state stay unchanged.
Library catalog: Render UI, `@smthrs/ui` ToastStack/Toast. This is core page layout.

Validation on the Mac mini:

- Old placement at `bc3ec358`: all three regressions failed at the collapse button's center
  hit test, at 1190×785, 1440×900 and 390×844.
- Fixed placement: all three sizes passed in Chromium and WebKit. Short and tall
  pins, collapse/expand/unpin, complete toast visibility, toast controls,
  keyboard Hide, unchanged bounds and phone reduced motion are exercised.
- Chromium also passed model setup and all four chat/branch no-shift journeys
  at 1280px and 390px: eight behavior tests; WebKit passed three, plus setup.
- Four real-service integration/render tests and 21 shared UI tests (133
  assertions) passed. The UI suite retains the cap, +N, keyboard and motion.
- VibeLang frontend typecheck and ESLint on every changed source/test file passed.
  The test lint adds TypeScript parsing for tests the app config normally excludes.
- New placement markup/style is exercised with absent, expanded and collapsed
  pins. No logic module changed.
- Astra and Fable reviews: no actionable findings.

The first broader browser run found a fixture readiness race: the composer was
measured empty before its model/session gate loaded. The no-shift test now waits
for a visible composer before its existing strict baseline and shift assertions.
The full rerun passed. No deployment.

Rebased onto the concurrent timeline-room layout, preserving its style and the
new toast owner. Combined-source typecheck, lint, ownership test and the full
Chromium/WebKit matrix passed again.
