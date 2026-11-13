---
title: Preserve docs section destinations
status: done
area: app
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5274
  - ../features/docs.md
---

Section links stay on the original docs site because the app's Markdown headings have no section targets. Whole-page links retain in-app navigation. This uses the existing `@smthrs/ui` docs renderer from the library catalog.

Validation: `src/features/docs/view.test.ts` and `tests/DocsLinks.test.ts` exercise destination selection and the rendered page's ordinary and modified link clicks.

Validation: 14 focused tests pass with 100% statements, branches, functions and lines in `view.ts`; the docs helper and its unit tests typecheck, and production lint passes. The regression fails on the original code. Full-app typecheck reports the same 29 existing errors before and after this change.
