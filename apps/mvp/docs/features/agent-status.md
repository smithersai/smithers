# Agent status

What the agent is doing, and whether it needs you. The agent's run reports one of five states from its own durable steps, and the conversation, the header, a toast and the tab's title show it on every device the person has open. When the agent can't go on without the person, it asks with `app/agent/ask`; the person answers from the card, and the run in the asking browser goes on. Will, 2026-10-20: "I think the old one and our smithers agent has ability to give status updates like whether the thing needs help or not". Decision: [0015](../decisions/0015-agent-status.md), on [0009](../decisions/0009-notifications-and-live-work.md) and [0011](../decisions/0011-the-agent-runs-in-the-browser.md). Deep run inspection is decision 0014's run pages.

```
chat/Answer (this device's engine)
  chat/LoadTurn ─ NotYourTurn: report waiting(turn), once ─ its turn: report working
  chat/Respond ─ cell: ctx.call("app/agent/ask", { kind, prompt, options })
                   app/agent/ask/request ─ report needs_you { execution, kind, prompt, options }   POST /api/runs/<id>
                   HumanTask (system/human-task) ─ parks, at most 10 minutes
                   app/agent/ask/answer ─ report working ─▶ { answered, answer } or { answered, approved, note? }
                                                        refused or timed out: { answered: false }
  chat/Settle ─ report done or failed
                                         │
Postgres runs ─▶ Electric (/api/shapes/runs, the person's own rows) ─▶ every device's `runs`
                                         │
card, toast or header Answer ─▶ run/answer { runId, version, execution, value }
  run/answer/record ─ POST /api/runs/<id>/answer: the first answer settles the question
  run/deliver/answer ─ HumanTask.answer on this device's engine, if it holds the run
another device's answer ─▶ Electric ─▶ the device that holds the run: run/deliver (door sync), one per question
```

## States

| State | When | Shows |
|---|---|---|
| Working | the run's turn came; a question was answered | the answer streaming; the header's `◌ Working` while it is the latest |
| Waiting | an earlier answer holds its turn | `○ Waiting` under the answer and in the header |
| Needs you | `app/agent/ask` is open and unanswered | the card, `◆ Needs you` on the top bar's bell (a count above 1; [notifications.md](notifications.md#the-top-bar)), a toast with Answer, `(N) Smithers` |
| Failed | the answer settled failed | `Couldn't answer` and Retry, as before; `✕ Failed` in the header while it is the latest |
| Done | the answer settled done | the answer; nothing else |

The answer's own settled status always wins over the run's row (`src/features/status/queries.ts`), so a report that never landed can't leave an answer looking live.

## The runs table

Migration `0013_runs`: decision 0009's `runs`, with the columns this slice needs, under 0009's names.

| Column | |
|---|---|
| `id` | the run's execution id: the answer's id for `chat/Answer` |
| `flow` | `chat/Answer`: the route sets it, since every run that reports in this slice is an agent's answer |
| `status`, `waiting` | the state, and why it waits: `turn`, or `input` and `approval` while it needs the person |
| `wait` | the run's latest question: `{ execution, kind, prompt, options }`, kept after it closes so the card shows what was answered |
| `version` | how many questions the run asked; an answer names the one it answers |
| `answer`, `answered_at` | the accepted answer, `{ value }`: words, `true` or `false`, or `{ approved, note }` |
| `launched_by` | the asker's person id: never synced; the shape filters on it |

CHECKs hold the shape: `waiting` is set exactly while `waiting` or `needs_you`; `needs_you` has a `wait`; `answer` and `answered_at` go together.

## Answers

A question takes words or one of its options. An approval takes `true` (Approve) or `false` (Deny), or `{ approved, note }`, the needs-you queue's Approve and Changes with the person's note (`Decision`, at most 8,000 characters). The route keeps words and notes trimmed; an empty note is a decision without one, and the agent hears `{ answered: true, approved }`.

## core/waits

`waitsQuery(home, runs)` (`src/features/status/queries.ts`, decision 0017): the open waits addressed to the person, from the synced `runs`, in every conversation. A row is open while `needs_you`, unanswered and holding a `wait`, unless its answer in the home conversation already settled. Today a wait is addressed to the run's launcher, the only person its row syncs to and the only one `run/answer` lets answer. `StatusStore.waits` is the live query; the plugin host reads its `rows`, and the tab's title counts it.

| Field | |
|---|---|
| `runId`, `version`, `execution` | what `run/answer` takes: the run, the question and the `app/agent/ask` execution |
| `kind`, `question`, `approval` | `question` or `approval`, and a flag for each, for a keybinding's `when` |
| `prompt`, `options` | the question; `options` is empty for an approval |
| `createdAt` | when the run started: the oldest wait comes first |

`WAITS_ROW` (`src/features/status/contract.ts`) is the row as JSON Schema; the plugin loader checks a manifest's `$item.<field>` against it. Result rows also carry TanStack DB's virtual `$` fields. Because it reads `runs`, a wait shows for any run that asks, not only a chat answer; a branch run whose settled report never landed still shows until it does.

## The routes

`worker/Runs.ts`, in ChatApi. Only the person who asked the answer's question may report or answer, while they may still ask (Member or above). The agent's run reports with its run credential, for its own run only; only the person answers ([run credentials](sign-in.md#run-credentials)).

| Route | Answers |
|---|---|
| `POST /api/runs/<id>` `{ status, waiting?, wait? }` | `200 { txid }`; `200 { txid: null }` for a repeat on a writable run from the same launcher: the same status or question, including that question after it was answered. `409 { code: "not_writable", reason }` when it cannot write: `settled` or `other_launcher`. A question with a new `execution` bumps `version` and clears the answer |
| `POST /api/runs/<id>/answer` `{ version, value }` | `200 { txid }` for the first answer to the open question; `200 { txid: null }` for the same answer again; `409 { code: "not_open" }` once it is answered, closed or replaced; `400` for words to an approval or a decision to a question; `403 { code: "person_only" }` for anyone acting for the person |
| `POST /api/runs/<run>/credential` `{ flow, ceiling? }` | a run's credential ([run credentials](sign-in.md#run-credentials)) |
| `GET /api/shapes/runs` | Electric's `runs` where `launched_by` is the signed-in person, without that column. Signed out, no one's rows; when sessions can't be read, `503` with `Retry-After: 5`, so the device keeps its rows and retries |
| all | `401` signed out; `403 { code: "forbidden" }` for a Guest, no role, or anyone but the asker (logged `not_launcher`); `403 { code: "other_run" }` for a run credential of another run; `404` for an id that isn't an answer or a run; `405` for another method; `413` over 16 KiB; `503 { code: "unavailable" }` when Postgres can't be reached |

## Flows

`src/features/status/flows.ts`. The question is a durable wait: closing the tab keeps it, and the next tab's engine parks on it again. The tab dispatches only their references; their steps run in the engine worker.

| Flow | Door | Steps |
|---|---|---|
| `app/agent/ask { kind, prompt, options? }` | the agent's cell | `app/agent/ask/request` reports the question (retried for a minute; a refusal is final), then `HumanTask` (`ask` for a question, `json` for an approval, one attempt, `ASK_WITHIN_MS`), then `app/agent/ask/answer` reports working. A refused question tells the agent "not answered" (`{ answered: false }`), as does one not answered in time; an approval's note, trimmed, rides as `note` when it isn't empty |
| `run/answer { runId, version, execution, value }` | the card (`button`) | `run/answer/record` (retried for 10 minutes; `AnswerNotOpen` and `AnswerRefused` are final), then `run/deliver/answer` |
| `run/deliver { execution, value }` | `sync` | `run/deliver/answer`: polls the run; a run this device never held is `not_here`, a finished one `closed`; otherwise `HumanTask.answer`, retried for two minutes while the run wakes and parks on its question again |

`run/answer` and `run/deliver` are acts on a run, as 0009's Cancel and Retry are (`run/*`), so the agent's catalog leaves them out.

## Reporting

`RunReporter` (`src/features/status/reporter.ts`) sends a run's status from inside the step that reports it, so a step run again after a crash reports again, which the route takes as no change. The run is the execution's requester (`src/flows/requests.ts`). `report` never fails the step; it skips a status this engine already sent for the run, so `chat/LoadTurn`'s retries report `waiting` once. `reportOrFail` is for the question, which the person can't answer unless they see it. Reports of one run go one at a time, in the order its steps make them; only the last report that landed can suppress a repeat. Questions and answers retry 408 and 429, as well as transport and server failures; other 4xx refusals are final.

## The browser

`src/features/status/` follows [state.md](../state.md):

| Piece | What it is |
|---|---|
| `runs` | the person's `runs`, an Electric collection kept on the device (`persist: { schemaVersion: 2 }`; version 2 holds an approval's note) |
| `status-local` | this tab's rows about each run's latest question: `draft`, `sending`, `focus`; a row for an older `version` counts as none |
| `statuses`, `latest` | each conversation's answers and latest state: its messages joined to `runs` and `status-local`, read through `Status.queries.of(conversationId)` |
| `waits` | `core/waits`: every open wait in the person's runs, oldest first, then by run id, including branches this tab has never opened; a settled home answer still wins ([below](#corewaits)) |
| `answer(id, value)`, `setDraft`, `focus` | the card's Answer (or the notifications panel's), its field, a toast's Answer |
| followers | delivery (`run/deliver` per answered question), the title (`TabTitle`, the host's `document.title`, counting `waits`), and `agent.status.shown` per wait |

A branch's status queries are built as chat opens the conversation (`ChatStore.forEachOpened`), before a tab shows it, and `Status.queries.of` only looks them up. The title counts `waits` across every conversation. A second Answer while one sends does nothing; an older answer settling late leaves the next question's draft.

The views are `@smthrs/ui`'s `AgentStatusPill` and `NeedsYouCard` (`components/`): `AnswerStatus` under each answer, and `HeaderStatus` first in the header row: the latest answer's Working, Waiting or Failed. Needs you shows on the top bar's bell instead, the one way in to what waits on the person, which opens the notifications panel at it (Will, 2026-10-20: "a notification type ui ux in the top bar of the app in general to bring us here"). The question's toast is the feed's ([notifications.md](notifications.md)): its row for the run's launcher reads `needs_you` with the question, its Answer runs `focus`, and Hide is synced to the person's other devices. It sits in the shell's one stack under the header (`src/screens/app/Toasts.tsx`, `ToastStack`'s `inline` placement): the open composer docks over the column's foot, so a toast there would hide behind it. A toast fades in after 300 ms, so a question answered at once never flashes.

## Observability

| Record | Kind | Fields |
|---|---|---|
| `agent.status.report`, `agent.status.answer` | log, ChatApi | `runId`, `report` or `version`, `status`, `durationMs`, `bytes`, `existing`, `errorCode` (`not_launcher`, `not_writable`, a SQL reason), `reason` (`settled`, `other_launcher`) |
| `agent.status.request` | span, ChatApi | `smithers.run.id`, `http.response.status_code` |
| `smithers_run_requests`, `smithers_run_shape_requests` | counter, ChatApi | `route` (`report`, `answer`), `status`; `status`, `live` |
| `agent.status.report`, `agent.status.answer` | span, engine | `smithers.run.id`, `http.response.status_code` |
| `agent.status.report` | log, engine | `runId`, `status`, `outcome` (`sent`, `failed` with `errorCode`) |
| `smithers_agent_status_reports` | counter, engine | `status`, `outcome` (`sent`, `skipped`, `failed`) |
| `agent.status.answer`, `agent.status.deliver` | log, engine | `outcome` |
| `smithers_agent_status_answers` | counter, engine | `outcome`: `recorded`, `not_open`, `refused`, `unrecorded`, `delivered`, `not_here`, `closed` |
| `agent.status.shown`, `smithers_agent_status_shown` | log and counter, tab | `runId`, `version`, `surface` (`title`: the tab's title counts it) |

No record carries a question, an option or an answer (tests read the logs for them).

## Limits

- **Ten minutes to answer.** A question closes after `ASK_WITHIN_MS`, inside `chat/Expire`'s 25 minutes; a longer one needs `chat/Expire` to read the run's row (0015 phase 2).
- **A run awaiting a person keeps its turn**, even after `ANSWER_TURN_LIVE_SECONDS`, until it resumes and settles ([0030](../decisions/0030-worker-admission-consistency.md)).
- **A tab closed while a question is open costs one model call.** The frame that asked was in flight, so the next tab's engine asks its model again; the call it makes joins the question already parked (`flows.test.ts`).
- **Only the asker answers**, and only their own runs sync. Other people see a run on their branch through the feed ([notifications.md](notifications.md)).
- **No browser notification yet**: 0015 phase 2. A failed answer toasts for 4 s through the feed.

## Tests

The killed-run case fences the old engine's database before stopping it. Calls
through that engine, including shutdown's final journal flush, fail with a
connection error instead of waiting forever. The next engine recovers only
committed records; the crashed incarnation cannot flush pending records into it.

| Test | Proves |
|---|---|
| `src/features/status/flows.test.ts` | On the Node host with a scripted model and the real routes: the run reports working, needs you and done; an answer resumes it; an approval, with and without a note; an answer from another device delivered by `run/deliver`; a second answer is `not_open`; a question that can't be shown; a run killed while it needs you resumes and asks again; waiting reported once while the turn waits; a failed answer reports failed |
| `src/features/status/queries.test.ts` | `core/waits` over a local `runs` collection: the order, every filter, rows following changes, each row exactly `WAITS_ROW` |
| `src/features/status/status.test.ts` | The tab's layer on two Node devices whose engines lead: the question in `statuses`, `waits` and the title on both, this tab's draft and focus, an answer from the other device delivered through sync, an approval with a note, waiting behind a question, a failure |
| `src/features/status/faults.test.ts` | Injected `RunsClient` faults: a question reported again, a delivery before the question parks, an approval refused, an answer sent again, refusals final |
| `src/features/status/api.test.ts`, `reporter.test.ts` | Every answer `RunsClient` reads; what the reporter sends, skips and fails with |
| `worker/Runs.test.ts` | Every route and status, the CHECK-backed transitions, the shape's filter and columns, records without the question or answer |
| `packages/smithers/ui/tests/agent-status.test.tsx` | The pill, the card, the toasts and the title |
| `e2e/status.spec.ts` | In real browsers: the scripted agent asks; the card, the top bar's bell, toast and title show it on two devices; the second device answers from the toast; the first device's run goes on; and a real-model run on two devices, locally or on the deployment's own branch: card, toast, bell and title on both, Hide on B clears both toasts while entries stay listed, and answering teal on B resumes A's run |

A failed header pill links to the failed answer's run, with the accessible name “Answer failed — view run”.
