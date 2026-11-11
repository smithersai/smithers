# 0033 — The API Worker's startup budget

Date: 2026-11-10. Lane vl-startup-cpu.

## Why

On 2026-11-10 at 15:08 PST Cloudflare refused the upload of main 90f526f0:
`ScriptStartupError: Error: Script startup exceeded CPU time limit`. Production stayed on 5e37278e, which had deployed
at 13:45 PST. Cloudflare's limit is 1 second of CPU: "A Worker must parse and execute its global scope (top-level code
outside of handlers) within 1 second", and a refused deploy reports error 10021, "Script startup exceeded CPU time
limit" ([Workers limits, Worker startup time](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time),
read 2026-11-10; [errors, 10021](https://developers.cloudflare.com/workers/observability/errors/#validation-errors-10021)).

## Cause

The API Worker's main module was 12 MB, and workerd parsed and ran all of it at startup:

```
main module of worker/Api.vibe, as alchemy deploy builds it      bytes
  src/assets/wiki.generated.vibe  every page's Markdown and HTML   6.6 MB   read only by the browser
  src/history/seed/vibelang.vibe  the bootstrapped history         2.9 MB   read when a History object first seeds
  code: flows, agent, Babel, sucrase, zod, rpc, effect, ...        2.9 MB   read by requests
```

The wiki grows with every lane's decision record, so startup crept up to the limit; 90f526f0 added about 460 KB and
crossed it. A redeploy that passes by luck would fail again on the next wiki change.

## Decision

The Worker's startup evaluates only what a Worker needs to exist. Everything else loads on the first event:

- Worker code imports `src/core/wikiIndex.vibe`, over `src/assets/wikiIndex.generated.vibe`: the pages' ids, titles and
  labels without their bodies, written by `scripts/wiki.vibe` beside the full module. `src/core/wiki.vibe` keeps the
  bodies for the browser and re-exports the index's functions, so the browser is unchanged.
- `seeded()` in `worker/HistoryObject.vibe` imports the seed dynamically, inside the Effect that seeds an object, as the
  browser's `MockMythical.vibe` already did. Span `vibelang.history.seed`, counter `vibelang_history_seed_loads`.
- `worker/Api.vibe` imports its request code (`worker/apiRuntime.vibe`: the objects, the agent, the model, the flows,
  the sandbox gateway) from inside its Effects. Alchemy's bridge builds those Effects on the first event
  (`WorkerBridge.ts`, `built ??= Effect.runPromise(...)`), never at startup. Span `vibelang.api.runtime`, counter
  `vibelang_api_runtime_loads`. A static import of `apiRuntime.vibe` or of any module it re-exports puts the graph
  back into startup.

The same code runs; only its first evaluation moves from startup to the first request or object start, which the
Worker's 300-second request CPU limit covers.

## Measurement

`test/support/workerStartup.ts` builds `worker/Api.vibe` as `alchemy deploy` does (Alchemy's `WorkerBundle`, the
Worker's own props and compatibility, its Effect entry, minified) and measures startup as `wrangler check startup`
does: a probe entry imports the main module inside a request while workerd's V8 profiler runs; active (non-idle)
sampled time is the startup cost. On nyc-01 (load 30–40), interleaved runs, median of each build's medians:

```
build                      main module   static closure   startup CPU (profiled)   Cloudflare
5e37278e                   11,991,856 B   12.41 MB          ~840 ms                 accepted
90f526f0                   12,452,826 B   12.87 MB          ~880 ms                 refused
wiki and seed split only    2,932,078 B    3.35 MB          ~570 ms
this decision                 127,011 B    3.34 MB          ~160 ms (fastest 150)
```

The local number tracks Cloudflare's: its line falls between the accepted and the refused build. Static-closure bytes
are a poor proxy: rolldown's `strictExecutionOrder` wraps each shared chunk's modules in lazy initializers, so a chunk
the main module reaches is parsed but its modules run only when called.

## Budget

`test/workerStartup.test.vibe` runs in `pnpm test` and fails a change that crosses either budget:

| Check | Budget | Now | Refused build |
| --- | --- | --- | --- |
| Main module bytes (deterministic proxy) | 1 MiB | 127 KB | 12.45 MB |
| Fastest of 5 startups: workerd CPU time on Linux, profiled time elsewhere | 400 ms | 150–180 ms | 595 ms or more |
| Cloudflare's limit | 1,000 ms | | |

Profiled time is wall time between samples, so it also counts time workerd waits for a CPU. On Linux the gate reads
workerd's own CPU time from `/proc` instead. On nyc-01 at load 220 on 32 cores, unfixed main measured 1,040–1,190 ms
of CPU (profiled 2,205–3,595 ms) and this decision's build 180–310 ms of CPU (profiled 504–1,000 ms); a profiled-time
gate failed the fixed build there. The fastest of 5 runs discards the rest of the host's noise. 400 ms is under half
of Cloudflare's limit and about 60% of the refused build's fastest run, so the gate fails long before Cloudflare
would. Raising a budget needs a new measurement against Cloudflare, recorded here.
