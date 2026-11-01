---
title: Scroll the conversation from the timeline rail
status: done
area: timeline
owner: codex-tl-wheel
updated: 2026-10-31
links:
  - ../design/timeline/DESIGN.md
---

Will's 2026-10-31 request: wheel input over the rail and its phone sheet scrolls the transcript, including the transcript's existing history path. Ignore horizontal-only input and pinch zoom. Implement in the library catalog's `@smthrs/ui` entry, not in the app; preserve navigation and reduced motion. Regression first, mini-only validation, no deploy.

The driver now consumes vertical wheel input on the rail only, normalizes line/page units, delivers the transcript's wheel input to release its existing scroll anchors, and changes that transcript's scrollTop. Its normal scroll event updates the rail; its existing Load earlier control remains the history path. Horizontal-only input and ctrl-modified pinch input remain native. The listener detaches on disposal.

Mini validation: regression failed before implementation (scrollTop remained 0 instead of 600); all 14 driver tests now pass with 100% of changed executable lines covered. UI TypeScript and app VibeLang checks pass. Full-suite receipts are recorded below. No package files were added, so target-index regeneration is unnecessary.

Final mini suite: 2,741 SDK tests pass with TZ pinned to America/Los_Angeles (the existing calendar DST suite changes process TZ after a step-log Intl formatter initializes). Both conversation e2e journeys pass in Chromium and WebKit, including wheel up/down and pinch preservation over desktop and three responsive sheets. The full timeline spec also ran: its two untouched branch cases fail expecting TODO draft/run entries, which current `railEntries` intentionally excludes under FE-16. Recorded rather than changing that separate test contract. Astra review: approved, no findings.

Fable review could not run: the subscription rotator exhausted its available/cooling accounts. No cooldowns or account settings were changed.
