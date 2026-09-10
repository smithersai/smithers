# walkthrough/

Everything that turns a change set + story + findings + quiz into the
self-contained walkthrough HTML (renders from `file://`, no network).

Pipeline:

1. `collectChanges.ts` — full diffs, including review-excluded files. It reads
   one snapshot and hands it to `changesFromDiffs.ts`, which is pure, so a
   caller that already holds a snapshot never reads the tree a second time.
2. `normalizeStory.ts` — repairs narrator output so every changed file lands
   in exactly one diff block; falls back to `fallbackStory.ts`'s
   deterministic, churn-ordered story.
3. `renderWalkthroughHtml.ts` — chapters of prose/diagram/diff blocks,
   findings index, quiz section, TOC. Supporting pieces: `walkthroughCss.ts`,
   `walkthroughScript.ts`, `renderProse.ts` (escape-first markdown subset),
   `renderOverviewChart.ts`, `renderQuizSection.ts`.
   `mermaidRuntimeGzipBase64.ts` + `mermaidLoaderScript.ts` inline the gzipped
   Mermaid runtime only when diagrams exist.

Schemas (`storySchema.ts`, `changedFileSchema.ts`, `changesSchema.ts`) are
permissive on purpose — `normalizeStory` enforces the invariants.

Gotchas: `escapeHtml.ts` here is also used by `../diffs`; `fallbackStory.ts`
and `renderOverviewChart.ts` each have their own `areaOf()` with deliberately
different root labels ("repository root" vs "(root)") — do not unify; Pierre
style leakage is repaired by `walkthroughRestoreCss`, emitted AFTER Pierre's
styles.
