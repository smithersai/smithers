---
title: Publish test uses Markdown paragraphs
status: done
area: app
owner: Codex md-end-newline
updated: 2026-10-26
links: [../features/coedit.md, ../features/repo.md, ../features/branch-publish.md]
---

The W9 publish test appended text without Enter after moving to the rendered document end. The editor correctly appends to the last paragraph; a source trailing newline does not create another paragraph. The Markdown-in-place test already uses End, Enter, then typing. Align branch-publish with that interaction and assert the complete GitHub document, allowing only trailing whitespace normalization. No editor change or library addition; catalog entry: `@smthrs/repo-view` (Markdown document editing).

Latitude: typecheck, importRules and lint passed; focused coedit.test.ts: 20 passed, 2 expected failures, coedit.ts 100% statements/branches/functions/lines. Only the E2E spec and documentation changed, so there are no changed runtime files to instrument. Browser verification remains unrun: mini unreachable; production runs excluded by assignment.
