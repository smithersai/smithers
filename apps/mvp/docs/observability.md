# Observability

Every request, answer and sync in the app can be traced end to end, counted, and explained from its records alone, without adding a log line after the fact. This page is the contract. Code that adds a feature adds its entries here, and the tests under [Tests](#tests) enforce them.

Status (2026-10-19): every record below exists and is tested.

## Rules

- **No content, no credentials.** Diagnostics never carry a question, an answer, a prompt, a model key, a database password or the Electric secret. They carry ids, counts, durations, sizes, status codes, model ids and error codes. A failure is recorded by its code, and a defect by its name, never by its message. A test asks questions containing a sentinel string and fails if the sentinel appears in any log record, span attribute, event or failure, or metric attribute.
- **One id per answer, everywhere.** The answer id (`answerId`) appears on:
  - the browser's logs and spans;
  - the body of `POST /api/questions`;
  - ChatApi's `chat.question` log line and span, and the answer routes' `chat.answer.turn` and `chat.answer.write` lines and `chat.answer.request` span ([agent.md](features/agent.md#observability)).
  - `chat/Expire`'s `chat.answer.expire` line and span, by `answerId` (below).

  W3C trace context (`traceparent` on `POST /api/questions`) parents ChatApi's `chat.question` span when it is well formed: version `00`, 55 characters of lowercase hex, neither id all zeros. Its sampled flag is ignored, and `b3` headers parent nothing. ChatApi doesn't answer: the browser's agent does, in a run of its own, whose model calls and answer writes are requests of their own ([agent.md](features/agent.md#observability)).
- **Every log line names its trace.** ChatApi's log lines carry the current span's `trace_id` and `span_id` among their annotations (`Logger.layerStructuredJson` in `@smthrs/observability`), the same names as the browser records ChatApi relays, so a log search joins them by trace.
- **Every outcome is recorded, not just success.** Completion, failure, refusals, database errors and defects each have a log line, span attributes and a metric. Every Warn or Error line of ChatApi's own carries an `errorCode` or an `outcome` that says why.
- **Effect does the recording.** Logs are `Effect.log*` with annotations, spans are `Effect.withSpan`, metrics are `Metric`. The host decides where they go, so the same code records in a browser, a Worker and a test.

## Where it goes

```
browser tab ─── Effect logs, spans, metrics ── OTLP JSON (@smthrs/observability Otlp.layerFetch) ── POST /api/telemetry/v1/*
engine worker ── the same, only the spans the relay keeps ─────────────────────────────────────────┤
                                                                                                    │ OtlpRelay.serve
ChatApi Worker ── Effect logs, one JSON object per line ── Workers Logs (persisted) ◀──────────────┘ one line per record
               ── Effect spans ── Cloudflare.Telemetry() ── Workers Traces (persisted)
               ── Effect metrics ── the isolate's registry; every value is also a log line field
site Worker    ── Workers Logs + Traces (platform: requests and the service binding to ChatApi)
optional       ── Cloudflare.Workers.ObservabilityDestination: Workers Logs and Traces to any OTLP collector
```

- **Logs.** ChatApi installs `Logger.layerStructuredJson()` (`@smthrs/observability`) in its handlers, so Workers Logs indexes every annotation as a field, `trace_id` and `span_id` included. Both Workers persist logs (`observability.logs.persist` in `alchemy.run.ts` and `worker/ChatApi.ts`).
- **Traces.** `Cloudflare.Telemetry({ persist: true })` turns on Workers Traces for ChatApi and mirrors its Effect spans into Cloudflare's waterfall. The site Worker sets `observability.traces` directly.
- **Metrics.** Workers has no metric exporter in this stack, so ChatApi's Effect metrics live in the isolate and the tests read them. Every metric is also a field of a log line (the table below names it), so Workers Logs' query builder counts and percentiles them, for example p95 of `durationMs` over `chat.question` lines.
- **Locally**, `alchemy dev` writes each Worker's logs to `.alchemy/log/dev_<user>/<Worker>/`, and the browser's console shows its own records.

### Sending to your own collector

Not wired yet: today Cloudflare keeps the Workers' logs and traces, and nothing leaves the account. To also send them to an OTLP/HTTP collector (Grafana, Tempo, Loki, or a hosted vendor):

1. Give the collector a public HTTPS endpoint that accepts OTLP/JSON at `/v1/traces` and `/v1/logs` and requires an auth header. Cloudflare preflights the endpoint with a `POST` that may carry no body, so that request must get a `2xx`.
2. Declare one `Cloudflare.Workers.ObservabilityDestination` per signal in `alchemy.run.ts`: `logpushDataset: "opentelemetry-traces"` with `<endpoint>/v1/traces`, and `"opentelemetry-logs"` with `<endpoint>/v1/logs`, each with the auth header as a `Redacted` value. Read the endpoint and the header from `Config` (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`) and declare no destination when they're unset.
3. List each destination's slug in each Worker's `observability.traces.destinations` and `observability.logs.destinations`, then deploy.

The Cloudflare token needs Workers Observability Edit. Cloudflare doesn't export Workers metrics over OpenTelemetry, so the metrics arrive as the log fields named in the tables below. The browser's records leave the same way, as ChatApi's relayed log lines and spans.

## What is recorded

### Browser

`appLayer` (`src/boot.ts`) installs `Otlp.layerFetch` with `serviceName: "smithers-mvp-web"`, so every Effect log, span and metric on the app's runtime goes to `POST /api/telemetry/v1/*`, and the console keeps its own copy. Every chat record is annotated `feature: chat`; boot and page records `feature: app`.

Logs:

| Message | When | Level | Fields |
|---|---|---|---|
| `chat ready` | the conversation was restored from the device (or, without a device store, synced) | Info | |
| `chat couldn't restore` | the device store couldn't restore the conversation; it still syncs | Error | |
| `persistent storage requested` | boot asked the browser to keep the site's storage | Info | `granted` (`true`, `false`) |
| `question asked` | `ask` put a question into the outbox | Info | `questionId`, `answerId`, `question.length`, `queued` (whether the pill showed) |
| `question stored` | a send got the question into Postgres, this device's engine recorded the run that answers it, and Electric delivered it | Info | `questionId`, `answerId`, `taken` (`inserted`, or `existing` for a resend ChatApi answered 200) |
| `answer not started` | ChatApi took the question, but this device's engine didn't record the run that answers it; the outbox sends the question again | Warn | `questionId`, `answerId`, `reason` (`refused`, `unavailable` when this tab has no engine, `invalid`, `defect`, `interrupted` when the tab closed first) |
| `question not sent` | ChatApi refused it for good; it stays on the device, unsent | Warn | `questionId`, `answerId`, `reason` (`refused` 400, `conflict` 409, `too_large` 413), `status` |
| `question not admitted` | the outbox couldn't take it (another tab leads the outbox, so this one takes the lead and sends it once it leads; or its storage failed); it stays unsent until then | Warn | `questionId` |
| `unsent question handled` | Edit, Discard or Retry on an unsent question | Info | `questionId`, `action` (`edit`, `discard`, `retry`) |
| `queued question taken back` | the tab's side of Edit on a queued question (`chat/edit`) | Info, Warn for `failed` | `questionId`, `outcome` (`edited`, `sent`, `failed`) |
| `chat draft restored` | a reload put the kept draft back into the composer | Info | `draft.length` |
| `chat draft saving`, `chat draft stored`, `chat draft failed` | a private draft write waits for the device, commits or fails; `chat.draft.save` spans the wait and `smithers_web_draft_writes{stage}` counts each stage (`waiting`, `stored`, `failed`) | Info / Warn on failure | `transactionId`, `conversation` (`home`, `branch`); never text or an error message |
| `chat prompt shared` | the owner shared the branch shown, or took its last share away: the draft became the branch's prompt, or theirs again ([co-editing](features/coedit.md#the-prompt)) | Info | `shared` |
| `outbox write withdrawn` | `Outbox.withdraw` took a write back (`@smthrs/effect-tanstack-db`) | Info | none of the write's contents |
| `chat connection changed` | the connection pill changed | Info | `status` (`up`, `offline`, `failed`, `stopped`) |
| `browser.engine.unavailable` | this tab's engine is unavailable (`@smthrs/platform-browser` `BrowserEngine`): its worker threw, as when a module can't load in a worker (`reason: worker-failed`), or couldn't build the engine (`engine-failed`); or its sign-out wipe couldn't delete the device's stores (`worker-failed`, `error.type` `WipeUnfinished`, src/wipe.ts); the device store opens in memory and the pill says Smithers can't run here | Error | `reason`, `error.type` (the failure's name, never its message) |
| `chat retried` | Retry on the pill, the browser came back online, or the device was adopted in place by the person signed in ([sign-in](features/sign-in.md#the-devices-owner)) | Info | `via` (`button`, `online`, `adopted`) |
| `page error` | an uncaught error on the window | Error | `name`, `source` (`file:line:column`); never the message |
| `unhandled rejection` | a rejection nothing handled | Error | `name`; never the message |
| `page reloaded` | a page restored from the back/forward cache, just before it reloads | Info | none. It reaches the relay only if an export runs before the page unloads; the console always keeps it |
| `collection cleanup failed` | a collection's cleanup rejected as its scope closed (`@smthrs/effect-tanstack-db`) | Warn | `collection` (its id), `error` (the error's name, never its message) |
| `persistence unavailable` | the device store's database couldn't open, so rows stay in memory (`@smthrs/effect-tanstack-db`) | Warn | `error` (the error's tag) |
| `flows.editor.storage` | a flow editor's SQLite service could not open or its collection could not restore; editors refuse writes and keep retained rows for recovery | Warn | `collection` (`device`, `flow-form`, `flow-answers`, `flow-code`), `outcome` (`unavailable`, `failed`) |
| `persisted write failed` | the device couldn't store a write to a persisted collection, such as an unsent question, so it rolled back; TanStack DB fails one whose coordinator tab closed mid-write (`IndeterminateCommitError`) (`@smthrs/effect-tanstack-db`) | Warn | `collection` (its id), `operation` (`insert`, `update`, `delete`), `error` (the error's name, never its message) |
| `persisted sync role` | this tab's source for a synced collection took a role: `writer`, the one tab of the device that stores what the shape syncs (it holds the collection's lock, `persisted-sync:<id>`), or `watcher`, a tab whose rows come from the device store while its shape only tells it how the network is (`@smthrs/effect-tanstack-db`, decision 0002 §1) | Info | `collection` (its id), `role` |
| `outbox lock refused` | the browser's lock manager refused the outbox's lock request, so this tab doesn't lead; it asks again on its next focus (`@smthrs/effect-tanstack-db`) | Warn | `error` (the error's name) |
| `outbox write sealed` | a queued write another owner of this device queued was kept out of this tab's outbox as it loaded (`stage: load`), or came up to be sent after the tab's owner changed (`stage: send`); it stays in IndexedDB, never sent as anyone else (`@smthrs/effect-tanstack-db` `Outbox.Principal`, decision 0023 rule 6) | Warn | `name`, `stage`; never the write's rows |
| `outbox couldn't load its writes` | the outbox's storage couldn't be read at start (`@smthrs/effect-tanstack-db`) | Warn | |
| `outbox write failed` | a send died with a defect; it is never sent again (`@smthrs/effect-tanstack-db`) | Error | `name`, `outcome: defect` |
| `session loaded` | the tab learned who is signed in (`features/auth`) | Info | `feature: auth`, `signedIn`; never the login |
| `session unreachable` | ChatApi couldn't say who is signed in | Warn | `feature: auth`, `status` when ChatApi answered outside the contract |
| `sign in pressed` | Sign in with GitHub pressed | Info | `feature: auth` |
| `signed out` | ChatApi ended this browser's session | Info | `feature: auth` |
| `sign out failed` | ChatApi didn't end it; the person stays signed in | Warn | `feature: auth`, `status` when ChatApi answered |
| `device wiped` | after a sign-out ChatApi took, the host wiped this device's synced data and outbox (the browser's reloads, and its next boot deletes them) | Info | `feature: auth` |
| `device wipe failed` | the host couldn't wipe the device; the person is still signed out | Warn | `feature: auth` |
| `auth.session_refresh` | a session check starts: as the app opens, when the browser comes back online, or when `auth/refresh` asks again ([sign-in](features/sign-in.md#when-chatapi-cant-say)) | Info | `via` (`startup`, `online`, `retry`) |
| `auth.refresh` | a check ChatApi couldn't answer started `auth/refresh`; how it ended is dispatch's `flow.dispatch` line | Info | `feature: auth`, `stage: started` |
| `timeline.summary.unavailable` | the timeline couldn't get an entry's summary (`timeline/summarize` failed); the entry shows without one | Warn | none |
| `timeline.summary.unconfigured` | the summary role has no model, so the timeline stops asking until the app opens again | Warn | none |
| `slash.run` | a slash command ran its flow from the composer ([slash commands](features/slash-commands.md)); the flow's own record is `flow.dispatch`, door `slash` | Info | `feature: commands`, `command`, `flow`; never the arguments |
| `slash.refused` | a line naming no command, or missing or misusing an argument, stayed in the composer | Warn | `feature: commands`, `outcome` (`unknown`, `missing`, `invalid`), `command` when the app offers it; never what was typed |

Every send runs inside the outbox (`@tanstack/offline-transactions`), a library that calls the `ask` mutation. The mutation runs with the services captured when the store was built, so it reaches the same exporter as every other record, and its `HttpClient` sends the trace to ChatApi. A send's trace is its own; it links to the ask's span.

Spans:

| Span | Kind | Attributes |
|---|---|---|
| `chat.ask` | internal: `ask` putting the question into the outbox, synchronously | `questionId`, `answerId`, `question.length` |
| `outbox.send` | internal: one send of one write (`@smthrs/effect-tanstack-db`), linked to the span the write was made in (`chat.ask`) | `name` (`ask`), `attempt` (1 for the first send), `outcome` (`sent`, `retry`, `refused`, `defect`, `withdrawn`) |
| `outbox.withdraw` | internal: Edit taking a queued question back out of the outbox (`Outbox.withdraw`) | `outcome` |
| `chat.copy`, `chat.edit` | internal, in the engine worker: `chat/copy`'s and `chat/edit`'s steps asking the tab that started the run ([chat](features/chat.md#message-controls)); each is also a log line of the same name, Info when copied or edited, Warn for `not_found` or `sent`, Error for `failed` or `gone` | `smithers.chat.door`, `smithers.chat.outcome`; the log line's `door`, `outcome`, `executionId`, `durationMs` |
| `chat.ask.send` | internal, child of `outbox.send`: from asking ChatApi, through this device's engine recording the answer's run, to Electric delivering the question | `questionId`, `answerId`, `taken` |
| `chat.question.post` | internal, child of `chat.ask.send` | `http.response.status_code` |
| `POST` | client (Effect `HttpClient`), child of `chat.question.post` | `url.full`, `http.response.status_code`; sends `traceparent`, which parents ChatApi's `chat.question` |
| `auth.session.get`, `auth.sign_out.post` | internal: asking who is signed in, signing out (`features/auth/api.ts`) | `http.response.status_code` |
| `auth.refresh.check` | internal, in the engine worker: `auth/refresh`'s step asking the tab that started the run to check its session ([sign-in](features/sign-in.md#when-chatapi-cant-say)); also a log line of the same name, Info, Warn for `unreachable` (the engine asks again) | `smithers.auth.outcome`; the log line's `outcome` (`signed_in`, `signed_out`, `unreachable`, `gone`), `executionId`, `durationMs` |
| `GET`, `POST` | client (Effect `HttpClient`), children of the two above | `url.full`, `http.response.status_code` |

Metrics (`src/features/chat/metrics.ts`, `src/boot.ts`, `src/page.ts`, and `@smthrs/effect-tanstack-db`'s `Outbox` and `Persistence`):

| Metric | Kind | Attributes |
|---|---|---|
| `smithers_web_questions` | counter | `queued` = `true` when the pill showed |
| `smithers_web_ask_failures` | counter | `reason` = `refused`, `conflict`, `too_large` or `not_admitted` |
| `smithers_web_unsent_actions` | counter | `action` = `edit`, `discard` or `retry` |
| `smithers_web_message_copies` | counter (engine worker) | `door` (`button`, `slash`, `agent`, `unknown` when the tab is gone), `which` (`message` or `latest`), `outcome` (`copied`, `failed`, `not_found`, `gone`) |
| `smithers_web_question_edits` | counter (engine worker) | `door`, `outcome` (`edited`, `not_found`, `sent`, `failed`, `gone`) |
| `smithers_web_composer_opens` | counter | `via` = `shortcut` or `button`; an open composer opened again doesn't count |
| `smithers_web_answer_first_text_ms` | histogram | from asking to the answer's first text on the asking tab, time queued included |
| `smithers_web_sync_failures` | counter | each time the pill showed: `reason` = `offline`, `unreachable`, `refused`, `invalid_response` or `engine` |
| `smithers_browser_engine_unavailable` | counter | `reason` = `worker-failed` or `engine-failed` (`BrowserEngine`) |
| `smithers_web_sync_retries` | counter | `via` = `button`, `online` or `adopted` |
| `smithers_web_history_loads` | counter | Load earlier presses |
| `smithers_web_storage_persisted` | counter | `granted` = `true` or `false` |
| `smithers_web_boot_ms` | histogram | from page start to the conversation restored from the device |
| `smithers_web_page_reloads` | counter | a page restored from the back/forward cache; reaches the relay only if an export runs before the page unloads |
| `smithers_slash_choices` | counter | rows chosen from the command menu: `kind` = `commands` or `values`, `how` = `accept` (Enter or a click) or `complete` (Tab) |
| `smithers_slash_submits` | counter | command lines submitted: `outcome` = `run`, `unknown`, `missing` or `invalid`, and `command` for a command the app offers |
| `outbox_attempts` | counter | `name`, `outcome` = `sent`, `retry`, `refused`, `defect`, or `sent_elsewhere` (a write this tab queued that the tab which took the lead sent meanwhile; settled here without a second send) |
| `outbox_refused` | counter | `name`, `status` |
| `outbox_queued_ms` | histogram | `name`: from the write to its mutation succeeding |
| `outbox_leader_changes` | counter | `leader` = `true` or `false` |
| `persistence_restore_ms` | histogram | `collection`: from creating a persisted collection to its rows restored |
| `persistence_unavailable` | counter | the database couldn't open |
| `persistence_write_failures` | counter | `collection`, `operation`: writes to a persisted collection the device couldn't store |
| `persistence_sync_roles` | counter | `collection`, `role` = `writer` or `watcher`: roles a tab's source took for a synced collection; one `writer` per device at a time |
| `smithers_web_sign_in_presses` | counter | Sign in with GitHub presses |
| `smithers_web_sign_outs` | counter | `outcome` = `signed_out` or `failed` |
| `smithers_web_device_wipes` | counter | `outcome` = `wiped` or `failed` |

Every name above, and every attribute, is in the feature's contract (`CHAT_TELEMETRY` in `src/features/chat/contract.ts`, `AUTH_TELEMETRY` in `src/features/auth/contract.ts`, `COMMANDS_TELEMETRY` in `src/features/commands/contract.ts`, and the app's own `APP_TELEMETRY` in `src/telemetry.ts`), which the relay keeps ([below](#relayed-browser-records)).

#### The engine worker

Each tab's engine worker (`src/flows/engine.worker.ts`) passes `BrowserRuntime.run` the exporter `engineTelemetry` (`src/flows/engine.ts`): `Otlp.layerFetch` to the same `POST /api/telemetry/v1/*`, with `serviceName: "smithers-mvp-engine"` and `spans: EXPORTED_SPANS`. Every log line, span and metric of the leader, the durable engine and the flows it runs, the agent's model calls included, reaches ChatApi's log like the tab's, but only the spans named below: the engine records about 3,900 spans for one answer (its SQL statements, runs, attempts, journal and one per poll), 3.2 MB of OTLP that ChatApi would refuse as 413, and sends 45 of them, 53 KB.

| Records | From | Fields |
|---|---|---|
| `flow.run.created`, `flow.run.claimed` | the durable engine admitting and claiming a run | `smithers.execution.id`, `smithers.flow`, `createdAtMs`, `claimedAtMs`; no input |
| `flow.dispatch` (log and span), `smithers_flow_dispatches` | the tab's dispatch (`src/flows/dispatch.ts`) | `flow`, `door`, `executionId`, `outcome`, `durationMs`; `reason` on an error, and `refusal` (such as `plan_changed`) when the engine's interpreter refused the run; the span's `smithers.flow.*` |
| `browser.engine.storage`, `browser.storage.persist`, `smithers_browser_engine_requests`, `smithers_browser_engine_storage` | the tab's side of the engine (`@smthrs/platform-browser`) | `request`, `outcome`, `error.type` |
| `browser.runtime.elect`, `browser.runtime.leader`, `browser.runtime.wake`, `browser.runtime.request` (a failed request's line), `browser.runtime.statement`, `browser.runtime.lost` (`reason`: `stolen` or `overflow`), `browser.runtime.stopped`, `smithers_browser_runtime_*`, `browser.tab_channel.overflow`, `smithers_browser_tab_channel_overflows` | the leader (`@smthrs/platform-browser`) | `flows`, `request`, `outcome`, `error.type`, `smithers.execution.id`, `smithers.flow`, `smithers.wake` |
| `auth.device_identity`, `smithers_device_identity_checks` | the owner check before the engine starts, and again when a page asks the leader to adopt a visitor's data in place (`src/device/identity.ts`, [sign-in.md](features/sign-in.md#the-devices-owner)) | `outcome` (`verified`, `visitor`, `offline`, `signed_out`, `changed`, `unverified`, `unavailable`); `via` (`owner`, `legacy`, `visitor`, `new`) when verified; `stage` and `reason` when unavailable. Never a login or a person |
| `FlowEngine.execute` and `Action.execute` (a run and each of its steps), `flow.run.created` and `flow.run.claimed` (with `createdAtMs` and `claimedAtMs`), `engine-store.registration.recovered`, the engine's warnings (with `A step log record could not be journaled`, code `step_log_failed`), `flows_engine_*` (with `flows_engine_step_logs`, each step log record's `outcome`), `flows_run_*`, `flows_journal_*`, `flows_db_*`, `flows_step_cache_*` | the durable engine (`@smthrs/flows`) | `executionId`, `flow`, `runId`, `action`, `stepKey`, `stepKeyDigest` (on what a step's body logs), `attempt`, `tier`, `outcome`, `error`, `code`, `op`, `to`, `channel`, `receipt` |
| `web.navigate` (log and span), `smithers_web_navigations` | `app/navigate`'s step ([flows](features/flows.md#navigation)) | `door` (the dispatch's, `agent`, or `unknown` when the tab that dispatched it is gone), `outcome` (`navigated`, `refused`, `gone`, `failed`), `executionId`, `durationMs`, `reason` on a refusal; the span's `smithers.navigation.door` and `smithers.navigation.outcome`. Never the path |
| `web.page.open` (log and span), `smithers_web_pages_opened` | `app/web/open`'s steps for the agent's openings, the tab for a person's ([web pages](features/web-pages.md#observability)) | `web_mode` (`embed`, `tab`), `door`, `outcome` (`embedded`, `card`, `opened`, `refused`, `forbidden`, `unavailable`), `reason` on a refusal, `web_framing` (`allowed`, `refused`, `unknown`) once ChatApi checked the page; the span's `smithers.web.mode`, `smithers.web.outcome` and `smithers.web.framing`. Never the URL, its origin or its path |
| `jev.judge` (log and span), `smithers_jev_judgments`, `smithers_jev_verdicts` | `app/jev/classify`'s and `app/jev/evaluate`'s steps in the engine worker ([Jev](features/jev.md#observability)) | `flow`, `items`, `outcome` (`judged` or the judge's failure code), the verdicts by code (`yes`, `no`, `labeled`, `unsure`), `durationMs`; the span's `smithers.jev.flow`, `smithers.jev.items` and `smithers.jev.outcome`. Never an item, a question, a label, a text or a criterion |
| `invoke_agent`, `chat agent`, `ModelStep`, `model.proxy.stream`, `execute_tool <flow>`, `agent_model_step_calls`, `agent_model_step_replays`, `agent_model_step_redispatches`, `smithers_model_proxy_*` (`side: client`) | the agent (`@smthrs/agent`, `@smthrs/model`) | `step` (the step's name, `harness/sealStep`), `gen_ai.*`, `smithers.model_step.*`, `smithers.model.proxy.*`, `requestId`, `modelId`, `events`, `firstEventMs`, `inputTokens`, `outputTokens` |

The full lists are `FLOWS_TELEMETRY` (`src/flows/contract.ts`), `AGENT_TELEMETRY` (`src/features/agent/contract.ts`), `THEME_TELEMETRY` (`src/features/theme/contract.ts`, the agent's `execute_tool app/theme/set`) and `NAVIGATION_TELEMETRY` (`src/features/navigation/contract.ts`, with the agent's `execute_tool app/navigate`) and `WEB_TELEMETRY` (`src/features/web/contract.ts`, with the agent's `execute_tool app/web/open`). None of their fields carries a flow's input, a prompt, an answer or a provider's text: a step key and a tool call's id are digests.

An answer's writes are ChatApi's to record, through the answer routes ([agent.md](features/agent.md#observability)).

### ChatApi Worker

Logs (`worker/Chat.ts`, and `ShapeProxy` from `@smthrs/effect-electric`, mounted in `worker/Chat.ts` with the name `chat.shape` and the metric `smithers_chat_shape_requests`):

| Message | When | Level | Fields |
|---|---|---|---|
| `chat.question` | every `POST /api/questions` | Info 2xx, Warn 4xx, Error 5xx | `status`, `bytes` (body bytes read, absent when a declared length was refused), `durationMs`; `questionId`, `answerId` once the body is valid; `existing: true` for a retry; `expiry: started` for a question ChatApi acknowledged; `errorCode` for every 4xx and 5xx (below), and `defect`, the defect's name, for 500 |
| `chat.answer.expire` | ChatApi stored a question but couldn't start its `chat/Expire`, and answered `503` | Warn | `answerId`, `outcome: not_started`, `errorCode` (the remote host's code, or `conflict`) |
| `chat.shape` | every shape request, once it has ended | Error 5xx or a failed body, Warn other 4xx, Info otherwise | `status` (499 when the browser left before Electric answered), `live`, `durationMs` (to the body's end), `bytes` (body bytes sent), `outcome` (`complete`, `aborted` or `failed`) |
| `chat.view.add` | every `POST /api/views` ([web pages](features/web-pages.md#the-views-table)) | Info 2xx, Warn 4xx, Error 5xx | `status`, `bytes`, `durationMs`; `viewId`, `template` once the body is valid; `reason` for a page it refused; `existing: true` for the same add again; `errorCode` for 503. Never the URL |
| `chat.views.shape` | every `GET /api/shapes/views`, once it has ended | as `chat.shape` | as `chat.shape` |
| `chat.web.preview` | every `POST /api/web/preview` ([web pages](features/web-pages.md#before-a-page-is-framed)) | Info 2xx, Warn 4xx, Error 5xx | `status`, `durationMs`; `mode` once the body is valid; `reason` for a page the policy refused; `framing`, `framingReason` and `cached` once checked; `errorCode` for 503. Never the URL, its host or its path |
| `chat.throttle` | a Rate Limiting binding failed, so the request went through ([throttling](features/chat.md#throttling)) | Warn | `route` (`shape`, `telemetry`), `outcome: error`. Never the address or the network |
| the browser's records | every OTLP record relayed ([below](#relayed-browser-records)) | the record's severity | the fields the allowlist keeps |

Every ChatApi line also carries `trace_id` and `span_id` when it is logged inside a span.

`chat.question` `errorCode`:

| Status | `errorCode` |
|---|---|
| 400 | `invalid` (not the contract's JSON), `utf8` (malformed UTF-8), `body` (the body broke off) |
| 401 | `authentication` (nobody is signed in) |
| 403 | `forbidden` (a Guest, or a person with no role: asking is Member or above) |
| 405 | `method` |
| 409 | `id_taken` (the question's id), `answer_id_taken` (the answer's id) |
| 413 | `too_large` |
| 500 | `defect`, with the defect's name as `defect`: a tagged value's tag, an error's name, or its type; `unknown` when that isn't an identifier |
| 503 | `sql:<reason>` (Postgres unreachable, or refusing the insert, such as a position taken), `database` (another failure building the client), `@smthrs/mvp/auth/SessionsUnavailable` (sessions couldn't be read), `expiry_not_started` (the question is stored, but its expiry's start wasn't recorded; `chat.answer.expire` has the host's code) |

Spans:

| Span | Kind | Attributes |
|---|---|---|
| `chat.question` | server, parented by a well-formed `traceparent` | `smithers.chat.question_id`, `smithers.chat.answer_id`, `http.response.status_code`; `error.type` = the `errorCode` for 5xx. A defect is caught inside it, so the span never ends with the defect's message |
| `chat.shape` | server | `http.response.status_code`, `electric.shape.live` |
| `chat.view.request` | server | `http.response.status_code` |
| `chat.views.shape` | server | `http.response.status_code`, `electric.shape.live` |
| `chat.web.preview` | server | `http.response.status_code`, `smithers.web.framing` |
| `WebPage.check` | internal, inside `chat.web.preview` (`@smthrs/views`) | `web_page.framing`, `web_page.reason`, `http.response.status_code`, `web_page.redirects`. Never the URL |
| SQL statements | client (`effect/sql`) | `db.query.text`: the statement with `$1` placeholders, never its values |
| HTTP calls to the model and Electric | client (Effect `HttpClient`) | `url.full` with `secret` redacted; request headers with `authorization` redacted |

Metrics (`worker/ChatMetrics.ts`):

| Metric | Kind | Attributes | Log field |
|---|---|---|---|
| `smithers_chat_questions` | counter | `status` | `chat.question` `status` |
| `smithers_chat_shape_requests` | counter | `status`, `live` | `chat.shape` |
| `smithers_view_requests` | counter (`worker/Views.ts`) | `status` | `chat.view.add` `status` |
| `smithers_view_shape_requests` | counter (`worker/Views.ts`) | `status`, `live` | `chat.views.shape` |
| `smithers_web_previews` | counter (`worker/WebPreview.ts`) | `status`, `framing` | `chat.web.preview` |
| `smithers_throttle_decisions` | counter (`worker/Throttle.ts`) | `route` (`shape`, `telemetry`), `outcome` (`admitted`, `limited`, `error`) | `chat.throttle` for `error`; a `limited` request has no log line, so a flood writes none |
| `flows_observability_otlp_relayed` | counter | `signal` | (`OtlpRelay`) |
| `flows_observability_otlp_relay_dropped` | counter | `signal`, `reason` = `not_allowed` (off the allowlist) or `over_limit` (past 200 in one export) | (`OtlpRelay`) |

### Model endpoint

`POST /api/model/<role>` ([model-endpoint.md](features/model-endpoint.md)) records through `ModelProxy.serve` (`@smthrs/model`), which ChatApi mounts with the attribute `role` and `onEnd` metering (`worker/ModelEndpoint.ts`). None of its records carries a prompt, an answer, provider error text, a key or an actor id. A call a person's own model answers is metered in their ledger instead ([Your model](#your-model)).

| Message | When | Level | Fields |
|---|---|---|---|
| `model.proxy.serve` | every request, once it has ended | Info `success` and `interrupted`, Warn `invalid` and `refused`, Error `failed` | `role`, `requestId` (the caller's), `invocationId` (the server's, the `model_usage` key), `traceId`, `side: server`, `outcome`, `status`, `durationMs`, `events`; when known `modelId`, `provider`, `errorCode` (the `ModelError` code: `authentication`, `quota_exceeded`, `no_route`, `provider_internal`, …), `errorTag`, `firstEventMs`, `requestBytes`, `inputTokens`, `outputTokens` |
| `model.endpoint` | Postgres failed (sessions, the role lookup or the budget reservation), or a role's setting is unusable | Error | `role`, `errorCode`: `sql:<reason>`, or `unusable:<reason>` (the planner's code, such as `credential_missing`, `credential_unknown` or `invalid`) |
| `model.usage` | the provider refused a call before any output, so it settled to what the provider reported (`refused`); a call's usage was unknown, so it kept its reservation (`kept`); it ended after its reservation expired (`expired`); or its settle failed and it stays counted at the reservation | Info `refused` and `kept`, Warn `expired`, Error for a failed settle | `role`, `invocationId`, `requestId`; `outcome` and `ended` (the call's `success`, `failed` or `interrupted`) for `refused`, `kept` and `expired`, `reported` (`none`, `partial` or `complete`: which counts the model reported) for `refused` and `kept`, and the call's `ModelError` code as `errorCode` when it failed; `errorCode` for a failed settle |
| `admin.set_model` | every `admin/SetModel` step that ended | Info `set`, Warn `refused`, Error `error` | `outcome`, `role`; `modelId` when set; `reason` (`not_admin`, `delegated`) when refused; `errorCode` on error |

Spans: `model.proxy.serve` (server, or internal under an HTTP server span) with `smithers.model.proxy.request_id`, `smithers.model.proxy.invocation_id`, `smithers.model.proxy.outcome`, `http.response.status_code`, `error.type`, `gen_ai.request.model`, `gen_ai.provider.name`, `smithers.model.proxy.events`, `smithers.model.proxy.duration_ms`, `smithers.model.proxy.first_event_ms` and `smithers.model.proxy.request_bytes`; under it `chat <model>` from `Model.withGenAiSpan`, and the SQL statements of the role lookup, the budget reservation and its settle. A failed span ends with a `ModelError` rebuilt from its code alone. `admin.set_model` (internal) carries `smithers.model.role`.

| Metric | Kind | Attributes | Log field |
|---|---|---|---|
| `smithers_model_tokens` | counter | `role`, `model`, `type` = `input` or `output` | `model.proxy.serve` `inputTokens`, `outputTokens` |
| `smithers_model_proxy_requests` | counter | `role`, `side: server`, `outcome`, `status` | `model.proxy.serve` `outcome`, `status` |
| `smithers_model_proxy_duration_ms` | histogram | `role`, `side: server`, `outcome` | `durationMs` |
| `smithers_model_proxy_first_event_ms` | histogram | `role`, `side: server` | `firstEventMs` |
| `smithers_model_usage_writes` | counter | `outcome` = `recorded` (settled to what it spent), `refused` (refused before any output, settled to what the provider reported), `kept` (its usage was unknown), `expired` (it ended after its reservation expired) or `error`: settles of a call's reservation | `model.usage` for every outcome but `recorded` |

The budget itself is the `model_budget_days` counter and the `model_usage` ledger, not a metric; a refused reservation is `model.proxy.serve` with `status` 429 and `errorCode` `quota_exceeded`. What each call spent, and the alerts it raises, are under [Spend alerts](#spend-alerts).

### Spend alerts

Model spend and its alerts to Admins ([spend-alerts.md](features/spend-alerts.md)): `ModelSpend.record` for each metered call (`worker/ModelSpend.ts`, from the model endpoint's `onEnd` and from `ModelEndpoint.local`'s calls), the endpoint's start of a window's alert, `ops/SpendAlert`'s alert step (`worker/flows/SpendAlert.ts`) and the alerts' shape (`worker/SpendAlerts.ts`). They carry roles, model ids, ids of alerts and calls, counts, tokens and dollars; never a prompt, an answer or a provider's text.

| Message | When | Level | Fields |
|---|---|---|---|
| `model.spend` | a metered call ended whose model reported tokens or a cost | Info | `role`, `modelId`, `invocationId`, `tokens` (input and output reported); `costUsd` and `costSource` (`estimated` from the rate card, `reported` by the provider) when priced |
| `model.spend.alert` | the endpoint couldn't start a window's alert | Error | `outcome: not_started`, `errorCode` (the host's, or the failure's tag, `unknown` for a defect) |
| `model.spend.alert` | each `ops/RecordSpendAlert` attempt that ended | Warn `recorded` and `failed`, Info `existing` and `none` | `alertId`, `outcome`; `calls`, `tokens` and, when priced, `costUsd` unless it failed; `errorCode` (`sql:<reason>`) when it failed |
| `spend.alerts.shape` | every `GET /api/shapes/spend-alerts` (`ShapeProxy`) | as `ShapeProxy` logs | `status`, `live` |
| `spend.alert.delivery` | each `ops/DeliverSpendAlert` attempt that ended (`worker/flows/SpendAlert.ts`) | Info `sent`, `off`, `none`, `existing`; Warn `refused` and `failed` | `alertId`, `channel`, `outcome`; `errorCode` (the send's code, such as `rate_limited`, or `sql:<reason>`) and `status` (the provider's HTTP status, when it answered) when it failed |
| `alerts.channel` | every `POST /api/alert-channels` (`worker/AlertChannels.ts`) | Info, Warn for a 4xx, Error for a 5xx | `status`, `durationMs`, `bytes`; `channel` and `destinations` (how many) once decoded; `existing: true` when it changed nothing; `errorCode` for a 503 |
| `alerts.channels.shape`, `alerts.deliveries.shape` | every `GET /api/shapes/alert-channels` and `/api/shapes/alert-deliveries` | as `ShapeProxy` logs | `status`, `live` |

Spans: `model.spend.alert` (internal) with `smithers.spend_alert.id`, around the alert step and its SQL; `spend.alert.delivery` with `smithers.spend_alert.id` and `smithers.channel`, around a delivery, and inside it `@smthrs/notifications`' `notifications.channel.send` (client) with `smithers.channel`, `http.response.status_code`, `smithers.channel.outcome` and `smithers.channel.code`; the HTTP client's own span, which would record the bot token in its url, is off. `alerts.channel.request` (server) around `POST /api/alert-channels`. No record carries an email address, a chat id, a key or a token.

| Metric | Kind | Attributes | Log field |
|---|---|---|---|
| `smithers_model_spend_tokens` | counter | `role`, `model` | `model.spend` `tokens` |
| `smithers_model_spend_usd` | counter | `role`, `model`; an unpriced model adds nothing | `model.spend` `costUsd` |
| `smithers_model_spend_alerts` | counter | `outcome` = `recorded`, `existing`, `none`, `failed` or `not_started` | `model.spend.alert` `outcome` |
| `smithers_spend_alert_shape_requests` | counter | `status`, `live` | `spend.alerts.shape` |
| `smithers_spend_alert_deliveries` | counter | `channel`; `outcome` = `sent`, `refused`, `failed`, `off`, `none` or `existing` | `spend.alert.delivery` `outcome` |
| `smithers_alert_channel_requests` | counter | `channel` (`none` before one decoded), `status` | `alerts.channel` |
| `smithers_alert_channel_shape_requests`, `smithers_alert_delivery_shape_requests` | counter | `status`, `live` | `alerts.channels.shape`, `alerts.deliveries.shape` |

In the browser (`src/features/spend/`, `SPEND_TELEMETRY`), an Admin's tab records `spend.alert.shown` (Info: `alertId`, `calls`, `tokens`) and `smithers_web_spend_alerts_shown` once per alert per tab, and `spend.alert.hidden` (Info: `alertId`) and `smithers_web_spend_alerts_hidden` once the device stored a Hide. Each Save of a channel runs `alert/channel`, whose step records `alerts.channel.set` (Info `sent`, Warn `refused` and `unsent`: `channel`, `destinations` as a count, `outcome`, and ChatApi's `status` and `code` when it refused) and `smithers_web_alert_channel_sets` by `channel` and `outcome`, with its span `alerts.channel.set` (client).

### Database load

The app's Postgres connections, sampled once a window by `ops/DatabaseLoad` ([database-alerts.md](features/database-alerts.md), `worker/flows/DatabaseLoad.ts`), and its alert's delivery. They carry counts and the ratio, never a query, a role, an address or a chat id.

| Message | When | Level | Fields |
|---|---|---|---|
| `database.connections` | each `ops/SampleConnections` attempt that ended | Info `under`, Warn `over` and `failed` | `outcome`; `used` (client connections in use), `max` (`max_connections`) and `ratio` (`used / max`) unless it failed; `errorCode` (`sql:<reason>`) when it failed |
| `database.connections` | a `FlowExecution` alarm couldn't start its window's sample | Error | `outcome: not_started`, `errorCode` (the host's, or the failure's tag, `unknown` for a defect) |
| `database.alert.delivery` | each `ops/DeliverDatabaseAlert` attempt that ended | Info `sent`, `off`, `existing`; Warn `refused` and `failed` | `alertId` (the execution id), `channel`, `outcome`; `errorCode` and `status` when it failed, as `spend.alert.delivery` |

Spans: `database.connections` (internal) with `smithers.database_load.id`, around the sample and its query; `database.alert.delivery` with `smithers.database_load.id` and `smithers.channel`, around a delivery, with `@smthrs/notifications`' `notifications.channel.send` inside it, as a spend alert's.

| Metric | Kind | Attributes | Log field |
|---|---|---|---|
| `smithers_database_connections` | gauge | none | `database.connections` `used` |
| `smithers_database_max_connections` | gauge | none | `database.connections` `max` |
| `smithers_database_load_samples` | counter | `outcome` = `under`, `over`, `failed` or `not_started` | `database.connections` `outcome` |
| `smithers_database_alert_deliveries` | counter | `channel`; `outcome` = `sent`, `refused`, `failed`, `off` or `existing` | `database.alert.delivery` `outcome` |

### Sign-in

ChatApi's sign-in routes and sessions ([sign-in.md](features/sign-in.md), `worker/SignIn.ts`), the role check (`auth/RecheckRole`, `worker/flows/RecheckRole.ts`) and the token revocation at sign-out (`auth/RevokeGitHubToken`, `worker/flows/RevokeGitHubToken.ts`). No record carries a token, a code, `state`, a cookie, a secret, GitHub's text or a login: a person is their id, a session its id.

| Message | When | Level | Fields |
|---|---|---|---|
| `auth.sign_in` | every `GET /api/auth/sign-in` | Info `redirected`, and `signed_in` with `reason: local_developer` under `alchemy dev` without the App; Warn `failed` | `outcome`; `reason` (`not_configured`, `error`) and `errorCode` when it failed |
| `auth.callback` | every callback | Info `signed_in`, Warn `failed` | `outcome`, `durationMs`; `personId` and `role` (`none` for no role) when signed in; `reason` when it failed (below), and `errorCode` for `database`, `sign_out_not_started` and `error` |
| `auth.sign_out` | every `POST /api/auth/sign-out` | Info `signed_out` and `no_session`, Warn `refused` and `failed` | `outcome`; `reason: cross_site` when refused, `local_developer` for the dev fallback, `not_started` when the host didn't record the sign-out flow's start and `error` for any other failure; `errorCode` when it failed (the host's code, or `conflict`, for `not_started`) |
| `auth.session` | Postgres failed reading a session | Error | `outcome: error`, `errorCode` (`sql:<reason>`) |
| `auth.config` | SESSION_SECRET is shorter than 32 characters, so sign-in is off | Error | `errorCode: session_secret_too_short` |
| `auth.role_check` | every role check step that ended, or a check ChatApi couldn't start | Info for each step's outcome: `redeem` (`none`, `unusable`, `refused`, `redeemed`), `store` (`stored`, `changed`, `none`), `check` (`checked`, `revoked`, `ended`) and `keep` (`kept`); Warn `failed` (one attempt) and `not_started` | `sessionId`, `step` (absent for `not_started`), `outcome`; `role` (`none` for no role) for `check` and `keep`; `errorCode` (GitHub's refusal or `sql:<reason>`) when it failed |
| `auth.revoke_token` | every sign-out step that ended | Info for each step's outcome: `end` (`ended`, `over`), `revoke` (`revoked`, `unreadable`, `none`, `live`) and `forget` (`forgotten`); Warn `failed` (one attempt) | `sessionId`, `step`, `outcome`; `errorCode` (GitHub's refusal or `sql:<reason>`) when it failed |

A callback's `reason`: `not_configured`, `method`, `state_mismatch` (the state isn't this browser's), `replayed` (its sign-in already finished), `expired` (over 10 minutes), `denied` (the person declined on GitHub), `invalid` (no code), `unreadable` (the sealed verifier didn't open), `sign_out_not_started` (the host didn't record the sign-out of the session this browser held, so GitHub's code was never redeemed), `<step>_<reason>` for GitHub (`exchange_rejected`, `user_unavailable`, `permission_misconfigured`, …), `database`, or `error` (a defect, by its name).

Spans: `auth.sign_in`, `auth.callback`, `auth.sign_out`, `auth.session` and `auth.resolve` (internal, each request that reads the session cookie); `auth.role_check` and `auth.revoke_token` with `smithers.auth.session_id` and `smithers.auth.step`; `GitHubClient.request` (`@smthrs/integrations`) for GitHub's REST calls, the revocation's `DELETE` among them; `OAuthToken.request` (`@smthrs/integrations`) with `oauth.provider` for the code and refresh exchanges; and the SQL statements, placeholders only.

| Metric | Kind | Attributes | Log field |
|---|---|---|---|
| `smithers_auth_requests` | counter | `route` (`sign_in`, `callback`, `sign_out`), `outcome`, `reason` (`none` unless refused or failed) | the route's line |
| `smithers_auth_role_checks` | counter | `step` and `outcome`: a step's outcome above, or `failed` | `auth.role_check` `step`, `outcome` |
| `smithers_auth_token_revocations` | counter | `step` and `outcome`: a step's outcome above, or `failed` | `auth.revoke_token` `step`, `outcome` |

**Run credentials** ([sign-in.md](features/sign-in.md#run-credentials)): who acted, as which `act`. No record carries a token, a payload or content; a run is its execution id.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `auth.credential` | log | ChatApi, each `POST /api/runs/<run>/credential` | `runId`, `flow`, `by` (`person`, or the caller's `act`), `act` and `depth` when minted, `status`, `durationMs`, `bytes`, `errorCode` |
| `auth.credential` | log, Warn | ChatApi, a bearer token that didn't read | `op: verify`, `outcome` (`forged`, `expired`, `ended`) |
| `auth.credential.verify` | span | ChatApi | |
| `smithers_run_credentials` | counter | ChatApi | `op` (`mint`, `verify`), `outcome` (`minted`, `person_only`, `capability_exceeded`, `too_deep`; `verified`, `forged`, `expired`, `ended`), `act` |
| `auth.device_principal`, `smithers_device_principal_refusals` | log (Warn) and counter | ChatApi, a request read as nobody because of whose device data it comes from (`x-smithers-device-person`) | `outcome`: `mismatch` (another person's) or `unbound` (a cookie-authenticated write naming no one). Never either person |
| `auth.person_only` | log, Warn | ChatApi, a person-only route refusing an `act` | `act` (the flow or protected act), `by` (`agent`, `flow`, `app`, `sandbox`), `runId`, `depth` |
| `smithers_person_only_refusals` | counter | ChatApi | `act`, `by` |
| `auth.resolve`'s `smithers.actor.act` | span attribute | ChatApi, every request | `person`, an `act` kind, or `none` |
| `auth.run_credential` | span | engine worker, each credential asked for | `smithers.execution.id` |
| `auth.run_credential` | log | engine worker | `flow`, `outcome` (`minted`, and `signed_out` when the starting tab said nobody is signed in so none was asked for, at Debug; `anonymous`, `refused`, `unavailable`, `door_timeout` when the starting tab is silent, and `stale` when a credential came back `401`, at Warn), `act`, `principal` (`session`, `credential`), `status`, `code` |
| `smithers_run_credential_mints` | counter | engine worker | `outcome`, `act` |

### Remote flow executions

The `FlowExecution` Durable Object ([remote-flows.md](features/remote-flows.md)) records through `ExecutionObject` (`@smthrs/platform-cloudflare`), with `Logger.layerStructuredJson()` installed in both handlers (`worker/Executions.ts`), so its lines reach Workers Logs as ChatApi's do. None of its records carries the payload or a failure's message.

| Message | When | Level | Fields |
|---|---|---|---|
| `cloudflare.execution.start` | every `start` | Info `accepted` and `duplicate`, Warn `conflict` and `failed` | `outcome`; `error.type`, the failure's tag, for `failed` |
| `cloudflare.execution.alarm` | every alarm | Info `idle`, `settled`, `parked` and `forgotten`, Warn `retrying` | `outcome`; for `retrying`, `error.type` (the failure's tag) and `smithers.execution.attempt` |
| `repo.run.settle` | an alarm that finds a repository's run settled ([actions.md](features/actions.md)) | Info; Warn when the row couldn't be written | `runId`, `outcome` (`done`, `failed`, `stopped`, or `failed` with `errorCode`) |
| `probe.mark` | each step of `probe/Pause` | Info | `label` |
| `chat.answer.expire` | each step of `chat/Expire` that decided or failed ([agent.md](features/agent.md#settling)) | Info `abandoned`, `settled`, `missing`, and `waiting` (a round that found the queue moved, so the next round waits again); Warn `failed` (one attempt) | `answerId`, `outcome`; `errorCode` (`sql:<reason>`) when it failed |

Spans `cloudflare.execution.start` and `cloudflare.execution.alarm` carry `smithers.execution.id`, `smithers.flow` and the outcome as `smithers.execution.start` or `smithers.execution.alarm`; a retrying alarm adds `error.type` and `smithers.execution.attempt`. Each `chat/Expire` step attempt is a `chat.answer.expire` span with `smithers.chat.answer_id`. The engine adds its own spans and SQL statement spans inside the alarm.

| Metric | Kind | Attributes | Log field |
|---|---|---|---|
| `smithers_cloudflare_execution_starts` | counter | `outcome`: `accepted`, `duplicate`, `conflict` or `failed` | `cloudflare.execution.start` `outcome` |
| `smithers_cloudflare_execution_alarms` | counter | `outcome`: `idle`, `settled`, `parked`, `retrying` or `forgotten` | `cloudflare.execution.alarm` `outcome` |
| `smithers_repo_run_writes` | counter | `op` (`record`, `settle`), `outcome` (`recorded`, `existing`; `done`, `failed`, `stopped`) | `repo.run.record`, `repo.run.settle` `outcome` |
| `smithers_answer_expiries` | counter | `outcome`: `abandoned`, `settled`, `missing`, `waiting`, `failed`, or `not_started` (counted by ChatApi) | `chat.answer.expire` `outcome` |

An answer stuck `streaming` shows as no `chat.answer.write` for its `answerId` after its `chat.question`, then, 25 minutes after its queue last moved, `chat.answer.expire` `abandoned` for it, after a `waiting` line for each round that found the queue moved. A `not_started` line comes with a `503`, so the outbox sends the question again.

A run that keeps failing shows as `cloudflare.execution.alarm` lines at Warn with a rising `smithers.execution.attempt` for one `smithers.execution.id`; its `error.type` names the cause ([troubleshooting](../../../packages/smithers/flows/platform-cloudflare/docs/troubleshooting.md)).

### Repositories

RepoApi (`worker/RepoApi.ts`), the clone (`worker/flows/RepoClone.ts`) and the browser's repository view ([repo.md](features/repo.md)). No record carries a file's contents, a commit message, Code Storage's or GitHub's error text, a token or the Code Storage key.

| Message | When | Level | Fields |
|---|---|---|---|
| `repo.clone.request` | every `POST /api/repos`, which persists the request and starts nothing | Info 2xx, Warn 4xx, Error 5xx | `outcome` (`requested`, `existing`, `method`, or the refusal's code), `status`, `durationMs`; `id`, `attempt` and `cloneId` once valid; `row` (the existing row's status); `errorCode` for 503 |
| `repo.clone.launch` | every `POST /api/repos/launch` | Info 2xx, Warn 4xx, Error 5xx and `conflict` | `outcome` (`launched`, `settled`, `conflict`, `method`, or the refusal's code), `status`, `durationMs`; `id` and `cloneId` once valid, `attempt` for a launch; `row` (a settled or superseded row's status); `errorCode` for 503 and for `conflict` (the start found another payload under the attempt's execution id, and the attempt settled `failed`) |
| `repo.tree`, `repo.blob`, `repo.raw`, `repo.refs` | every read | Info 200, Warn 4xx, Error 5xx | `repoId`, `status`, `bytes` (returned), `durationMs`; `sha` for a tree or a file; `errorCode` (`not_found`, `too_large`, `capacity`, `unavailable`, or a defect's name) |
| `repo.about` | every `GET /api/repos/<owner>/<name>/about` | Info 200, Warn 4xx, Error 5xx | `repoId`, `status`, `bytes`, `durationMs`; `cache` (`hit`, `miss` when GitHub was read now, `stale`, `refusal` for a kept refusal, `wait` when another request's first read didn't land within 10 seconds), `via` (`app`, `deployment` or `anonymous`), `waitedMs` (how long it waited in the store for another request's first read), `store` (the store operations that failed, comma-separated); when GitHub was read, `read` (its outcome), `rateRemaining`, and on a GitHub refusal finite `stage` and numeric `upstreamStatus`; `errorCode` (`not_found`, `rate_limited`, `github_unavailable`, `unavailable`, or a defect's name) |
| `repo.about.read` | each read of GitHub for a repository's About, at most one per repository at a time across data centers | Info answered, Warn otherwise | `repoId`, `via`, `outcome` (`answered`, `partial`, `not_found`, `rate_limited`, `github_unavailable`), `durationMs`; `stage` and `upstreamStatus` on a refusal; `rateRemaining` (the least `x-ratelimit-remaining` GitHub answered with); `missing` (the parts GitHub couldn't give now); `tokenError` (why the App's token couldn't be had) |
| `repo.meter` | a read's bytes Postgres didn't record; the read still answered | Warn | `bytes`, `errorCode` |
| `repo.clone.step` | each of Inspect, Import, Pull, AwaitSync and Index that answered | Info | `step`, `id`; Inspect's `cloneId`, `outcome` and `reason`; Import's `created`; AwaitSync's `outcome` (`ready`, `timed_out`); Index's `files` (-1 when the list couldn't be read) and `installed`; the engine's `runId`, `stepKey`, `attempt` |
| `repo.clone.settle` | Settle | Warn `failed`, Info otherwise | `id`, `cloneId`, `status`, `reason` (the failure or budget, or `none`), `settled` (false for a stale attempt); `errorCode` when Postgres refused |
| `repo.spend.alert` | a metered write crossed 50%, 80% or 100% of `REPO_BUDGET_USD` for the first time this month | Error | `pct`, `estimateUsd` |
| `repo.config` | the Code Storage key didn't import; the deployment clones nothing | Error | `errorCode` (`invalid_key`) |
| `repo.shape` | every `GET /api/shapes/repositories`, once its body ended (`ShapeProxy`) | as `chat.shape` | as `chat.shape` |
| `immutable cache call failed; reading through` | the cache refused a `get` or `put` (`@smthrs/artifacts`) | Warn | `backend`, `namespace`, `operation`, `reason` |

| Span | Kind | Attributes |
|---|---|---|
| `repo.clone.request` | server | `smithers.repo.id`, `http.response.status_code` |
| `repo.clone.launch` | server | `http.response.status_code` |
| `repo.tree`, `repo.blob`, `repo.raw`, `repo.refs` | server | `http.response.status_code`, `smithers.repo.bytes` |
| `repo.about` | server; `repo.about.answer` inside, then the store's `repo.about.store.<op>` and the GitHub read, `repo.about.graphql` or `repo.about.rest`, each call a `GitHubClient.request` span | `http.response.status_code` |
| `repo.clone.inspect`, `repo.clone.import`, `repo.clone.pull`, `repo.clone.await_sync`, `repo.clone.index`, `repo.clone.settle` | internal, inside the engine's step spans | `smithers.repo.id` |
| `repo.clone.feed` | internal, inside each write to a clone's row: the person's feed row (worker/CloneFeed.ts) | `smithers.repo.id` |
| `CodeStorage.<operation>`, `GitRemote.head` | internal (`@smthrs/effect-code-storage`) | `code_storage.repo`, `git.remote` |
| `GitHubClient.request` | internal (`@smthrs/integrations`) | `http.request.method`, `url.path` |
| `ImmutableCache.get`, `ImmutableCache.put` | internal (`@smthrs/artifacts`) | `immutable_cache.backend`, `.namespace`, `.outcome`, `.bytes` |

| Metric | Kind | Attributes |
|---|---|---|
| `repo_clone_requests` | counter | `outcome` |
| `repo_clone_launches` | counter | `outcome` |
| `repo_reads` | counter | `kind` (`tree`, `blob`, `raw`, `refs`, `about`), `status` |
| `repo_about_answers` | counter | `cache` (`hit`, `miss`, `stale`, `refusal`, `wait`) |
| `repo_about_reads` | counter | `via` (`app`, `deployment`, `anonymous`), `outcome` |
| `repo_about_rate_remaining` | gauge | `via`: GitHub's rate limit left after the latest About read |
| `repo_read_bytes_total` | counter | bytes returned |
| `repo_shape_requests` | counter | `status`, `live` |
| `repo_clones` | counter | `outcome` (`ready`, `failed`, `capacity`), `reason` |
| `repo_capacity` | counter | `reason` |
| `repo_stored_bytes`, `repo_spend_estimate_usd` | gauge | as of the last metered write |
| `repo_spend_alerts` | counter | `pct` |
| `code_storage_requests`, `code_storage_bytes_read` | counter | `operation`, `outcome` (`@smthrs/effect-code-storage`) |
| `git_remote_requests` | counter | `outcome` |
| `immutable_cache_requests`, `immutable_cache_bytes` | counter | `backend`, `namespace`, `operation`, `outcome` |

The browser (`src/features/repo/`), the tab's and the engine worker's, relayed through ChatApi's allowlist (`REPO_TELEMETRY` in `src/features/repo/contract.ts`). `repo/clone` and `repo/copy` record in their steps, on the engine worker, whichever door ran them:

| Record | Kind | Fields |
|---|---|---|
| `repo.open` | log and span | `kind` (`tree`, `blob`); the span's `smithers.repo.kind` |
| `repo.clone` | log and span, `repo/clone`'s step; Info `started` and `existing`, Warn otherwise | `outcome` (`started`, `existing`, `sign_in`, `forbidden`, `limit`, `invalid`, `not_configured`, `unavailable`), `status` (RepoApi's, for a refusal), `durationMs` |
| `repo.clone.launch` | log and span, `repo/clone`'s second step; Info `launched` and `settled`, Warn otherwise | `outcome` (`launched`, `settled`, `sign_in`, `forbidden`, `limit`, `invalid`, `not_configured`, `unavailable`), `status` (RepoApi's, for a refusal) |
| `repo.clone.unconfirmed` | log, Warn: a person's clone RepoApi took whose row Electric didn't deliver in time | |
| `repo.copy` | log and span, `repo/copy`'s step; Info `copied`, Warn `refused`, Error otherwise | `what` (`permalink`, `path`, `contents`, `clone-url`), `door` (the dispatch's, `agent`, or `unknown` when the tab that asked is gone), `outcome` (`copied`, `failed`, `refused`, `unavailable`, `gone`), `executionId`, `durationMs`; the span's `smithers.repo.copy` |
| `repo.tree.load`, `repo.blob.load`, `repo.refs.load`, `repo.about.load` | log | `outcome`, `durationMs`, `status` |
| `repo.head.load` | log: RepoApi's refs naming a repository's ready head before Electric delivered its row ([a page's head](features/repo.md#a-pages-head)); Info, Warn `failed` | `outcome` (`ready`, `absent`, `failed`), `durationMs`, `status` |
| `repo.locate` | log, Info: a page knew where its location is | `source` (`row`, `refs`), `outcome` (`located`, `missing`, `failed`), `durationMs` from the page opening |
| `repo.clone.post`, `repo.tree.get`, `repo.blob.get`, `repo.refs.get`, `repo.about.get` | span, parents the client's `GET` or `POST` | `http.response.status_code` |
| `execute_tool repo/tree`, `repo/read`, `repo/refs`, `repo/clone`, `repo/copy` | span: the agent's call of the flow | |
| `smithers_web_repo_clone_clicks` | counter | `kind` (`clone`, `retry`) |
| `smithers_web_repo_clones` | counter | `outcome`, as `repo.clone` |
| `smithers_web_repo_opens` | counter | `kind` |
| `smithers_web_repo_tree_load_ms`, `smithers_web_repo_blob_load_ms`, `smithers_web_repo_refs_load_ms`, `smithers_web_repo_head_load_ms`, `smithers_web_repo_about_load_ms` | histogram | `outcome` |
| `smithers_web_repo_locate_ms` | histogram | `source`, `outcome`, as `repo.locate` |
| `smithers_web_repo_copies` | counter | `what`, `door`, `outcome`, as `repo.copy` |

### A repository's home

The browser's read of a repository's homes and its actions ([home.md](features/home.md)), relayed through ChatApi's allowlist (`HOME_TELEMETRY` in `src/features/home/contract.ts`), and ChatApi's home route. No record carries a section, a block, a title, a text, a path, a link, a branch's name or a file's contents; RepoApi's own `repo.blob` lines record the reads.

| Record | Kind | Fields |
|---|---|---|
| `home.resolve` | log and span; Warn `unreadable`, Info otherwise | `outcome` (`declared`, `absent`, `invalid`, `unreadable`, `cached` for a home this device had, or `preview` for a repository's own home read from what GitHub says before a clone), `blocks` (in all sections), `skipped` (of a kind the app doesn't know), `reason` (an invalid home's: `json`, `shape`, `sections`, `section`, `blocks`, `block`, `binary`, `too_large`), `status` (RepoApi's, for a refusal), `durationMs`; the span's `smithers.home.outcome`, `smithers.home.blocks`, `smithers.home.skipped` |
| `home.file.load` | log; Warn `failed`, Info `text` | `outcome`, `status`, `durationMs`: a file a Markdown block names |
| `home.answer` | log and span; Warn `unreadable` | `outcome` (`declared`, `absent`, `unreadable`), `audience`, `sections`, `status`, `durationMs`: ChatApi's answer of who the person is and the curated home |
| `home.action` | log and span; Warn on a failure | `flow`, `outcome` (`done` or the flow's refusal), `durationMs`; the span's `smithers.home.flow`, `smithers.home.outcome` |
| `smithers_web_home_resolves`, `smithers_web_home_answers`, `smithers_web_home_actions` | counters | `outcome`; the last also `flow` |
| `home.curated` (ChatApi) | log and span; Warn `unavailable`, `invalid`, `role_unavailable` | `outcome` (`curated`, `absent`, `invalid`, `unavailable`, `role_unavailable`, `method`), `audience`, `source` (`signed_out`, `role`, `no_role_here`), `refused` (`RepoRoles`' refusal code, decision 0079), `sections` sent, `hidden` held back, `status`, `durationMs`; the span's `smithers.home.outcome`, `smithers.home.audience`; the role's own read is a `github.repo_role` span and line |
| `smithers_home_curated_requests` (ChatApi) | counter | `outcome`, `audience` |

`src/features/home/home.test.ts` asserts each outcome's record and count, and that a sentinel in the home's text, title, link and Markdown file reaches no log line; `worker/home/Api.test.ts` that no section's words reach ChatApi's records.

### A repository's docs

[docs.md](features/docs.md#observability): ChatApi's `repo.docs` and `repo.docs.page` (log and span per request, `smithers_docs_requests` by route and status, `docs.source` on a failure that isn't an answer) and the engine worker's `docs.search` (log per settled search and failed step, span per step, `smithers_web_docs_searches` by door and outcome, `smithers_web_docs_shown` by door). No record carries a query, a path, a URL, a title or a page's text.

### Code intelligence

The repository view's language server ([code-intelligence.md](features/code-intelligence.md)), relayed through ChatApi's allowlist (`CODE_INTEL_TELEMETRY` in `src/features/code-intel/contract.ts`). No record carries a path, a symbol, a signature, documentation or a problem's message.

| Record | Kind | Fields |
|---|---|---|
| `code.file.open` | span | a routed file opening: its server, problems and outline |
| `code.session.open` | span | a server starting for a repository and commit; `files` in its file list |
| `code.hover`, `code.definition`, `code.references`, `code.problems`, `code.outline` | span | `act` |
| `code.ask.failed` | log, Warn | `act`, `error` (the failure's tag) |
| `smithers_web_code_intel_asks` | counter | `act`, `outcome` (`answered`, `none`, `failed`) |
| `smithers_web_code_intel_sessions` | counter | servers started |
| `browser.language_server.<method>` (`@smthrs/platform-browser`) | span | `method`, and on an answer `files` loaded and `partial` |
| `browser.language_server.failed` | log, Error | the worker failed |
| `smithers_browser_language_server_requests` | counter | `method`, `outcome` (`answered` or the failure's code) |
| `smithers_browser_language_server_ms` | histogram | `method` |
| `smithers_browser_language_server_files` | counter | files the tab read for its servers |

`src/features/code-intel/code-intel.test.ts` asserts the counts and the failure line; `src/telemetry.test.ts` that each name is one the app or its SDK packages emit.

### GitHub

The git loop's routes, flows and tokens, triage, and the browser's issue writes, record ids, operations, outcomes, statuses and durations, never a title, a body, a comment, a login, a payload, the webhook secret or a token. [issues.md](features/issues.md#observability) lists every record; `worker/github/Flows.test.ts`, `worker/github/Api.test.ts`, `worker/github/Triage.test.ts` and `src/features/issues/issues.test.ts` assert them and their sentinels.

| Record | Kind | Where |
|---|---|---|
| `github.webhook`, `github.write.request`, `github.shape.<table>`, `github.reconcile.start` | log, span | ChatApi |
| `github.write`, `github.write.give_up`, `github.apply`, `github.reconcile`, `github.token.mint`, `github.config` | log, span | the `FlowExecution` Durable Object |
| `github_webhooks`, `github_delivery_lag_ms`, `github_write_requests`, `github_writes`, `github_write_ms`, `github_write_unknown`, `github_applies`, `github_reconciles`, `github_reconcile_changed`, `github_sync_age_seconds`, `github_token_mints`, `github_shape_requests` | counters, histograms, gauge | ChatApi and the Durable Object |
| `triage.read`, `triage.decide`, `triage.apply`, `triage.comment` | log, span | the `FlowExecution` Durable Object ([triage](features/issues.md#triage)); `triage.apply` with `dropped: enabler_demoted` is an Error |
| `triage_runs{outcome}`, `triage_decisions{decision,via}`, `triage_dropped{reason}`, `triage_overrides{from,to}`, `triage_tokens` | counters | the Durable Object; a person's override is counted by `github/Write`. Overrides of the flow are its error rate |
| `issues.write.queue`, `issues.write.send`, `issues.pending`, `smithers_issue_writes`, `smithers_issue_write_sends`, `smithers_issue_pending_actions` | browser | the engine worker and the tab |
| `issues.shape.sync`, `smithers_issue_shape_transitions` | browser log, span, counter | the tab; first request, first answer, changed failure status or recovery with finite phase, status and observation duration, without repository or issue content |
| `pulls.shape.sync`, `smithers_pull_shape_transitions` | browser log, span, counter | the tab; the same finite progress for the pull metadata shape, without repository or pull content |
| `item.shape.retry`, `smithers_item_shape_retries{item}` | browser log, span, counter | a person's Try again on an unavailable issue or pull; `item` is `issue` or `pull` |
| `pulls.merge.post`, `pulls.compare.get`, `smithers_web_pull_merges` | browser | the tab ([pull requests](features/pulls.md#observability)) |

### Agent status

What the agent's runs report, and what the person does about a question ([agent-status.md](features/agent-status.md#observability)). No record carries a question, an option or an answer.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `agent.status.report`, `agent.status.answer` | log | ChatApi | `runId`, `report` or `version`, `status`, `durationMs`, `bytes`, `existing`, `errorCode`, report `reason` (`settled`, `other_launcher`, `no_row`) |
| `agent.status.request` | span | ChatApi | `smithers.run.id`, `http.response.status_code` |
| `smithers_run_requests` | counter | ChatApi | `route` (`report`, `answer`), `status` |
| `smithers_run_shape_requests` | counter | ChatApi | `status`, `live` |
| `agent.status.report`, `agent.status.answer` | span | engine worker | `smithers.run.id`, `http.response.status_code` |
| `agent.status.report` | log | engine worker | `runId`, `status`, `outcome` (`sent`, `failed`), `errorCode` |
| `smithers_agent_status_reports` | counter | engine worker | `status`, `outcome` (`sent`, `skipped`, `failed`) |
| `agent.status.answer`, `agent.status.deliver` | log | engine worker | `outcome`, `delivered` |
| `smithers_agent_status_answers` | counter | engine worker | `outcome` |
| `agent.status.shown` | log | tab | `runId`, `version`, `surface` |
| `smithers_agent_status_shown` | counter | tab | `surface` |

### Conversation timeline

| Record | Kind | Where | Fields |
|---|---|---|---|
| `timeline.summary`; `smithers_timeline_summary_calls` | log, span; counter | engine worker | `role`, `outcome` (`ready`), `replayed`; counter without labels |
| `timeline.summary.unavailable`, `timeline.summary.unconfigured` | warning | tab | none; kept by `TIMELINE_TELEMETRY` |

### Plugins

What the plugin host loads and what the person does on its strip and keys ([plugins.md](features/plugins.md#observability)). No record carries a manifest's text, an item or a note.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `plugin.load` | span, log | tab | `plugin`, `version`, `tier`, `outcome` (`active`, `refused`), `reason` |
| `plugin.refused` | log | tab | `plugin`, `outcome`, `reason`, `path` (the manifest field) |
| `smithers_plugin_loads` | counter | tab | `outcome`, `tier`, `reason` |
| `smithers_plugin_contributions` | counter | tab | `point` |
| `plugin.press` | log | tab | `plugin`, `view`, `event`, `door` (`button`, `key`), `outcome` (`done`, `failed`, `invalid`, `stale`) |
| `smithers_plugin_presses` | counter | tab | `plugin`, `event`, `door`, `outcome` |
| `plugin.key` | log | tab | `plugin`, `key` |
| `smithers_plugin_keys` | counter | tab | `plugin`, `key` |

A key's flow is also `flow.dispatch` with door `key`.

### Notifications

The personal feed: a run's state routed to its people, GitHub's `main` and release deliveries, and what each person does with their entries ([notifications.md](features/notifications.md#observability)). Records carry run ids, subjects and counts, never a title, a question, a commit message or who pushed.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `runs.fold` | span | ChatApi | `smithers.run.id`, `smithers.notifications.written` |
| `smithers_notifications_routed` | counter | ChatApi and the clone's steps | `kind` (`run`, `clone`, `main`, `release`), `state` |
| `notifications.repo_event` | log, span | ChatApi | `kind`, `repoId`, `watchers`, `written` |
| `notifications.pending` | warning | tab | `subject`, `version`, `act`, `outcome` (`dropped`), `reason` (failure tag) |
| `smithers_notification_acts_dropped` | counter | tab | `act`, `reason` |
| `notifications.watch`, `notifications.ack` | log | ChatApi | `conversationId` or `subject`, `act`, `version`, `status`, `durationMs`, `bytes`, `existing`, `errorCode` |
| `notifications.request` | span | ChatApi | `smithers.route`, `http.response.status_code` |
| `smithers_notification_requests` | counter | ChatApi | `route` (`watch`, `ack`), `status` |
| `smithers_notification_shape_requests` | counter | ChatApi | `status`, `live` |
| `notifications.watch`, `notifications.ack` | log, span | engine worker | `subject`, `act`, `version`, `outcome` (`sent`, `refused`, `unsent`), `status` |
| `smithers_notification_watches`, `smithers_notification_acks` | counter | engine worker | `outcome`; `act`, `outcome` |
| `notifications.shown` | log | tab | `subject`, `version`, `state`, `kind` |
| `smithers_notifications_shown` | counter | tab | `state` |
| `notifications.panel` | log | tab | `act` (`open`, `expand`, `retry`), `via` (`bell`, `toast`, `more`, `key`) on open, `subject` |
| `smithers_notifications_panel` | counter | tab | `act`, `via` on open |

### Branch workspace

Tracking a branch, its conversation, its terminals, its machine, sharing it and its room ([branch-workspace.md](features/branch-workspace.md#observability)). No record carries a terminal's bytes, a screen, a branch's name, a token, a login, a person's place or anything asked; no metric label carries an id.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `branch.track` | log, span | ChatApi | `repoId`, `outcome` (`tracked`, `existing`, or the refusal), `mode`, `forge`, `status`, `bytes`, `durationMs`, `errorCode` |
| `smithers_branch_tracks` | counter | ChatApi | `outcome` |
| `terminal.open`, `terminal.connect` | log, span | ChatApi | `terminalId`, `branchId`, `access`, `outcome`, `code`, `status`, `durationMs`, `errorCode` |
| `smithers_terminal_requests` | counter | ChatApi | `route` (`open`, `connect`), `outcome` |
| `terminal.shape` | log, span | ChatApi | `status`, `live`, `durationMs`, `bytes`, `outcome` |
| `terminal.show` | log, span | browser | `preloadMs`, `rowCount`, `outcome` (`ready`, `failed`, `cancelled`); no identifiers or content |
| `terminal.show.failed` | log | browser | background selection or presence completion failed; no error contents |
| `smithers_terminal_shape_requests` | counter | ChatApi | `status`, `live` |
| `terminal.open.wake`, `terminal.open` | log | the `FlowExecution` Durable Object | `branchId`, `generation`, `terminalId`, `outcome`, `recorded`, `errorCode` |
| `sandbox.wake`, `terminal.session`, `terminal.open` | span | the `FlowExecution` Durable Object | `smithers.branch.id`, `smithers.terminal.id` |
| `smithers_terminal_opens` | counter | the `FlowExecution` Durable Object | `outcome` (`open`, `unavailable`, `checkout`) |
| `sandbox.object.wake` (span), `sandbox.checkout`, `sandbox.wake`, `sandbox.forge`, `sandbox.object.session` (logs, JSON) | | `SandboxObject` | `smithers.branch.id`, `branchId`, `stage` (`start`, `checkout`, `restore`, `placeholders`), `exitCode`, `failure` (`forge`, `branch`, `clone`, `other`), `status`, `outcome`, `errorCode` |
| `sandbox.box_request` (log) | | ChatApi | `errorCode`: a box's request that couldn't reach its object (502) |
| `smithers_cloudflare_terminal_connects`, `_sessions_open`, `_bytes`, `_sessions`, `smithers_cloudflare_sandbox_wakes`, `smithers_cloudflare_sandbox_rearms` | counters | `SandboxObject` (`@smthrs/platform-cloudflare`) | `access`, `outcome`, `direction` |
| `git.proxy` (log), `GitProxy.uploadPack` (span), `git_proxy_requests` | | `SandboxObject` (`@smthrs/effect-code-storage`) | `service`, `outcome`, `status`, `durationMs` |
| `branch.track`, `branch.open`, `smithers_web_branch_tracks`, `smithers_web_branch_opens`, `smithers_web_branch_reopens`, `chat conversation opened`, `chat conversation shown` | browser | the engine worker and the tab | `outcome`, `status`, `durationMs`, `conversation`, `conversationId` |
| `terminal.open`, `terminal.open.press`, `terminal.connect`, `smithers_web_terminal_opens`, `terminal_open_ms`, `terminal_reconnects`, `terminal_bytes`, `terminal_ended` | browser | the engine worker and the tab | `outcome`, `status`, `terminalId`, `branchId`, `durationMs`, `code`, `direction`, `reason` |
| `branch.share` | log, span | ChatApi | `branchId`, `change` (`person`, `access`, `remove`, `link`), `outcome` (`changed`, `unchanged`, or the refusal), `revoked`, `status`, `durationMs`, `errorCode` |
| `smithers_branch_shares` | counter | ChatApi | `change`, `outcome` |
| `smithers_branch_terminal_revocations` | counter | ChatApi | none |
| `branch.shares.shape` | log, span | ChatApi | `status`, `live`, `durationMs`, `bytes`, `outcome` |
| `smithers_branch_share_shape_requests` | counter | ChatApi | `status`, `live` |
| `branch.room` | log, span | ChatApi | `branchId`, `access`, `outcome` (`joined`, or the refusal), `status`, `durationMs`, `errorCode` |
| `smithers_branch_room_joins` | counter | ChatApi | `outcome` |
| `sandbox.enforce` (log), `sandbox.object.enforce` (span) | | `SandboxObject` | `detached`, `revoked`, `attached`, `errorCode` |
| `room.enforce` (log), `room.object.enforce` (span) | | `RoomObject` | `closed`, `errorCode` |
| `smithers_presence_joins`, `_frames`, `_evictions`, `_open` | counters | `RoomObject` (`@smthrs/sync`'s `PresenceRoom`) | `outcome` |
| `branch.share`, `branch.share.post`, `branch.share.press`, `smithers_web_branch_shares` | browser | the engine worker and the tab | `outcome`, `change`, `status` |
| `presence.join`, `presence.closed`, `smithers_web_presence_joins`, `smithers_web_presence_closes` | browser | the tab | `outcome`, `code` |

### Co-editing

Texts people edit together ([coedit.md](features/coedit.md#observability)). No record carries a text, an update, a path or a cursor; no metric label carries an id.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `text.write` | log, span | ChatApi | `textId`, `scope` (`conversation`, `run`), `bytes`, `seed`, `outcome` (`stored`, `existing`, or the refusal), `status`, `durationMs`, `errorCode` |
| `text.room` | log, span | ChatApi | `textId`, `scope`, `access`, `outcome` (`joined`, or the refusal), `status`, `durationMs`, `errorCode` |
| `smithers_text_writes`, `smithers_text_room_joins` | counters | ChatApi | `outcome` |
| `text.shape`, `smithers_text_shape_requests` | span, counter | ChatApi | `status`, `live` |
| `coedit.open`, `coedit.send`, `coedit.seed`, `coedit.apply`, `coedit.save` | browser | the tab | `kind`, `outcome`, `status`, `bytes`, `textId`, `durationMs` |
| `smithers_web_coedit_opens`, `_sends`, `_saves` | browser | the tab | `kind`, `outcome` |

### Sandbox tools

A branch machine's tools and its sleep and wake ([sandbox-tools.md](features/sandbox-tools.md#observability)). No record carries a command, a path, a file's content or a command's output; no metric label carries an id.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `sandbox.call`, `sandbox.result` | log, span | ChatApi | `callId`, `tool`, `door` (`person`, `agent`), `branchId`, `outcome` (`running`, `existing`, a status, or the refusal), `code`, `status`, `durationMs`, `errorCode` |
| `smithers_sandbox_call_requests` | counter | ChatApi | `route` (`call`, `result`), `outcome` |
| `sandbox.tool`, `sandbox.call` | log | the `FlowExecution` Durable Object | `callId`, `branchId`, `tool`, `outcome`, `settled`, `exitCode`, `timedOut`, `errorCode` |
| `sandbox.call.tool`, `sandbox.call.settle` | span | the `FlowExecution` Durable Object | `smithers.branch.id`, `smithers.sandbox.tool`, `smithers.sandbox.call.id` |
| `smithers_sandbox_calls` | counter | the `FlowExecution` Durable Object | `tool`, `outcome` (`done`, or the failure) |
| `sandbox.keep`, `sandbox.slept` | log, span | the `FlowExecution` Durable Object | `branchId`, `generation`, `ended`, `terminals`, `errorCode` |
| `smithers_sandbox_keeps` | counter | the `FlowExecution` Durable Object | `outcome` (`slept`, `busy`, `gone`, `unavailable`) |
| `sandbox.object.tool`, `sandbox.object.sleep`, `sandbox.checkpoint.save`, `sandbox.checkpoint.restore` (spans), `sandbox.checkpoint.save`, `sandbox.checkpoint.restore` (logs) | | `SandboxObject` | `smithers.sandbox.tool`, `smithers.sandbox.generation`, `outcome`, `errorCode` |
| `smithers_sandbox_checkpoints` | counter | `SandboxObject` | `op` (`save`, `restore`), `outcome` |
| `sandbox.egress.trust` (span), `sandbox.egress.setup` (warning log) | | `SandboxObject` | the wake's trust of the container's CA in a box without secrets; the warning carries the script's `exitCode` (2: the CA couldn't be trusted) or `errorCode` |
| `sandbox.registry.egress` (span), `secrets.egress` (log) | | `SandboxObject` (`@smthrs/secrets`' `Egress.forward`) | a box's request through the registry egress: `host`, `method`, `status`, `outcome`; never a path or a header |
| `smithers_registry_egress_requests` | counter | `SandboxObject` | `outcome` (`forwarded`, or the refusal: `host_not_allowed`, `port_not_allowed`, …). Was `smithers_job_egress_requests` until every box got the registry egress (2026-10-25) |
| `sandbox.tool` | span | `SandboxObject` (`@smthrs/sandbox`'s `SandboxTools`) | `smithers.sandbox.tool`, `smithers.sandbox.tool.outcome`, `smithers.sandbox.tool.exit_code` |
| `sandbox.call`, `sandbox.call.start`, `sandbox.call.post`, `sandbox.call.result`, `smithers_web_sandbox_calls` | browser | the engine worker | `tool`, `outcome`, `callId`, `door` |

### Sandbox budgets

How many machines are awake, who waits for one, and what a month of them costs ([sandbox-budgets.md](features/sandbox-budgets.md)). Ids, counts, dollars and hours only: never a person's id, a command or an address.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `sandbox.budget` | log (Info admitted, Warn waiting or failed), span `sandbox.budget.admit` | `SandboxObject` before a stopped machine starts; `terminal/Open`'s `sandbox/Admit` | `branchId`, `kind` (`branch`, `todo`, `job`), `outcome` (`admitted`, `waiting`, `failed`), `awake`, `scope` and `limit` when waiting, `errorCode` when failed |
| `smithers_sandbox_admissions` | counter | the same | `outcome`, `scope` (`deployment`, `person`, `none`), `kind` |
| `smithers_sandbox_awake` | gauge | the same, and `ops/SampleSandboxSpend` | machines awake in the deployment |
| `sandbox.keep.seen` | log, Warn | `sandbox/Keep` | a ledger renewal Postgres refused: `branchId`, `generation`, `errorCode` |
| `terminal.admit` | span | `terminal/Open` | `smithers.terminal.id` |
| `sandbox.wake` | log | `SandboxObject` | gains the stage `admit` and its `admitMs` |
| `sandbox.limits` | log, span `sandbox.limits.request` | ChatApi, `POST /api/sandbox-limits` | `awake`, `perPerson`, `monthlyAlertUsd`, `status`, `durationMs`, `bytes`, `errorCode` |
| `smithers_sandbox_limit_requests`, `smithers_sandbox_limit_shape_requests` | counter | ChatApi | `status`; the shape's `live` too |
| `sandbox.spend` | log (Info under, Warn over, Warn failed, Error not started), span with `smithers.sandbox_spend.id` | `ops/SampleSandboxSpend`, and a `FlowExecution` alarm that couldn't start it | `outcome`, `month`, `usd`, `hours`, `awake`, `limitUsd`, `errorCode` |
| `smithers_sandbox_spend_usd` | gauge | `ops/SampleSandboxSpend` | the month's estimated spend |
| `smithers_sandbox_spend_samples` | counter | the same | `outcome` (`under`, `over`, `failed`, `not_started`) |
| `sandbox.spend.bell` | log, span | `ops/BellSandboxSpend` | `alertId`, `admins` (how many bells it reached), `errorCode` |
| `sandbox.spend.delivery` | log, span | `ops/DeliverSandboxSpend` | as `database.alert.delivery` |
| `smithers_sandbox_spend_alert_deliveries` | counter | the same | `channel`, `outcome` |
| `sandbox.limits.set`, `smithers_web_sandbox_limit_sets` | browser | the tab's engine, `sandbox/limits/request` | the limits, `outcome` (`sent`, `refused`, `unsent`), `status` |

### Bug reports

A person's bug report, its intake and the Admins' notice ([bugs.md](features/bugs.md)). Counts, codes and the report's random id only: never what the person wrote, a page, a login, an address or a token.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `bug.request` | log (Info, Warn refused, Error unavailable), span | ChatApi, `POST` and `GET /api/bugs` | `op` (`file`, `list`), `outcome` (`filed`, `listed`, or the refusal's `code`), `status`, `durationMs`; filing: `bytes`, `reportId`, `by` (the act's kind), `existing`; listing: `door` (`session`, `token`), `count`; `errorCode` |
| `smithers_bug_requests` | counter | the same | `op`, `outcome` |
| `bug.shape`, `smithers_bug_shape_requests` | log, counter | ChatApi, `GET /api/shapes/bug-reports` (`ShapeProxy`) | `status`, `live` |
| `bug.report.bell` | log, span with `smithers.bug_report.id` | `ops/BellBugReport` | `alertId`, `admins` (how many bells it reached), `errorCode` |
| `bug.report.delivery` | log, span | `ops/DeliverBugReport` | as `database.alert.delivery` |
| `smithers_bug_report_deliveries` | counter | the same | `channel`, `outcome` |
| `bug.context`, `smithers_web_bug_contexts` | browser | the tab's engine, `app/bug/report/context` | `outcome` (`answered`, `gone`), `door` (`tab`, `agent`), `traces`, `runs`, `failures` (counts) |
| `bug.report`, `smithers_web_bug_reports` | browser | the tab's engine, `app/bug/report/send` | `outcome` (`filed`, `refused`, `unsent`), `door`, `status`, `code` |
| `bug.list`, `smithers_web_bug_lists` | browser | the tab's engine, `app/bug/list/read` | `outcome` (`read`, `refused`, `unsent`), `count`, `status` |
| `bug.file`, `bug.read` | browser span | `BugsClient` | `http.response.status_code` |

### Secrets

An Admin's writes of repository secrets, their shape, and a box's requests through the egress ([secrets.md](features/secrets.md#observability)). No record carries a value, a ciphertext, a header, a path or a body; records name secrets by name only, and no metric label carries a name or an id.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `secret.request` | log, span | ChatApi | `op` (`put`, `delete`), `repoId`, `name`, `hosts` (a count), `outcome` (`putting`, `deleting`, or the refusal), `code`, `status`, `durationMs`, `errorCode` |
| `smithers_secret_requests` | counter | ChatApi | `op`, `outcome` |
| `secret.shape` | log, span | ChatApi | `status`, `live`, `durationMs`, `bytes`, `outcome` |
| `smithers_secret_shape_requests` | counter | ChatApi | `status`, `live` |
| `secret.write` | log, span | the `FlowExecution` Durable Object | `op`, `change` (`set`, `replace`, `deleted`, `missing`, `repeat`), `repoId`, `name`, `outcome`, `errorCode` |
| `smithers_secret_writes` | counter | the `FlowExecution` Durable Object | `op`, `change` |
| `secrets.egress` (span) | | the egress | `smithers.branch.id`, `smithers.sandbox.generation` |
| `Egress.execute` (span), `secrets.egress` (log) | | the egress (`@smthrs/secrets`) | `server.address`, `http.request.method`, `smithers.egress.outcome`, `http.response.status_code`; the log's `outcome`, `host`, `method`, `status`, `secrets` (a count), `durationMs`, `errorCode` |
| `secret_egress_requests` | counter | the egress (`@smthrs/secrets`) | `outcome` (`forwarded`, `broken`, a refusal code, `unavailable_<code>`) |
| `secrets.put`, `secrets.delete` | span | browser, the Secrets page (`SecretsClient`) | the client span's own: no body |
| `secrets.write` | log | browser, the Secrets page | `op` (`put`, `delete`), `name`, `outcome` (`started` on 202, `refused`, `unknown` for no whole answer, then `landed` once the list shows it or `late` past 60 s), `code` (the refusal, or `exists`), `hosts` (a count) |
| `smithers_web_secret_writes` | counter | browser, the Secrets page | `op`, `outcome` |

The egress turns its HTTP client's own span off, so no request header reaches a trace. `secret_events` keeps each decision in Postgres for the audit.

### Your model

A person's own model: its routes, its shape, the `model/*` flows' steps, and the calls it answers ([personal-model.md](features/personal-model.md#observability)). No record carries a key, a ciphertext, a base URL, a model id or a prompt; no metric label carries a person.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `personal_model.request` | log, span | ChatApi | `op` (`put`, `delete`, `test`), `outcome` (`putting`, `deleting`, `ok`, `failed`, or the refusal), `code`, `protocol`, `failure` (a test's code), `providerStatus`, `status`, `durationMs`, `errorCode` |
| `smithers_personal_model_requests` | counter | ChatApi | `op`, `outcome` |
| `personal_model.shape` | log, span | ChatApi | `status`, `live`, `durationMs`, `bytes`, `outcome` |
| `smithers_personal_model_shape_requests` | counter | ChatApi | `status`, `live` |
| `personal_model.write` | log, span | the `FlowExecution` Durable Object | `op`, `change` (`set`, `replace`, `deleted`, `missing`, `repeat`), `outcome`, `errorCode` |
| `smithers_personal_model_writes` | counter | the `FlowExecution` Durable Object | `op`, `change` |
| `personal_model.call` | log | ChatApi, the `FlowExecution` Durable Object | a call the person's model didn't finish: `role`, `invocationId`, `outcome` (`failed`, `interrupted`), `errorCode`, `httpStatus` (the provider's); a warning for a refused key |
| `smithers_personal_model_calls` | counter | ChatApi, the `FlowExecution` Durable Object | `role` (a model role, or `test`), `outcome` |
| `smithers_personal_model_tokens` | counter | ChatApi, the `FlowExecution` Durable Object | `role`, `type` (`input`, `output`) |
| `personal_model.usage`, `smithers_personal_model_usage_errors` | log, counter | ChatApi, the `FlowExecution` Durable Object | a ledger write Postgres refused: `op` (`begin`, `end`), `invocationId`, `errorCode` |
| `model.endpoint` | log | ChatApi | `own_unusable:<reason>` for a saved model that can't be used here |

### Custom domains

A Maintainer's custom domains: the routes, their shape and the `domain/*` flows' steps ([domains.md](features/domains.md#observability)). Records carry the repository, codes and outcomes; never a hostname (unpublished until its owner points DNS at it), the provider's token or a request body.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `domain.request` | log, span | ChatApi | `op` (`add`, `remove`), `repoId`, `outcome` (`adding`, `refreshing`, `removing`, or the refusal), `code`, `status`, `durationMs`, `errorCode` |
| `smithers_domain_requests` | counter | ChatApi | `op`, `outcome` |
| `domain.shape` | log, span | ChatApi | `status`, `live`, `durationMs`, `bytes`, `outcome` |
| `smithers_domain_shape_requests` | counter | ChatApi | `status`, `live` |
| `domain.step` | log, span | the `FlowExecution` Durable Object | `op` (`claim`, `check`, `release`), `repoId`, `outcome` (a claim's `add`, `refresh`, `taken`, `removing`, `missing`, `repeat`; a check's state, `superseded`, `unreachable` or `orphaned`; `released`, `missing`, `unavailable`), `errorCode` |
| `smithers_domain_steps` | counter | the `FlowExecution` Durable Object | `op`, `outcome` |
| `domains.off` | log | ChatApi, the `FlowExecution` Durable Object | `reason` (`no_zone`, `no_zone_id`, `no_token`) |

In the browser (`src/features/domains/`, `DOMAINS_TELEMETRY`), each press on a repository's Settings page is a span `domain.add.press`, `domain.refresh.press` or `domain.remove.press`. Each runs `domain/add` or `domain/remove`, whose step records `domain.request` (Info `sent`, Warn `refused` and `unsent`: `op`, `outcome`, and ChatApi's `status` and `code` when it refused) and `smithers_web_domain_requests` by `op` and `outcome`, with its span `domain.add.send` or `domain.remove.send` (client). None carries a hostname or a DNS record.

`domain_events` keeps each add, refresh, removal and each change of state or problem in Postgres for the audit.

### TODOs

The stack's route, its one writer, its shapes and the browser's TODO steps and sends ([todos.md](features/todos.md#observability)). No record carries a title, a prompt, a criterion or a login: only ids, numbers, operations, outcomes, statuses and durations. `worker/stack/Stack.test.ts` and `worker/stack/Api.test.ts` assert the records and their sentinels.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `stack.request` | log, span | ChatApi | `op`, `via` (from the session), `opId`, `outcome` (`committed`, `dropped`, `repeated`, or the refusal's code), `number`, `status`, `bytes`, `durationMs`, `errorCode` |
| `stack.status`; `smithers_todo_status_reads` | log, span; counter | ChatApi, authenticated TODO status read | `outcome`, `status`, `durationMs`; unexpected database failures record only a finite SQL reason or `unexpected`, never an arbitrary error tag |
| `stack.apply` | log, span | ChatApi, inside `stack.request` | `repoId`, `opId`, `op`, `via`, `outcome` (`committed`, `dropped`, `stack_full`, `merged`, `not_found`, `repeated`, `conflict`), `number`, `version`, `durationMs` |
| `stack.report`; `smithers_todo_reports` | log, span; counter | TODO execution | attempt and TODO ids, kind, outcome (`applied`, `repeated`, `stale`), successor count; metric labels are kind and outcome |
| `todo.start`; `smithers_todo_admissions` | log, span; counter | TODO execution | flow, execution id, outcome (`started`, `not_started`), error code; metric labels are flow and outcome. Admission acknowledgment is distinct from execution completion |
| `todo.fail` | warning log | TODO execution | attempt and TODO ids, public `failure`, outer `errorCode`, typed `harnessCode`, typed `modelCode`, finite `budgetScope`, and finite `causeCode` for an evaluator, sandbox, or repeated-failure guard (otherwise `none`). Codes and scope are checked against SDK schemas or exact persisted tags; messages, amounts and causes are omitted. The stack transition counter records the failed state. |
| `smithers_stack_requests` | counter | ChatApi | `op`, `outcome` |
| `smithers_stack_ops`, `smithers_todo_transitions` | counters | ChatApi | `op`, `outcome`; `from` (`new` for a commit), `to` |
| `stack.shape.todos`, `stack.shape.todo_requests`; `smithers_todo_shape_requests`, `smithers_todo_request_shape_requests` | log, span; counters | ChatApi | `status`, `live` |
| `todos.draft`, `todos.queue`, `smithers_todo_drafts`, `smithers_todo_queued` | browser | the engine worker | `draftId` or `opId`, `op`, `via`, `door`, `outcome` (`kept`, `not_kept`, `issue_not_found`, `tab_gone`, `agent`), `fromIssue`, `durationMs` |
| `keys.press`, `smithers_web_shortcut_presses` | browser | the tab | `key`: a one-key shortcut pressed the button that declares it, such as Make TODO's `t` |
| `todos.send`, `todos.pending`, `smithers_todo_sends`, `smithers_todo_pending_actions` | browser | the tab | `opId`, `op`, `outcome` (`taken`, `existing`, `retry`, `refused`), `status`, `code`; `action` (`edit`, `discard`, `discard_draft`) |

A refused commit or drop of the agent's (`outcome: agent`) is the defense the catalog already holds; a nonzero count means a flow call reached the step that the catalog should have refused.

Watching a TODO's run ([runs.md](features/runs.md#a-run-on-cloudflare)): ChatApi reads the run from the engine's schema and serves its row of the engine's change feed. Ids, sizes and outcomes only; never a value of the run. `worker/RemoteRuns.test.ts` asserts them and a sentinel.

| Record | Kind | Where | Fields |
|---|---|---|---|
| `run.inspect` | log, span | ChatApi, each `GET /api/remote-runs/<run id>` | `host` (`remote`), `runId`, `outcome` (`read`, or the refusal's code), `events`, `bytes`, `clipped`, `status`, `durationMs`, `errorCode` |
| `smithers_remote_run_reads` | counter | ChatApi | `outcome` |
| `runs.shape.remote`; `smithers_remote_run_shape_requests` | log, span; counter | ChatApi | `status`, `live` |
| `run.read`, `smithers_run_reads` | browser | the tab | as for this device's runs, `outcome` also `not_started` |
| `run.stop`; `smithers_run_stops` | log, span; counter | ChatApi, each `POST /api/remote-runs/<run id>/stop` ([actions.md](features/actions.md#acts)) | `host` (`remote`), `runId`, `via`, `outcome` (`requested`, `settled`, or the refusal's code), `status`, `durationMs`, `errorCode` |
| `repo.run.record` | log, span | ChatApi or a remote flow, each repository run recorded | `runId`, `repoId`, `flow`, `event`, `outcome` (`recorded`, `existing`) |
| `run.steer`; `smithers_run_steers` | log, span; counter | ChatApi, each `POST /api/remote-runs/<run id>/steers` | `host` (`remote`), `runId`, `steerId`, `via`, `outcome` (`taken`, `existing`, or the refusal's code), `bytes`, `status`, `durationMs`, `errorCode` |
| `runs.steer.queue`; `smithers_run_steers_queued` | log, span; counter | the engine worker | `steerId`, `runId`, `via`, `door`, `outcome` (`kept`, `not_kept`, `tab_gone`, `no_credential`) |
| `run.steer.send`; `smithers_run_steer_sends` | log, span; counter | the tab | `steerId`, `runId`, `outcome` (`taken`, `existing`, `retry`, `refused`), `status`, `code` |

Steering a TODO's agent ([runs.md](features/runs.md#steering)) records ids, sizes and outcomes; a message's words reach only the run's queue and its model, never a record. `worker/RemoteRuns.test.ts` asserts a sentinel message in no record.

### Flow usage

Which flows run, and how (Will, 2026-10-20: "Everything is a flow so the most obvious metrics are just what flows are being ran and how"). The durable engine records them for every run on every host, so a flow gets them without declaring anything: `@smthrs/flow` `RunMetrics`, recorded by `@smthrs/engine-store` and by `@smthrs/agent`'s model steps ([its API](../../../packages/smithers/flows/flow/docs/api.md#runmetrics)).

| Record | Kind | Fields |
|---|---|---|
| `flow.run.created`, `flow.run.claimed` | log (Info) | `smithers.execution.id`, `smithers.flow` on creation, `createdAtMs` or `claimedAtMs`; no identity or payload |
| `flow.run.started`, `flows_runs_started` | log (Info), counter | `flow`, `door`, `actor`, `placement`; the line adds `executionId` |
| `flow.run.settled`, `flows_runs_settled` | log (Info `succeeded`, else Warn), counter | the same, `outcome` (`succeeded`, `failed`, `refused`, `cancelled`, `lost`) and `code` (`none`, the refusal's or failure's code, `defect`, `interrupted`, `cancelled`); the line adds `durationMs` |
| `flows_run_duration_ms` | histogram | `flow`, `outcome`, `placement`: from admission to the lineage's settlement |
| `flows_run_first_step_ms` | histogram | `flow`, `placement`: from admission to the engine first starting the run |
| `flows_steps`, `flows_step_retries` | counters | `flow`, `outcome` (`succeeded`, `failed`, `interrupted`): each step attempt that ran its body; a retry is an attempt after the first |
| `flows_waits`, `flows_wait_ms` | counter, histogram | `flow`, `kind` (`timer`, `signal`, `approval`, `quota`, `human`, `other`): each park, and its length at the resume |
| `flow.model.call`, `flows_model_calls`, `flows_model_tokens` | log (Info), counters | `flow`, `model`, `outcome`; tokens by `direction` (`input`, `output`); the line carries `inputTokens` and `outputTokens` |

- **Door and actor.** The app's dispatch (`src/flows/dispatch.ts`) names them: its door, and the actor kind behind it (`actorOf`: `person` for `button`, `slash`, `view`, `composer` and `key`; `agent` for `agent`; `app` for `sync`). `BrowserEngine.start` carries them to the leader. A run another run starts is door `flow` by its starter's actor kind, and a run an agent's tool call starts is door `agent` by `agent`. Remote flows carry their starter's through `ExecutionObject.intent`; one ChatApi starts without naming one is `unknown`.
- **Placement** is the engine's: `browser` in the engine worker, `cloudflare` in `FlowExecution`. Both hosts write the lines at Info (`RunMetrics.layerInfoLines`); elsewhere they are Debug.
- **Model.** On the app a model step's model id is its role (`agent`), so `flows_model_tokens` joins ChatApi's `smithers_model_spend_tokens` and `model.spend` by role.
- **Bounded, content-free.** Doors, actors, placements, outcomes and wait kinds are closed sets (`other` otherwise). Flow tags, model ids and codes are cleaned to identifiers and capped per engine at 200, 50 and 100 distinct values (`other` past the cap). No record carries a payload, a result, a failure's message or who started a run.
- **Where they go.** The engine worker's records reach ChatApi's log through the relay (`FLOWS_TELEMETRY`); `FlowExecution`'s are its own log lines. The [flow usage dashboard](../ops/grafana/README.md) reads the `flow.run.*` and `flow.model.call` lines from Loki, since a browser's counters start over on each reload and a line per run adds up across devices. On the device, the Runs page sums its own runs ([runs](features/runs.md#flows)).

### Relayed browser records

`POST /api/telemetry/v1/{logs,traces,metrics}` relays the browser's records through `OtlpRelay.serve` with limits and an allowlist (`worker/Chat.ts`; [chat.md](features/chat.md#post-apitelemetryv1logstracesmetrics)):

- **One list, shared:** `BROWSER_TELEMETRY` (`src/telemetry.ts`) merges every feature's contract (`APP_TELEMETRY`, `CHAT_TELEMETRY`, `AUTH_TELEMETRY`, `FLOWS_TELEMETRY`, `AGENT_TELEMETRY`, `THEME_TELEMETRY`, `NAVIGATION_TELEMETRY`, `REPO_TELEMETRY`, `HOME_TELEMETRY`, `STATUS_TELEMETRY`, `BRANCH_TELEMETRY`, `TERMINAL_TELEMETRY`, `TIMELINE_TELEMETRY` and the others). The relay takes it as `allow`, and the engine worker's exporter sends only its span names, so the browser and ChatApi can't drift: `src/telemetry.test.ts` fails when the relay drops anything the browser exports that `WITHHELD` doesn't name.
- **Records:** the log messages, span names and metric names under [Browser](#browser) and [The engine worker](#the-engine-worker), by name. Any other record is dropped and counted as `not_allowed`.
- **Fields:** the relay's own (`RELAY_FIELDS`: `otlp.signal`, `service.name`, `otlp.severity`, `trace_id`, `span_id`, `otlp.parent_span_id`, `otlp.duration_ms`, `otlp.metric_type`, `otlp.unit`, `otlp.value`, `otlp.count`, `otlp.sum`), each feature's attributes, `exception.type`, and the HTTP client span's `http.request.method`, `http.response.status_code`, `url.path`, `url.scheme`, `server.address`, `server.port` and `error.type`. Every other field is removed.
- **Withheld (`WITHHELD`):** the fields `exception.message`, `exception.stacktrace` and `otlp.status_message`, since a message can quote what someone wrote, and `effect.fiberId`; `url.full` and `url.query`, whose values can include credentials or private query parameters; and the per-request spans `browser.engine.request` (the tab's, dropped by the relay) and `browser.runtime.request` (the leader's, never sent), one per poll, hundreds per answer, which `smithers_browser_engine_requests` and `smithers_browser_runtime_requests` count.
- **Limits:** 128 KiB per export (413 past it), and 200 records per export (the rest dropped and counted as `over_limit`): `TELEMETRY_LIMITS` in `src/telemetry.ts`. The tab's and the engine worker's exporters take the same limits and split a larger batch into exports under both, so a burst arrives whole. Before 2026-10-22 they sent it as one request, which the relay refused: a reload that woke 60 flow runs lost its 616 KB of spans.

The relay doesn't check the values: a caller picks its records' `service.name`, `trace_id` and `span_id`.

## Tests

| Test | Proves |
|---|---|
| `e2e/fixtures.ts` | every e2e test keeps the browser console; a failing test saves `browser.log` |
| `e2e/console.test.ts` | a browser log line keeps every field of a record: Playwright's `text()` keeps an object argument's first five properties, so `e2e/console.ts` writes each object out from its value (a `sandbox.call`'s `outcome` and `callId` were missing until 2026-10-25) |
| `worker/Chat.test.ts` "what anyone wrote never reaches a log line, span or metric" | a sentinel in questions, an invalid body, a refused retry and a Guest's refused question appears in no log, span attribute, event or failure, or metric attribute |
| `worker/Chat.test.ts` "a crash on … is 500, logged by the defect's name and never its message" | a defect is `chat.question` at Error with `errorCode: defect` and its name, `error.type` on a span that ends without it, and its message nowhere |
| `worker/Chat.test.ts` 400, 401, 403, 405, 409, 413 and 503 tests | each `chat.question` `errorCode` |
| `worker/Chat.test.ts` "traceparent" tests | a well-formed `traceparent` parents `chat.question` and its line carries its `trace_id` and the span's `span_id`; the sampled flag is ignored; a malformed one, or `b3`, parents nothing |
| `worker/Chat.test.ts` "POST /api/telemetry/v1/*" tests | a browser record becomes one ChatApi line with only the allowlisted fields; a span's status message is dropped; records off the allowlist or past 200 are dropped and counted; past 128 KiB is 413 |
| `worker/ShapeProxy.test.ts` | one `chat.shape` line per request with its bytes (502 at Error, an abandoned request `aborted`), and the Electric secret in no log or span |
| `worker/ModelEndpoint.test.ts` "telemetry" | a sentinel in the prompt, echoed by the model and quoted in a provider's error, and a sentinel key, appear in no log, span attribute, event or failure, or metric attribute |
| `worker/ModelSpend.test.ts`, `worker/flows/SpendAlert.test.ts`, `worker/SpendAlerts.test.ts` | `model.spend` and both spend counters by role and model, with no prompt; `model.spend.alert` `not_started` by code, never a defect's message, and `smithers_model_spend_alerts` by outcome; the alert step's lines at Warn and Info and its failure by `sql:<reason>`; `spend.alerts.shape` and its count |
| `worker/flows/DatabaseLoad.test.ts` | `database.connections` at Info under the share and Warn over it with only `used`, `max`, `ratio` and the span's ids, both gauges, `smithers_database_load_samples` by outcome and the step's span around its query; a failed sample by `sql:<reason>`; a refused start at Error by code; `database.alert.delivery` and its count, naming no chat or token |
| `src/features/spend/spend.test.ts` | `smithers_web_spend_alerts_shown` once per alert per tab, and `smithers_web_spend_alerts_hidden` once per stored Hide |
| `worker/ModelEndpoint.test.ts` refusal, role and metering tests | `model.proxy.serve` with `role` and its outcome for 401, 403, 400, 429 and 503; `model.endpoint` with `sql:<reason>` and `unusable:<reason>`; `model.usage` for `refused` and `kept` (with `ended`, `reported` and the failure's `errorCode`), `expired` and a failed settle, and `smithers_model_usage_writes` by outcome; `smithers_model_tokens` by role and model |
| `worker/SetModel.test.ts` | `admin.set_model` at Warn with the refusal's reason, and at Error with the SQL reason |
| `packages/smithers/agent/model/test/ModelProxy.test.ts` | the proxy's spans, metrics and log lines, the host's attributes on server records only, and no prompt, response or provider text in any of them |
| `packages/smithers/flows/observability/test/Logger.test.ts` | `Logger.layerStructuredJson` writes the current span's `trace_id` and `span_id`, and a caller's own annotations under those names win |
| `src/features/chat/telemetry.test.ts` "asking" | read back from the browser's OTLP exports, attribute by attribute: `question asked`, `question stored`, `question not sent` and `unsent question handled`; `chat.ask`, then `outbox.send` linked to it, with `chat.ask.send`, `chat.question.post` and `POST` in one trace with ChatApi's `chat.question`; `smithers_web_questions`, `smithers_web_ask_failures`, `smithers_web_unsent_actions`, `smithers_web_composer_opens`, `smithers_web_answer_first_text_ms`, `outbox_attempts`, `outbox_refused`, `outbox_queued_ms`, `outbox_leader_changes` and `persistence_restore_ms`; a sentinel in questions and answers in no export |
| `src/features/chat/telemetry.test.ts` "an answer not started" | `answer not started`, `reason` `unavailable`, for a question ChatApi took on a tab whose engine worker failed |
| `src/features/chat/telemetry.test.ts` "the connection and the window" | the same for `chat connection changed`, `chat retried`, `smithers_web_sync_failures`, `smithers_web_sync_retries` and `smithers_web_history_loads` |
| `packages/effect-tanstack-db/test/Outbox.test.ts`, `Persistence.test.ts` | `outbox.send` with its link and attributes, `outbox write failed`, `outbox couldn't load its writes`, `persistence unavailable`, `persisted write failed`, and every `outbox_*` and `persistence_*` metric |
| `src/features/chat/chat.test.ts` | each metric's count by its attributes in every case: asking, failures, sync health, history, the composer and shortcuts |
| `src/boot.test.ts` | read back from the OTLP exports: `chat ready` and `smithers_web_boot_ms` once the conversation is restored from the device; `chat couldn't restore` and no boot time when it can't be; `persistent storage requested` and `smithers_web_storage_persisted`, granted or not; `page error` and `unhandled rejection` by name and place, never their message; `page reloaded` and `smithers_web_page_reloads` |
| `packages/effect-tanstack-db/test/Collection.test.ts` | `collection cleanup failed` with the collection's id and the error's name, never its message |
| `packages/effect-electric/test/ShapeProxy.test.ts` | the shape proxy's log line, span, count and 405, a subset request's parameters dropped and never forwarded, and the Electric secret in no log or span |
| `src/telemetry.test.ts` "the relay keeps everything the browser exports" | the tab's and the engine worker's exports, as `src/boot.ts` and `src/flows/engine.worker.ts` install their exporters, through the real relay with `BROWSER_TELEMETRY`: an answer whose agent calls a flow, asking, a refused ask, sync failing and retried. Nothing is dropped that `WITHHELD` doesn't name, the end-to-end tests' fields arrive, and no engine export comes near 128 KiB |
| `src/telemetry.test.ts` "the contract" | no field that can carry what someone wrote; every record name is a string literal in the app or the SDK packages it names, or one a library forms (`GET`, `chat agent`, `execute_tool <flow>`) |
| `src/telemetry-privacy.test.ts` | the real exporter and relay preserve `notifications.pending`, `smithers_notification_acts_dropped` by `act` and `reason`, `auth.run_credential` with `door_timeout`, and every report refusal's `reason`; sensitive URL fields stay removed |
| `packages/smithers/flows/observability/test/Otlp.test.ts` "exports only the spans `spans` names" | an exporter's `spans` list: only the named spans are sent, a dropped span's children keep its trace and parent id, and logs are sent as before |
| `packages/smithers/flows/platform-browser/test/BrowserRuntime.test.ts` "run sends the worker's logs, spans and metrics to its telemetry" | `BrowserRuntime.run`'s `telemetry` receives the leader's log, spans and counts |
| `worker/ExecutionHost.test.ts` "every start and alarm is one log line and one count by outcome, never the payload" | `cloudflare.execution.start` (`accepted`, `duplicate`) and `cloudflare.execution.alarm` (`settled`) lines and their counters, with a sentinel payload absent from every line |
| `worker/flows/Pause.test.ts` "logs one probe.mark line" | the deployed probe step logs `probe.mark` with its `label` |
| `worker/flows/Expire.test.ts` "each step logs and counts its outcome, never the text" | `chat.answer.expire` for `abandoned`, `settled` and `failed` (with `sql:<reason>`), `smithers_answer_expiries` by outcome, and a sentinel question in no line |
| `worker/Chat.test.ts` "chat/Expire" | `chat.question` `expiry`, and a refused start's `chat.question` `503` with `expiry_not_started` and `chat.answer.expire` `not_started` with the host's code or `conflict`, counted |
| `worker/SignIn.test.ts` "telemetry" | GitHub's tokens, the code, `state`, the session cookie and its token, SESSION_SECRET, the client secret and the login appear in no log, span attribute, event or failure, or metric attribute; ChatApi's relay keeps the browser's sign-in records and drops a field off its allowlist |
| `worker/SignIn.test.ts` route tests | `smithers_auth_requests` by route, outcome and reason for every refusal and failure, and the `auth.callback`, `auth.sign_in`, `auth.session` and `auth.config` lines with their `errorCode` |
| `worker/flows/RecheckRole.test.ts` "its records carry the outcome and the session id, never a token or a login" and "keeping the role records it, …" | `auth.role_check` by step: `redeemed`, `stored`, `checked`, `none`, `failed` and `kept`, with no token or login |
| `worker/flows/RevokeGitHubToken.test.ts` "its records carry the outcome and the session id, never a token or a login" | `auth.revoke_token` by step: `over`, `failed` and `revoked`, with no token or login |
| `worker/SignIn.test.ts` sign-out tests | `auth.sign_out` `failed` with reason `not_started` and the host's code; `auth.callback` `failed` with reason `sign_out_not_started` |
| `src/features/auth/auth.test.ts` | `session loaded` with `signedIn` and never the login, `session unreachable` and `sign out failed` with their `status`, `device wiped` and `device wipe failed`, `smithers_web_sign_in_presses`, `smithers_web_sign_outs` and `smithers_web_device_wipes` by outcome |
| `worker/RepoApi.test.ts` | `repo.about` with `cached` and `errorCode`, and `repo_reads` of kind `about`; `repo.clone.request` by outcome, `repo.tree` and `repo.blob` with `repoId`, `sha` and `errorCode`, `repo.raw` and `repo.refs` (no `sha`), `repo.meter`, `repo.clone.step` and `repo.clone.settle`, `repo.spend.alert` once per threshold, `repo_clone_requests`, `repo_reads`, `repo_clones`, the gauges, and a sentinel file and commit message in no log, span or metric |
| `worker/flows/RepoClone.test.ts` | `repo_clones` and `repo_capacity` by reason; `repo.clone.settle` with `errorCode` when Postgres refuses; the clone's feed row through each stage |
| `worker/RepoConfig.test.ts` | `repo.config` with `invalid_key`, and the key nowhere in the log |
| `src/features/repo/repo.test.ts`, `faults.test.ts`, `copy.test.ts` | the browser's repository records and metrics by outcome: `repo.clone` and `smithers_web_repo_clones` for each of RepoApi's answers, `repo.clone.unconfirmed`, `repo.copy` and `smithers_web_repo_copies` by what, door (a person's and the agent's) and outcome, and `repo.refs.load` |
| `src/features/commands/commands.test.ts` | `smithers_slash_choices` by kind and how, `smithers_slash_submits` by outcome and command (none for a name the app doesn't offer), and `smithers_flow_dispatches` with door `slash` for a command that ran |
| `src/features/navigation/navigation.test.ts` | `web.navigate` and `smithers_web_navigations` by door and outcome for every outcome, the span's attributes, every field one the relay keeps, and a sentinel path in no line or span |
| `src/features/web/web.test.ts`, `src/features/views/views.test.ts`, `worker/Views.test.ts`, `worker/WebPreview.test.ts` | `web.page.open` and `smithers_web_pages_opened` by mode, door, outcome and framing for the agent's steps and a person's tab, every field one the relay keeps, a sentinel page in no line or span; `chat.view.add` and its counts for every status; `chat.web.preview`, its span and `smithers_web_previews` by status and framing, a sentinel page in no record |
| `src/features/jev/jev.test.ts` | `jev.judge`, `smithers_jev_judgments` and `smithers_jev_verdicts` by flow, outcome and verdict code, every field one the relay keeps, a sentinel item, question, label, text and criterion in no line or span |
| `packages/smithers/flows/flow/test/RunMetrics.test.ts` | `RunMetrics`' closed sets and caps, `settlement` by code and never message, and each recorder's metric and log line with the same fields |
| `packages/smithers/flows/engine-store/test/RunUsageMetrics.test.ts` | through the durable engine, into an injected registry and logger: runs started and settled by flow, door, actor and placement (a child's door `flow`), a declared failure's code, a cancellation, the first step, a step's retry, a signal wait parked and ended; a sentinel payload in no attribute or line |
| `ops/grafana/dashboard.test.ts` | the flow usage dashboard filters only on lines the relay keeps or ChatApi writes, and parses only fields they carry |
| `e2e/flow-usage.spec.ts` | locally or on a deployment with log access, the theme button's `flow.run.started` and `flow.run.settled` lines (door `button`, actor `person`, placement `browser`, `succeeded`) relayed to ChatApi, and the Runs page's flows summary counting the run |
| `e2e/navigate.spec.ts` | locally, the engine worker's `web.navigate` lines for the agent's navigation and refusal, read from ChatApi's relayed records |

Answer exchange deadlines emit `chat.answer.exchange`, `chat.answer.exchange.timeout` and `smithers_answer_exchange_timeouts`, by `operation`. Independent progress writers emit `chat.answer.progress`, `chat.answer.progress.failed` (`answerId`, `status`) and `smithers_answer_progress_writes` for accepted writes. These records contain no answer content.

### Shape recovery (2026-10-22)

Every shared `ShapeProxy` request emits its existing per-shape line, including refusals, access-check defects and abandonment. Fields include `route` (fixed shape name), `status`, `statusClass`, `durationMs`, `upstream` and `correlationId` (also returned as `x-request-id`). `upstream` is `electric` once Electric was contacted, `database` when ChatApi's session/access database cannot answer, `access` for a permission refusal or access-check defect, and `proxy` for a method refusal. It identifies the failed boundary rather than inferring Electric's internal dependency. `electric_shape_responses{name,statusClass}` counts all shapes; existing per-route counters remain. No URL, query, table predicate, credential, user content or error message is added.

Browser `chat load failed` / `chat load recovered` records, `chat.load` spans and `smithers_web_chat_loads{shape,surface,status,outcome}` use the existing OTLP exporter and relay contract. `shape` is `chat.messages`; `surface` is `conversation` or `composer`; status is the failed HTTP status (0 for a network/decoding failure), or 200 after an installed transaction's resume cursor matches the accepted response. An outage records one transition for each surface and one recovery, not one line per retry. Branch and home conversations are observed independently without logging conversation ids or contents. The shape client's existing indefinite SyncPolicy backoff owns recovery; no app retry loop was added. The timeline's existing content-free `timeline.summary.unconfigured` diagnostic is now retained by the same allowlist.

Proof: `worker/ShapeProxy.test.ts`, `worker/SpendAlerts.test.ts`, `worker/AlertChannels.test.ts`, `src/features/branch/conversation.test.ts`, `src/features/spend/spend.test.ts` and `e2e/shape-recovery.spec.ts`. The e2e uses a faulty Effect ShapeSource that answers 503 three times for a new branch, then delegates to the real proxy and Electric; it also checks a Member never subscribes to Admin shapes. No browser route interception or UI copy is added.

The browser relay retains `flows_engine_replay_seeds` and the engine lifecycle records `engine-store.registration.recovered`, `flow.run.created` and `flow.run.claimed`, including `createdAtMs` and `claimedAtMs`. These records carry operational counters, identifiers and times, never user content. The relay integration test checks that these records and fields survive export.

Repository trigger admission records `not_allowed` in `ci.dispatch` and `smithers_ci_dispatches` when `REPO_FLOWS_REPOSITORIES` excludes the repository. The durable `triggers/Match` receipt has that outcome and an empty flow list. `triggers/Start` checks the allowlist again and logs `ci.start` with `not_allowed` if it has changed.

Conversation list loading records `conversations.shape.sync` and
`smithers_conversation_shape_transitions{phase}` for the first shape request,
answer, changed failure status and recovery. `conversations.list` logs and spans
changed `syncedRows`, `pendingRows`, `listedRows`, `archived` and `loaded`;
`smithers_conversation_list_updates{archived,loaded}` counts those transitions.
A shape answer is a network receipt, not proof of installed or rendered rows.
Use the list counts and page snapshot to locate a blank list. These records
contain no ids, repository or branch names, search text or conversation content.

### Production test capture integrity

`e2e/logs.ts` reads the deployment's ChatApi through a Cloudflare tail. Usage and correlation captures filter invocations to POST carrying their opaque per-capture header: asks, answer writes and all three OTLP signals remain included, while unrelated Electric GET traffic is excluded before Cloudflare streams it. Opening waits for the exact trace of a content-free, signed-out `POST /api/questions` (`{}`, refused without storing anything). An unrelated log cannot satisfy readiness, and a missing receipt fails capture after a bounded wait. A failed opening can be tried again; a disconnected or sampled capture stays failed for its readers, and the next capture opens a fresh connection. Cloudflare's `overload-stop` notification cannot restore dropped records.

A tail's empty result does not prove absent instrumentation. The production sweep's browser log already contains `app/theme/set` usage lines. ChatApi emits `chat.question` before the response that produces `question stored`; missing that server line while the browser has its response is evidence of an incomplete capture, rather than proof that the handler never ran. The flow usage integration test checks the real engine's started and settled lines, all usage labels, duration, exporter and relay. The correlation E2E still requires every record and trace id.

Cloudflare documents that [real-time logs can sample under load](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/). Sampling, socket failure and receipt timeout are reported as incomplete capture, never converted into successful assertions or empty production logs. Only the protocol warning's type is retained; its text and request metadata are not logged.

The 2026-10-25 browser transport reproduction received ten successful, fully consumed collector acknowledgments but captured five records. No sampling warning arrived and the configured head sampling rate was 1. A Node reproduction retained all 20 records. The remaining production gap is unresolved; passing the capture integrity regressions does not prove the original production usage or correlation assertions pass. Stored-log comparison requires access to Cloudflare’s telemetry query API, which the available tail token lacks.
