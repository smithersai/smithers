# Database alerts

The app's Postgres connections in use, and Hyperdrive's pools in front of it, are sampled once every 5 minutes. When the connections reach 80% of `max_connections`, or more than 10 clients waited for one config's pool connection 2 minutes in a row, the deployment's Admins get an alert by email and Telegram, where an Admin set them ([spend alerts' channels](spend-alerts.md#channels)). On 2026-10-22 at 01:55 PDT the production compute (a fixed 0.25 compute units, 112 connections) stopped accepting logins with 91 of them held, and nothing told anyone ([Connections](../infrastructure.md#connections)).

## How it works

```
any FlowExecution alarm, once done ──▶ start `ops/DatabaseLoad` for this window (once per window per isolate)
                                          │ one execution per window: database-load-300000-<window start ms>
                                          ▼
FlowExecution ── ops/SampleConnections: client connections in use, max_connections (pg_stat_activity)
                    │ database.connections line · smithers_database_connections gauge
                    ├─ under 80% ──▶ done: email none, telegram none
                    ▼ 80% or more
                 ops/DeliverDatabaseAlert × { email, telegram } (one step per channel)
                    │ alert_channels row? ── none ─▶ off
                    ▼
                 Channels.send ─▶ "Database connections high" and the app's link
                    │ alert_deliveries receipt: sent · refused · failed (the engine retries)
                    └─▶ Settings: "Telegram chat · Sent · 1 min ago"
```

1. **Start.** Each `FlowExecution` alarm, once it is done, whatever it did, starts its window's `ops/DatabaseLoad` through `FlowStarter` (`worker/Executions.ts`, `DatabaseLoad.sampler`, `ExecutionHost.make`'s `afterAlarm`). Windows are 5 minutes long (`DatabaseLoad.WINDOW`), laid end to end from the epoch, so every alarm in a window starts the same execution, and starting it again is a no-op. Each isolate remembers the window it last started (`Flows.startEachWindow`, shared with spend alerts), so a busy isolate starts it once per window. A start the host refuses is an Error line and a count (`not_started`), the next alarm starts it again, and the alarm itself goes on.
2. **Sample.** `ops/SampleConnections` reads, in one query on the app's Postgres, the client connections in use and `max_connections`, and whether in use reached `ALERT_PERCENT` (80, `infra/Connections.ts`) of it. Postgres failing fails the step, which retries from a second, doubling to a minute, without giving up.
3. **Hyperdrive's pools (`ops/DatabaseLoad/v2`).** Each window's sampler starts `ops/DatabaseLoad/v2` (`database-load-v2-<window ms>-<start ms>`); `ops/DatabaseLoad` stays registered so a run in flight at the deploy resumes. When the deployment has `HYPERDRIVE_METRICS_TOKEN` (a Cloudflare API token with Account Analytics: Read) and `CLOUDFLARE_ACCOUNT_ID`, the same step reads `hyperdrivePoolSizesAdaptiveGroups` from Cloudflare's GraphQL Analytics API for the 7 minutes ending now: each minute, the most clients waiting at each config's busiest slice (`worker/HyperdrivePool.ts`; the configs in `HYPERDRIVE_CONFIG_IDS`, which ChatApi binds). More than 10 waiting for 2 minutes in a row counts the sample as over. Postgres never sees a client that waits at Hyperdrive, so the connection count alone missed the saturation of 2026-11-02 ([decision 0150](../decisions/0150-engine-database-pool.md)). Each read is a `database.hyperdrive` line (Info `calm`, Warn `saturated` or `failed`), the `smithers_hyperdrive_waiting_clients` gauge and `smithers_hyperdrive_pool_reads` by outcome. A read that fails never fails the sample. Without the token the pools aren't read.
4. **Alert.** Only when the sample is over, `ops/DeliverDatabaseAlert` runs once per channel, email and Telegram, as its own step, and records a receipt keyed by the execution id. Under the share the flow ends with both channels `none`.

## The sample

- **What counts.** Rows of `pg_stat_activity` whose `backend_type` is `client backend`: every session Hyperdrive, Electric, the deploy and Neon itself hold, each one against `max_connections`. A role without `pg_read_all_stats` sees another role's sessions with no `backend_type`, so those in a database count too; that counts a replication sender, such as Electric's one, as a connection, and misses none.
- **The share.** `ALERT_PERCENT` is the share the connection budget stays under (`CONNECTION_BUDGET`, [Connections](../infrastructure.md#connections)). With every client at its cap, in use stays under it; reaching it means a client is over its cap or something else holds connections, before the compute refuses logins. Neon sizes `max_connections` by the compute's largest size, so the alert reads the server's own number, not the budget's.
- **When no login works.** The sample needs a connection, and so does the engine that runs it. A compute that accepts no login at all can't be sampled: the alert is the warning before that.

## The alert

- **The message.** Subject `Database connections high`; text, the link to the app (the `app_url` the channel's setting holds). A shared channel carries no numbers ([decision 0149](../decisions/0149-shared-alert-channels-carry-no-private-content.md)): the counts are in the `database.connections` log line and metrics. Telegram gets both as one plain-text message.
- **Delivery.** The same as a spend alert's ([Delivery](spend-alerts.md#delivery)): `worker/flows/AlertDelivery.ts` holds what both flows' delivery steps do. At least once, `irreversible`, keyed by the alert and the channel; email carries the execution id as Resend's `Idempotency-Key`. A refusal is recorded and never tried again; a failure another attempt may clear retries for a day. No channel set: `off`, no receipt.
- **How often.** Every window that is over alerts: an overload that lasts an hour sends 12. Settings lists the receipts with the spend alerts' (the latest 10).

## Every alarm, every window

A `FlowExecution` object keeps a settled execution a day, and its last alarm then also starts the window it falls in. So the sample runs at least once a day even when nothing else runs. The sample's own alarm starting its window again costs it one alarm that drives nothing: the same intent, which the object answers with its settlement.

## Records

`database.connections` (Info under the share, Warn at it or past it, Warn for a failed sample, Error for a start the host refused), its span, `smithers_database_connections` and `smithers_database_max_connections` (gauges), `smithers_database_load_samples` by outcome, and the delivery's `database.alert.delivery` and `smithers_database_alert_deliveries` ([observability.md](../observability.md#database-load)). They carry counts and the ratio, never a query, a role, an address or a chat id.

## Not built

- **An alert in the app.** There is no table of database alerts, so no toast: the channels and their receipts are the delivery.
- **A window or share setting.** `DatabaseLoad.WINDOW` and `ALERT_PERCENT` are constants; `DatabaseLoad.registration` takes another share (`{ percent }`), which the tests use.

## Files

| File | What it holds |
|---|---|
| `worker/flows/DatabaseLoad.ts` | `ops/DatabaseLoad`: the sample, its records, the alert's words, the delivery step and the start once a window (`sampler`) |
| `worker/flows/AlertDelivery.ts` | what every alert's delivery step does on one channel: the receipt, the setting, the send, refusal against retry, and its records |
| `worker/Flows.ts` | `windowAt` and `startEachWindow`, the start once a window spend alerts share |
| `worker/ExecutionHost.ts` | `remote` registers the flow; `make`'s `afterAlarm` runs the start after each alarm |
| `worker/Executions.ts` | the `FlowExecution` Durable Object: each alarm's start, with the window remembered once per isolate |
| `infra/Connections.ts` | `ALERT_PERCENT`, and the budget it bounds |

## Tests

| Test | Proves |
|---|---|
| `worker/flows/DatabaseLoad.test.ts` "the sample" | on the compose Postgres: in use and `max_connections` as the server reports them; held connections counted and over the share they reach; the share's boundary (90 of 112 is over, 89 is not); a role without `pg_read_all_stats` still counts the sessions it can't see the kind of; its line, gauges, count and span; Postgres unreachable fails it `SampleFailed`, by code |
| `worker/flows/DatabaseLoad.test.ts` "ops/DatabaseLoad on the Node host" | under the share it sends nothing with both channels set; over it, one email and one Telegram message with the numbers and the link, and both receipts keyed by the execution id |
| `worker/flows/DatabaseLoad.test.ts` "the delivery step" | off; run again, one message and one receipt; a refusal recorded with its reason, naming no chat or token; `unconfigured`; irreversible, keyed by the alert and the channel |
| `worker/flows/DatabaseLoad.test.ts` "the start once a window" | one start per window with the window as payload; a start the host refuses is an Error line and a count, and the next alarm starts it |
| `worker/Flows.test.ts` | windows end to end; one start per window and the next window's; a conflict counts as started; a refused or dying start reported by its code and started again |
| `worker/ExecutionHost.test.ts` "afterAlarm", "ops/DatabaseLoad" | `afterAlarm` runs after an idle and a settling alarm; an alarm starts the window's sample on its own object, which samples once, and its own alarm's start of the same window samples nothing more |
| `worker/flows/SpendAlert.test.ts` | the shared delivery keeps every spend alert behavior: unchanged tests |
