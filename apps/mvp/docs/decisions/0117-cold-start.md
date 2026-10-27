# 0117: The engine worker's cold start does no work it can skip

2026-10-26. Follows [0108](0108-first-load.md). A production bug bash on a cold device saw nothing for 4 to 15 s, and
the engine worker logged `engine-store.registration.recovered {registrations: 500, durationMs: 17580}`.

## What we measured

That `durationMs` is a sum over 500 registrations that ran at once; the registration phase itself took 0.9 s
(`flows.runtime.phase registration 910`). A cold visit to `/smithersai/vibelang` on production (5527d82b) rendered at
3.1 s and showed its heading at 4.0 s. Chrome traces of the same build, served locally:

```
0.3-0.9  the worker parses its 3 MB bundle and evaluates every flow module; 352 declarations format a stack each
0.9-1.1  wa-sqlite, OPFS, the session read (only now), the owner check
1.2-2.0  migrations, then 500 registrations, the worker busy under 20%: 70 to 100 timers of 4 ms per 100 ms
2.0-2.2  device/prepare, the device store opens, the page renders
2.2-3.0  the route's data, behind 558 device-store write transactions from 38 persisted collections
```

- **Nested timers.** Effect's scheduler hands queued fiber work to `setTimeout(f, 0)` where the global has no
  `setImmediate`, as in every browser, and a browser holds a timer nested five deep to 4 ms. Every statement on the
  engine's one SQLite connection resumes the fiber waiting for the next, so the worker waited out those holds idle.
  A `MessageChannel` in place of the timer moved the store's opening from 2.18 s to 1.54 s on its own.
- **1,000 recovery reads.** Each registration read the store for its flow's pending clocks and its unconsumed
  completions: 500 registrations, 1,000 statements, 87 distinct flows. The interpreter's three system flows were 249
  of those registrations, once per flow.
- **Formatted stacks.** `@smthrs/flow` captured each declaration's source position from `new Error().stack` as it was
  declared. Formatting a stack in a 3 MB bundle cost the worker 122 ms for 352 declarations, and the page 23 ms, for
  positions a browser never names: its frames are URLs, which name no file.
- **DevTools inflates exceptions.** Under Playwright, `Node.capture`'s built-in slot probes, which throw by design,
  cost the worker 242 ms; with no DevTools attached, 3 ms. The benchmark drives Chromium through DevTools, so its
  numbers overstate a person's; the results below give both.

## Decisions

1. **The browser's fibers dispatch over a `MessageChannel`.** `@smthrs/platform-browser`'s `BrowserScheduler.make()`
   is Effect's `MixedScheduler` with a message on a channel for its immediate, as React's scheduler and `setImmediate`
   polyfills do. `BrowserRuntime.run` and `BrowserLanguageServer.serve` run their workers on it. The page keeps
   Effect's default: with the worker on the channel, putting the page on it too moved nothing measurable.
2. **A runtime recovers its registrations once.** `@smthrs/engine-store`'s `Options.deferRecovery` lists the flows
   registered before the host's first `Driver.reportRecovery` and recovers them in it, with one read of the pending
   clocks and one of the unconsumed completions. `@smthrs/flows`' `Runtime.layer` and the native hosts' `layerHost` set
   it: they report as soon as registration finishes and resume no run before it, so no run can wake through them
   before its clocks are armed. A flow registered later recovers as it registers. The system flows still register
   once per flow; recovery counts each flow once, so they cost no store reads, only their share of the registration
   phase's 85 to 96 ms.
3. **A declaration's site is formatted when read.** `@smthrs/flow` keeps the captured `Error` and parses its stack the
   first time something reads the site (`DeclarationSite.resolve`); copies of a declaration carry the unparsed capture.
   What a site reads is unchanged.
4. **The worker's first session read starts before its bundle evaluates.** The engine worker's first import,
   `src/flows/sessionStart.worker.ts`, starts `GET /api/auth/session`, and its first owner check takes that response
   (`src/flows/sessionRead.ts`); every later read asks again. The read now runs while the bundle evaluates, about
   150 ms earlier. A read the bundle's parse delays stays behind it: the parse precedes all evaluation.

Durability is unchanged. The journal, the clocks and the completions are written as before; only when a starting
runtime re-arms them moved, to the end of its registration phase. `test/DeferredRecovery.test.ts` in
`@smthrs/engine-store` restarts over a store on disk and shows a parked run's clock re-armed in the first report and
not before, and the run completing; the restart and recovery suites pass unchanged.

## Results

Cold, signed-out visits, the app's assets served locally over HTTP/2 and `/api/*` on smithers.sh, medians in ms.
With no DevTools attached (headless Chromium reporting its own marks, seven visits to `/smithersai/vibelang` and five to
`/` per build, interleaved):

```
                         activation   store   render   heading /smithersai/vibelang   heading /
before (4295ce31)               775    1,792    1,871                          2,526       1,873
this decision                   608      877      957                          1,714         967
```

`pnpm bench:first-load` (Playwright, five visits each; receipts in
[bench/first-load-results](../../bench/first-load-results/), `2026-10-26-*`):

```
                                  FCP /      content /   FCP vibelang   content vibelang
smithers.sh, 5527d82b             2,920 ms   2,895 ms    3,720 ms       3,857 ms
before, served locally            2,308 ms   2,290 ms    3,284 ms       3,251 ms
this decision, served locally     1,476 ms   1,454 ms    2,428 ms       2,394 ms
```

The budget is now 3.0 s for both medians ([benchmarks](../benchmarks.md#first-load)). In the worker,
`engine-store.registration.recovered` reads `{registrations: 500, durationMs: 1}` and the registration phase 85 to
96 ms, from 910.

## Not yet

The page renders 80 ms after the store opens. What follows is the route's data: `/smithersai/vibelang` shows its
heading about 750 ms after render, waiting for the repositories collection's first sync, whose request leaves only
once its persisted restore has queued behind the startup writes of every other persisted collection: 558 receipted
write transactions, about 1.15 s of the worker's time. Starting persisted collections when something reads them
(0108's next step) removes most of them. The worker's bundle, 3 MB, takes about 400 ms to parse before any of it
runs, the session read included; loading the flows a page does not start lazily would shorten that. `repo/about`
takes 350 ms through the engine for a 140 ms request. The pending-admission sweep reads the store once per
registered flow on every tick, about 270 statements a second while the page is open.
