# Local run-route samples

Node 26.5.0, real local Postgres/Electric, real remote engine and nested
`probe/Pause` run. The fixture is the test named `a real repository run records`
in `src/features/runs/remote.test.ts`. It opens a real repository run, holds its
last action, calls the frontend's route entry, then records the frontend boundary
and waits for its subscriptions' first rows. No model or mocked backend is used.

From the repository root, after installing the frozen lockfile:

```sh
RUN_ROUTE_TIMINGS=/tmp/run-route.json pnpm --dir apps/mvp test \
  src/features/runs/remote.test.ts src/features/runs/timing.test.ts \
  -t 'a real repository run records|route timing records' \
  --maxWorkers=1 --coverage.include=src/features/runs/timing.ts
```

`before.json` was executed on instrumentation commit `8230819d`: route entry
returned in 55.196 ms; root inspection was ready at 23 ms, child at 53 ms,
frontend boundary at 55 ms, first change rows at 140/152 ms.
`after.json` was executed on the final implementation: entry returned in
16.314 ms; frontend boundary at 16 ms, root ready/published at 53/55 ms, child
ready at 121 ms, cached repository rows at 94 ms and first change rows at
144/201 ms. The new route also initializes the persisted repository collection.

These are single local harness samples, not production or browser performance
claims. The after sample ran concurrently with the locked full app gate and had
slower inspection service timings. `render` in these samples is the harness's
frontend-boundary callback after route entry returns; the separate React route
regression exercises the real committed DOM callback. That regression holds both
inspection and shape services, requires the frame and persisted header within
5,000 ms, then releases each separately and verifies graph/live completion. It
failed on the old blocking route; the child and cached-refresh regressions also
failed before their fixes. Neither the CI browser budget nor any gate is relaxed.

Production's reported delay beyond five seconds was not reproduced here. The
farm's real-push ci.spec is required to finish that proof; its scratch repository,
push credential and webhook secret were absent in this job's environment.
