# Chat with Smithers

Opening Chat records `focusRequested` in the memory-only composer collection.
The input consumes it through `takeComposerFocus` when attached, then focuses.
Closing Chat cancels it; a route remount or draft change creates no request.
The React view holds no focus state. See [decision 0081](../decisions/0081-keyboard-focus-through-file-navigation.md).

## What the user does

1. Opens the app (`/app`) and presses ⌘K (Ctrl+K), or clicks Chat ⌘K. The app opens at once, from the device, online or not. It installs as a PWA.
2. Types a message and presses Enter or Send, whenever: offline, or while an answer streams. Asking needs sign-in as a Member or above: a signed-out person sees Sign in with GitHub where the composer would be ([sign-in.md](sign-in.md#the-browser)). Smithers answers with the person's own model ([Your model](personal-model.md)): a person who saved none sees "Add your model" and Open settings where the composer would be, unless the deployment's own model is on ([hosted inference](model-endpoint.md#hosted-inference), off for a deploy).
3. Hides the chat with ⌘K again, Esc, or the Hide button.
4. Sees their message at once, then Smithers' answer growing as it streams. Questions asked in a row are sent in that order.
5. Sees the same conversation, live, on every other device that has the app open. Reloading a tab mid-answer doesn't stop the answer; closing every tab of the asking browser pauses it until the app opens there again.
6. Sees the most recent 50 messages, and clicks Load earlier for the 50 before them; the device has the whole conversation, so this needs no network.
7. Uses each message's controls ([message controls](#message-controls)): sees when each was written (`3m ago`), copies a finished message with Copy or the latest answer with `/copy`, takes a queued question back to the composer with Edit before it is sent, and finds an unsent draft still in the composer after a reload.

The status copy is decision [0002](../decisions/0002-local-first.md) §2:
- Offline, the header's pill says `Offline`, or `Offline · 2` with two questions waiting; each waiting question is badged `Queued`. They are sent once the device is back online, after a reload or a restart too. The pill hides once everything is sent and synced.
- When Smithers can't be reached for 10 s with the browser online, the pill says `Offline` with Retry; when Electric refuses the shape, `Sync failed` with Retry.
- A question the server refuses stays where it was, `Not sent`, with Edit (back to the composer) and Discard; one the outbox couldn't take has Retry and Discard.
- If Smithers can't answer, the answer says `Couldn't answer`, with Retry, which asks again.
- If this browser can't run Smithers' engine (its engine worker failed), the pill says `Smithers can't run in this browser`, with Reload, for good.
- No loading, saving or syncing copy exists, and no spinner: an answer that hasn't started is one skeleton line in its bubble, the height of its first line, shown only once the wait has lasted 300 ms ([navigation](navigation.md)).

## How it works

```
browser ── messages (OPFS SQLite) ◀── Electric shape ◀── GET /api/shapes/messages ◀── Electric ◀── Postgres
        ├─ ask: asking row + outbox write (IndexedDB) ── POST /api/questions ── ChatApi ── INSERT question + streaming answer ──▶ Postgres
        └─ once ChatApi took it: start chat/Answer { answerId } ── the tab's engine (engine worker, SQLite on OPFS); the send waits until it recorded the run
              chat/Answer ── GET /api/answers/<id> ── POST /api/model/agent ── POST /api/answers/<id> ── UPDATE answer ──▶ Postgres
service worker: the app's shell, cached for offline; never /api/* and never the engine
```

- **Postgres** holds the conversation (`messages`). It is the only source of truth, and its `position` column orders it.
- **Electric** streams the `messages` table to every device. Browsers reach it only through ChatApi's shape proxy, so the Electric URL and secret stay on the server.
- **ChatApi** (`worker/ChatApi.ts`) is an Alchemy Effect-native Worker. It reaches Postgres through Hyperdrive. It answers nothing itself.
  - For a signed-in Member or above, it inserts the question and an empty `streaming` answer in one statement, starts the answer's expiry (`chat/Expire`, [agent.md](agent.md#settling)), and answers 202 with the transaction id once the start is recorded.
  - It serves the routes the browser's agent answers through: the metered model endpoint, `POST /api/model/<role>` ([model-endpoint.md](model-endpoint.md)), and the answer routes, `GET` and `POST /api/answers/<id>` ([agent.md](agent.md#the-answer-routes)).
  - Its code: `Chat.ts` (routes and the shape proxy, `ShapeProxy` from `@smthrs/effect-electric`), `Messages.ts` (asking and the history), `Answers.ts` (the answer routes).
- **The browser's agent answers.** Once ChatApi takes a question, the asking tab dispatches `chat/Answer { answerId }` on this browser's durable engine, with the answer's id as its execution id ([agent.md](agent.md), decision [0011](../decisions/0011-the-agent-runs-in-the-browser.md)), and the send waits until the engine has recorded the run, so the outbox keeps the question until a run exists to answer it: a tab closed in between leaves the question in the outbox, and the next page sends it again and starts the run. The engine's starts are idempotent by execution id, so a resend starts no second run. A reload or a killed tab resumes the run from its journal when the app opens again; a model call that sealed is never made again.
- **The browser** (`src/features/chat/`) keeps the conversation on the device and sends every question through a durable outbox (decision [0002](../decisions/0002-local-first.md)). Its state machine, the Effect boundary and the libraries it uses are in [state.md](../state.md).
  - **Reads come from the device.** `messages` is an Electric collection kept in SQLite on OPFS (`SharedSqlite`, the app's database beside the engine's in the leading tab's engine worker, one per origin, shared by the browser's tabs through TanStack DB's tab coordinator). It syncs the whole conversation eagerly; a reload restores it before the network answers, and Electric resumes from the stored handle and offset. Load earlier moves a window over what the device has.
  - **Writes go through the outbox** (`@tanstack/offline-transactions`, IndexedDB). Asking puts the question into the outbox as an optimistic `asking` row; the outbox stores it before sending, sends one at a time in the order asked, retries with its backoff (1 s doubling to 60 s), and restores waiting questions after a reload or restart. One send is `POST /api/questions` under one 15 s deadline, then the start of the answer's run, recorded by this device's engine, then a wait of up to 15 s until Electric delivers the question (the 202's transaction id, or for a resend answered 200, the question's id). A run the engine doesn't record (this tab's engine failed, or the tab is closing) is sent again. Every resend carries the same ids, so Postgres keeps one question.
  - **A refused question stays** (400, 409, 413): kept in the persisted `unsent` collection, `Not sent`, until the person edits or discards it. A question the outbox can't take (its storage failed, or another tab still leads the outbox for the moment this tab takes the lead) is `unsent` as well, with Retry; the tab sends it again once it leads.
  - **The tab a person uses leads the outbox**, elected through `@smthrs/platform-browser`'s `WebLock` service: the window getting focus, anything in it getting focus (the composer), or asking takes the lock at once with `steal`, so a question asked in any tab is sent from it. The tab that led waits in line again; when the leading tab closes, the next tab leads and sends what the first stored.
  - **The device store is one SQLite database per origin** (`SharedSqlite` from `@smthrs/platform-browser`), served by the leading tab's engine worker. When that tab closes, the next leader serves the same file; a transaction the old leader never finished runs again on the new one, so a handover loses no write the store took ([platform-browser](../../../../packages/smithers/flows/platform-browser/docs/concepts/durable-browser-engine.md)).
  - **The connection pill** follows the browser's `offline` and `online` events, the shape's requests and the outbox's sends (see [state.md](../state.md#chat-2026-10-20)). Shape requests that fail on the network or with 5xx or 429 retry under the sync policy (an Effect `Schedule`: 1 s, doubling to 10 s, jittered) forever; Retry and the browser's `online` event send every waiting request and write at once.
  - **The PWA:** `vite-plugin-pwa` makes the web app manifest (installable) and a service worker that precaches the shell (scripts, styles, fonts, icons, the engine worker) and keeps every other same-origin file it fetched, network first, so a reload works offline after one online visit. Its virtual registration module reloads open tabs when an updated worker activates; the worker skips waiting and claims those tabs. The reload logs `pwa.update` with an outcome only, and a registration refusal logs `pwa.register` without the error value. It never caches or answers `/api/*`, and it never runs the flow engine (decision [0011](../decisions/0011-the-agent-runs-in-the-browser.md)). At boot the app asks for persistent storage (`StoragePersistence`) and counts the answer.
  - A page restored from the back/forward cache reloads, because its device store's connections closed when it was hidden.
  - Every TanStack DB and Electric API is used through Effect: `@smthrs/effect-tanstack-db` (persistence, the outbox) and `@smthrs/effect-electric`.

## Message controls

```
message meta:  (3m ago [Copy])                    a finished question or answer; "Copied" once the clipboard has it
               (3m ago [Copy] [⋰])                 an answer: [⋰] is its debug info, a link to the run that answered it
               Queued (3m ago [Edit])              a question waiting in the outbox while the pill shows
               Not sent [Edit] [Discard] (3m ago)  unchanged (decision 0002 §2)
               ( ) shown only on hover, focus inside the message, or a tap
Copy  ─▶ chat/copy { messageId? } ─▶ step (engine worker) ─▶ the tab that asked: its conversation ─▶ Clipboard
Edit  ─▶ chat/edit { questionId? } ─▶ step ─▶ the tab that asked: Outbox.withdraw under the outbox's lock ─▶ composer
type  ─▶ setDraft ─▶ composer row (memory) + drafts row (SQLite on OPFS), per conversation
```

- **Shown on hover.** A message's time, Copy and a queued question's Edit are `ChatMessage`'s `actions` (`@smthrs/ui`): hidden until the pointer is over that message or focus is inside it, and on a touch screen until it is tapped. Their space is kept, so nothing moves when they show; the fade is 120 ms, none under reduced motion. `Queued`, `Not sent` and the Retry, Edit and Discard that recover a message are its `meta`, always shown (Will, 2026-10-20: "copy should not be visible nor should the timestamp unless you are already hovering over the message").
- **Times.** Every message shows when it was written, as `@smthrs/ui`'s `RelativeTime` (`just now`, `3m ago`, a date after a day), with the full date and time as its title. A synced message uses its `created_at` in Postgres; a question this device hasn't sent yet, when it was asked here (`timeOf`, `src/features/chat/view.ts`).
- **Copy.** A finished question or answer has Copy (`@smthrs/ui`'s `CopyButton`), which says `Copied` once the clipboard has the text. It runs `chat/copy { messageId }` through `FlowDispatch`, door `button`. `/copy` runs it with no message, which copies Smithers' latest finished answer, and so does the agent when asked to copy its last answer: `chat/copy` is model-invocable. The step runs in the leader tab's engine worker and asks the tab that started the run ([the tab that asked](flows.md#the-tab-that-asked)), which finds the text in the conversation it shows and writes it through the host's `Clipboard` (`src/clipboard.ts`, shared with `repo/copy`). The text never passes through the engine or its journal. An answer still streaming, a failed answer and a view aren't copied: `MessageNotFound`. A clipboard that refuses answers `{ copied: false }`.
- **Debug info.** Every answer has a small icon labelled `Debug info`, among its hover controls, that opens `/app/runs/<answer id>`: the run that answered it, since an answer's id is its run's (`debugRunOf`, `src/features/chat/view.ts`). The run's page shows its flow view, the agent's turn and every flow it called as a step, each with its input and output ([runs](runs.md#the-run-page)). An answer another device gave reads "On another device", since runs are read from this device's engine. Will, 2026-10-20 19:52: "we should be able to see it used jev via clicking on debug info and seeing the flow view".
- **Edit on a queued question.** While the pill shows, a queued question has Edit beside `Queued`. It runs `chat/edit { questionId }`, door `button`; `/edit` runs it with no question, which takes the latest waiting one, queued or unsent. The tab takes the question out of the outbox with `Outbox.withdraw` (`@smthrs/effect-tanstack-db`), which holds the outbox's own lock against a send: the question is taken back before it is sent, or it is sent and stays, never both. Taken back, it is deleted from the outbox's storage, its row goes, and its text opens in the composer; the outbox never sends it, and the questions behind it are sent in order. A question being sent, or already sent, stays where it is (`QuestionNotEditable { reason: "sent" }`), and so does the composer's draft. An unsent question's Edit is unchanged. Only the person edits: the agent never runs `chat/edit`.
- **The saved draft.** Home and unshared branches keep private drafts per conversation in the device's `chat-drafts` collection. Only a branch its owner shared uses the collaborative prompt ([co-editing](coedit.md#the-prompt)). Both survive reloads offline. The composer's textarea says `data-draft="saved"` once the device has stored what it shows, and `unsaved` until then. Private writes record `chat draft saving`, then `chat draft stored` or `chat draft failed`, correlated by transaction id, with a `chat.draft.save` span and `smithers_web_draft_writes{stage}` counter; no draft or error message enters those records.

## Contract

### `messages` (Postgres)

| Column | Type | |
|---|---|---|
| `id` | `uuid` primary key | chosen by the browser, so asking is idempotent |
| `role` | `text` | `user` or `assistant` |
| `text` | `text`, default `''` | |
| `status` | `text` | `done`, `streaming` or `failed` |
| `question_id` | `uuid` | an answer's question; null for a question |
| `failure` | `text` | when failed: `quota`, `rate_limited`, `model_error`, `empty`, `unfinished` or `abandoned` (see below) |
| `model_id`, `stop_reason` | `text` | set when an answer settles; `stop_reason` when the model gave one |
| `input_tokens`, `output_tokens` | `integer` | set when an answer settles, when the model reported them |
| `parts` | `jsonb`, default `[]` | an answer's steps, as the agent shows them ([agent.md](agent.md#streaming)); `[]` for a question |
| `asked_by` | `text` | a question's asker: the person id of the session that asked, never the body's. Null for an answer, and for a question asked before `0011_question_askers`. Never synced |
| `position` | `bigint` identity, stepping by 2 | the conversation's order: a question draws one, and its answer takes the next |
| `created_at`, `updated_at` | `timestamptz` | display and diagnostics only |

Failures:

| `failure` | When |
|---|---|
| `quota` | the model refused for credit or quota, including HTTP 402, or the deployment's daily model budget was spent; shows “Couldn't answer. Model credit or quota is used up.” with Retry |
| `rate_limited` | the model answered a plain 429 and durable backoff ended |
| `model_error` | any other model failure |
| `empty` | the model finished with no text |
| `unfinished` | the agent ran out of frames, or the queue before the answer didn't move for the turn wait (10 minutes) while it waited its turn |
| `abandoned` | still `streaming` once nothing in its queue (it, and the earlier answers in its conversation) had moved for 25 minutes, so `chat/Expire` settled it: its device never came back, or its run ended without settling ([agent.md](agent.md#settling)); or left `streaming` by ChatApi's former server-side answering when migration `0008_browser_answering` ran |

A question ChatApi didn't take has no row and no `failure`: the asking tab shows it failed from its own memory (above).

Rules:
- An answer only changes while `streaming`, through the answer routes, and only for the person who asked its question; settling is one update to `done` or `failed` ([agent.md](agent.md#the-answer-routes)).
- A question and its answer are inserted in one statement (`Messages.ask`). The question draws its `position` from the identity, which steps by 2, and the answer takes the next one, so no other row lands between them. Asking locks the conversation before allocating positions and holds that lock through commit; later asks and answer turns cannot overtake an uncommitted pair.
- Ids are stored lowercase, as Postgres prints a `uuid`.
- `db/migrations/0001_messages.ts` creates the table, with these values as `CHECK` constraints; `0003_paired_positions.ts` makes `position` step by 2; `0006_answer_parts.ts` adds `parts` and `unfinished`; `0008_browser_answering.ts` drops `attempts` (added by `0002`), settles answers the server left `streaming`, and indexes streaming answers by `position` for the turn wait; `0011_question_askers.ts` adds `asked_by`, checked null on an answer, and settles `abandoned` the answers still `streaming`, since no one may write them.

### `POST /api/questions`

- **Who may ask:** a signed-in Member or above (decision [0007](../decisions/0007-roles-and-tags.md): asking Smithers is `repo:ask`). ChatApi reads who is asking (`Sessions`, [sign-in.md](sign-in.md)) before it reads the body, and writes nothing for anyone else.
- **Body:** `{ "id": uuid, "answerId": uuid, "text": string }`, two different UUIDs, where `text` is 1 to 8,000 characters after trimming. The question is stored trimmed.
- **`traceparent`** (optional): a W3C `traceparent` of version `00`, exactly 55 characters of lowercase hex, neither id all zeros. ChatApi's spans for the request join its trace; its sampled flag is ignored, so a caller can't turn off ChatApi's records. Any other value, and `b3` headers, parent nothing.
- **Responses:**

  | Status | Body | When |
  |---|---|---|
  | `202` | `{ "txid": number }` | both rows inserted: the question, and its answer, empty and `streaming`, for the asking browser's agent to answer |
  | `200` | `{ "txid": null, "existing": true }` | a retry: this question is already stored, with the same text, `answerId` and asker; nothing is written |
  | `400` | `{ "message" }` | invalid body, malformed UTF-8 or a body that breaks off included |
  | `401` | `{ "message": "Sign in to ask Smithers." }` | nobody is signed in; nothing is written |
  | `403` | `{ "message": "Asking Smithers needs the Member role." }` | a Guest, or a person with no role on the repository; nothing is written |
  | `405` | | another method |
  | `409` | `{ "message": "id belongs to another message." }` | `id` is taken by another message: a different question, the same text with another `answerId` or from another person, or an answer; nothing is written |
  | `409` | `{ "message": "answerId belongs to another message." }` | `answerId` is taken; nothing is written |
  | `413` | | body over 64 KB, declared or streamed |
  | `500` | | a defect in ChatApi; logged by the defect's name, never its message |
  | `503` | `{ "message" }` | Postgres can't be reached (for sessions or the insert), or refuses the insert for another reason; nothing is written |
  | `503` | `{ "message": "Smithers couldn't take the question. Try again." }` | the question is stored, but the remote host didn't record its expiry's start; the outbox sends it again, and the resend (`200`) starts it |

  The client validates both success bodies before starting an answer: a `200` must carry
  `{ "txid": null, "existing": true }`. Malformed or incomplete bodies are `invalid_response`;
  the request deadline includes reading either body, so a stalled `200` is `unreachable`.

  `txid` is the inserting transaction's id (`pg_current_xact_id()`), the one Electric reports for both rows. A retry has no transaction to wait for: the client reconciles from the rows Electric already has, or delivers next. Ids compare case-insensitively, and the text after trimming.
- **The browser** keeps a question refused with 400, 401, 403, 409 or 413 on the device as `Not sent`, and sends anything else again.

### Answering

The asking browser's agent answers: `chat/Answer` on that browser's durable engine, started once ChatApi takes the question ([agent.md](agent.md)). It reads its turn and history from `GET /api/answers/<id>` (what the model sees: the most recent finished exchanges before the answer, at most 19 or 24,000 characters), calls the model through `POST /api/model/agent`, and writes the answer's text and steps through `POST /api/answers/<id>`: at most once a second while it streams, then once to settle it `done` or `failed`. Answers come in order: an answer waits while an earlier one is still streaming and live ([agent.md](agent.md#turn-by-turn)).

Each streaming write is one row update, and Electric logs an update with the whole `text`, so the shape log grows by the answer's length at every write: about `L × n / 2` characters for an answer of `L` characters written in `n` writes ([infrastructure.md](../infrastructure.md#limits)). Electric needs `REPLICA IDENTITY FULL`, which adds nothing to the shape log.

### `GET /api/shapes/messages`

- **Request:** the Electric client's shape protocol, served by `ShapeProxy` from `@smthrs/effect-electric` with `table=messages` and its `columns` fixed on the server ([its docs](../../../../packages/effect-electric/docs/shape-proxy.md)): every column but `asked_by`, which stays on the server. A column a migration adds syncs only once `SYNCED_MESSAGE_COLUMNS` (`worker/Chat.ts`) lists it.
  - Forwarded as sent: `offset`, `handle`, `live`, `live_sse`, `experimental_live_sse`, `cursor`, `expired_handle`, `log` and `cache-buster`, the first value of each.
  - Everything else from the browser is dropped, so it can't change the shape: `table`, `where`, `params`, `columns`, `replica`, `secret`, `source_id`, and the `subset__*` parameters of on-demand subset requests (the device syncs the whole conversation eagerly, decision [0002](../decisions/0002-local-first.md)). ChatApi adds `secret` when `ELECTRIC_SECRET` is set, and Electric Cloud's `source_id` when `ELECTRIC_SOURCE_ID` is. The URL ChatApi sends Electric is canonical, its parameters sorted by name, so the same shape at the same point of its log is one URL from every device.
- **Response:** Electric's, streamed through: status, body and headers. `content-encoding` and `content-length` are dropped, as Electric's proxy guide says, because `fetch` has already decoded the body. `access-control-*` are dropped too, since the app calls ChatApi from its own origin. Every answer, a `405` or `502` included, says `Cache-Control: private, no-store` in place of Electric's `public, max-age=604800` and `etag`: the rows depend on the session and the URL doesn't name the person, so a kept response would reach the next person in that browser, or anyone after sign-out. Every other shape route answers the same way, and the device's shape requests skip the HTTP cache (`cache: "no-store"`).
- **Errors:** `405` for another method; `503` with `Retry-After: 5` when sessions or the home conversation can't be read (`worker/ShapeAccess.ts`): serving another conversation's `where` under the device's handle would make Electric answer `409 must-refetch` and empty the device's copy, so the device keeps its rows and retries instead; `502` when Electric can't be reached; `429` from the [throttle](#throttling). Every shape route that filters on the session answers the same way.

### `POST /api/telemetry/v1/{logs,traces,metrics}`

The OTLP/HTTP JSON exports of the browser's tabs (`smithers-mvp-web`) and engine workers (`smithers-mvp-engine`). `OtlpRelay.serve` (`@smthrs/observability`) re-emits each record as one ChatApi log line; see [observability.md](../observability.md#relayed-browser-records).

- **Limits:** an export over 128 KiB is `413` and relays nothing. One export relays at most 200 records; the rest are dropped, and the answer is `200` with an OTLP `partialSuccess` that counts them.
- **Allowlist:** `BROWSER_TELEMETRY` (`src/telemetry.ts`), which every browser feature's contract contributes its record names and fields to, so the relay and the browser can't drift ([observability.md](../observability.md#browser)). Any other record is dropped and counted the same way, and any other field removed.
- **Responses:** `200` (`{}` or `partialSuccess`), `400` for a body that isn't OTLP JSON, `404` for another path, `405` for another method, `413`, and `429` from the [throttle](#throttling).

### Throttling

Every Electric shape (`/api/shapes/*`) and the telemetry relay answer anyone, signed in or not, so ChatApi throttles them per network before anything else runs (`worker/Throttle.ts`, decision [0008](../decisions/0008-auth.md) §7.3's edge pre-filter). A network is the IPv4 /24 or IPv6 /48 of `CF-Connecting-IP`; a request without one shares the network `unknown`. Each route has its own Cloudflare Rate Limiting binding, declared in `worker/ChatApi.ts`:

| Routes | Binding | Per network |
|---|---|---|
| `/api/shapes/messages`, `/api/shapes/views`, `/api/shapes/repositories` | `SHAPE_LIMIT` (namespace 71001) | 3,000 requests a minute |
| `/api/telemetry/v1/*` | `TELEMETRY_LIMIT` (namespace 71002) | 3,000 requests a minute |

Past it, ChatApi answers `429 { "code": "rate_limited" }` with `Retry-After: 60` and `Cache-Control: no-store`; the device's shape requests retry under the sync policy. The binding counts per Cloudflare location and approximately, so it bounds bursts and does no accounting. A binding that fails lets the request through: a broken pre-filter must not stop every device syncing. Neither number comes from a load test. While an answer streams, a tab's `messages` shape returns about once a second and its two other shapes about 3 times a minute, and its tab and engine worker export logs every second, traces every 5 s and metrics too: about 70 shape requests and 150 exports a minute. Each limit lets about 20 such tabs share a network, and stops one address from sending more than 50 requests a second. Each decision is counted (`smithers_throttle_decisions`); a binding's failure is also a `chat.throttle` line. Neither records the address or the network.

Not built: binding a request to a session or a visitor cookie and limiting by it, and per-request shape authorization (decision 0008, phase P1).

## Configuration

| Variable | Default | |
|---|---|---|
| `CHAT_MODEL` | Cerebras `qwen-3.8-27b` (`DEFAULT_CHAT_MODEL`, `worker/ModelRoles.ts`) | a Smithers configured-model record, as JSON: the model endpoint's default model for every role, used only while hosted inference is on, a work in progress off for a deploy ([model-endpoint.md](model-endpoint.md#hosted-inference)) |
| the record's credential | none | for example `CEREBRAS_API_KEY` |
| `DATABASE_URL` | the compose Postgres, `postgresql://smithers:smithers@localhost:54321/smithers` | `pnpm db:migrate` and the tests connect to it; ChatApi reaches it through Hyperdrive, which `alchemy dev` passes straight through |
| `ELECTRIC_URL` | `http://localhost:30001` | |
| `ELECTRIC_SECRET` | none | sent as `secret`; unset in production, where Electric's gateway has no public URL ([infrastructure.md](../infrastructure.md#electric)) |
| `ELECTRIC_SOURCE_ID` | none | Electric Cloud's source id; sent as `source_id` |

ChatApi reads these with Effect `Config` while Alchemy plans it, and Alchemy binds each one that is set to the Worker as a secret. See [infrastructure.md](../infrastructure.md) for production.

## Run it

- `pnpm db:up` starts Postgres and Electric (`docker-compose.yml`); `pnpm db:down` stops them.
- `pnpm db:migrate` applies `db/migrations`.
- `pnpm dev` runs `alchemy dev`, serving the app and both Workers at https://localhost:1443 over HTTP/2, as production does, and at http://localhost:1337 over HTTP/1.1 ([infrastructure.md](../infrastructure.md#https-and-http2)). Open https://localhost:1443/app; without the GitHub App's credentials a local developer is signed in ([sign-in.md](sign-in.md#local-development)).

## Tests

Stopping the app removes its keyboard listeners, covered by `src/boot.test.ts`
and `src/features/chat/chat.test.ts`. Shortcut cleanup uses `{ capture: true }`
to remove the capture listener on both browsers and the Node test host.

- **Unit (`pnpm test`):**
  - The libraries' own suites (`packages/effect-tanstack-db`, `packages/effect-electric`): the TanStack DB and Electric wrappers against real collections and real Electric shapes, persistence on a SQLite file (restore, resume, a new `schemaVersion`), the outbox (resends, refusals, admission, a write restored by the next program, the lock leader's handover), the sync policy and the shape proxy.
  - The browser's state machine (`src/features/chat/chat.test.ts`, `telemetry.test.ts`, `src/boot.test.ts`), driven through the chat layer's actions and queries with no React, built by the same `appLayer` the browser uses, on a Node device (`nodeDevice`: SQLite through TanStack DB's own browser persistence, the outbox in memory, `WebLock` over Node's Web Locks, and its engine leading, as a browser's engine worker does), against ChatApi's real handler (`src/test/chatApi.ts`), with a scripted model behind ChatApi's model endpoint, which the tab's own agent calls. Each test gets its own schema in the database Electric replicates, made by `db/migrations` and dropped after, so it never touches the dev conversation: ChatApi reaches it through the connection's `search_path`, and its Electric requests name it in `table`. Unhappy paths get faulty services by injection, never an intercepted request: ChatApi's client fails the next question as unreachable, a gateway's 503, ChatApi's 400, a 413, cut short after a 202, delivered twice, beaten by a conflicting writer or answered too late; Electric's shape source goes down, refuses (all requests or live ones), stalls or cuts its responses short (`src/test/faults.ts`); the host's outbox storage refuses a write, or another tab holds the outbox's lock even against a steal; this tab's engine never leads, fails, or holds its starts (`EngineFaults`). Tabs: the tab that gets focus or asks leads at once, and a tab closed before its engine recorded an answer's run leaves the question to the next page; a tab alone whose browser grants the outbox's lock late still shows its first question Queued; and a busy tab's late snapshot never erases a question the device's writing tab stored (`busyTab`). Happy paths use the real services. They need `pnpm db:up`.
  - The real ChatApi client from the browser's side (`src/features/chat/api.test.ts`) against a local HTTP server: a body that stalls after 202, or no answer at all, fails at the deadline and the server sees the request aborted; a 202 cut short is `invalid_response`; nothing listening is `unreachable`.
  - ChatApi (`worker/*.test.ts`) through its real handler (`worker/test/harness.ts`) against the compose Postgres and Electric, with a scripted model through `HostModel`: the routes and who may ask (`Chat.test.ts`), asking and the history (`Messages.test.ts`), the answer routes (`Answers.test.ts`), the shape proxy (`ShapeProxy.test.ts`) and the site Worker (`index.test.ts`). Every wait is for a condition, never a fixed time. `Messages.test.ts` holds one ask mid-statement, with a trigger on another connection's lock, while a second transaction asks, and checks that each answer stays right after its question.
  - The browser's agent (`src/features/agent/*.test.ts`, [agent.md](agent.md#tests)).
  - Message controls (`src/features/chat/controls.test.ts`) on the app's own layer over a device whose engine leads: Copy on an answer and on a question through `chat/copy`, `/copy` copying the latest answer, a message not shown (`MessageNotFound`), a clipboard that refuses, nothing copied while streaming or failed; Edit on a question queued after a failed send (never sent, the edit is), `/edit` and the button on the latest waiting question, a question being sent stays (`sent`), nothing waiting; the draft across a reload, per conversation, gone once sent or cleared, and never over what the person typed first; Postgres' timestamps and a local question's time. `src/features/chat/steps.test.ts`: both steps over the engine's channels, every outcome, the agent's door, and a tab that is gone.
  - The database layer, `pnpm db:migrate` and the test guard (`db/*.test.ts`).
  - Each test file has one runtime and a schema of its own on the compose Postgres ([infrastructure.md](../infrastructure.md#tests)), so no test touches the dev conversation. With Postgres or Electric down, the file fails and says to run `pnpm db:up`.
- **End to end (`pnpm e2e`):**
  - Real browsers, Worker, Postgres, Electric and model; no mocks and no intercepted requests. Every test records video.
  - An unhappy path opens `/app?faults` under the dev server, so the page runs on the faulty services (`src/test/e2e.ts`), and throws their switches with `page.evaluate(() => window.faults.shapes.down())` once `"faults" in window`. `?faults=down`, `refuse`, `refuse-<status>`, `stall` or `corrupt` opens the page with sync already failing. A production build has no such page.
  - Every page runs the no-spinner observer (`e2e/fixtures.ts`): an init script records any `aria-busy="true"` or progress bar a frame paints outside a streaming answer, the router's own bar aside, and the test fails if it saw one. A loading state still in its first 300 ms paints nothing, so it never counts.
  - A device test (`e2e/devices.ts`) is void, and fails saying so, when the dev server reloaded one of its pages mid-test: Vite's `full-reload` on its HMR socket, sent when someone edits a module it serves. The page restarts and loses its memory and its fault switches. The tab's log names the file. Run e2e against a dev server whose checkout nobody edits meanwhile: on 2026-10-21 the shared one reloaded test pages about once a minute.
  - `e2e/message-controls.spec.ts`: an answer and its question show their times, hidden until hovered, Copy puts the answer on the clipboard and says `Copied`, Edit takes a question queued offline back to the composer and only the fixed question reaches Postgres, and a draft survives a reload. GIFs: `message-controls-message-copy.gif` and `message-controls-message-edit.gif` from `pnpm e2e:gifs`.
  - Debug info: `src/features/jev/jev.test.ts` opens an answer's run from its debug info (`debugRunOf`) and reads its flow view, and `e2e/jev.spec.ts` shows the icon only on hover, opens the answer's run from it, and inspects the Jev step there ([Jev](jev.md#seeing-that-smithers-used-jev)).
  - Coverage includes ⌘K, asking, the browser's agent answering through the model endpoint (`e2e/agent.spec.ts`), the theme by button and by the agent, a killed tab whose answer resumes without paying again for a sealed model call, signing out (`e2e/sign-in.spec.ts`), two devices, a reload mid-answer (the answer still completes), a tab closed mid-answer (the answer waits for its device), late joiners, concurrent asks, sync down at boot (the shell at once, then the pill with Retry), and 0002 §7: questions asked offline survive a reload offline and a restart and are answered in order; a flapping network; two tabs (the tab a person asks in leads and sends at once; the outbox's handover when the leading tab closes); a tab closed after ChatApi took its question, before its engine recorded the run (answered when the app opens again); offline mid-answer; Electric down at boot after one visit (the conversation from the device); Retry sending at once; back and forward.
  - `e2e/local-first-conflicts.spec.ts`: the conflicts the device store and the outbox resolve, one test each, on two devices or two tabs of one device, on the real model; the two clock tests set a device's clock with Playwright's clock (ruling TEST-12). Two writers claim one question id (409: the device keeps its own `Not sent`, and Edit asks it again under a new id); two people drop the same TODO offline (the second drop changes nothing); two devices come back in either order (Postgres' arrival decides); a reply lost after ChatApi took the question (the resend gets 200 `existing`, stored once); a tab that lost the outbox's lead leads again (`sent_elsewhere`: not sent twice); Edit in one tab takes back a question another tab's outbox holds (never sent); a new build that can't resume a parked answer (`payload_changed`: `Couldn't answer` on both devices, and Retry answers); a device clock a day behind (its question still lands by arrival). Three are marked broken (`test.fail`, TEST-5, just before the assertion the bug fails): Edit after ChatApi took the question but before the device saw it arrive takes it back anyway, so it is both in the composer and answered; a question Edit took back in one tab stays `Queued` in the tab that led the outbox; and after a device clock steps back, the next question shows twice and the outbox orders writes by that clock (`@tanstack/offline-transactions` orders and schedules by `createdAt` and `nextAttemptAt`). Access lost while offline (403) is still to come ([local-first conflicts](../work/local-first-conflicts.md)).
  - A device's first page waits for the service worker and loads again online, the one earlier visit an offline reload needs: under the dev server the service worker keeps only what a page it controls fetched.
- **Benchmarks (`pnpm bench`):** see [benchmarks.md](../benchmarks.md).
- **Observability:** see [observability.md](../observability.md).

IPv4-mapped IPv6 addresses use the IPv4 /24 throttle key in dotted, hexadecimal and fully expanded forms.

## Pin a message

Pin on a person's or the agent's message keeps a copy above the conversation while the conversation scrolls. Pin another to replace it; Unpin on either copy removes it. A tall copy scrolls within a capped height and collapses with its toggle, including at 390, 768 and 1280 pixels. The composer stays usable.

A pin belongs to one person in one conversation and follows that person across devices. Other people on the branch keep their own pins. Migration 0054 stores `message_pins`; Electric's session-filtered `/api/shapes/message-pins` keeps device schema version 1. The device holds unsynced intents in the versioned `message-pin-pending` collection and runs `chat/pin` or `chat/unpin` durably. Newer timestamped acts supersede older retries; unpin keeps a tombstone. Collapse lives in a tab-local TanStack DB collection.

Both controls and the agent use the same model-invocable flows. “Pin that” without an id targets the previous completed agent answer in its conversation. The write route `/api/message-pin` derives the person from the session, checks conversation access and message membership, and refuses unrelated run targets. Its `chat.pin` span, log and `smithers_message_pins` counter record status and outcome without content. See [decision 0090](../decisions/0090-pin-message.md). Tests: `src/features/pins`, `worker/Pins.test.ts`, and `e2e/pin-message.spec.ts`; eval cases `chat-pin-that` and `chat-unpin`.

Agent calls first journal a timestamp from `/api/message-pin/stamp`, newer than the current personal pin even after a device's fast clock. Device intents retain their original timestamp through retries. A refused launch restores the synced pin and keeps Retry available; reloading resumes unfinished intents without silently retrying a final refusal.

Queued and unsent questions pin immediately. The versioned intent keeps a local copy, including if its original is taken back or discarded, until Unpin. Retry preserves that copy and its expected answer id. A conflicting synced message with the same id cannot replace its text: the same durable flow waits for the matching question and answer before syncing the pin to other devices; a newer pin or unpin ends an obsolete wait. This also works for the first question, before any message has synced. No message text enters the flow payload or telemetry.

The composer keeps keystrokes arriving immediately after its shortcut, before the input mounts. Typed text shows its character count and the 8,000-character limit. Oversize input stays intact with a refusal; it is neither truncated nor sent.

The composer (or its model-settings action) precedes message history in keyboard
order while remaining docked below it visually. Message actions remain reachable
after it. `e2e/accessibility-composer.spec.ts` checks this with existing history.

Question actions resolve after durable outbox admission. The queued question survives a reload at that boundary; server acceptance and the answer run continue in the background.

An admission still in progress cannot clear newer typing or a later conversation’s draft. A second storage refusal on Retry retains the same unsent question.

Repeated Send of one pending draft shares its receipt. New typing starts a separate question; cancellation releases the pending reservation and wakes its waiters.
