---
title: Shell bug bash 26 October
status: in-progress
area: shell
owner: bb-shell
updated: 2026-10-26
links: []
---

Check production home, settings, notifications, documentation search and bug-report doors. Use the catalog's `@smthrs/ui` components and existing TanStack Router and Effect collection services. Members may read secret names (features/secrets.md); no permissions change is needed.

Production probes reproduced all reported surfaces without console, page or request errors. Home now offers `Open Smithers` to someone signed in. The Settings empty state, model fallback labels, notifications empty state and bug-report door each have regressions observed failing before the fix. Secrets visibility is correct for Members; the VibeLang sidebar intentionally follows its repository's published docs index (features/docs.md), including Effect's reference pages. Docs search hides only the repeated `#_top` sub-result and retains section links.
