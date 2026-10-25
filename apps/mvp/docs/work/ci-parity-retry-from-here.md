---
title: CI parity: retry a run from a chosen step
status: done
area: sdk
owner: flows-retry builder
updated: 2026-10-25 14:11 PDT
links: [../proposals/ci-cd-parity.md, ci-parity-rerun-failed.md, flow-debugging.md]
---

## What

Start a run again from a chosen step, keeping everything before it.

## Why

`TimeTravel.fork` and `rewind` exist but need jj on the host (`docs/libraries.md:230`), and CI needs rules for which later steps a changed step invalidates. Retry failed (`ci-parity-rerun-failed`) covers the common case.

## Repositories

Smithers, Tevm, Effect.

## Smallest slice

Built as Retry from here (ruling FLOW-11, Will's queue answer 2026-10-20 18:29: "Allow it: it's a retry, not a history fork"). The engine owns it: `flow.retryFrom` in `@smthrs/flow`, implemented by `@smthrs/engine-store` on SQLite and PostgreSQL, so it runs in the browser engine and on Node and Cloudflare hosts. A new run replays every step attempt that finished before the chosen step, in the source run's journal order, and runs the step and everything after it; the source run is untouched. It is not `TimeTravel.fork`, which needs jj on the host. A changed declaration fails the new run with `plan_changed` before any step runs. The app offers it on a settled run of this device ([runs](../features/runs.md#acts)): `run/retry/from`. A run on Cloudflare (a TODO's, a repository's) doesn't offer it yet.

## Disposition

Built for runs on this device. Matrix row 41. Design: [the CI/CD parity proposal](../proposals/ci-cd-parity.md); engine semantics: `@smthrs/flow`'s guide `docs/guides/retry-from-a-step.md`.

## History

2026-10-20 22:50 PDT: written by the Claude Opus merger from the merged CI/CD parity proposal (Opus and Codex Sol designs, ruling FLOW-8).
2026-10-25 14:11 PDT: built by the flows-retry builder (ruling FLOW-11): `FlowRuntime.retryFrom` in the engine, `run/retry/from` and the inspector's Retry from here in the app.
