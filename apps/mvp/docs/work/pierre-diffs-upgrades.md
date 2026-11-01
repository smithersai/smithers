---
title: Pierre's diffs and Highlights in the code views
status: in-progress
area: sdk
owner: pierre-oss survey (Claude Opus)
updated: 2026-10-21
links: [../proposals/pierre-oss-survey.md, ../features/repo.md, ../features/code-intelligence.md]
---

## Current specification — 2026-10-21, 14:30 PDT

**What:** Keep `@pierre/diffs` current in `@smthrs/repo-view` and the review flow, and decide whether `@pierre/highlights` replaces Shiki.

**Why:** Will asked on 2026-10-21 what of Pierre's open source we should add or upgrade. The survey, with its benchmarks, is [pierre-oss-survey.md](../proposals/pierre-oss-survey.md).

## State

| Step | State |
|---|---|
| `@pierre/diffs` 1.3.6 to 1.5.2 in `@smthrs/repo-view`, with the worker pool on pierre's own startup timeout | done, waiting for the lander |
| `@pierre/diffs` 1.3.6 to 1.5.2 in `.smithers/flows` (the review flow) | done, waiting for the lander |
| `e2e/code-intel.spec.ts` and `e2e/repo-browse.spec.ts` on the upgraded code view | not run: they need Code Storage credentials |
| `@pierre/diffs` 1.6.1 in both | waits until 2026-10-22 18:05 UTC (SDK-15); 1.6.0 throws on its default themes |
| Highlights as the highlighter | Will's call: faster by 30 to 70 times, but it recolors code and has no VibeLang lexer |
