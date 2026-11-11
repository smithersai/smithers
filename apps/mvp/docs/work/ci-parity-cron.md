---
title: CI parity: scheduled flows
status: review
area: sdk
owner: none
updated: 2026-11-10
links: [../proposals/ci-cd-parity.md, cloudflare-flow-host.md, ../features/remote-flows.md, ../features/ci.md]
---

## What

Start repository flows on cron schedules while every device is off.

## Why

Six live workflows run on crons: Smithers' canary and reliability, Tevm's nightly conformance and auto-update, Effect's npm-promote and ai-codegen. `@smthrs/triggers` has `Trigger.make`, `Cron`, overlap and catch-up, but nothing in the app runs it (`worker/github/Reconcile.ts:19`). `Scheduler.layer` forks a fiber that runs forever, which a Durable Object can't host and DUR-3 forbids.

## Repositories

Smithers, Tevm, Effect.

## Smallest slice

`{ on: "cron", cron, timezone }` triggers stored through `SqlTriggerStore`. One `triggers/Tick` lineage on `FlowExecution`: a step calls `Scheduler.make(...).runOnce` with a runner that starts flows through `FlowStarter` under the key `<trigger>:<occurrence>`, then sleeps one minute durably and hands off. The started run's payload names the schedule that fired, as Smithers' canary needs to tell its hourly run from its quarter-hour ones.

## Disposition

Build now, 14 of 18. Matrix row 7. Design: [the CI/CD parity proposal](../proposals/ci-cd-parity.md).

## Built (issue #4607)

Library catalog entry: "Start flows on a cron" (`@smthrs/triggers`). The design follows the smallest slice above, with `Scheduler.tick` in place of `Scheduler.make(...).runOnce`: a scheduler built for each tick never fired a trigger that hadn't fired, and closing its scope cut its launches off ([package api](../../../../packages/smithers/agent/triggers/docs/api.md#schedulertick)).

- `worker/ci/Triggers.ts`: a `cron` row is `{ on: "cron", flow, title?, ...Schedule.Schedule.fields }` from the package, five fields only; `schedulesOf` reads them as `triggersOf` reads the rest.
- `worker/ci/Cron.ts`: `triggers/Sync` (`triggers/Register`), started by the webhook for a default-branch push with `REPO_FLOWS` on, registers the active flows' rows in `SqlTriggerStore` (schema `smithers_triggers`) and disables the rows the manifest dropped. `triggers/Tick { from, until }`, one per minute window, started by every `FlowExecution` alarm: `triggers/Since` (the store's heartbeat), `triggers/Fire` (`Scheduler.tick`), then a durable sleep to the window's end, whose alarm starts the next window's tick. The runner starts `repo/Run` at the default branch's head with `event: "schedule"` and `{ schedule: <cron> }`, one execution per trigger and occurrence; `inspect` reads the run's row, `cancel` stops its execution.
- A run's event `schedule`: `RUN_EVENTS`, `RunRequest.event`, `CloudTrigger`, migration `0118_scheduled_runs`.
- `@smthrs/triggers`: the `TriggerError` code `runner_unavailable`, so a start GitHub or the host couldn't make waits for the next tick instead of failing its occurrence.
- Docs: [CI schedules](../features/ci.md#schedules), with where to look when a schedule did not fire.

Not built: the canary's and the other live workflows' ports onto `cron` rows; a `FACTORY.ts` declaring them (`Trigger.bind`); `github/Reconcile` on a cron (decision 0012 W9 names it its own change); a view of a repository's schedules and their next occurrences (`DispatchReader`); pruning the fire ledger on a schedule (each tick prunes at most hourly, as the package does). Production proof needs a deploy with `REPO_FLOWS` on.

## History

2026-11-10: built on the app (issue #4607): cron rows on the package's schema, `triggers/Sync`, `triggers/Tick` on `Scheduler.tick`, the `schedule` run event, `runner_unavailable` in `@smthrs/triggers`. Status `review`.

2026-10-20 22:50 PDT: written by the Claude Opus merger from the merged CI/CD parity proposal (Opus and Codex Sol designs, ruling FLOW-8).
