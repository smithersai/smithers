# Lane `runs` — REPORT

Brief: `runs.md` (the seven P0 gaps of `../UI-COVERAGE-GAPS.md` §P0). Status:
all seven steps shipped and green. Gates: `apps/app` tsc clean and 1323 pass /
3 fail (the three pre-existing `TargetGraph.integration.test.ts` failures that
need the `~/artsy/force` fixture — the lane's baseline, unchanged);
`packages/rpc` 119 pass; `apps/server` 176 pass; the T1 Playwright spec passes.
The relay (step 1) and the card wire schema landed as `fce5e44994` and
`a52a987155`; the rest is this lane's working tree.

## What shipped, per step

1. **Relay allowlist.** `apps/server/src/gatewayRpc.ts` mounts `Resume`,
   `Steer`, and `Signal` (`/rpc`) beside `Plan`/`Run`/`Cancel`/`List`/`Watch`/
   `Projection.Snapshot`; the `transcript`, `run-events`, and runless
   `approvals` projections ride the already-mounted `Projection.Snapshot`.
   `Approve`/`Deny` stay out — `Approval.Submit` covers decisions. Server
   tests pin the exact mount table.
2. **`run-list` card.** `runs.list [status] [flow] [by=] [lineage=]
   [owner/repo]` reads `workspace-runs`, filters client-side, and upserts
   `run-list-<repo>`: mono count line by status in the header, rows
   runId · flow · status-or-waiting · turns/calls · age, filter chips that
   re-invoke `runs.list` with the chip's argument, and a `Stop all N` footer
   (`flow.run.stop-all [owner/repo]`, confirming). A row's Open runs
   `runs.open <runId>`, which materializes the run's own `flow-run` card from
   its summary. `by=` refuses in words and asks nothing: the wire's run
   summary records no launcher, and `Control.list` refuses the filter — a
   silently dropped filter would list runs the human asked to exclude.
3. **`approvals-inbox` card.** `approvals.list [owner/repo]` reads the
   `approvals` projection with NO run id (the workspace's pending gates) and
   upserts `approvals-inbox-<repo>`: count line, rows run · question · age.
   Each row carries the submit-ready envelope the gateway published, and its
   Approve/Deny dispatch the ordinary `approval.approve` / `approval.deny`
   flows addressed `inboxCardId:requestId` — `decideApproval` routes that
   shape to a new `forwardInboxApprovalDecision`, which submits the envelope
   unchanged and freezes (or, on refusal, error-marks) the row from the
   server's answer. `approvals.open <runId>` materializes one run's pending
   gates as ordinary per-run approval cards, so their decisions ride the
   existing path. `system.recommend`'s rule leads with `approvals.list` while
   an approval card is undecided, else `runs.list` while a run is live.
4. **flow-run card: lifecycle.** Stop on every non-terminal phase —
   `flow.run.stop` gained `[reason]` and `confirm: "stop the run"` and lost
   `userOnly` (stays hidden; the wave-12 review test now pins that a model's
   stop is a confirmation question and cancels nothing, while
   `flow.repo.choose`/`flow.run.retry` stay user-only). Resume appears when
   the control plane names a wait other than an approval (`/runs.resume`,
   which sends the standing reason "Nothing was driving the run." for the
   executor convention). Run again appears when settled: `/runs.rerun`
   relaunches through the same `launchWorkflow` path with the launch `input`
   the card recorded at launch (claims `outbound:launch`), and refuses
   honestly when this client never saw the input — an opened-from-the-inbox
   run has none. The phase line names the wait in the control plane's word:
   `accepted · nothing is driving it` (the CLI's render-time convention) for
   an accepted run, `waiting · <reason>` for a parked one.
5. **flow-run card: steer.** A steer composer row under the steps
   (`runs.steer <runId> <message>`) and the mono strip: a seat input
   (`runs.seat`), a thinking dropdown carrying the wire's own six levels
   (`runs.thinking`), a tools input (`runs.tools`). A queued steer reads
   `steering pending · delivered at the next turn`, driven by the summary's
   `steeringPending` count through the pump. The envelope's principal is the
   server's to stamp — the client sends a placeholder `ControlServer`
   overwrites on every steer over RPC, so no client names authority.
6. **flow-run card: facets.** Steps / Transcript / Events tabs, each a
   registered flow. `runs.logs <runId> [--follow]` shows the transcript
   projection; `--follow` toggles the live merge, which rides the pump's own
   poll cycle (one round trip, no second poller). `runs.events <runId>` is
   the raw journal and exists only under `/debug.verbose` — the flow refuses
   otherwise, and the Events tab renders only when the session's verbose flag
   is on (threaded App.tsx and CardTabBody into CardView as `debugVerbose`).
7. **Docs.** LOCAL-APP.md gained the Cards section (the three run-lifecycle
   surfaces and their flows); WORKBENCH-UX.md gained §3.13 "Runs (the agent's
   work on the workspace)".

## Wire facts the lane established

- `RunSummaryRow.waitingReason` is a plain word (`approval`, `timer`,
  `quota`, …) with no clock and no signal name, so the card renders the
  reason plus its unblock act and nothing more — `waiting · provider quota ·
  resumes 12:40` is not renderable on this wire and was not invented.
- `RunSummaryRow.steeringPending` is a count, not a boolean.
- The launch path is `Plan` → `Approval.Submit` (the client auto-approving
  its own plan) → `Run`; the e2e double has to speak all three.
- `Approval.Submit` rides the relay envelope spread flat beside `decision`.
- Every mutation mints one idempotency key per invocation (`resume:`,
  `signal:`, `steer:` with the run id and clock), so a relay replay lands one
  effect and two deliberate clicks land two.
- React's `onChange` normalization does not fire under the happy-dom test
  setup — card text inputs use `onInput` (the `RunTimelineCard` scrubber's
  established pattern).

## Tests

- `state/controller/gateway.test.ts` — the seam against a relay double:
  every new projection's selector shape (including approvals with and without
  a run id) and every operation's payload, refusal pass-through, and the
  empty-rows envelope.
- `state/Runs.test.ts` — the controller through the real registry against a
  relay double: the inbox and its filters, the `by=` refusal asking nothing,
  open, resume (and its Terminal refusal), rerun with the recorded input and
  the honest refusal without one, signal JSON parsing, the steer family, the
  facets (follow toggle, pump merge, verbose gate), stop-all, and the
  approvals inbox including the `inboxCardId:requestId` decision routing.
- `cards/RunsCards.test.tsx` — the cards per phase and waiting reason: count
  line, chips, stop-all footer, row Open; inbox decisions and the frozen /
  errored row; Stop on live phases, Resume per wait, Run again when settled,
  the steer row and thinking strip, the facets.
- Grammar pins in `flows/SlashPayload.test.ts`; registry and parity pins
  updated (NAMESPACES gained `runs` and `approvals`; ChatCards 24 handlers,
  RunsCards 6).
- `e2e/playwright/runs.spec.ts` — T1: launch a fixture flow, steer it, stop
  it, and see it in the run inbox, all through page.route doubles with the
  RPC recorded and asserted.

## Review (Kimi K3, read-only, 2026-09-02) and what changed

Fixed in the working tree after the review: (1) HIGH `runs.signal`, the steer family (`runs.steer|seat|thinking|tools`), and `runs.resume` were performable by the model with no confirmation — a model could release a human gate; each now carries `confirm`, so the agent asks and the human performs (matching `flow.run.stop`); (2) MEDIUM-HIGH "Stop all N" counted the inbox's wire rows but cancelled only this client's cards and ignored the inbox's filter — it now cancels the inbox's live rows under the active filter, and falls back to the client's cards only when no inbox is open; (3) MEDIUM inbox approval rows had no in-flight guard, so a second click could send a contradicting decision — rows carry `pending`, the buttons hide while it is set, and the controller refuses a decided or pending row; (5) LOW the filter chips derived from the filtered rows, so a single-status filter removed every chip including All — the run-list payload records the unfiltered `statuses` and the chips read it; (6) LOW one decided row marked the whole inbox `acted` — the card is acted only when every row is decided; (7) LOW `stopped` (the phase a REFUSED cancel leaves) was treated as terminal, offering "Run again" on a possibly live run — it is no longer terminal, so the card no longer offers Run again on it (the `runs.rerun` flow itself stays invocable on any run with a recorded input, as its tests pin: a rerun is a NEW run); (8) LOW the Events facet body kept rendering after verbose was turned off — the body is gated like the tab; (4) the transcript rows now render `at · kind` beside the text.

Open from the same review: (4b) the transcript facet still has no follow toggle in the card (follow rides the `--follow` slash argument); the `RunsCards.test.tsx` "confirming flow" test asserts only the dispatched flow name.
