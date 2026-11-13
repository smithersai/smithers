---
title: Preserve Markdown code and screenshot captions
status: completed
area: site
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5406
---

The site and downloadable Markdown must preserve fenced code examples and
Markdown escapes in screenshot captions.

The projection and portable-text helpers now share parser-based code-block
handling, including tilde and backtick fences and list indentation. Markdown copies retain the original alt
escapes; HTML decodes them before escaping the attribute.

Validation:

- The 30 focused tests pass; 12 regression cases fail against the original implementation.
- The documentation-text helper has 100% line, branch, and function coverage.
- Site typecheck, lint, projection exit diagnostics, and the landing projection fixture pass.
- Full site tests report the same three failures with and without the fix:
  the harness API namespace count, flows setup release guidance, and support-table row count.
- App, API, and LLM projections regenerate without changes and pass drift checks.
- The broader docs flow could not run in the validation image because it lacks
  the native `smithers-jj-export` helper.
