---
title: Shell bug bash 26 October
status: in-review
area: shell
owner: bb-shell
updated: 2026-10-26
links: []
---

Check production home, settings, notifications, documentation search and bug-report doors. Use the catalog's `@smthrs/ui` components and existing TanStack Router and Effect collection services. Members may read secret names (features/secrets.md); no permissions change is needed.

Production probes reproduced all reported surfaces without console, page or request errors. Home now offers `Open Smithers` to someone signed in. The Settings empty state, model fallback labels, notifications empty state and bug-report door each have regressions observed failing before the fix. Secrets visibility is correct for Members; the VibeLang sidebar intentionally follows its repository's published docs index (features/docs.md), including Effect's reference pages. Docs search hides only the repeated `#_top` sub-result and retains section links.

Latitude: home, repository Settings and personal model regressions passed (35 tests); personal-model/view.ts measured 100% statements, branches, functions and lines. Browser runs on the mini are unavailable; deployment is left to the lander.

Lander checks after deploying both app and docs site: signed-in `/` offers Open Smithers; Member repository Settings has its empty state; empty tier placeholders start Default; a visitor's bell says No notifications; repository bug links at desktop and phone widths open the in-app form; a submitted report's build equals `/version.json`; docs search has one visible Quickstart and scorers title while section links still work. Do not submit a GitHub draft.

Final Latitude validation: typecheck, importRules, lint, 59 focused Vitest tests and the legacy redirect test passed. The measured model view and report context/GitHub formatting logic reached 100% statements, branches, functions and lines; TSX and CSS are outside the repository coverage gate. Every fix has a regression observed failing on old code. Post-change production probes still reproduce the old deployment without browser or request errors. Deploy and end-to-end verification remain with the lander.
