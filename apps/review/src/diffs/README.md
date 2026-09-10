# diffs/

Diff-to-HTML rendering, exported as `@smthrs/review/diffs`, which maps to
`index.ts` (keep the barrel). `../../package.json`'s `exports` map lists the
package's other entry points.

- `renderPierreFileDiff.ts` — server-side rendering via `@pierre/diffs`
  (syntax highlighting, light/dark tokens).
- `extractDiffAssets.ts` — splits Pierre output into shared assets (sprite +
  styles, with `:host` rescoped to `.pierre-diff`) and a per-diff body, so a
  page with many diffs carries the assets once.
- `renderFallbackDiffHtml.ts` — plain table renderer for binary, oversized,
  or failed diffs, with `data-old`/`data-new` line anchors so finding cards
  can still link into it.

Gotcha: `renderFallbackDiffHtml` imports `escapeHtml` from `../walkthrough` —
the two directories are coupled by design (the walkthrough embeds these
renderers).
