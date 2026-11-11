---
title: "Schedule a build target"
description: "Declare a schedule with S.Cron in PACKAGE.ts and let smthrs triggers serve run its targets: no cron line, with overlap rules, fire history, logs and cancellation."
---

A `PACKAGE.ts` declares a schedule with `S.Cron`. A host running
`smthrs triggers serve` (or `smthrs serve`) registers it as a durable trigger
and runs its targets through the build when it is due. Nothing else is
installed: no cron line, no service unit, no lock file.

## Declare the schedule

```ts
import { Smithers as S } from "@smthrs/targets"

const census = S.Shell.Run({ shell: "node scripts/coverage-census.mjs" })

export const Package = S.Package({
  targets: {
    census,
    coverageCensus: S.Cron({ schedule: "*/10 * * * *", run: [census] })
  }
})
```

`run` lists targets, not label strings, and every entry must be listed in a
`Package` map so it has a label. `refresh` targets, when declared, run first;
the `run` targets start only after they succeed.

## Run the scheduler

```bash
smthrs triggers serve
```

The host reads the workspace's `S.Cron` targets as it starts and registers each
one under its label:

```bash
smthrs triggers list --json
```

```text
[{"id":"//:coverageCensus","flowId":"system/target-run","input":{"run":["//:census"],"declaredBy":"//:coverageCensus"},"cron":"*/10 * * * *","overlap":"skip","catchUp":"none","maxCatchUp":0,"enabled":true,"revision":1}]
```

When an occurrence is due the host starts `smthrs target //:census` in the
project, exactly as you would by hand. To pick up a changed `PACKAGE.ts`
without restarting the host, or to check a declaration before serving it, run:

```bash
smthrs triggers sync
```

`sync` registers new and changed declarations and disables a registration whose
declaration was removed. A disabled registration keeps its history, and
declaring it again enables it. `smthrs triggers disable <label>` survives a
sync, and triggers registered by hand are never touched.

## What a run is

The build executes a scheduled target; Control does not, so there is no plan to
approve. Each occurrence is one row in the project's control database:

| Fact | Where |
| --- | --- |
| The active run and its state | `smthrs triggers show <label>`, under `activeTargetRun` |
| The command's output | `.flows/logs/target-run_<label>_<occurrence>.log` |
| Past occurrences and their outcome | the trigger's fire history |

An occurrence that arrives while the previous one is still running is skipped
(`overlap: "skip"`). A run whose host dies is taken over by the next scheduler
that finds its lease expired, about 30 seconds later, and its command starts
again. A scheduled target therefore runs at least once per occurrence: write it
so that a repeat is safe. Cached targets such as tests are served from the
build cache when their inputs did not change; a `Shell.Run` target always runs.

## Fire it now

```bash
smthrs triggers fire //:coverageCensus
```

queues one occurrence for the running host, which is the quickest way to prove
a new schedule before its first calendar occurrence.

## Schedule targets without `S.Cron`

A trigger registered by hand may run targets too: give it the reserved flow
`system/target-run` and the labels as input.

```bash
smthrs triggers register census --flow system/target-run \
  --cron "*/10 * * * *" --input '{"run":["//:census"]}'
```
