# 0116: Lists sync facts; detail pages sync text

Status: accepted implementation of the cold-shape payload request (2026-10-26).

A signed-out production issues or pulls page downloaded 3,845 item rows (8,238,476 decoded bytes) and 8,061 comments (8,969,563 bytes). No list reads body text or comments. `item-summaries` is a server-defined projection without `body`, GitHub ids, state reasons, creation/closure timestamps or triage pins, which its summary views never read; homes and lists read it. The full `items` and `comments` shapes wait for an issue or pull detail page. A TODO draft made from an issue explicitly requests full items, because its prompt uses the body, without requesting comments.

All summaries remain available: home triage counts and full-list filters/search require their facts. A recent-items limit would change those counts. All shapes retain the same server authorization and device authority gates (0110). Each projection has its own persisted collection; existing full-item history stays readable. Detail queries depend on full items, never a fabricated empty body, and detail transport has its own installation receipt. This preserves decisions 0002 and 0112.

The deployed payload projected without bodies is approximately 2.52 MB, with zero comment rows on lists: approximately 85% less item/comment data. This is a projection, not a deployed after measurement; deployment is excluded from this change. Production homes opened no issue shapes; the observed vibelang lists opened none either. The deployment-declared `e2e/shape-payload.spec.ts` enforces no detail demand and a 3 MB summary budget. Library catalog: `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`.
