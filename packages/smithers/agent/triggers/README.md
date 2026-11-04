# @smthrs/triggers

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/triggers/docs

Durable cron triggers and verified inbound channels for flows. A trigger is a
durable row: a flow id, a JSON input, and a cron expression. A channel is a
verified door: it authenticates raw request bytes and maps them onto a start or
a signal.

Nothing here executes a flow. A launch is handed to
[`@smthrs/control`](https://github.com/smithersai/smithers/tree/main/packages/smithers/control/docs), so a scheduled or webhook
started run gets exactly the authority a person starting it would get.

## Install

```bash
npm install @smthrs/triggers@next effect
```

It needs Node.js 22.19.0 or later and `effect` `4.1.0`. The full
requirements, the import forms, and the layers a running host adds are on
the [installation page](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/installation.md).

## The smallest declaration

```ts
import * as Trigger from "@smthrs/triggers/Trigger"

const nightly = Trigger.make({
  id: "nightly-report",
  flowId: "reports/nightly",
  input: { channel: "#ops" },
  cron: "0 3 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 1,
  enabled: true
})
```

`nightly` is an `Effect<Trigger, TriggerError>`. `Trigger.make` fills the policy
defaults and refuses a cron expression the calendar never satisfies. Registering
it in a `TriggerStore` makes it durable, and a running `Scheduler` fires it from
there. The [quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/quickstart.md) walks that
whole path, launch included, on a test clock.

## What the package does that a cron loop does not

- Coordinates claims when two hosts share a database. Lease recovery can retry
  the same occurrence, so preventing duplicate runs requires runner deduplication.
- Decides what a boundary means while the previous run is still going: skip it,
  remember the newest one, or cancel the run in flight and replace it.
- Bounds what a trigger owes after downtime, by a number the declaration states.
- Accepts an inbound request without handing it authority. A verified payload
  names a flow; it cannot widen what that flow may do.

Scheduled dispatch makes at-least-once launch attempts. `RunnerService.start`
must durably deduplicate by `idempotencyKey` and return the same run identity on
replay, including across host restarts.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/triggers/<Module>`. Every export, with its signature and its
guarantees, is on the
[API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/api.md).

| Namespace         | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `Trigger`         | The trigger declaration: a flow id, a JSON input, a schedule, and an enabled flag.           |
| `Schedule`        | The reusable schedule half of a declaration: cron, timezone, and the two policies.           |
| `Cron`            | Typed wrappers around Effect's cron: parse, next, previous, and a bounded occurrence search. |
| `Overlap`         | The pure decision for an occurrence that arrives while a run is in flight.                   |
| `CatchUp`         | The pure computation of what a trigger owes after downtime, bounded by its declaration.      |
| `TriggerStore`    | The durable state contract: registration, listing, the claim protocol, and results.          |
| `SqlTriggerStore` | The SQLite and PostgreSQL implementation of that contract, with its own migrations.          |
| `Scheduler`       | The Clock-driven poller, and the `Runner` port it launches through.                          |
| `DispatchReader`  | The `@smthrs/control` read port served from a store: trigger summaries and the fire ledger.  |
| `Channel`         | The authority-free inbound channel declaration: verify, then map to a start or a signal.     |
| `Webhook`         | A verified webhook door built on `Channel`, dispatching only through Control.                |
| `TriggerError`    | The one failure type, carrying a stable code and an optional field path.                     |

`@smthrs/triggers/test/TestTriggers` is an in-memory `TriggerStore` for tests.
It applies the same claim decision as the SQL store, with the same refusal
codes, lease timing, watermark rules, registration validation, and id-ordered
listings. It keeps no rows and applies no migrations, so a test about a schema
or a column shape needs `SqlTriggerStore`.

## Documentation

- [Overview](https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/triggers/docs)
- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/quickstart.md)
- [The claim protocol](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/concepts/claim-protocol.md)
- [Choose an overlap and catch-up policy](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/guides/choose-a-policy.md)
- [Ingest a verified webhook](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/guides/ingest-a-webhook.md)
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/triggers/docs/troubleshooting.md), which lists
  every failure code, what causes it, and what to change.

## License

MIT. See [LICENSE](./LICENSE).
