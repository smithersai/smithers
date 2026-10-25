# Run pages publish before remote reads finish

Date: 2026-10-25

A run route previously awaited its root inspection, every child's inspection and
journal, and live-subscription setup before committing its screen. Holding either
inspection kept the known page invisible beyond the existing five-second budget.
The local real Postgres/Electric nested-run baseline was 55 ms (root at 23 ms,
child at 53 ms); it did not reproduce the production delay.

The route now selects its local view and returns. Store-scoped reads and Electric
subscriptions continue independently. Cached repository rows draw the known
header, and each root inspection publishes before its descendants finish. The
existing generation and replay guards protect incremental writes; replay freezes
what was visible when selected. Components read live collections, with no React
state or synchronization effects. This is the existing run infrastructure, using
the catalog's local state/sync and UI libraries; no new feature or runtime.

The five-second ci.spec budget stays. Slow inspections and sync are not required
to paint a frame. `run.route.stage` records measure the production stages without
content. Local harness route entry fell to about 16 ms; this is not a production
browser timing claim. Production/farm reproduction remains required evidence. Samples and method are
kept in [the work evidence](../work/evidence/ci-runpage-slow/method.md).
