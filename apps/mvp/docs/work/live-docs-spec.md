---
title: Exercise independently deployed docs from their live index
status: done
area: testing
owner: Codex docs-spec
updated: 2026-10-25
links: [../features/docs.md]
---

Read the live llms.txt and selected Markdown before exercising search and rendering. Keep failures to fetch or render visible; never fall back to another page after a failed read. The reported production failure found Retrying but could not read it; both upstream and the production page API answer successfully during investigation.

The library catalog entry used is `@smthrs/views` (read a repository's docs index): `Docs.parse` and `Docs.search`; Playwright reads the real upstream responses. The rendering assertion uses the Markdown's heading, which can differ from the index's link label, and checks the complete first code block. No production logic changed.

Latitude: application typecheck and `//apps/mvp:importRules` pass. A Mac mini run caught the differing live heading; its final-file rerun caught local dev reloads clearing the search after 502 responses, rather than silently passing on an unfiltered index. The serial rerun also failed before the repository header appeared; the dev server recorded network connection losses and socket hang-ups. The original visitor journey then passed (58.1 s), and an isolated standalone Docs visitor rerun passed (54.3 s), including reload. These are local mini receipts, not production browser receipts.
