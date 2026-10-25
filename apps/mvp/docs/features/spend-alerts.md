# Spend alerts

Any model spend alerts the deployment's Admins, at most once a window: by email and Telegram where an Admin set them, and as an entry in the notifications panel (the bell), never a toast that takes page space. Will, 2026-10-19: "anybody using the app at all shoujld alert me because we have 0 users we will configure it as we grow" ([decision 0008](../decisions/0008-auth.md) §11, question 3); 2026-10-20, on where alerts go: "configurable but atm i think alerts to email make sense but telegram too would be useful". The alert carries the window's tokens and estimated cost by role, and today's tokens against the daily budget.

## How it works

```
POST /api/model/<role> ── admitted ──▶ start `ops/SpendAlert` for this window (once per window per isolate)
                                             │ one execution per window: spend-alert-<window ms>-<window start ms>
                                             ▼
FlowExecution (Durable Object) ── sleep until the window ends ── claim the ledger's uncarried calls, record one alert
                                                                             │ spend_alerts row, audience admin
GET /api/shapes/spend-alerts ◀── Electric ◀──────────────────────────────────┤
  └─▶ an Admin's devices ──▶ an entry in the notifications panel: "Model spend · agent · 12,340 tokens · $0.02"
                                                                             ▼
                                    ops/DeliverSpendAlert × { email, telegram } (one step per channel)
                                       │ alert_channels row? ── none ─▶ off
                                       ▼
                                    Channels.send ─▶ Resend POST /emails · Bot API sendMessage
                                       │ alert_deliveries receipt: sent · refused · failed (the engine retries)
GET /api/shapes/alert-deliveries ◀── Electric ◀─┘ ──▶ Settings: "Telegram chat · Sent · 1 min ago"
```

1. **Start.** When the model endpoint admits a call (its budget reservation succeeded), it starts its window's `ops/SpendAlert` through `FlowStarter` (`worker/ModelSpend.ts`). Windows are `MODEL_SPEND_ALERT_WINDOW` long, laid end to end from the epoch, so every call in a window starts the same execution, and starting it again is a no-op. Each isolate remembers the window it last started, so a burst costs one start per isolate. A start the host refuses is logged and counted (`not_started`), and the next call starts it again; the call itself goes on. A refused call (`401`, `403`, `429`) spends nothing and starts nothing. A server flow's own call (`ModelEndpoint.local`: a `todo` run's agent, triage's and a head's review's judge) starts it the same way, through the `FlowStarter` its `FlowExecution` object builds from the alarm it runs in (`Executions.starter`), so a window whose only spend is a TODO run still alerts.
2. **Wait.** The flow sleeps on a durable timer until the window ends (`ops/SpendAlertIn`, sealed, on the host's clock).
3. **Record.** `ops/RecordSpendAlert`, in one transaction, claims every `model_usage` row made before the window's end that no alert has carried (`spend_alert_id`), and records one `spend_alerts` row with their calls, tokens charged, and estimated cost, in total and by role, plus today's committed tokens and the budget. A call still running counts at its reservation. A window whose calls an earlier alert carried records nothing (`none`). Run again, the step returns the alert it recorded and claims nothing more. Postgres failing fails the step, which retries without giving up.
4. **Deliver.** `GET /api/shapes/spend-alerts` syncs every alert to a person with the Admin role and to nobody else: a Member, a Guest, an agent acting for an Admin and a signed-out request receive 403 without contacting Electric. An Admin's bell counts each alert it hasn't hidden, and the notifications panel shows it newest first. Spend alerts never appear as in-app toasts or reserve page space. Hide marks that alert and every earlier one seen on that device, kept through a reload; a later alert still shows.
5. **Send.** Once the alert is recorded, `ops/DeliverSpendAlert` runs once per channel, email and Telegram, as its own step. Each sends to the destinations an Admin set ([Channels](#channels)) and records a receipt.

Cost is `Pricing.cost` from `@smthrs/model`: the rate card of the call's model, or the provider's own charge when it reported one. A call's charge beyond what the model reported (a reservation it kept because its usage is unknown) is priced as output, the dearer kind. A model the rate card doesn't price has no cost, and neither has its role or the alert; its tokens still count.

The alert is a durable record delivered through the bell and the configured channels below.

## Channels

An Admin sets where alerts go outside the app at **Settings** (`/app/settings`, the header's Settings link; a Member sees the page too, for their own model, but not this section): email addresses, and one Telegram chat. A channel is on once it has a destination; clearing the field turns it off. The setting is the deployment's, not a person's.

```
Settings ── Save ──▶ alert/channel { channel, destinations }      (the tab's engine; retried an hour while offline)
                       └─▶ POST /api/alert-channels ──▶ alert_channels row (none: the row is deleted)
                                                          └─▶ GET /api/shapes/alert-channels ──▶ the fields
```

- **Who:** an Admin acting in person. An agent, flow or sandbox acting for them is refused `403 person_only` (`alert/channel` is person-only in the registry); any other role `403 forbidden`; signed out `401`.
- **Email:** 1 to 10 addresses, one `@` and a dotted domain each, separated by commas or spaces. **Telegram:** one chat id: a person's or a group's number, a supergroup's `-100…`, or a public channel's `@username`. The fields check the same rules before Save (`type="email" multiple`, and a `pattern`); the route checks them again with `@smthrs/notifications`' `isEmailAddress` and `isTelegramChatId` (`400 invalid_destination`). Blanks and repeats are dropped.
- **The link:** each message links to the deployment’s configured `ALERT_APP_URL`, independently of the origin the Admin saved from.
- **The message:** short. The subject is the notification's words, `Model spend · 12,340 tokens · $0.02`; the text is the window (`15:00–15:15 UTC, 2026-10-20`), the three roles that spent most (`agent 12,000 · judge 340`) and the link. Telegram gets both as one plain-text message, link previews off.
- **Saving:** HTTP 408 and 429, network failures and server failures retry durably for up to an hour; other 4xx responses are final. The Save button's flow runs at once on the tab's engine; `Saving` shows beside the button until it lands, and `Not saved` if ChatApi refused it, until the next Save.
- **Editing:** a synced channel update preserves the field's unsaved destinations and focus; untouched fields follow the synced setting.

### Delivery

`ops/DeliverSpendAlert { alertId, channel, outcome }` sends through `@smthrs/notifications`' `Channels` (library catalog: "Send a person a short message by email or Telegram from a durable step"). What it does on one channel is every alert's delivery (`worker/flows/AlertDelivery.ts`): [database alerts](database-alerts.md) and [sandbox spend alerts](sandbox-budgets.md#the-spend-alert) deliver the same way, to the same channels, with receipts in the same table.

- **Email: Resend.** One `POST /emails` per alert with the alert's id as its `Idempotency-Key`, so a retried step sends one email. Resend was picked because a Worker reaches it with one `fetch` (no SMTP, no binding, so the same code runs on any host and a test points it at a local server), and its idempotency key makes the engine's retries safe. Postmark and MailChannels have no idempotency key; Cloudflare Email Routing's `send_email` is a Worker binding that reaches only verified addresses and can't be pointed at a local fake.
- **Telegram: the Bot API's `sendMessage`.** It has no idempotency key, so a host that dies after Telegram took the message and before the step recorded it sends it again.
- **At least once, declared.** Each channel's send is the step's one write, so the step is `irreversible` with the alert and the channel as its key: the engine runs it again after a host died mid-send rather than stop it, because a duplicate alert beats a lost one ([durable external effects](../proposals/durable-external-effects.md)).
- **Receipts:** one `alert_deliveries` row per alert and channel: `sent` with the provider's id; `refused` with the code and the provider's short reason (`Bad Request: chat not found`), never tried again; `failed` while the engine retries. A refusal includes a channel the deployment has no key for (`unconfigured`) and a stored destination the channel can't take (`invalid_destination`). A step run again after its receipt says `sent` or `refused` sends nothing.
- **Retries:** a send another attempt may clear (unreachable, a timeout, 5xx, 408, 409, 429) fails the step, and the engine retries it from 5 seconds, doubling to 10 minutes, for a day; a 429's `Retry-After` replaces the backoff. Each attempt updates the receipt and its `attempts`. Postgres failing is `DeliverUnavailable`, retried the same way.
- **Off:** no `alert_channels` row for the channel, or no alert recorded: nothing is sent and no receipt written.
- **Shown:** Settings lists the latest 10 receipts, newest first: the channel, `Sent`, `Refused · <reason>` or `Retrying · <code>`, and when.

| Variable | Default | |
|---|---|---|
| `ALERT_EMAIL_API_KEY` | unset: no email | a Resend API key, a deployment secret |
| `ALERT_EMAIL_FROM` | `Smithers <onboarding@resend.dev>` | the sender; Resend's test sender reaches only the Resend account's own address, so set one on a domain Resend verified to reach anyone else |
| `ALERT_APP_URL` | required | absolute HTTP or HTTPS app URL without credentials; a missing or invalid value refuses destination saves with 503 |
| `ALERT_EMAIL_API_URL` | `https://api.resend.com` | Resend's origin |
| `ALERT_TELEGRAM_BOT_TOKEN` | unset: no Telegram | a bot's token from @BotFather, a deployment secret. The bot reaches a person only after they started a chat with it, and a group once it is a member |
| `ALERT_TELEGRAM_API_URL` | `https://api.telegram.org` | the Bot API's origin |

ChatApi reads `ALERT_APP_URL` when saving destinations. FlowExecution reads the provider settings when its Durable Object starts. Neither key is ever in a row, a payload, a log line, a span or a metric. Under `alchemy dev` (`worker/DevChatApi.ts`), a provider whose URL is set and whose key isn't sends with the key `dev`, so a local stand-in takes it: the end-to-end test runs that way.

## What each call records

Every call the endpoint meters, and every call a server flow makes through `ModelEndpoint.local`, records what the model reported: `smithers_model_spend_tokens` and `smithers_model_spend_usd`, by `role` and `model`, and a `model.spend` line ([observability.md](../observability.md#spend-alerts)). A call that reported no tokens and no cost records nothing.

## Settings

| Variable | Default | |
|---|---|---|
| `MODEL_SPEND_ALERTS` | on | a boolean (`true`, `false`, `on`, `off`, …): whether any spend alerts. `alchemy dev` defaults it to off (`worker/DevChatApi.ts`), because a laptop's runs and the end-to-end tests spend all day; setting it turns them back on |
| `MODEL_SPEND_ALERT_WINDOW` | `15 minutes` | a duration of at least a second: one alert per window at most |

A deploy reads both when ChatApi starts. A deploy that sets nothing alerts. Each deploy, and the dev database, needs migrations `0019_spend_alerts` and `0029_alert_channels` (`pnpm db:migrate`) before the shapes can sync.

## Acting on an alert

- **Lower the budget:** set `MODEL_DAILY_TOKEN_BUDGET` and deploy ([model endpoint](model-endpoint.md#configuration)). Once today's committed tokens reach it, every call is refused `429 quota_exceeded`.
- **Use a cheaper model:** `admin/SetModel` changes a role's model on the next call ([model endpoint](model-endpoint.md#roles)).
- **Stop asking:** sign-in decides who may ask; a person without the Member role can't ([sign-in](sign-in.md)).

Blocking a network and pausing asking without a deploy are not built ([todo.md](../todo.md#alerts-on-token-spend)).

## Not built

- **Budget thresholds** (50%, 80% and 100% of the day's budget) as alerts of their own. Each alert already carries today's tokens and the budget.
- **Code Storage spend.** `@smthrs/effect-code-storage` reports no usage (Code Storage has no usage API); the app meters it itself and logs `repo.spend.alert` ([repo.md](repo.md#spend)), which doesn't reach Admins yet.
- **Other channels** (Slack, SMS, a webhook): `Channels` takes a new provider beside email and Telegram.

## Files

| File | What it holds |
|---|---|
| `worker/ModelSpend.ts` | the per-call records, the settings, and the start of a window's alert (`Flows.startEachWindow`, with the windows, in `worker/Flows.ts`) |
| `worker/flows/SpendAlert.ts` | `ops/SpendAlert`: the wait, the claim and the alert |
| `worker/flows/AlertDelivery.ts` | what every alert's delivery step does on one channel, shared with [database alerts](database-alerts.md) |
| `worker/SpendAlerts.ts` | `GET /api/shapes/spend-alerts`, Admins only |
| `worker/ModelEndpoint.ts` | calls `ModelSpend.record` when a call ends and the alert start when one is admitted |
| `db/migrations/0019_spend_alerts.ts` | `spend_alerts`, and `model_usage.spend_alert_id` |
| `src/features/spend/` | the browser: the synced alerts, the device's mark, the panel entries and Hide; the channels, their receipts and `alert/channel` (`flows.ts`, `steps.ts`, `api.ts`) |
| `worker/AlertChannels.ts` | `POST /api/alert-channels`, the channels' and receipts' shapes, and the providers from the environment (`channelsConfig`) |
| `src/features/spend/components/AlertSettings.tsx`, `src/screens/settings/` | Settings: the two fields, Save, and the receipts |
| `db/migrations/0029_alert_channels.ts` | `alert_channels` and `alert_deliveries` |

## Postgres

| Table | Columns | |
|---|---|---|
| `spend_alerts` | `id` (key: the execution id), `kind` (`model`), `audience` (`admin`), `window_start`, `window_end`, `calls`, `tokens`, `cost_usd` (null when a model isn't priced), `roles` (jsonb: `role`, `calls`, `tokens`, `costUsd` each), `day_tokens`, `budget`, `created_at` | one row per alert; synced to Admins without `audience` |
| `model_usage.spend_alert_id` | the alert that carried the call; null until one did. Rows from before migration `0019` read `before_spend_alerts` | partial index on `created_at` where null |
| `alert_channels` | `channel` (key: `email` or `telegram`), `audience` (`admin`), `destinations` (jsonb, 1 to 10 strings), `app_url`, `updated_by`, `updated_at` | one row per channel that is on; synced to Admins without `audience`, `app_url` or `updated_by` |
| `alert_deliveries` | `alert_id` and `channel` (key), `audience`, `status` (`sent`, `refused`, `failed`), `code`, `reason` (the provider's, at most 120 characters), `http_status`, `provider_id`, `attempts`, `created_at`, `updated_at` | one receipt per alert and channel; synced to Admins without `audience` or `provider_id` |

## Tests

| Test | Proves |
|---|---|
| `worker/ModelEndpoint.test.ts` "a server flow's own calls" | given the host's starter, a server seat's admitted calls start their window's alert once a window; a refused call, a seat with no starter or alerts off start none |
| `worker/ModelSpend.test.ts` | each call's tokens and cost by role and model, a provider's own charge, an unpriced model, no usage; production's default is on and starts its window's alert once with the window and budget; a refused call starts nothing; the dev default is off, the setting turns it back on and off; the window setting; a start the host refuses or that dies is logged by code and retried by the next call, and one already started counts as started; the settings' bounds |
| `worker/Flows.test.ts` | the windows, laid end to end from the epoch, and the start once a window both alerts use |
| `worker/flows/SpendAlert.test.ts` | on the Node host: waits for the window to end, then one alert with each role's calls, tokens and cost, carrying only uncarried calls from before the window's end; an unpriced model; a step run again; a window with nothing to carry; its records; Postgres failing |
| `worker/ExecutionHost.test.ts` "the deployed flows run ops/SpendAlert" | the deployed host's flows include it: a model call starts it, its alarms wait out the window, and it records the alert |
| `worker/SpendAlerts.test.ts` | a model call starts the alert, the flow records it, and the compose Electric syncs it to an Admin; a Member, an agent for an Admin and a signed-out request receive 403 without contacting Electric; sessions unreadable is 503 |
| `src/features/spend/spend.test.ts` | an Admin's tab shows alerts newest first, Hide marks earlier ones seen, kept through a reload, another device unaffected; a Member's tab syncs none; server-side demotion hides retained alerts, settings and receipts through reload; independent deployments at one origin; the notification's words |
| `src/features/spend/source.test.ts` | permission checks preserve the source's replay-cache namespace, including its absence |
| `db/Database.test.ts` "0019_spend_alerts" | earlier calls are marked carried; the table's bounds |
| `packages/smithers/notifications/test/Channels.test.ts` | Resend's and the Bot API's requests against a server on loopback; every status classified once; `Retry-After` and `retry_after`; no redirect followed; the key and the token in no failure or span; unreachable and timeout by an injected `fetch`; destinations and messages checked before any request (100% coverage) |
| `worker/flows/SpendAlert.test.ts` "delivers outside the app" and "the delivery step" | on the Node host: once the window ends, one email and one Telegram message with their bodies and receipts; nothing for a window with nothing to carry; off, missing, a step run again, a refusal with its reason, `unconfigured`, an invalid stored destination, a provider that is down (a faulty `Channels`, injected) then up, and Postgres failing; no record names an address, a chat or a token |
| `worker/AlertChannels.test.ts` | an Admin sets, replaces and clears each channel; every refusal (signed out, Member, an agent for an Admin, invalid input, too large, another method, Postgres failing); the shapes to Admins only; the providers from the environment, and the dev key |
| `src/features/spend/spend.test.ts` "an Admin's alert channels" | Save on a tab's engine sets both channels and they sync back; a refused save shows Not saved; a Member's is refused and syncs nothing; a delivery's receipt syncs, the latest 10 first; the message's and a receipt's words |
| `tests/AlertSettings.test.ts` | a synced email or Telegram update preserves the unsaved field, its element and focus; Save submits the draft; untouched fields follow sync |
| `e2e/alert-channels.spec.ts` | in a real browser against `alchemy dev`: Settings, both channels saved, a question that spends, and both receipts `Sent` with the local providers holding the email and the Telegram message; clearing Telegram turns it off (dev server started with `MODEL_SPEND_ALERTS=true`, a short window and the providers' URLs; skipped otherwise and against a deployment) |

### Shape access and outage recovery (2026-10-22)

The browser waits for a confirmed Admin session before sending spend-alert, channel or delivery shape requests, and rechecks permission before every request. Members, Maintainers, Guests, signed-out people and agents acting for Admins receive 403 on direct requests, without Electric being contacted or a retry header. Cached Admin rows disappear from queries as soon as permission is lost. A demoted person's reload confirms their current server role before showing retained data; alerts, settings and receipts stay hidden and no shown-alert count is emitted. The permission-checking source preserves the wrapped source's replay-cache namespace, so simulated devices cannot inherit another deployment's Electric cursor. A later confirmed Admin session reconnects the client's stopped shapes. An unreadable session remains 503 with Retry-After; it never changes the shape definition under a stored handle. These routes share ChatApi's Electric connection configuration; the confirmed defect was unconditional subscriptions and empty shapes for non-Admins, not a separate shape binding. The historical production 503's dependency cannot be proven from the old records.
