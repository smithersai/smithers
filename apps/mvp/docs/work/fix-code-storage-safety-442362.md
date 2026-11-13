---
title: Code Storage error and read safety
status: done
area: effect-code-storage
owner: codex-fix-442362
updated: 2026-10-21
links: []
---

Use the library catalog's Code Storage client entry. Reproduce unsafe public
unknown-code interpolation, permanent HTTP retries and unchecked byte caps;
fix within the existing Effect service and bounded readers.

Latitude regression baseline: 25 failures, 45 passes. After fixes: 127 passes,
one credential-dependent live integration skipped, 100% coverage in all four
categories. Real GitHub and gzip HTTP integration passed. Browser e2e not run
(mini offline).
