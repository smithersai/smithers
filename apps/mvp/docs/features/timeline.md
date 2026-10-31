# Conversation timeline

A desktop rail beside the conversation maps recorded asks and answers to transcript anchors. Clicking jumps. Arrow keys, J/K and Home/End move and jump; Escape focuses the transcript entry. The visible band follows scrolling and resize, including in branch conversations. On narrow screens, and in conversation columns below 600 pixels, the rail starts closed behind the conversation's Timeline control (touch, Enter or Space) and opens as a sheet over the chat without narrowing it, so a branch side pane never overlaps its code view. The rail measures wrapped labels and reduces the number of visible entries to fit its available height. Each row reserves that measured height; the position band includes row gaps and partial groups. `@smthrs/ui` supplies `ChatTimeline` and the public `ChatTranscript.rail` slot.

Every settled question and answer gets one model summary of 1–8 words, made once for every tab, device and person, and synced on the message ([Cost](#cost)). The tab that shows a conversation launches `timeline/summarize` on the browser durable engine for what the rail spans, the newest first. At most two run at once, across the home and the branch conversation a tab follows, and a tab asks about each revision once. `timeline/SummarizeEntry` claims the message on the server (`POST /api/timeline/summaries`), then calls `ModelStep` through `/api/model/summary` and records the summary on the message. An answer's call reads the question's first 500 characters and the answer's first 2,000; a question's reads the question and the answer before it, which resolves "it" and "those"; both allow 32 output tokens. A claim another tab, device or person holds completes with `{ outcome: "taken" }` before any model call and logs `timeline.summary` at Debug with outcome `taken`, never an Error; its summary arrives with the message. No reasoning effort is sent: a model that doesn't reason refuses the parameter, so the endpoint decides. The viewer's own model writes the summaries when they saved one ([Your model](personal-model.md#answering), decision 0099), a shared branch's included; the `summary` role is the cheap model's tier, so per-person model tiers can point it at a cheap model. Otherwise, while hosted inference is on, the cheap `summary` role is an Admin's setting (`admin/SetModel`), else the Worker's `SUMMARY_MODEL`; with neither, or with hosted inference off, the endpoint refuses the call `409 no_route`. The role uses the existing endpoint's permissions; a person's own model's calls are kept in their ledger, and the deployment's in its reservations, metering and quotas.

## Phases

Outer levels divide the conversation by what happened (FE-19, decision [0138](../decisions/0138-timeline-phases.md)). `timeline/phases` asks the same `summary` model where the goal changes, and stores a title ("Fixing flaky checkout tests") and a sentence on the message each phase starts at (`messages.phase`), so every device shares them. It reads numbered exchanges, each the question's summary (or clipped text while it has none) and the first 180 characters of the answer, never whole answers.

```
exchanges   1   2   3   4   5   6   7   8   9  10  11  12
            ╰──── Researching ────╯ ╰── Fixing ──╯╰ Review
call 1      reads 1–8    closes nothing past the last 3 items
call 2      reads from the first open span
closed      never read or changed again
```

A span closes once at least three items follow it, or when a call reads a full window of 24 exchanges. Everything still open is read again by the next call, which comes after 4 new exchanges, so an early wrong boundary can still be corrected. The server refuses to rewrite a closed span. Arcs (`messages.arc`) do the same over closed phases, from 12 of them. The rail shows a third column only when phases outgrow the second.

## When summaries can't be made

The app says so; it never falls back silently (FE-19). A failure every later call would repeat stops the tab's summaries and phases, in any conversation, until the app opens again, and raises one toast per cause on the shared stack (decision 0009), with the same words on the rail's hover for what is missing a summary.

| Cause | Failure | Toast |
| --- | --- | --- |
| No model for the role (`409 no_route`, or hosted inference off) | `unconfigured` | No summary model is set |
| The person's daily cap, or the endpoint's token budget | `capped` | Today's summaries are spent |
| A provider's 402 or `out_of_credit` | `credit` | The summary model is out of credit |
| An outage, after the durable step's retries | `unavailable` | The summary model isn't answering |
| Our own route not answering | `server` | Summaries can't be saved right now |

A load whose summary model can't answer costs at most two runs. These failures free their claim, so the message gets its summary once a model can make it. Every attempt counts against the daily cap, released or not, so an outage can't re-claim the same messages for ever. A claim a closed tab left behind can be taken again after ten minutes. A rejected output (`invalid`), a policy refusal (`refused`) or a claim someone else holds (`taken`) belongs to its entry, so later entries still run; a rejected summary keeps its claim, while a rejected segmentation frees its own, because a kept one would freeze the conversation's phases. The toast is local to the device and stays in the person's list until they dismiss it.

The summary lives on the message (`messages.summary` and `summary_revision`, migration 0066), so every device that syncs the message shows it, and a rail entry shows it only while its revision matches the message's content: full-content SHA-256 identities, so changed content is a new revision that may be claimed once more. Deleting a message deletes its summary, its claims and any phase that starts there, which joins the phase before it. Provider acceptance before sealing retains ModelStep's documented at-least-once charge window; a run that crashes after its claim and before its record leaves the label until the claim can be taken again.

`timeline.summary` logs/spans expose role, ready outcome, reason and replay status; `smithers_timeline_summary_calls` counts model calls, including failed calls and rejected output. `timeline.phases` exposes level, items read, phases made and replay status, and `smithers_timeline_phase_calls` counts its calls. `timeline.summary.notice` logs a toast's cause. Provider policy refusals fail `refused`, outages fail `unavailable`, and absent configuration remains `unconfigured`. Projection failures log only `timeline.summary.unavailable` or `timeline.summary.defect`; a missing summary model logs `timeline.summary.unconfigured`. A stopped lane logs `timeline.summary.stopped` once, with the failure's `code`, and counts `smithers_timeline_summary_stops`. `TIMELINE_TELEMETRY` keeps these records through the relay. No transcript text or summaries are logged. The engine journal retains model input/output as private run data rather than telemetry.

The compiled first-party contribution lives in `src/features/timeline`; its intended manifest declares `chat.rail`. Until decision 0017's new Manifest/PluginHost loader lands, chat explicitly mounts the contribution. There is no separate private data interface. [Design and limitations](../design/timeline/DESIGN.md), [interactive mock](../design/timeline/timeline.html).

The grant-store failure regression injects one-millisecond retry timings through `SummarySeat`, preserving six real durable attempts and the safe `unavailable` failure. Hosts that omit the policy retain ModelStep’s production backoffs.

Validation sources: `integration.test.ts` (two tabs on two devices, real routes and Postgres: at most one call per answer), `store.test.ts` (two devices share one call per answer; an idle page whose summary model refuses 402 makes at most two calls on the real durable engine; which failures stop the lane), `summary.test.ts` (bounds, content identities, safe labels), `phases.test.ts` (when a segmentation is due, what it reads, what may be stored), `notice.test.ts` (each cause toasts once, through a faulty dispatch), `view.test.ts` (states and stale summaries), `engine.test.ts` (real durable engine and replay; claim before the model, record after), `ledger.test.ts` (the route's answers to the step), `worker/TimelineSummaries.test.ts` (one claim per revision, the cap, refusals), UI `chat-timeline.test.tsx` (keys/rendering and recorded accessible names), `e2e/timeline.spec.ts` (scripted app scroll, keys, arriving summaries, phone), `e2e/timeline-look.spec.ts` (phases, levels, hover and each notification, on real flows and routes with the model scripted), `evals/timeline.eval.ts` (real models, judged) and `e2e/timeline-live.spec.ts` (real-model question and linked reply on the deployment account's own branch). The live journey waits for the reply entry to sync after question acceptance, follows its `aria-controls` link, and requires a completed answer containing the requested word, the recorded question name and answered outcome, and visible reply text beyond a generic status. A failed reply fails the journey. Device actions and step chapters record its GIF. Receipts live in the work note; configured coverage is not executed coverage.


## Cost

On smithers.sh on 2026-10-25, with bring-your-own-key live, the test account's own model took 350 summary calls in 50 minutes against 19 answers, about 7 a minute for each open page, and drained its key to 402 at 17:39. Summaries lived only in each device's TanStack DB, and the in-flight set was per tab, so every tab, device and fresh browser context (each e2e test opens one) summarized the whole window again: the ledger shows the same 15 inputs, by token count, in every burst, up to five times a minute.

Now a message's revision costs at most one call, whoever shows it:

- **Once.** `timeline_summaries` holds one claim per message revision (primary key), so a second claim from any tab, device or person is told `claimed: false`; only the claimant may record the summary.
- **Capped.** A person's claims in any 24 hours, summaries and spans together, stop at `TIMELINE_SUMMARY_DAILY_CAP` (200 unless set): the route answers `429 capped`, the tab stops asking and says so. Every attempt counts, released or not.
- **Bounded phases.** A call reads at most 24 exchanges and writes at most 900 tokens, after 4 new exchanges at the soonest. A closed span is never read again, so a conversation's phases cost about one call per 4 exchanges, once.
- **Recorded.** Each claim keeps the person, the reason and when it was recorded, never content; `timeline.summary.claim` logs its outcome (`claimed`, `taken`, `capped`, `recorded`, `released` or a refusal), reason, status and duration, and `smithers_timeline_summary_claims` counts them by outcome.

`src/features/timeline/integration.test.ts` proves it on ChatApi's real routes and Postgres with a person's own model: an idle page and a second tab on another device make one call for one answer, and three answers across both tabs make three, where the old code made one per message per device.


## Entry text

`@smthrs/ui`'s `ChatTimelineEntry.label` carries concrete fallback text independently of `summary`: fallback availability never claims the summary model completed. A matching, nonempty, specific summary wins. Old cached state-only summaries are ignored. The summary seat requests 1–8 words naming an object and observed outcome; its validator rejects generic labels such as “Reply sent”. Content identities, private model data and content-free telemetry are unchanged.

When the summary differs, the button's accessible name includes both the visible summary and recorded label. Its question subject and outcome stay identifiable after summarization; grouped buttons keep their group names.

| Entry | Before | Now without a summary |
| --- | --- | --- |
| Question (`ask`) | Question sent, Working, Not sent or Waiting to send | First eight words, a placeholder until its summary arrives; `Not sent` or `Queued` |
| Reply (`answer`) | Reply completed (production report: Reply sent), Reply failed, Working, Needs you or Waiting for reply | Linked question's first words · answered, a placeholder until its summary arrives; `Working`, `Needs you`, `Couldn't answer` or `Waiting` |
| Run (`flow`) | Not connected to the rail | Recorded flow name · completed/running/failed/needs you/queued |
| TODO draft (`tool`) | Not connected to the rail | Draft title · draft |
| Committed TODO (`tool`) | Not connected to the rail | Title · T number or PR number · recorded step, failure or state |

The conversation query retains the existing `questionId`; replies never borrow a neighboring question or parse assistant prose. An absent question uses the reply's recorded id. The agent-status query retains the existing run's flow name. Drafts join only by `answerId` in the visible conversation. The branch's stack is warmed through the existing TODO service, and committed TODOs are selected by their stored branch. Activating one opens its TODO; keyboard traversal stays on the branch. Draft and run entries jump to transcript anchors; drafts use the same creation order as their cards. No raw tool arguments, secrets service values or provider diagnostics are copied into entries. The catalogued `@smthrs/journal` Redaction scrubs recognized credential forms before excerpts, flow names and summaries render; it is defense in depth, not detection of arbitrary secrets pasted as ordinary prose. This is a private view of the same conversation, not telemetry or a new share.

PR checks are not present on the TODO row; no label claims they passed. Web-page rows remain outside this conversation rail. Arbitrary nested tool calls remain in the run's detail, not new rail entries.
