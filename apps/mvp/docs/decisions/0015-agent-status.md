# 0015: Agent status: what the agent is doing, and whether it needs you

Status: proposed (2026-10-20); phase 1 built ([agent-status.md](../features/agent-status.md)). It is the person-facing layer of [0009](0009-notifications-and-live-work.md) for the agent's runs, on the browser engine of [0011](0011-the-agent-runs-in-the-browser.md). Deep run inspection (graph, steps, journal, replay) is the flows design panel's, decision 0014; this decision links to it and never duplicates it. Mock: [design/agent-status/](../design/agent-status/agent-status.html).

Will, 2026-10-20: "I think the old one and our smithers agent has ability to give status updates like whether the thing needs help or not we should have a designer figure out how to design that into app and get that into app".

## Decision

1. **Five states, one word each.** The agent's run is `working`, `waiting`, `needs_you`, `failed` or `done`. The UI words are **Working**, **Waiting**, **Needs you**, **Failed**, and nothing for done. These are 0009 §4's states: 0009's `live` is shown as Working, the word mvp.md §4.1 uses.
2. **The run reports its own status from its durable steps.** Each step that changes the status reports it to 0009's `runs` row, inside the step: `chat/LoadTurn` reports `waiting` while an earlier answer holds its turn and `working` when its turn comes, `chat/Settle` reports `done` or `failed`, and `app/agent/ask` reports `needs_you` with its question, then `working` once answered. A report that can't land never fails the run; only the question is retried, because the person can't answer what they can't see.
3. **Needs you is a flow the agent calls.** `app/agent/ask { kind, prompt, options? }` is a model-invocable client flow. Its body is `HumanTask` (`ask` for a question, `confirm` for an approval), so the question is a durable wait: closing the tab keeps it, and the next tab asks it again. `kind` is `question` (an answer in words, or one of `options`) or `approval` (Approve or Deny).
4. **Answering is a flow too.** `run/answer` records the answer on the server, then delivers it to the waiting run on this device. Every device syncs the answered row, and the device that holds the run delivers it there (`run/deliver`), so an answer from a phone resumes the run in the laptop's browser. The first accepted answer settles the question. Both are acts on a run, beside 0009's Cancel and Retry.
5. **One record, many views** (0009 decision 1). The `runs` row is the truth. The conversation, the header, the tab title and the toast are views of it and store nothing. Electric syncs it to the person's other tabs and devices.
6. **You see your own runs** (0009 §1, "You watch what you start"). The `runs` shape is the signed-in person's rows. Branch and repository scopes come with 0009's watches.

## States

| State | Row (`status`, `waiting`) | Glyph and tone | Detail | Action |
|---|---|---|---|---|
| Working | `working` | `◌` brand, pulsing | the answer streaming | none |
| Waiting | `waiting`, `turn` (later `quota`, `flow`) | `○` muted | none | none |
| Needs you | `needs_you`, `input` or `approval` | `◆` gold (`--warning`) | the agent's question, in its words | Answer; Approve or Deny |
| Failed | `failed` | `✕` ember (`--danger`) | 0002's `Couldn't answer` | Retry |
| Done | `done` | none | the answer | none |

Waiting is anything outside the run that it can't move: its turn behind an earlier answer today; a model rate limit and a remote flow next. Needs you is the one state that is the person's to act on. Both wait, so they share no color: needs you is gold, waiting is quiet.

## Where it shows

```
desktop                                                          phone
┌──────────────────────────────────────────────────────────┐   ┌──────────────────────┐
│ [◆ Needs you]                         ◐  ben   Sign out  │   │ [◆ Needs you]   ◐ ben│
│ ┌ ◆ Needs you · Which branch should I…  [Answer] × ┐     │   │ ┌◆ Which branch… [⏎]┐│
│ └───────────────────────────────────────────────────┘    │   │ └──────────────────┘ │
│                       Deploy the docs preview, please. ▐ │   │   Deploy the docs… ▐ │
│ ▌ ┌ ◆ Needs you ────────────────────────────────────┐    │   │ ▌ ◆ Needs you        │
│ ▌ │ Which branch should I deploy?                   │    │   │ ▌ [main] [docs-v2]   │
│ ▌ │ [ main ] [ docs-v2 ]  or  [Your answer…][Answer]│    │   │ ▌ [Your answer…    ] │
│ ▌ └─────────────────────────────────────────────────┘    │   │ ▌           [Answer] │
│                                                          │   │                      │
│                        [ Chat ⌘K ]                       │   │      [ Chat ⌘K ]     │
└──────────────────────────────────────────────────────────┘   └──────────────────────┘
tab title: (1) Smithers
```

- **The conversation.** The answer that needs you holds its question, in the agent's words, with the way to answer it: the `options` as buttons and a field, or Approve and Deny. Waiting shows a `Waiting` pill on the answer. Working is the answer streaming, as today; no pill. Failed keeps 0002's `Couldn't answer` and Retry. After an answer, the card collapses to the person's answer under an `Answered` pill.
- **The header.** One pill, first in the header row, in its own live region: `Needs you` (with a count above 1) while any of your runs needs you, else the latest answer's `Working`, `Waiting` or `Failed`, else nothing. Pressing it scrolls to the oldest open question and focuses its field.
- **The tab title.** `(N) Smithers`, where N is how many of your runs need you. Nothing else changes the title, so a background tab reads true at a glance.
- **The run row.** 0009's `runs` row, synced by Electric to every device the person signs in on. A device with no tab open shows the last status it synced; 0009's `No signal since` comes with its liveness phase.
- **Other tabs and devices.** Every view reads the synced row, so all of them change together, and an answer from any of them resumes the run.

## How "needs you" reaches you

| Channel | When | Rule |
|---|---|---|
| The conversation | always | The card shows while the question is open. |
| A toast, under the header | the question opens | 0009's stack, hung under the header rather than at the bottom-left, because the open composer docks over the column's foot and would hide it; an overlay since [0137](0137-toasts-overlay-the-page.md), never a row of the page: gold, the question's first line, one action (Answer), Hide. Shown after 300 ms, so a question answered at once never flashes. Never hides itself; Hide keeps the card and the header pill. Answer scrolls to the card and focuses it. One toast per question: a new question raises a new one (0009's `version`). |
| A browser notification | the question opens while every tab is hidden | 0009 §4: one Allow ask, on the first needs-you toast, only on a click and only on HTTPS; tag `run:<id>:<version>`; closes when the question is answered anywhere. Phase 2. |

The toast shows even when the card is on screen. 0009's rule against toasting a run whose card is visible is for live work; needs you is attention, and the header pill is not enough on a long conversation.

## Answer and steer

- **Answer** settles the open question. Questions take the field or an option; approvals take Approve or Deny. Only the person who asked the agent may answer in this slice (the answer routes' rule, [agent.md](../features/agent.md#the-answer-routes)); mvp.md §4.1's "any member answers" arrives with shared branch conversations.
- **Steer** (mvp.md §4.1, J3) sends context into a working run without settling a question. The app agent has no steering yet ([agent.md](../features/agent.md#the-host)). When it does, the composer reads `Answer Smithers` while a question is open, with **Answer** as its primary action and **Steer** beside it, and a draft left after someone else answers stays as **Send as steer**. Phase 3.
- **Inspect** opens 0014's run monitor from the answer. Agent status links there and never shows steps, attempts or a journal itself.

## Data

```sql
runs (id uuid PRIMARY KEY,              -- the run's execution id: an answer's id for chat/Answer
      flow text,                        -- chat/Answer
      status text,                      -- working | waiting | needs_you | failed | done
      waiting text,                     -- turn | input | approval, while waiting or needs_you
      wait jsonb,                       -- the open question: { execution, kind, prompt, options }
      version int,                      -- bumps when a new question opens (0009 §3)
      answer jsonb, answered_at,        -- the accepted answer: { value }
      launched_by text,                 -- the asker; never synced, the shape filters on it
      created_at, updated_at)           -- REPLICA IDENTITY FULL
```

| Route | Who | Does |
|---|---|---|
| `POST /api/runs/<id>` | the run's own steps, for the asker | Upserts the status. A settled row never changes; a new question bumps `version` and clears `answer` |
| `POST /api/runs/<id>/answer { version, value }` | the asker | Records the first answer to the open question. `409 not_open` once it is answered, closed or replaced |
| `GET /api/shapes/runs` | signed in | Electric's `runs`, `launched_by = <you>`, without `launched_by` |

0009's other fields (`step`, `attempt`, the limits, `progress_*`, `host_*`) and its `notifications` and `watches` tables arrive with its phases. The row's columns are a subset of 0009 §2's, under the same names, so its fold takes the table over instead of adding a second one.

## Flows

```
chat/Answer { answerId }
  chat/LoadTurn ── NotYourTurn: report waiting(turn), once ── its turn: report working
  chat/Respond ─ ctx.call("app/agent/ask", { kind, prompt, options })
                   app/agent/ask/request ─ report needs_you(wait) ─▶ HumanTask (parks) ─▶ app/agent/ask/answer ─ report working
  chat/Settle ── report done | failed

Answer (card; the toast and header bring the card) ─▶ run/answer { runId, version, execution, value }
  run/answer/record  ─ POST /api/runs/<id>/answer
  run/deliver/answer ─ HumanTask.answer on this device's engine (another device's run: nothing to deliver)
Electric ─▶ an answered row still needs_you ─▶ run/deliver (door sync) on the device that holds the run
```

- A question is open at most 10 minutes (`ASK_WITHIN_MS`), inside `chat/Expire`'s 25-minute expiry. Then `app/agent/ask` fails `timeout`, the agent answers without it, and the card closes. Longer questions need `chat/Expire` to read the `runs` row first (phase 2).
- Superseded by [0030](0030-worker-admission-consistency.md): a run waiting on a person retains its turn regardless of lease age.
- A tab closed while a question is open costs one model call: the frame that asked was in flight, so the next tab's engine asks its model again, and the call it makes joins the question already parked.

## Reusable pieces in `@smthrs/ui`

| Piece | What |
|---|---|
| `AgentStatusPill` | The five states as glyph, tone and word; `count` for needs you |
| `NeedsYouCard` | A question with options and a field, or Approve and Deny; controlled, so the app keeps the draft |
| `ToastStack`, `Toast` | 0009 §4's stack: at most three, Hide on every row, one action, tone by state |
| `agentStatusTitle(base, count)` | The tab title |

## Phases

1. **This slice (built):** the states and their reports, `app/agent/ask`, `run/answer` and `run/deliver`, the `runs` table and shape, the card, the header pill, the title and the needs-you toast, synced across tabs and devices.
2. Browser notifications by consent; a failed toast when the answer is off screen; `waiting` for a model rate limit (`model-parked`) and for remote flows; `chat/Expire` honoring an open question; 0009's fold writing every run's row.
3. Steer, with the composer as the answer box; Inspect into 0014; any member answering on a shared branch.

## Why

- **The old app had the words, scattered.** `StateWord.tsx` named ten TODO states; `RunsInbox.ts` grouped runs as Needs you, Working and Done, with purple for "the person acts now", blue for motion and amber for parked; `BranchView.tsx` raised `Needs you` notices. Each card had its own copy. Here one row feeds every view.
- **mvp.md fixes the tone:** "Live entries pulse, Needs you is gold and failures are ember" (§6.4). Gold is `@smthrs/ui`'s `--warning`; ember is `--danger`.
- **The SDK already asks people.** `HumanTask` is a durable, validated, re-askable wait with a deadline; `@smthrs/agent`'s `StandardFlows.ask` has the same input. The prototype of 2026-10-20 proved that a child flow parked on `HumanTask`, called from inside an action as the agent's catalog calls it, parks its parent and resumes it when answered.
- **Waits must be visible.** v4's `coding-clarification` parked a run "with no way to answer it" (`AgentSession.ts`), because the question lived in a child the inbox never read. Here the question is on the row the moment the agent asks.

## Questions for Will

None block this slice. Settled by the designer, Will may override:
1. **The toast shows while the card is on screen.** Needs you is the one state that must not be missed.
2. **Only the asker answers for now.** Everyone else in the conversation sees nothing new until shared branches exist.
