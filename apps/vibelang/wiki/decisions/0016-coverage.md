# 0016. Coverage of the VibeLang sources

**Status:** in progress, 2026-11-07. **Rulings:** VL-5, VL-7, VL-14, VL-29.

The goal remains 100% lines, branches, functions and statements for each production file, independently per suite.
That goal has **not been achieved**. No source file is excluded from the unit or workerd roster, or, since 2026-11-10, the fuzz gate,
whose roster had left out `scripts/`, `infra/` and `worker/Api.vibe` ("Measuring every gate" below). This decision records landed behavioral tests and
the coverage commands. `pnpm e2e` measures and reports Chromium coverage without failing on it. The strict gates
`pnpm test:coverage` and `pnpm e2e:coverage` are the exclusive PACKAGE targets `coverage` and `browserCoverage`: a
person asks for them, no wildcard selects them, and they stay red until every file reaches 100%. Exclusive is the
same pattern as `benchCoverage` and `fuzzCoverage`. Exclusive is not a threshold change: both gates hold 100%.

## Known-red gates stay opt-in (the lead's call, 2026-11-10)

`coverage`, `browserCoverage`, `benchCoverage` and `fuzzCoverage` stay `exclusive: true` while they are red: a
person runs them by name and a wildcard `smthrs test` skips them. Each joins the default gate in the commit that makes
it pass, by removing its `exclusive: true` in that commit. Every gate keeps its 100% per-file thresholds meanwhile.
`workerdCoverage` follows the same rule. The lead decided this for the lane; it does not go to Will.

## Browser gate scope (the lead's call, 2026-11-10)

The browser gate's denominator is the code a browser runs: every `.vibe` file in `src/web`, plus every app source
(`src/`, `worker/`, `scripts/`, `infra/`) that the e2e build's source maps name. A bundled source counts whole,
including exports that tree-shaking dropped. A `src/web` file that no chunk imports still counts.

`src/surfaces`, `scripts`, `worker`, `infra` and the server-only parts of `src` run in no browser, so no browser
journey can reach them. With them in the denominator the browser gate's 100% was unreachable (session 15: 153 of 167
files below 100%). The unit gate (`pnpm test:coverage`) and the workerd gate still measure every file in all four
directories; nothing leaves them. A server source that the bundle starts to import enters the browser gate on that
build, with no configuration change.

The roster is `browserSources` in `e2e/coverage-reporter.ts`. It reads `dist/assets/*.js.map`, fails if the build
has no source maps, and the reporter prints its size on each run. Test: `test/browserCoverageScope.test.vibe`.

Because a bundled source counts whole, a browser module that imports one name from a server module ships, and is
measured on, all of it. Such a name moves to a module of its own (session 25). `src/history/areas.vibe` holds the
epics' areas, `areaOf` and the `BOOTSTRAP` byline: the sequencer files an outside commit by `areaOf`, and the history
page hides the byline. Before the move those two imports put all of `src/history/seed.vibe` in the bundle: the
bootstrap that groups real commits, which only `scripts/mythical-seed.vibe` runs (87 browser branch arms, 154 lines).
The unit gate still measures `seed.vibe` whole. The same session moved a title's scope and the first area naming it
(`titleScope`, `areaIndex` and the index walks they call) from `seedDecision.vibe` to `src/history/areaDecision.vibe`:
`areas.vibe` needs only those, and importing them shipped the bootstrap's queue, join, sentence and evidence decisions
too (40 browser branch arms, 27 lines). Their proofs and mutations moved with them.

The same holds for `src/core`'s pure decision files (lane vl-coverage-core, 2026-11-12). Each server decision below
lived in a file the bundle imports for other names, so the browser gate counted it and no browser could run it. Each
moved with its `//@` contract, unit tests, fuzz and bench calls, mutation rows and 0018 inventory row; `pnpm verify`
and `pnpm verify:broken` pass on all nine modules, and the unit gate measures every one.

| Function | Was in (browser loads it for) | Now in | Callers |
| --- | --- | --- | --- |
| `agentRefused` | `issueHostDecision` (only this name: `IssuesFactory`) | `flowPolicyDecision` | `IssuesFactory`, `worker/Issues` |
| `appends`, `startAnswer`, the `ReplyRun` model (8 functions) | `flowDecision` (tour decisions: `flows`, `MockFactory`) | `replyDecision` (new) | `worker/Reply`, `worker/Sequencer` |
| `routeOf`, `decodeSegment`, `Route` | `wire` (paths and schemas: `LiveFactory`, `MockFactory`) | `routes` (new) | `worker/Http` |
| `nonnegativeCursor`, `responseKind`, `liveHealth`, `validTourStep` | `protocolDecision` | `clientProtocolDecision` (new); `protocolDecision` keeps the Worker's and command hosts' decisions and leaves the bundle | `schemas`, `LiveFactory`, `MockFactory`, `web/backend`, `worker/Http` |
| `reviewActions`, `vipDocumentMatches`, `VipFile` | `conversation` (the state machine: every screen) | `issueHostDecision` | `worker/Issues` |
| `cancellable` | `actionRunDecision` (only this name: `MockActions`) | `src/actions/actionHostDecision` | `MockActions`, `worker/ActionRuns` |
| `wikiUnwritten`, `wikiRefusalStatus` | `wikiPageDecision` (page lookups: `wiki`, `WikiFactory`) | `issueHostDecision` | `worker/Wiki` |

Measured on main `6fbe6ee1` (`pnpm e2e:coverage`, base and change on boxes): covered counts are identical
(branches 4,522, lines 4,643, functions 2,004, statements 5,547), so the browser runs exactly what it ran; the roster
lost 278 branch arms, 110 lines, 51 functions and 159 statements that no browser ran. `src/core`'s open branches
went from 862 to 584: `issueHostDecision` (123), `protocolDecision` (52) and `actionRunDecision` (17) left the
roster, `flowDecision` 83 → 24, `wikiPageDecision` 34 → 11, `wire` 11 → 1, and `clientProtocolDecision` has 6 of 8.
That measurement also moved `wikiUnwritten` and `wikiRefusalStatus` out of `wikiPageDecision` (its 34 → 11); they
moved after vl-proveall3's proofs in that file landed (`7b447afd`).

Named browser sites and status:

| Site | Reason |
| --- | --- |
| `src/history/flows.vibe:213` | V8 range defect (`~/vl/vibelang-bugs/coverage-v8-suspend-else-arm/`), if the bundle ships it. |
| `src/history/tools.vibe:93` | The compiler's exhaustive-match fallthrough arm (ruling VL-37; the fleet lead's compiler change). |
| `src/web/wikiView.vibe:88` (`toHtml`) | `toHtml` runs since session 19: the GitHub-recorded repository copy differs from the build. Its link resolver still never runs: the recorded page has no links (session 21). |
| `src/web/main.vibe:391`–`394` and `issueRecovered`, `issueRecoveredView` (`issueDecision.vibe`) | Closed in session 20: the browser uses production issue routes on workerd over recorded GitHub. Pending new issues and VIPs restore their forms; completed and unwritten-refused comments restore their issue. |
| `src/web/main.vibe:1375`–`1376` (`LoadAccount` failure) | Only `startup.vibe`'s mode resolution sends `LoadAccount`; the fault pages start in mock mode without it. The same `AccountFailed` arm runs from sign-in and Visit as. |
| `issueKnownAction` (`issueDecision.vibe:207`) | Called only by a proof contract and a unit test, never by product code: 28 of the file's browser branch arms. It becomes a `spec function` when the compiler parses VIP-43 (`~/vl/vibelang-bugs/spec-only-function/`, session 24). |
| `src/web/historyStartup.vibe` (`signedRoles`) | Runs only live: the preview has no API Worker, and the mock plays the role the page chose. The unit suite drives it through the real startup over a loopback API (`test/historyStartup.test.vibe`). |
| `src/core/conversation.vibe` `apply`: a fractional or negative walkthrough `step`, `duration` or seek | The page decodes every event with `EventSchema`, whose `Seq` is a non-negative integer, so such an event fails decoding first (vl-coverage-core: the forged fault crashed Foldkit's schema check when it sent one). The contracts keep the checks because Dafny's numbers are not integers. |
| `src/core/conversation.vibe` `hasClientId("")` | `apply` refuses an empty client id before calling it, and `post` before that. |
| `src/core/conversation.vibe` `holdRemaining`: `remaining < 0` | A walkthrough's remainder is a `WalkthroughDriven` duration, which `apply` admits only when it is 0 or more, or `holdRemaining`'s own answer, which is never negative. The guard keeps the function total for its proof. |
| `src/core/conversation.vibe` `tourWalkthrough` answering `null` for a walkthrough it holds | `TourStarted` clears the last tour's walkthrough (`c5a2f3f9`) and `WalkthroughDriven` applies only to the running tour, so a walkthrough always belongs to the running tour; `flows.vibe` `walk`, the only reader, runs only for a running tour. |
| `src/core/flowDecision.vibe` `tourLawful` (18 arms) | Called only by proof contracts, `test/decisions.coverage.test.vibe` and the fuzz oracle (`fuzz/core-flow-decisions.node.fuzz.vibe`), never by product code. It becomes a `spec function` when a compiler parses VIP-43 (`~/vl/vibelang-bugs/spec-only-function/`). |
| `src/core/flowDecision.vibe` `observeTourActivity` past `begun`, `startTourSpeech` when it cannot speak, `finishTourSpeech` when not speaking | `flows.vibe` `toured`, the only product caller, calls each once, in that order, on a fresh run and only after `canSpeakTour` holds. The guards keep each function total for its proof; the unit test and fuzz suite reach them. |
| `src/core/flowDecision.vibe` `readingHold`'s four-second floor | It applies to a narration of 10 words or fewer; every subtitle in `walkthroughSteps.vibe` has 12 to 18. The unit test and bench reach it. |
| `src/core/wikiPageDecision.vibe` `fixtureVerdict`: `unchanged` | The page stops a save that changes nothing ("No changes.", `e2e/core-wiki.spec.ts`) before it reaches the fixture repository. |
| `src/core/wikiPageDecision.vibe` `fixtureVerdict`: `stale` | A save's base is the page the editor read, and the mock never changes a page: its saves and proposals open reviews. The GitHub host's conflict reaches the browser through `fault=wiki-conflict`. |

### A backend that breaks the conversation's rules (vl-coverage-core, 2026-11-12)

`fault=forged` (`test/support/forgedEvents.vibe`) inserts schema-valid events that `apply` must ignore into the real
mock's stream: 34 in the home conversation (9 while a reply streams: a restart of the reply before it streamed
anything, which clears nothing, then another reply or tour, pane and tour moves by the wrong id; 25 after it: repeated,
empty and id-less posts, replies to nothing, moves of no reply, tour or run, refused grants) and 7 in a tour (a pause
before any walkthrough, a settlement in a conversation that requested no run, out-of-range steps, an empty target,
out-of-range seeks).
Each takes the next sequence number, so the page applies it rather than replaying a gap; the real events after it are
renumbered, and a subscription that resumes inside an insertion gets the rest of it first. `e2e/core-conversation.spec.ts`
asserts the client's conversation equals the real one but for `seq`, one question and one answer show, no forged text
shows, and the tour stays on its real step and still moves on.

**A reply a reload interrupted** (`e2e/core-restore.spec.ts`, vl-coverage-core). The page journals the walkthrough's
demo conversation in localStorage; the spec seeds the journal a page leaves when it closes mid-reply (a post, the
reply's start, its first words) and loads the page with the tour active. The mock restores the conversation, fails
the reply no execution can finish (`MockFactory` `openRoom`), and the page shows "The agent failed. Try again." under
the partial reply (`apply`'s `ReplyFailed`, `viewDecision` `failureOf`, `view.vibe` 263). A new question is answered.
A `ReplyFailed` with an empty reason, which no producer in the mock sends, arrives from a stored journal (below).

**A clock the sandbox meter cannot read** (`fault=sandbox-clock`, `e2e/core-sandbox-clock.spec.ts`). After the first
sandbox starts, the faulty factory's sandbox clock reads before 1970 for one sandbox call. `sandboxHost` `load` fails
on it and `emergency` stops every running sandbox with real machine stops before the call fails; the page shows the
sandbox stopped and the command wrote nothing.

**A walkthrough journal with moves the machine refuses** (`e2e/core-journal.spec.ts`, vl-coverage-core session 6).
The page decodes any schema-valid event list from localStorage (`startup.vibe`), so a journal an older page or a
person edited reaches `apply` through the mock's restore (`MockFactory` `openRoom`, `replayLog`); `receive` is not the
only browser caller. One journal restarts a reply, fails it with an empty reason, requests one run twice, sends a step
with no key and a late result for an earlier attempt, cancels the run while one step runs and one waits, then settles
it again. The page shows the reply's second text under "Answer failed", and the next question is the journal's 15th
event. Another journal skips numbers 5 and 6.

**Bug fixed.** A retained journal that skips or repeats a number stopped the page. The restored room kept every
retained event in its log, so a reader's replay sent seq 7 after 4; the page marked a gap, replayed from 4 and met 7
again, without end, and never handled Escape. `openRoom` now keeps only the events the replay applied
(`mockFactoryDecision` `appliedIndexes`: proved, two mutation rows, unit cases for repeats and skips; counter
`vibelang_mock_trimmed_journal_events`, log `vibelang.mock.restore` with outcome `journal-trimmed`). Red first:
`core1/s6journal1` (Escape left the tour running); green: `core1/s6journal5`, 6 passed on three projects.

Closed in `conversation`: `apply`'s out-of-sequence guard (its named row above is gone), the other-entry arms of
`ReplyRestarted` and `ReplyFailed` and the empty reason, `hasRun`'s repeat, `settleRun` on a settled run, `cancelStep`,
`stepRun`'s empty key and late attempt, and `latestAt`'s earlier step.

**A second tour in one tab** (`e2e/core-tour-repeat.spec.ts`, `e2e/core-tour-journal.spec.ts`, session 6).
`learnMore` starts every tour of a session in its one tour conversation, and the page follows that conversation from
its first event, so the earlier tour's start, steps and end arrive again before the new tour's.

**Bug fixed.** A second Learn more in a tab ended at once ("Tour ended. You have control."), and so did a reload during
a second tour. The replayed end of the first tour ran `endTour`: it dismissed the tab's tour, so the new tour's steps
never showed, and it sent `EndTour`, which ended the new tour on the sequencer. Once that was fixed, the start's own
answer did the same: `SucceededTour` ends a start that lands after the tour ended, and read the replayed end as the
person's. Now an end the sequencer recorded gives the screen back and sends and dismisses nothing; only a dismissal,
the person's end, ends a late start; and only a running tour's walkthrough presents, so a refused move of an ended
tour does not show it again (`src/web/main.vibe` `endTour`, `receiveTour`, `SucceededTour`). Red first: unit
`test/mainUpdate.coverage.test.vibe` (2 failed on the old code) and `core1/s6repeat2`, `core1/s6tours1`; green:
`core1/s6tours2`, 84 passed on three projects with every tour, walkthrough, restore and recovery spec. The unit test
that expected a received end to send `EndTour` encoded the bug and now expects the opposite.

A stored tour journal restores a step with what remains of its reading time: none once it ran out (the tour moves on
at once) and all of it when the step's clock reads later than the page's. Closed in `conversation`: `TourEnded`'s
other-entry arm and `holdRemaining`'s clock-behind and elapsed arms.

**A transport that resends** (`fault=sandbox-replay`, `e2e/core-sandbox-replay.spec.ts`, session 6). The faulty
transport loses the answers to the first sandbox start and the first command and sends each again with its operation
id, then sends the second command under the first command's id. The sandbox writer answers each resend from its receipt,
so the transcript holds the first command once, and refuses the second command (`operation-conflict`); the page shows the
refusal, writes nothing, and the next command runs. Closed: `sandboxHost` `admit`'s stored receipt and conflict and
`command`'s receipt answer; `sandboxHostDecision` `replayConflict` (all five comparisons) and `replayAnswer`'s conflict
and replay arms.

Orphan settlement lives in the Worker (2026-11-13, the lead's approval of 08:44Z). `sandboxHost` `current` had a
`settle-command` arm for a pending command no fiber of the host instance runs: after a Durable Object eviction, or when
the command fiber is interrupted or dies. No browser input reached it: the browser's mock builds one host per in-memory
store, its flows have no step timeout, and `memoryMachines` cannot fail a command except with `Unavailable`, which the
command records itself; a failing store write is a defect and ends in Foldkit's crash view (session 5). Only the
Worker's store outlives a command fiber, so `worker/Sandboxes.vibe` `open` now counts the command ids its incarnation's
fibers run and settles any other pending command as `command-uncertain` on the read that finds it
(`test/sandboxesObject.coverage.test.vibe`: an evicted incarnation, an interrupted fiber, and a running command left
to its fiber after a refused copy). `sandboxHostDecision.recoveryOf` no longer takes `active` and proves that a pending
command is always awaited; mutation row `sandbox-host-recovery-command` replaces `sandbox-host-recovery-active`.

`fault=post-empty` now loses the post's text on the way instead of faking the refusal, so the mock's sequencer refuses
it itself (`decide`'s empty post); the page shows "Empty message" and Retry as before (`e2e/recovery.spec.ts`).

### Live mode against the production sandbox objects (vl-coverage-core, session 7, 2026-11-13)

`e2e/core-live.spec.ts` runs the page in live mode on a live site whose API Worker (workerd,
`test/workerd/worker.vibe`) has sign-in configured and runs the production sandbox gateway (`gatewayOf`), per-person
account object (`accountObject`) and per-sandbox machine object (`machineObject`) in workerd SQLite on an in-memory
Container (`test/workerd/liveSandboxes.vibe`; served by `e2e/authbroker-host.vibe`). Six journeys, each on three
projects:

| Journey | `LiveFactory` arms it closes |
| --- | --- |
| A maintainer starts a sandbox, runs two commands and stops it | read, start, command, stop success |
| A machine that never starts: the refusal and Retry | `sandboxRefusal` with a reason |
| An account object that resets during a start, a command and a stop: each failure shows, Retry recovers | start, command and stop answering neither 200 nor a refusal |
| A person whose role was taken away after the page's last read: the read is refused, then a start | read answering 403; a refusal with no reason |
| A message over 8,000 characters (the sequencer's 409, "Message too long"), two over the post body limit (the Worker's 413, "Send failed"), a Retry of one that fails again, then one that is sent | `refusable` refused and unavailable; in `conversation`, `failPost` and `retryPost` passing another pending post |
| An API Worker that throws on health: the page starts in the mock | `health` answering other than 200 |

Each journey that changes an account uses its own person (a contributor the maintainer grants), so no journey sees
another's sandbox. Faults are the test host's injected services, set through `/__fault/sandbox` and
`/__fault/health`: the in-memory Container's own (`machine=`), an account object whose call rejects during one kind
of operation as a Durable Object reset does (`account=…&fail=<kind>`), an identity service whose role check answers
`new` (`account=…&revoked=1`), and a Worker that throws on health. Nothing intercepts a request.
`test/sandbox.workerd.test.vibe` drives the same objects over HTTP without a browser: start, two commands, a write
from another origin refused (403), stop.

`LiveFactory` `sandboxCommand` now decodes its answer with a schema (`decodeTerminal`), as every other answer in the
file is decoded, instead of a hand-written check; the reason is still "terminal is not the protocol"
(`test/liveSandboxEdges.coverage.test.vibe`).

Still open in `LiveFactory`, both reached only from Node:

| Site | Reason |
| --- | --- |
| `pathOf`'s invalid conversation | The page's conversation ids are generated session UUIDs. Only the CLI and the MCP server pass an id a person typed; the unit gate covers it. |
| `read` | No browser code calls `Factory.read`: the page follows `events`. Only the CLI reads (`src/surfaces/commands.vibe`). Taking `read` off the browser's `Factory` is the lead's call (asked on the board). |

**Two sandboxes in one allowance** (`e2e/core-sandbox-two.spec.ts`, session 7). Learn more moves the page to the
tab's tour conversation, and it stays there after the tour, so a contributor's sandbox at home and another in the tour
conversation share one ledger: two entries, both running, with distinct ids and separate machines (a file written in
one is missing in the other). It closes `sandboxDecision`'s comparisons against another entry (`distinctFrom`,
`validSandboxes`), `replaceSandbox` and `sandboxIndex` passing another entry, and `meterDelay`'s share between two
running sandboxes. `runningCountPrefix` (4 arms) is called only by contracts; it becomes a `spec function` when a
compiler parses VIP-43 (`~/vl/vibelang-bugs/spec-only-function/`).

**An end sent twice** (`fault=end-twice`, `e2e/core-end-twice.spec.ts`, session 7). The transport sends the first tour
end twice, as a client that resends an end whose answer it lost. The mock's sequencer refuses the second (`decide`'s
`EndTour` with no tour running); the page reads that refusal as the tour already ended, gives the person control, and
the next question is answered. Two other `decide` refusals of a person's request never reach `decide` from a page:
`OpenPane` with no page (the mock's `openWiki` and the Worker refuse a page outside the wiki first, `wikiPath`) and
`SeekTour` past the last step (the mock and the Worker answer 400 first, `validTourStep`). The guards keep `decide`
total for its proof; the unit and fuzz suites reach them.

### History names and the signed-in ledger carried by their schemas (session 23, 2026-11-11)

The lead's two decisions: move `decide`'s non-blank guarantee into the outline's schema, and make the session type
carry the signed-in person's ledger. Both close their sites by deleting the code, not by testing it.

**History names.** `src/history/schemas.vibe` has a `Name` schema: a string that is not blank, checked by the proved
`named` (`src/history/mythical.vibe`, `text.trim() != ""`). Every title, id and SHA the history holds uses it:
`Epic.id` and `.title`, `Commit.id` and `.title`, `Real.sha`, `Head.id` and `.title`, and `EpicCount.id` and `.title`.
`Outline`, `EpicPage`, `CommitPage`, `Matches`, the stored `History` and the page's `HistoryModel` decode through
them. So a blank one is refused where it enters, and no view needs a fallback. Deleted:

| Deleted | Was |
| --- | --- |
| `historyViewDecision.vibe` `orFallback` | the crumb's and the plan form's blank epic label ("Epic"), the blank SHA link ("Commit") |
| `historyViewDecision.vibe` `commitLabel` | a blank commit title named by its id, or "Change" |
| mutations `hv-fallback-trim`, `hv-label-id` (`verify/web_mutations.py`) | the two helpers' mutations |
| scenes of blank data (`historyViewEdges.coverage`, `history.scene`, `paneViewDecisions`) | data the schemas now refuse |

`decide` already refuses a blank title or id. `apply` refuses an empty fold SHA, and fold SHAs come from git. So no
history the product writes changes. New mutations `history-named-trim` and `history-named-empty`
(`verify/extended_mutations.py`) break `named`'s proof.

Tests that failed first, on `main`'s schemas: `test/schemaParity.test.vibe` "refuses a blank history title, id or
SHA at every decode boundary" and `test/history.scene.test.vibe` "refuses a model whose outline holds a blank epic
title" (2 failed, 18 passed). Both pass after the change.

**The signed-in ledger (`historyStartup.vibe:69`).** A signed-in person must always have a ledger, and both hosts
already give one (`worker/Accounts.vibe` `current`, `MockAccounts.vibe` `current`). So the type now guarantees it,
and the line runs; nothing was deleted. `src/core/roles.vibe` adds `Session = Viewer | SignedIn`. `Viewer` has the
empty id and no ledger. `SignedIn` has a non-empty id and requires `ledger`. `Accounts.current()` answers a
`Session`, and the browser's `LiveAccounts` decodes the session route with it. A reply that names a person without
a ledger, or a blank id with a login, is refused as `AccountUnavailable`. `signedRoles` follows grants from
`identity.ledger.seq` with no fallback. `Identity`, the member list's type, is unchanged.

TypeScript narrows the union on `"ledger" in identity`, not on `id === ""`: a literal `""` member beside a `string`
member is not a discriminant (`tsc` probe, this session). `historyStartup.vibe` and `surfaces/backend.vibe` test
for the ledger.

Test: `test/liveClientsEdges.coverage.test.vibe` "a session reply naming a person without the ledger their role came
from is refused". Its red is at compile time: `main`'s `LiveAccounts` no longer satisfies `Accounts.Shape`
(TS2375, `ledger` optional where `Session` requires it).

Unit gate on this tree (box node26, `pnpm typecheck && pnpm test:coverage`): exit 1 on thresholds only. 299 files
passed, 1 skipped; workerd 20 passed. 12 of 202 files below 100%. `historyStartup.vibe` reaches 100%.
`issuesViewDecision.vibe` and `view.vibe` are new gaps from `main`'s changes since session 22.

| Gate | Files below 100% | Lines | Branches | Functions | Statements |
| ---: | ---: | ---: | ---: | ---: | ---: |
| Unit, session 22 → 23 | 12/196 → 12/202 | 8617/8634 → 8814/8831 | 8881/8919 → 9107/9147 | 3271/3287 → 3380/3396 | 10950/10970 → 11185/11206 |

Proofs (box node26): `pnpm verify src/history/mythical.vibe src/web/historyViewDecision.vibe` reports 43 and 16
verified, 0 errors. `pnpm verify:broken history-named-trim history-named-empty`: BROKEN PASS, 2 of 2 rejected.

**A fixture that held an impossible session.** `test/workerd/live-issues.vibe` answered the session route with a
signed-in person and no ledger, a reply production never sends. After the change above, `LiveAccounts` refused it, so
three `e2e/live-issues.spec.ts` journeys failed in 3 projects (9 failures in this session's browser gate). The host
now answers as `worker/Accounts.vibe` does, with the ledger: 15 passed.

**Unit arms closed in session 23:**

| Site | How |
| --- | --- |
| `view.vibe` `model.docs ?? ""` (2) | Deleted: `Model.docs` is required (`"pane" \| "max"`) |
| `view.vibe:153`, the tour's error line | `test/app.scene.test.vibe`: a failed tour request is named in the walkthrough bar |
| `issueHostDecision.vibe:230`, an unlabel with no label | `test/issueHostDecision.test.vibe` |
| `sandboxMeter.vibe:40`, `meter-overflow` | `test/sandboxMeterEdges.coverage.test.vibe`: a full ledger with a running sandbox |
| `sandboxHost.vibe:52`, `:55`, `failureReason` | `test/sandboxHost.coverage.test.vibe`: an untagged failure, a non-object and a non-string tag log `defect` |
| `sandboxMock.vibe:60`, `:63` | `test/sandboxKernelEdges.coverage.test.vibe`: a machine that never started holds no lease and runs no command |

Named, not closed (unit):

| Site | Reason |
| --- | --- |
| `issuesViewDecision.vibe:76`, `digits("")` | `compactAge`, its only caller, passes a string of length 1 or more. Closes with `//@ requires text.length > 0` on `digits` and the line deleted, which changes another lane's proof. |
| `worker/mainLogDecision.vibe:73`, `at === undefined` | The inner loop pops every top that `bySha` lacks, so `at` is always defined. The arm only satisfies the type; the proof module owns it. |
| `MockFactory.vibe:114`, `:122` | Unchanged from session 22. |
| `issueGraphDecision.vibe`, `core/replayDecision.vibe` | Proof helpers that the fuzz suite also calls as oracles (`fuzz/core-issue-graph.node.fuzz.vibe`, `fuzz/conversation.fuzz.vibe`). VIP-43 specifies `spec function`, but no VibeLang compiler parses it yet (session 24: 0.0.12 and effectscript `0363c8ab8e` reject it with TS1434; `~/vl/vibelang-bugs/spec-only-function/`). Once one does, making these spec functions would still break the fuzz suite's oracles, which belong to `vl-fuzzpkg`. |
| `core/flows.vibe:343`, `history/tools.vibe:93` (VL-37) | Unchanged. |

Browser gate on this session's first change (box playwright): 423 passed, 9 failed (the fixture above), 12 skipped.
101 of 123 files below 100%. Lines 4591/5549, branches 4412/6341, functions 1985/2356, statements 5475/7068.

### Required counters, refused writes and empty lists in the browser (session 24, 2026-11-11)

Both gates ran on `main` `fcb8e086` before this change and on this change, in the same boxes (unit: node26; browser:
playwright, 4 vCPU, 3 workers).

| Gate | Checks | Files below 100% | Lines | Branches | Functions | Statements |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Unit, main → this change | 2,516 → 2,519 passed; workerd 86 | 8/202 → 7/202 | 8815/8832 → 8815/8832 | 9113/9145 → 9084/9115 | 3380/3396 → 3380/3396 | 11186/11206 → 11187/11206 |
| Browser, main → this change | 428 passed, 4 failed → 477 passed, 0 failed (12 opt-in skips each) | 101/123 → 101/123 | 4606/5550 → 4618/5550 | 4430/6337 → 4487/6307 | 1989/2356 → 1995/2356 | 5496/7068 → 5522/7068 |

| `src/web` file (browser) | Branches, main → this change |
| --- | ---: |
| `main.vibe` | 628/750 → 614/722 |
| `issuesView.vibe` | 245/285 → 258/285 |
| `issuesViewDecision.vibe` | 163/198 → 182/198 |
| `viewDecision.vibe` | 122/150 → 130/150 |
| `paneDecision.vibe` | 36/48 → 42/48 |
| `screenRead.vibe` | 31/40 → 29/38 |
| `wikiView.vibe` | 77/82 → 80/82 |

**Deleted: four optional `Model` fields.** `init` always set `account`. `sandboxRequest`, `wikiSerial` and
`wikiEditRequest` stayed undefined until a scope change or a save wrote them, and every reader treated undefined as 0.
All four are now required, `init` sets the counters to 0, and 15 fallbacks (`?? 0`, `?? null`, `?? signedOut`) are gone from `main.vibe` and `screenRead.vibe`
(30 branch arms in each gate). The fallbacks disagreed: a wiki save sent `wikiEditRequest ?? 0` and its failure was
matched against `wikiEditRequest ?? null`, so a failure on a page whose counter was never written would have been
dropped. No product path reached it, because every role that may edit first changes the account, which writes the
counter. Two unit tests and two fuzz scenarios had built the deleted states by removing the fields; they now start
from the page's first request, 0. Proofs: `pnpm verify src/web/modelWrite.vibe src/web/updateDecision.vibe` (33, 17
and 13 verified) and `src/web/screenRead.vibe` (13 verified), 0 errors.

**Faults that refuse a write, as the live hosts do** (`test/support/FaultyFactory.vibe`, `e2e/runtime/entry.vibe`):

| Fault | Refuses | Journey | Credits |
| --- | --- | --- | --- |
| `issue-connect`, `issue-fork`, `issue-install` | the first issue write, before it happens | `e2e/issues.spec.ts` "a comment refused with …" | `main.vibe` 411's three texts; `issuesView` `failureAction` and `connect` |
| `wiki-forbidden`, `wiki-conflict`, `wiki-connect`, `wiki-fork`, `wiki-install` | the first wiki save | `e2e/fault-paths.spec.ts` "a save refused with …" | `paneDecision` `wikiEditErrorText`; `wikiView` 55's steps |
| `post-empty`, `post-duplicate`, `post-not-replying`, `post-full` | the first post, with that refusal | `e2e/recovery.spec.ts` "a post the sequencer refuses …" | `viewDecision` `postFailure` |
| `issue-forbidden`, `issue-closed`, `issue-no-model` | the first issue write, with that reason | `e2e/issue-paths.spec.ts` "a comment the host refuses …" | `issueDecision` `issueFailureText` (session 25) |
| `issue-assignee` | the first issue write, with `assignee`, as `worker/Issues.vibe` does for a commit to someone it cannot assign | `e2e/issue-paths.spec.ts` "a commit the host refuses for its assignee …" | `issueFailureText`'s `assignee` arm (session 31) |

A post of 8,001 characters is refused as `too-long` by the mock's real sequencer, with no fault
(`e2e/recovery.spec.ts`). New journeys without faults (`e2e/issues.spec.ts`): a search with no match and a Tasks list
with every task uncommitted (`emptyTitle`, 0 calls before); Split and Link open their dialogs; the kinds' left arrow
wraps; a key other than j, k or an arrow moves nothing; a closed issue reads Closed.

Session 25 (`e2e/issue-paths.spec.ts`, no fault unless named): each VIP step names its missing field and Back keeps the
typed fields (`issueStepError`, the `back` arm); an issue linked under itself is refused by the mock host's own tree
rule (`Choose another parent.`); with `issue-write`, a saved write that lost its answer holds New issue and Link until
Retry (`issueAction`'s `blocked` arms). The form's own submit is disabled while a write waits, so only the list's
New issue and the issue's Link reach those arms.

**A focus race in `e2e/issues.spec.ts` "Split and Link open their own dialogs …" (session 25).** It failed once in a
full browser gate and once on the host. The journey clicked All and focused `.sui-issues-link` at once; when the click
had not rendered yet, it focused the first link of the VIPs list (#45). The All list then rendered with #48 first, focus
stayed on #45 as it should, and the re-resolved `first()` pointed at #48. Reproduced 6 times in 12 runs at 6 workers
(`s25/diag1.log`, the focused element logged each time). The journey now waits for All to read checked, which renders
in the same patch as its list: 12 of 12 focused #48 (`s25/diag2.log`), and 9 of 9 passed at 3 workers at host load 182
(`s25/diag3.log`). The product was right; the test read a list it had not waited for.

**Still unreachable from a mock browser** (named, not closed):

| Site | Why |
| --- | --- |
| `view.vibe` `docsPane`, `viewDecision` `docsAddress` | Only the live model's docs tool (`worker/WikiTools.vibe`) opens a non-wiki page; the mock agent never does. Needs a recorded model reply (VL-36, `vl-record-replay`). |
| `markdown.vibe` 114–145 (tables, lists, quotes) | No scripted mock reply holds them, and the wiki pages are compiled at build time. Needs a recorded model reply, or a wiki fixture whose repository copy holds them. |
| `emptyTitle` "No VIPs in review", "No … issues" | The fixture always has an open VIP (#44, accepted) and open and closed issues. |

**`e2e/source-map.spec.ts` timed out in all three projects on `main`** (120 s). Its `measure` call compiled the
whole app project to seed three fixture sources: 36 s alone on a box, more than 120 s under the gate's load. `measure`
takes the compiling project as a parameter (the gate's reporter keeps the app's), and the spec passes
`e2e/coverage-fixtures/tsconfig.json`, which extends the app's options and includes only the fixtures: 1.2 s on a box,
with the spec's assertions unchanged.

**`e2e/live-issues.spec.ts` "a VIP whose save was lost…" failed once** on `main` (dark): after Retry, the address
kept its resume keys at the 5 s default. The address clears once the Worker's write settles and never returns, so the
three such waits are bounded by 20 s.

**Unit:** `sandboxMeter.vibe:40` read uncovered again because `main` moved the overflow guard to line 37; line 40 is
now the stored next-month bucket's domain check, and `test/sandboxMeterEdges.coverage.test.vibe` refuses a negative,
fractional and unsafe bucket. The seven files left are named above (session 23) and below.

**Correction.** Session 23 wrote that VibeLang has `spec function`. VIP-43 specifies it, but no compiler parses it
(0.0.12 and effectscript `0363c8ab8e` reject it with TS1434); `~/vl/vibelang-bugs/spec-only-function/` records it.

### Two unit waits that timed out under load (session 24, 2026-11-11)

vl-proveall2's node26 run (job `fd1974b6`, 2026-11-11) had two `vi.waitFor` timeouts that passed on rerun. Both are
fixed in the test; neither is a product bug.

| Test | What it waited on | Why it timed out | Fix |
| --- | --- | --- | --- |
| `test/historyStartup.test.vibe` "?agent=live forgets a stored mock choice and asks the server" | The page `pending` while its health probe was in flight. The probe failed at once and the page then fell back to `mock`, so the state it polled for ended on its own. | The run failed with `expected 'mock' not to be 'mock'`: the page had already fallen back before a poll saw `pending`. A trace on nyc-01 put the probe at 611 ms and the fallback at 4,262 ms; a loaded host can miss that window. | The test holds health with `test/support/heldHealth.vibe` and its deadline clock. The page stays `pending` until the test answers, then the answer `mock` is asserted, with exactly one probe. Removing the storage clear in `historyStartup.vibe` fails it. |
| `test/scroll.runtime.test.vibe` "ArrowUp, intent-first" | The runtime's first animation-frame request (`host.pending() > 0`). | A requested frame stays until the test runs it, so the state cannot be missed, only reached late. The first render took longer than `vi.waitFor`'s 1 s default. | Every wait in the file is bounded by 20 s, inside the 30 s test budget. |

### A browser journey that timed out under load (session 30, 2026-11-13)

The full browser gate on main `c79e7386908a` (box `d22703165ac0c4bbe261fa0b`) timed out once in `light`:
`e2e/core-sandbox-clock.spec.ts` "a clock the meter cannot read stops the running sandbox", at `locator.fill` on the
terminal. Not a product bug.

| What it waited on | Why it timed out | Fix |
| --- | --- | --- |
| The terminal's command box, after the sandbox read `Running`. | `fault=sandbox-clock` broke the meter's clock after the sandbox started, for the next metered call of any kind. Under load the page's sandbox status read came before the typed `pwd`, failed closed, and stopped the sandbox, so the command box never came back. | The fault breaks the clock for the first command only (`test/support/FaultyFactory.vibe` `sandboxCommand`), the call the journey types. `--repeat-each 5` in all three projects passes. |

### History fallbacks, refused sign-in, sandbox minutes, the wiki link and escape (session 22, 2026-11-11)

**History fallbacks.** Five `historyView.vibe` fallbacks are for data the history never holds. The proved `decide`
(`src/history/mythical.vibe`) trims each epic and commit title and refuses one that is then empty. It also refuses
an empty id and a fold with an empty SHA, and the Sequencer's SHAs come from git. The five are a blank epic label in
the crumb and in the plan form, a blank commit link name, and a blank SHA. This session deleted them, but on rebase
`main` had moved them into proved helpers (`historyViewDecision.vibe` `orFallback` and the commit link name, another
lane's work). They are kept as that lane wrote them, and the unit scenes that reach their fallback arms stay. In the
browser their blank arms stay uncovered; session 23 moved `decide`'s guarantee into the outline's schema and deleted them.
`fuzz/issues-node-fake.vibe` now answers matching refs sorted by name, as GitHub does. The new recording made the
conformance test (`test/fakeConformance.test.vibe`) fail first: the fake had answered in creation order.

The four reachable fallbacks are now credited in Chromium:

| Site | When it happens | Journey |
| --- | --- | --- |
| `historyView.vibe:111`, no folded-through mark | A read between the first fold's `EpicOpened` and its `Folded`: the Sequencer writes three events | fault `unfolded` (`test/support/FaultyMythical.vibe`), `e2e/history-faults.spec.ts` |
| `historyView.vibe:191`, `:251`, an epic missing from the outline | A search or commit page newer than the outline, here because the outline read after a plan failed | `e2e/history-faults.spec.ts` "a commit newer than the outline…" |
| `historyView.vibe:365`, the plan target unknown | The page went back while the plan dialog stayed open (`navigatedFrame` keeps the dialog) | `e2e/history-paths.spec.ts` "an open plan keeps naming its commit…" |
| `historyView.vibe:59`, a failed commit read (unit gate) | The commit read failed | unit scene |

**Live sign-in refused.** The live workerd host (`test/workerd/live-issues.vibe`) now answers
`/__fault?session=unavailable` with the session route of a deployment that has no sign-in: the production
`Accounts.disabled()`. `e2e/live-issues.spec.ts` "a deployment without sign-in…" reaches `clickedSignIn`'s refused arm.

**Sandbox minutes.** Faults `sandbox-low` and `sandbox-out` (`test/support/FaultyFactory.vibe`) run the sandbox meter
on a faulty `Clock`. It starts on the 15th of the current month (UTC), so the jump never crosses a reset. When the
first sandbox starts, it jumps to five minutes before the allowance runs out, or to one minute past it.
`e2e/sandboxes.spec.ts` checks "5 minutes left" and "Out of minutes — <id> stopped" (`sandboxLowMinutes`,
`sandboxOutOfMinutes`).

**Wiki link.** The fixture page (`test/support/wikiWorld.vibe` `SOURCE`) now links to the roadmap. `wiki.json` was
recorded again against `codeplanesmithers/smithers-vibelang-e2e` (0032; label `wiki-1794437464295`, 100 exchanges,
135 KB). The old recording failed first with `UnrecordedRequestError`. Afterwards the test repository had no open pull
request and no branch from the run. vl-bench's `bench/wiki-delegated.bench.vibe` replays the new recording and its
description names the link. `e2e/fault-paths.spec.ts` checks that the link resolves to `/wiki/roadmap`
(`wikiView.vibe:88`).

**Unit gaps from another lane's refactor.** `runEscape` (`main.vibe`) now runs the proved `escapeWrite` for every
kind. The proof shows it returns the Model unchanged for a tour, the palette and the splash, whose own steps then run,
so those three arms are live. `escapeWritesIssues` and `screenKept` are proof-only. They are tested against the code
they specify (`test/modelWrite.test.vibe`), as earlier specification functions are, because VibeLang has no
specification-only function (`~/vl/vibelang-bugs/spec-only-function`). `historyStartup.vibe:71`: a grant to someone
else leaves the person's role. That test failed with the person filter removed: Expected contributor, Received
community.

Named, not closed:

| Site | Reason | Closes with |
| --- | --- | --- |
| `historyStartup.vibe:69`, `identity.ledger?.seq ?? 0` | Both Accounts (worker and mock) give every signed-in identity a ledger. `Identity.ledger` is optional only because a viewer has none. | Closed in session 23: `Accounts.current()` answers `Session`, whose signed-in member requires the ledger |
| `modelDecision.vibe` `slashHighlight` empty, `actionsFailureApplies` no epoch | Unchanged from session 21 | Unchanged |
| `src/history/flows.vibe:213` (V8), `src/history/tools.vibe:93` (VL-37) | Unchanged | Unchanged |

Measurements on this session's tree (unit: box node26 job `c70505ea…`; browser: box playwright). The unit run had
two failing tests, both fixed after it (the fake's ref order, and a scene test of a deleted fallback, restored with
the fallback on rebase):

| Gate | Files below 100% | Lines | Branches | Functions | Statements |
| ---: | ---: | ---: | ---: | ---: | ---: |
| Unit, session 21 → 22 | 14/196 → 12/196 | 8596/8619 → 8617/8634 | 8895/8940 → 8881/8919 | 3253/3271 → 3271/3287 | 10928/10954 → 10950/10970 |
| Browser, session 21 → 22 | 95/117 → 94/117 | 4235/5339 → 4425/5354 | 4112/6134 → 4231/6113 | 1811/2231 → 1884/2247 | 5063/6817 → 5286/6833 |

Browser checks: 432 passed, 12 opt-in skips, 0 unexpected. `historyView.vibe` read 100% in the browser before the
rebase onto the proved helpers above. The unit
files still below 100% are `MockFactory`, `core/flows`, `issueGraphDecision` and `replayDecision` (proof-only),
`issueHostDecision`, `sandboxHost`, `sandboxMeter`, `sandboxMock`, `history/tools` (VL-37), `historyStartup` (`:69`,
above), `view` and `worker/mainLogDecision`. `modelWrite` reaches 100%.

### Browser coverage across navigations, and People over a maximized pane (session 21, 2026-11-11)

Both full gates, each on a box over this session's tree before its history journey. `pnpm test:coverage`
(`--image node26`): typecheck 0; 296 files and 2,428 tests passed (1 expected fail, 5 skipped); the workerd suite
passed 20 files and 83 tests; exit 1 on thresholds only. `pnpm e2e:coverage` (`--image playwright`, three projects):
`failedTests` empty, every check with evidence; exit 1 on thresholds only.

| Gate | Files below 100% | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unit (Node + workerd), session 20 → 21 | 13/195 → 14/196 | 8544/8562 → 8596/8619 | 8872/8910 → 8895/8940 | 3222/3239 → 3253/3271 | 10873/10894 → 10928/10954 |
| Browser, session 20 → 21 | 94/116 → 95/117 | 4163/5290 → 4235/5339 | 4025/6110 → 4112/6134 | 1768/2198 → 1811/2231 | 4963/6764 → 5063/6817 |

Denominators moved with other lanes' work (`modelWrite.vibe` and `screenRead.vibe` are new; `historyStartup.vibe`
grew), so the percentages are not a controlled delta. The unit gate's new gaps are those two lanes' files:
`modelWrite.vibe` (6 lines, 2 functions, 5 branches) and `historyStartup.vibe` (2 branches). `main.vibe` reaches 100%
in the unit gate: session 20's follow-reconnection regression closes line 1127. Per-file browser rows for `src/web`
are in `~/vl/vl-coverage-evidence/s21/browser-web-table.md`.

**Measurement defect, fixed.** Chromium's RenderDocument feature gives each cross-document navigation a new frame,
and V8 drops the old document's coverage with it. `page.coverage.stopJSCoverage()` returned each chunk once, for the
last document, so every journey that loads two documents (two `page.goto` calls, a reload, a full-load link, sign-in)
under-credited the browser gate. Evidence: `e2e/history.spec.ts` "shows a viewer no action, and a contributor no
retelling" passes, yet `historyView.vibe:38`'s viewer arm read 0; a viewer-only test reads it 1. With
`BackForwardCache` or `ProactivelySwapBrowsingInstance` disabled alone the test still returned 13 script entries; with
`RenderDocument` disabled alone it returned 26, two per chunk. `playwright.config.ts` now launches Chromium with
`--disable-features=RenderDocument`. Regression: `e2e/coverage-navigation.spec.ts` (red: each chunk reported once;
green: twice). Browser tables before session 21 undercount for this reason.

**Product bug, fixed.** With the wiki, docs or People maximized, the open Account menu rendered under the pane. The
header `.vl-top` (sticky, `z-index: 30`) is the menu's stacking context and maximized panes sit at 45, so the pane's
heading took the click on People. The header now stacks at 46, under the palette (50). Regression: `e2e/roles.spec.ts`
"People opened over a maximized wiki takes its place maximized" (red: the click timed out; the wiki's heading
intercepted it), which also reaches `peopleOpened`'s maximized arm.

**Dead code deleted.** `selectedRun`'s unknown-run arm. Both run pickers (`actionView.vibe`) render from
`actions.runs`, and `mergeRuns` never removes a run, so a picked run is always known. `SelectedRun` now carries the
run's flow, and `main.vibe`'s lookup and `selectedRun`'s `known` parameter are gone. The unit test checks a pick made
while another flow is selected; the fuzz drivers send only shown runs; mutation `run-unknown` is removed and
`run-selected` and `run-id` follow the new source.

**New fault.** `fault=roles-gap` (`test/support/FaultyFactory.vibe`) loses the role event of the first grant. The next
grant shows the gap, the page replays the ledger, and both people show their new roles (`e2e/roles.spec.ts`). It
reaches `roleReceived`'s gap arm and `ReceivedRole`'s replay.

**New journey.** `e2e/history-paths.spec.ts` "a maintainer exports, files evidence and a superseded note, and plans
before a commit": the Exported badge, a key that is neither Enter nor Space on an epic header and then Space, the
Evidence and Superseded note sections, and the plan dialog's "Before" (`historyView.vibe` 114, 170, 320, 364).

Browser gaps named this session, with what closes each:

| Site | Reason | Closes with |
| --- | --- | --- |
| `modelDecision.vibe` `slashHighlight`, `length === 0` | The view sends `MovedSlash` only while completions exist (`view.vibe:288`). The arm guards a menu that shrinks between the key and the update. | Nothing in a browser; the unit gate covers it. |
| `modelDecision.vibe` `actionsFailureApplies`, `current === null` | An actions command carries an epoch only when the page holds one, and the page never clears it. | A non-optional epoch in `ActionsState`, which removes this arm and `actionsEpochCurrent`'s. |
| `modelDecision.vibe` `clickedSignIn` refused, `signInRefused`'s live operand | The fault page starts in mock mode and never sends `LoadAccount`, so no unavailable identity loads. | A live host whose session route is `worker/Accounts.vibe`'s `disabled()`. |
| `modelDecision.vibe` `sandboxLowMinutes`, `sandboxOutOfMinutes` | The mock meter counts real minutes against a role's allowance. | A faulty `Clock` under the sandbox meter, or a seeded ledger. |
| `wikiView.vibe:88` link resolver | `toHtml` runs (session 19), but the recorded repository copy has no links. | A recording whose page links; re-recording `wiki.json` changes vl-bench's workload. |
| `historyView.vibe` 93, 111, 191, 193 (two), 251, 280, 352, 365 | Fallbacks for an empty epic title, an unfolded main, an unknown epic, an empty commit title and id, a commit with no epic, an empty SHA and a missing plan target. The bootstrapped history holds none of them. | A history fixture that holds them, or deleting each one the history schema rules out. |

### Issue recovery and agent run reads (session 20, 2026-11-11)

The browser now reaches the production issue routes on workerd SQLite over GitHub's recording, using the real
smithers.sh per-person connection (`test/support/recordedIssues.vibe`, `liveSite.vibe`, `workerd.vibe`). Each project
owns its host. A faulty IssueHost fails a write once; normal calls construct the production GitHub host. No request
is intercepted. New-issue and VIP recovery restore their saved forms and retry; a completed comment leaves its
resume address, and an unwritten refusal offers no issue retry. GitHub's initial post-create list really is stale:
refreshed reads use its later recorded observation, not a manufactured response.

Two UI regressions failed first: startup's first account answer erased a recovered retry, and a restored detail
screen never requested its comments. Startup confirmation now uses the account epoch; a subsequent sign-out or
person switch still clears the prior request. Restoring a detail screen asks the existing LoadIssueDetails command
for its notes; a late response for another selection remains ignored. The browser checks the actual comment list.

The Actions fault page binds the scripted agent to the same Actions service as its controls. The agent requests
`/tour` through the healthy service, while the page's first run read fails. Retry reloads the real run; its card and
run row then appear. A runtime unit regression also cancels a Tour through another client while the page's first
follow is lost: only the reconnected subscription can update the page to Cancelled. Tests open Actions before requesting the run so opening it cannot hide the read failure.

The wiki host's `wiki/revision` and `wiki/page/*` writes had no reader and are deleted, along with their single-use
helper. The recording test poisons old values: reads still answer GitHub and leave those values alone; only the
person's draft persists. MockFactory's ended-tour wait replays the journal before following live events, as the
worker does; this removes its redundant state guard (the reported line 367). A queued, immediately ended pair of
tours releases the next post. Strict thresholds and all unit/workerd source directories remain unchanged.

Final full-suite counts and per-file measurements follow once the session's gates finish.

### Browser journeys and measurement (session 16, 2026-11-11)

New Chromium journeys over faulty Effect services (`test/support/FaultyFactory.vibe`): `fault=accounts` fails the
first sign-in or Visit as choice, member list, grant and sign-out once each (`e2e/accounts.spec.ts`, which also
covers the lost role stream's Retry and Dismiss); `fault=live-details` runs the live screens over the mock and fails
the first issue-details read (`e2e/issue-details.spec.ts`); `e2e/actions-faults.spec.ts` drives the Actions list
failure, Retry and a Post run's typed input.

Bug found and fixed: on a phone in live mode the header (88px, two rows) covered the issues surface's own header and
back link, because only the mock-only Visit as picker set `--vl-header-height`; surfaces started at the 56px
fallback. The height now keys on the identity tools. Regression: `e2e/phone-header.spec.ts` (live failed, mock
passed, before the fix).

Full `pnpm e2e:coverage` (box, all three projects): 315 passed, 12 opt-in skips, 0 unexpected; exit 1 on thresholds
only. Before is the first run with this roster (old structure counting); after includes the structure counting from
`9fa0b210`, so totals are snapshots, not a controlled delta.

| File (lines, branches, functions, statements) | Before | After |
| --- | --- | --- |
| All 106 roster files | 3721/4947, 3713/5891, 1537/2023, 4317/6261 | 3930/5025, 3792/5875, 1649/2091, 4656/6420 |
| `src/web/main.vibe` | 606/667, 589/823, 305/369, 747/884 | 637/663, 620/823, 362/402, 789/877 |
| `src/web/modelDecision.vibe` | 52/78, 73/112, 37/51, 59/95 | 74/76, 95/112, 51/51, 89/93 |
| `src/web/issueDecision.vibe` | 79/91, 173/257, 16/22, 99/142 | 80/90, 173/257, 17/22, 100/141 |
| `src/web/historyView.vibe` | 64/73, 116/145, 40/43, 70/82 | 67/72, 116/145, 40/43, 73/81 |
| `src/web/wikiView.vibe` | 27/27, 82/96, 17/19, 33/38 | 27/27, 82/96, 17/19, 36/38 |

Files below 100%: 91 of 105, then 89 of 106. The history page has no fault host yet, so its failed, empty and
refused states (`historyView.vibe` 48–59, 206–211) are the next journeys.

### History, tour and navigation journeys (session 17, 2026-11-11)

The history page has a fault host: `e2e/history-runtime/` runs the real page (`historyMain`, whose `around` parameter
wraps its history service) over `test/support/FaultyMythical.vibe`. Each fault `?fault=` names happens once: `outline`
(the first load), `empty` (no epics), `reads` (the first epic, commit and search read, and the first outline read after
the load), `events` (the first event stream) and `writes` (the first plan, start, note, approve and fold).
`e2e/history-faults.spec.ts` and `e2e/history-paths.spec.ts` drive them, plus a refused plan, a new epic and the epic
page. `e2e/chat-paths.spec.ts` covers lost tour events, a resize during the tour, a modifier-click on a wiki link and
live sign-in.

Bugs found and fixed, each with a check that failed first:

| Bug | Fix | Regression |
| --- | --- | --- |
| A lost history event stream ended following for good; the page's own Start left the badge at "planned". | The subscription follows again 2 seconds later; `FailedEvents` had no sender left and is deleted. | `history-faults.spec.ts` |
| A failed commit read left the page on a skeleton with no alert. | The page shows the failure and the History crumb. | `history-faults.spec.ts` |
| A lost tour event stream stalled the tour (Skip stayed at step 1) and labeled it "Send failed" in a hidden composer. | The tour's subscription follows again 2 seconds later. | `chat-paths.spec.ts`, `mainRuntime.coverage.test.vibe` |
| A check that leaves the app with a full load lost its Chromium evidence ("Missing executed source"). | A local run reads such chunks from the build it served. | `chat-paths.spec.ts` live sign-in |
| The auth broker setup gave the host 120 s; a loaded host needs 195 s, so focused runs failed before any test. | It uses `E2E_SERVER_SECONDS` (default 600), like the web server. | Focused runs on nyc-01 |

A focused Chromium run of the three history specs (dark project, before the commit-read fix) reached 81/81
statements and 43/43 functions in `historyView.vibe` (session 16: 73/81, 40/43); `historyApp.vibe` went from 181/217
statements and 84/105 functions to 201/218 and 101/105. A full `pnpm e2e:coverage` after these commits is the next
measurement.

### Measurement, wiki edit, run step, mode and tour control journeys (session 18, 2026-11-11)

Full `pnpm e2e:coverage` with the scoped roster, on main `2ed14ecf` plus session 17's range (box, all three
projects): 351 passed, 12 opt-in skips, 0 unexpected, every check with evidence; exit 1 on thresholds only.

| File (lines, branches, functions, statements) | Session 16 | Session 18 |
| --- | --- | --- |
| All roster files | 3930/5025, 3792/5875, 1649/2091, 4656/6420 (106 files) | 4019/5075, 3889/5937, 1704/2115, 4775/6481 (109 files) |
| `src/web/main.vibe` | 637/663, 620/823, 362/402, 789/877 | 641/667, 618/815, 366/403, 797/878 |
| `src/web/historyView.vibe` | 67/72, 116/145, 40/43, 73/81 | 72/72, 130/147, 43/43, 81/81 |
| `src/web/historyApp.vibe` | not listed | 156/164, 45/54, 103/105, 204/218 |
| `src/web/modelDecision.vibe` | 74/76, 95/112, 51/51, 89/93 | 74/76, 95/112, 51/51, 89/93 |

Files below 100%: 89 of 109. New journeys after that run, each checked against the targeted lines in a focused run:

| Journey | Reaches in `main.vibe` |
| --- | --- |
| `e2e/edit-paths.spec.ts`: saving an unchanged page, then Cancel | `CanceledWikiEdit`, the `no-changes` submit arm |
| `e2e/edit-paths.spec.ts`: choosing each step of a run's trace | `SelectedActionStep` |
| `e2e/edit-paths.spec.ts`: typing `/live`, and picking Live mode from the slash menu | `switchMode`, the `mode` submit kind, `PickedSlash` for `mode/`, `SwitchMode` |
| `e2e/fault-paths.spec.ts` over `fault=wiki-edit` (the first save fails, unwritten) | `FailedWikiEdit` and its retry |
| `e2e/fault-paths.spec.ts` over `fault=tour-control` (the first pause, resume or seek fails) | `FailedTourEvents` |

Bug found and fixed, with a check that failed first: a pause, resume or seek the server refused set the tour's error
to "Connection lost", which only the composer showed, as "Send failed", and the composer is hidden during the tour.
The person saw nothing and the tour kept playing. The failure is now the reason `connection`, which the proved
`postFailure` maps to "Connection lost"; the walkthrough bar shows the tour's failure as an alert, and the next
control clears it. Regression: `e2e/fault-paths.spec.ts` (red: no "Connection lost" on the page),
`test/mainUpdate.coverage.test.vibe`, `test/app.scene.test.vibe`; `pnpm verify src/web/viewDecision.vibe` and its 49
mutations pass.

`switchMode`'s `switchesMode` guard narrows a slash entry's name to the `mock | live` literals `SwitchMode` takes. No
browser reaches its false arm: typed text reaches it only as `/mock` or `/live`, and the slash menu registers only
`mode/mock` and `mode/live`.

### Measurement, action failures and the wiki's repository copy (session 19, 2026-11-11)

Both full gates on main `0e4de0ea`, each on a box. `pnpm test:coverage` (`--image node26`): 285 files and 2,340 tests
passed (1 expected fail, 5 skipped); the workerd suite passed 19 files, 82 tests; the gate exits 1 on thresholds only.
`pnpm e2e:coverage` (`--image playwright`, all three projects): 369 passed, 12 opt-in skips, 0 unexpected, every check
with evidence; exit 1 on thresholds only.

| Gate | Files below 100% | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unit (Node + workerd) | 13 of 188 | 8241/8258 (99.79%) | 8645/8684 (99.55%) | 3125/3142 (99.45%) | 10507/10529 (99.79%) |
| Browser (session 18 → 19) | 89/109 → 90/112 | 4019/5075 → 4036/5088 (79.32%) | 3889/5937 → 3918/5945 (65.90%) | 1704/2115 → 1717/2121 (80.95%) | 4775/6481 → 4801/6499 (73.87%) |

Unit gaps by owner: specification-only functions in `src/core/issueGraphDecision.vibe` and `replayDecision.vibe`
(vl-ghost-functions); `src/history/tools.vibe:93` (VL-37); `src/core/flows.vibe:343`; single arms in
`MockFactory`, the sandbox hosts,
`issueHostDecision`, `historyView`, `main.vibe:939`, `view.vibe:149` and `worker/Wiki.vibe:68`.

Correction in session 20: `core/flows.vibe:343` is a distinct current gap after a suspending conditional.
The plain-JavaScript V8 reproduction names `history/flows.vibe:213`; it does not establish the cause of the core gap.
The historical V8 defect remains named above even when merged history counters are positive.

Bugs found and fixed, each with a browser check that failed first (`e2e/actions-paths.spec.ts` over new
`FaultyActions` points `start`, `read`, `follow` and `cancel`):

| Bug | Fix |
| --- | --- |
| Every Actions failure read "Couldn't load runs" and replaced the pane body: input that isn't JSON hid the input box, and a failed start or cancel named a load. | The proved `actionFailureText` (`modelDecision.vibe`) names the input, a refusal, a failed start or cancel, else the load. Only a load failure replaces the body, with Retry. Typing and a new Cancel clear the last failure. |
| A run whose follow subscription failed stayed "Running" forever: the subscription swallowed the failure and its dependencies never changed. | A lost follow logs `action run follow lost; following again` and follows again 2 seconds later, as the tour does (session 17). A run's follow starts with its current state, so nothing is missed. |

The wiki's `toHtml` runs in Chromium. A mock-mode save never changes a page's source, so the build's rendering was
the only one a mock browser saw. `mockFactoryFor` now takes the fixture repository its wiki starts from, and the fault
host's `wiki-repository` seeds it with the Benchmarks page GitHub answered in `test/recordings/wiki.json` (VL-36,
`test/support/recordedWiki.vibe`). `e2e/fault-paths.spec.ts` saves an edit to that page and sees the repository's copy.
`toHtml`'s default resolver had no production caller (`wikiView` and `scripts/wiki.vibe` pass one), so it is deleted
rather than tested; that also removes `markdown.vibe:174`, one of the two lines vl-bench saw dropped.

`wikiLinks.vibe:14` (vl-bench's merge finding) is not a merge defect. The unit gate counts the line alone (1), with
`wikiProcess` (3) and together (4); under `bench/coverage.config.ts`, `src-edges` alone and with the five other
benchmark files that reach wiki links both count it (2). vl-bench's map at `2d7bb99a` reads the `if` at line 13
evaluated 3 times with arms [1, 0] and line 14 at 0. A full `bench:coverage` of main `0e4de0ea` in which
`src-edges` failed all 5 tests (a box with the wrong Node) reproduces exactly those counts: they are a run where
`src-edges` did not execute, and the other 3 evaluations come from the wiki script. `coverageUnion.ts` is unchanged.

Not reached yet: `ReadAction`'s failure arm (`main.vibe`, an agent-requested run whose read fails). A journey that
posts "Run /tour" on the actions fault host never ran it, so that host's agent doesn't request runs; it needs the
main fault host's scripted agent.

## Landed behavior

The new tests exercise sequencer replay, ordering and reply attempts; real loopback HTTP and product mock flows;
HTTP byte/name/cursor/schema boundaries; faulty Effect transports and protocol responses; subscription cancellation;
budget limits, repeated charges and rounding; model configuration and agent projections; history reads, planning,
work, notes, approval and folding; shared browser-backend selection, timeout and cancellation; viewport input; and
chunk boundaries. The Alchemy stack is tested as a real resource graph in dev, production and custom-domain modes,
with its selected state adapters resolved without initializing or deploying their providers.

Two product bugs found by this lane already landed with regressions (0014): ending a tour did not restore composer
focus, and a tour accepted between choosing a post and starting its reply could permanently lose the accepted
post's answer. That reply now drives the accepted tour as a durable child and uses the engine's retry policy before
starting the same reply, retaining oldest-post ordering and natural tour completion. The contended start has an
outcome-only log/counter and a reply span; no user content is logged.

Later dead code removed (2026-11-09): in `src/web/main.vibe`, the `?? 0` epoch defaults when an account or role change loads actions (the new epoch is always a number) and the `?? ""` wikiAfter default (reached only when no entry matches an undefined id).

Dead code removed: the unused custom chunk-size parameter (every product caller uses 24), and the markdown capture's
unreachable undefined fallback (the regular expression always captures a string, including an empty string).

## Coverage prototype and tool list

The prototype uses the monorepo's patched `@vitest/coverage-v8` **5.0.0**, matching Vitest **5.0.0**, and existing
`ast-v8-to-istanbul` **1.0.5** for Chromium conversion. No new runtime dependency is proposed. Declaring those test
tools in this app awaits Will's **VL-5 approval**. The prepared PACKAGE targets and scripts enforce all four 100%
thresholds per file, include all of `src/`, `worker/`, `scripts/` and `infra/`, and currently fail. Configuring the
thresholds is not evidence of achieving them.

The compiler/Vite maps preserve `.vibe` names and lines in the unbundled Vitest path. A negative control observes an
unvisited Effect return at its original fixture line 4 and a threshold-only child exit 1 despite a passing assertion.
Emitted CLI/MCP processes retain maps and inline source text. The prototype browser suite uses Playwright's built-in
`page.coverage` without a new browser dependency, retains raw Chromium evidence, and checks map source content
against the checkout. Its full-source zero seed retains tree-shaken exports and entirely unvisited files. The
denominator is the local e2e build's structure for the code that build contains and that seed for the rest; Chromium's
evidence credits it by source start (see "Chromium merge" and "Build structure" below). Vite's
generated module/preload helpers and pure re-export facades contain no app source; no production `.vibe` is excluded.

## Measurement blockers

**Bundled line and statement coverage is not yet trustworthy.** The real Chromium negative control returns 7 from
`answer(true)` but credits the unexecuted `return 9` source line after Vite minification combines two returns into
one conditional return. The unused export stays uncovered. The unbundled compiler map and real V8 execution agree;
the post-bundle statement granularity changes in `ast-v8-to-istanbul`. Branch arms retain `[1, 0]`.
`~/vl/vibelang-bugs/coverage-source-ranges/` on nyc-01 contains the minimal fixture, reproduction, both real executions
and ranges, maps and observed statement positions. The e2e build is now unminified, so the Chromium control
observes line 4 uncovered and its expected-failure marker is gone; the minified case stays a regression in
`test/browserCoverageMerge.test.vibe`, which still sees line 4 credited. No build/compiler behavior
was changed as a workaround. Will's decision is required before the upstream change; a fix must have a regression
and land through VibeLang's merge queue.

**A second cause: Rolldown drops statement-start segments.** Unminified, Vite 8.3.4's bundler (Rolldown 1.2.x)
prints no source-map segment at the start of an arrow-function or parenthesized initializer
(`const position = () => ...`, `const next = (serial ?? 0) + 1`), drops redundant parentheses
(`(a || b) ? x : y` prints `a || b ? x : y`) and wraps dynamic imports in `__vitePreload`. `ast-v8-to-istanbul` then
starts those statements at the declared name, so the bundle's start differs from the compiler's (`19:19` becomes
`19:8`). VibeLang's own map has the exact segment; plain JavaScript with no VibeLang compiler loses the same starts
(source `1:19 2:19 3:17` become `1:13 2:8 3:8`). On main `02b22822`, 38 lines in `src/` had no statement start the
bundle reproduces, so Chromium could never credit them. Reproduction: `~/vl/vibelang-bugs/coverage-source-ranges/rolldown-segments/` on nyc-01 (`node
control.mjs`, `README.txt`, `app-diagnostic.json`). No map change in VibeLang adds a segment Rolldown never prints, so
the reporter now takes the build's structure ("Build structure" below). An upstream Rolldown report is the lead's to
take to Will.

V8 precise coverage cannot be enabled on the installed workerd **1.20261019.1** inspector, directly or through
Miniflare: workerd's own CDP dispatch consumes `Profiler.enable` to create its CPU profiler and never forwards it to
V8's Profiler agent (`src/workerd/io/worker.c++`, case `PROFILER_ENABLE`, tag `v1.20261019.1`), so
`Profiler.startPreciseCoverage` reports `Profiler is not enabled`. That is workerd's design, not this app's defect,
and it no longer blocks any gate: `pnpm test:coverage`, `pnpm test:workerd:coverage` and `pnpm fuzz:coverage` measure
inside workerd with Istanbul counters ("Coverage inside workerd" and "Unit and fuzz gates inside workerd" below). No
gate waits for workerd's precise coverage or for VibeLang 0.0.13. `pnpm test:workerd --coverage` enables the counters
and merged gate automatically; `pnpm test:workerd:coverage` is its alias. A bare `vitest run --coverage` measures Node only. Two real-model tests remain opt-in without an authorized
configured model credential.

A script run in a child process is credited only when the child runs compiler-emitted JavaScript. Vitest 5.0.0
cannot read what a custom loader such as `vibelang/register` executed: `transformFile` (vitest
`dist/chunks/index.B89dZ0-N.js`, its own `TODO` says "custom --import=module.registerHooks need to be transformed as
well somehow") strips types from `.ts` and reads every other extension raw, so a subprocess `.vibe` reaches the
provider as VibeLang source and is dropped on a parse error. That is Vitest's limit, not VibeLang's: the loader runs
the program correctly. `scripts/fuzz-preflight.vibe` therefore builds into `dist-scripts/` like
`scripts/agent-context.vibe` (`tsconfig.scripts.json`), `pnpm fuzz` runs `dist-scripts/fuzz-preflight.js`, and
`test/fuzzPreflight.test.vibe` runs that same file: 0/16 lines before, 16/16 lines, 4/4 branches, 3/3 functions and
18/18 statements after (2026-11-10, focused run). New process-boundary tests run the emitted script, never
`node --import=vibelang/register` on a measured source. Reproductions: `~/vl/vibelang-bugs/coverage-native-loader/`
and `coverage-register-subprocess/`.

VibeLang 0.0.12 also loses service-Shape methods on object spread (TS2741, compiler exit 2). Minimal reproduction and
the blocked reply-recovery decorator test are under `~/vl/vibelang-bugs/service-shape-spread/`. No workaround or
compiler behavior change was made; Will's approval for upstream work is pending.

## Measurements

The lane report `~/vl/vl-coverage.REPORT.md` and evidence directory `~/vl/vl-coverage-evidence/` on nyc-01 retain exact
per-file before/after tables, covered/executable counts, original uncovered lines, commands and exits. Totals change
as other lanes land history and proof modules. Browser line/statement figures are diagnostic only; workerd figures
refer to Node clients only. The per-file snapshot below records the measured revisions; it is not a 100% claim.

<!-- measurements:start -->
Snapshot provenance: all three suites at `9861d6f26e36` (2026-11-09), each table showing the previous snapshot (unit `af56fa418a48`, workerd and Chromium `efb00d0f5854`) → this one. Passing ordinary tests do not change these frozen measurements.

Percentages show **previous snapshot → this snapshot**, independently for each suite. A dash means the file was absent from that
snapshot's source roster, not excluded. CSV retains every covered/executable count. The initial unit snapshot has 38
files and one timing-related assertion failure; the refreshed snapshots have 90 runtime files. Workerd and browser had no original
pre-work baseline: their before columns are the first retained earlier instrumented snapshots, already during the
lane's work. Different source rosters and the corrected provider mean these are snapshots, not a controlled delta.
Workerd values count Node execution only. All Chromium values remain diagnostic pending the bundled source-range
fix; even an unexecuted source return can receive a false statement hit. No production file is excluded.

## Unit

Previous snapshot: lines 77.51% (3133/4042), branches 75.2% (2509/3336), functions 68.19% (995/1459), statements 73.72% (3727/5055).

At `9861d6f26e36` less its last two issuesView scene cases (the run just before them; 1548 passed, 3 skipped): lines 90.88% (6592/7253), branches 88.32% (7006/7932), functions 87.78% (2378/2709), statements 88.9% (8318/9356).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | 0% → 100% | 100% → 100% | 100% → 100% | 0% → 100% |
| `infra/Stack.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `infra/WorkerBuild.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `scripts/agent-context.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `scripts/mythical-seed.vibe` | 100% → 100% | 94.44% → 94.44% | 93.75% → 93.75% | 96.92% → 96.92% |
| `scripts/wiki.vibe` | — → 100% | — → 92.85% | — → 100% | — → 100% |
| `src/actions/Actions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/LiveActions.vibe` | — → 100% | — → 95.23% | — → 96% | — → 98.14% |
| `src/actions/MockActions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/agent.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/catalog.vibe` | — → 100% | — → 97.5% | — → 100% | — → 100% |
| `src/actions/execution.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/tools.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/wire.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/assets/wiki.generated.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/Factory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/IssuesFactory.vibe` | 92.3% → 97.36% | 76.76% → 86.06% | 100% → 100% | 81.81% → 90% |
| `src/core/LiveAccounts.vibe` | 28% → 96.15% | 0% → 91.66% | 8.33% → 92.3% | 22.58% → 93.75% |
| `src/core/LiveFactory.vibe` | 70% → 100% | 40% → 83.33% | 94.44% → 100% | 67.07% → 94.38% |
| `src/core/LiveIssues.vibe` | — → 100% | — → 100% | — → 85.71% | — → 93.75% |
| `src/core/LiveWiki.vibe` | — → 33.33% | — → 0% | — → 30% | — → 28.57% |
| `src/core/MockAccounts.vibe` | 98.52% → 98.7% | 86.66% → 88.23% | 91.66% → 92.3% | 95.6% → 96.07% |
| `src/core/MockFactory.vibe` | 97% → 98.06% | 84.72% → 95.74% | 96.42% → 100% | 95.16% → 97.45% |
| `src/core/MockJournal.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/VipWriter.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/WikiFactory.vibe` | — → 98.46% | — → 90.27% | — → 100% | — → 94.31% |
| `src/core/WikiWriter.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/accountCookieDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/accountCookies.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/conversation.vibe` | 98.07% → 100% | 91.75% → 100% | 95.65% → 100% | 96.46% → 100% |
| `src/core/decide.vibe` | — → 100% | — → 96.26% | — → 100% | — → 97.7% |
| `src/core/flowDecision.vibe` | 90.9% → 100% | 94.11% → 100% | 100% → 100% | 91.66% → 100% |
| `src/core/flows.vibe` | 90.62% → 91.51% | 95.34% → 93.58% | 71.87% → 68.18% | 90.26% → 90.95% |
| `src/core/identityDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/issueFlows.vibe` | 90.62% → 100% | 100% → 100% | 88.88% → 100% | 91.89% → 100% |
| `src/core/issueSchemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockReplies.vibe` | 100% → 100% | 75% → 75% | 83.33% → 83.33% | 95.83% → 95.65% |
| `src/core/protocolDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/roles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sandboxDecision.vibe` | 96.36% → 96.36% | 84.72% → 87.5% | 93.33% → 93.33% | 86.84% → 89.47% |
| `src/core/sandboxHost.vibe` | 85.39% → 100% | 78.72% → 100% | 96.29% → 100% | 80.09% → 100% |
| `src/core/sandboxMeter.vibe` | 100% → 100% | 94.28% → 94.28% | 100% → 100% | 94.59% → 94.87% |
| `src/core/sandboxMock.vibe` | 100% → 100% | 62.22% → 71.11% | 91.3% → 95.65% | 91.66% → 95.83% |
| `src/core/sandboxPolicy.vibe` | 100% → 100% | 100% → 100% | 66.66% → 66.66% | 75% → 75% |
| `src/core/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sequenceDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/specification.vibe` | — → 100% | — → 79.62% | — → 100% | — → 90.9% |
| `src/core/tourStops.vibe` | 100% → — | 100% → — | 100% → — | 100% → — |
| `src/core/walkthroughSteps.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wiki.vibe` | — → 93.33% | — → 76.92% | — → 100% | — → 96.29% |
| `src/core/wikiDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wikiFlows.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wikiLinks.vibe` | — → 100% | — → 93.54% | — → 100% | — → 100% |
| `src/core/wikiSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/LiveMythical.vibe` | 100% → 100% | 92.3% → 83.33% | 100% → 100% | 97.72% → 95.74% |
| `src/history/MockMythical.vibe` | 100% → 100% | 100% → 100% | 96.42% → 96.42% | 97.56% → 97.67% |
| `src/history/MythicalHistory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/Sequencer.vibe` | 92.7% → 92.7% | 75% → 75% | 100% → 100% | 90.26% → 90.26% |
| `src/history/flowMachine.vibe` | 100% → 100% | 94.73% → 92.47% | 100% → 100% | 93.75% → 91.3% |
| `src/history/flows.vibe` | 89.18% → 89.47% | 80% → 77.77% | 75% → 75% | 88.63% → 88.88% |
| `src/history/mythical.vibe` | 98.49% → 95.74% | 95.76% → 94.76% | 100% → 96.55% | 94.62% → 92.3% |
| `src/history/pages.vibe` | 100% → 100% | 93.33% → 93.33% | 100% → 100% | 100% → 100% |
| `src/history/roles.vibe` | 83.33% → 100% | 100% → 100% | 0% → 100% | 83.33% → 100% |
| `src/history/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/seed.vibe` | 99.41% → 100% | 89.71% → 90.65% | 100% → 100% | 98% → 98.5% |
| `src/history/seed/vibelang.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/tools.vibe` | 96.29% → 96.29% | 93.61% → 93.61% | 88.88% → 88.88% | 97.05% → 97.05% |
| `src/history/wire.vibe` | 100% → 100% | 97.43% → 97.14% | 100% → 100% | 100% → 100% |
| `src/surfaces/backend.vibe` | 76.92% → 91.11% | 50% → 68.57% | 75% → 64.28% | 73.33% → 84.48% |
| `src/surfaces/cli-entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/cli.vibe` | 100% → 100% | 87.5% → 90% | 100% → 100% | 94.44% → 94.44% |
| `src/surfaces/commandDecision.vibe` | 100% → 100% | 84.84% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/commands.vibe` | 89.81% → 100% | 75.71% → 91.79% | 70.27% → 100% | 86.2% → 100% |
| `src/surfaces/manifest.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp-entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp.vibe` | 100% → 100% | 50% → 50% | 100% → 100% | 94.11% → 95% |
| `src/surfaces/session.vibe` | — → 93.65% | — → 70.83% | — → 81.81% | — → 86.66% |
| `src/surfaces/sessionFlow.vibe` | — → 96.55% | — → 100% | — → 90% | — → 97.14% |
| `src/surfaces/signin.vibe` | — → 98.13% | — → 90.21% | — → 61.53% | — → 89.36% |
| `src/web/actionModel.vibe` | — → 100% | — → 82.75% | — → 90% | — → 95.65% |
| `src/web/actionView.vibe` | — → 86.66% | — → 84.8% | — → 77.77% | — → 85.36% |
| `src/web/backend.vibe` | 76.92% → 100% | 100% → 100% | 57.14% → 100% | 71.73% → 100% |
| `src/web/entry.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `src/web/historyApp.vibe` | 62.58% → 100% | 73.19% → 100% | 48.48% → 100% | 57.48% → 100% |
| `src/web/historyBackend.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/historyStartup.vibe` | 100% → 100% | 100% → 91.66% | 100% → 100% | 100% → 97.36% |
| `src/web/historyView.vibe` | 85.36% → 98.63% | 80% → 91.72% | 88.37% → 97.67% | 85.71% → 98.78% |
| `src/web/issueDecision.vibe` | — → 98.87% | — → 89.24% | — → 95% | — → 99.28% |
| `src/web/issues.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/issuesView.vibe` | — → 100% | — → 99.53% | — → 100% | — → 100% |
| `src/web/main.vibe` | 72.59% → 100% | 68.96% → 99.67% | 59.41% → 100% | 63.48% → 100% |
| `src/web/markdown.vibe` | 100% → 100% | 100% → 95.78% | 100% → 100% | 100% → 99.33% |
| `src/web/media.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/modeSwitch.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/modelDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/paneDecision.vibe` | — → 100% | — → 97.61% | — → 100% | — → 95.23% |
| `src/web/roleView.vibe` | 83.33% → 83.33% | 81.25% → 83.33% | 71.42% → 71.42% | 85.18% → 85.18% |
| `src/web/sandboxView.vibe` | 94.11% → 94.11% | 91.3% → 94.56% | 83.33% → 83.33% | 94.73% → 94.73% |
| `src/web/screenDecision.vibe` | 100% → 100% | 92.95% → 100% | 100% → 100% | 94.28% → 100% |
| `src/web/startup.vibe` | 96.55% → 92% | 75% → 45.45% | 100% → 84.61% | 94.11% → 79.68% |
| `src/web/startupDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/styles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/theatre.vibe` | — → 100% | — → 80% | — → 100% | — → 94.11% |
| `src/web/theatreDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/tourDecision.vibe` | — → 100% | — → 95% | — → 100% | — → 94.73% |
| `src/web/view.vibe` | 100% → 100% | 93.79% → 82.65% | 100% → 100% | 98.38% → 98.27% |
| `src/web/viewDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/viewport.vibe` | 100% → 100% | 98.27% → 98.27% | 100% → 100% | 100% → 100% |
| `src/web/wikiView.vibe` | — → 92.85% | — → 86.81% | — → 78.94% | — → 89.74% |
| `worker/Accounts.vibe` | 14.11% → 99.62% | 12.85% → 95.61% | 11.9% → 93.54% | 13.77% → 98.37% |
| `worker/ActionDirectory.vibe` | — → 94.44% | — → 83.33% | — → 88.23% | — → 96% |
| `worker/ActionIdentity.vibe` | — → 100% | — → 95% | — → 100% | — → 100% |
| `worker/ActionRuns.vibe` | — → 97.43% | — → 87.5% | — → 94.11% | — → 93.75% |
| `worker/ActionsHttp.vibe` | — → 100% | — → 94.73% | — → 90% | — → 98.36% |
| `worker/AgentModel.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/Api.vibe` | 26.22% → 19.91% | 0% → 0% | 0% → 0% | 23.18% → 17.49% |
| `worker/Budget.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/HistoryActions.vibe` | — → 90.9% | — → 78.94% | — → 81.81% | — → 86.48% |
| `worker/HistoryObject.vibe` | 10% → 96.66% | 6.66% → 100% | 3.03% → 90.9% | 8% → 96% |
| `worker/HistoryTools.vibe` | 50% → 100% | 50% → 100% | 33.33% → 100% | 50% → 100% |
| `worker/Http.vibe` | 100% → 100% | 95.71% → 100% | 94.11% → 100% | 97.75% → 100% |
| `worker/IssueCredentials.vibe` | — → 93.75% | — → 55.55% | — → 72.72% | — → 83.33% |
| `worker/Issues.vibe` | — → 61.62% | — → 54.09% | — → 50% | — → 56.84% |
| `worker/MainLog.vibe` | 67.44% → 100% | 68.96% → 96.55% | 58.33% → 100% | 63.33% → 98.33% |
| `worker/ObjectStorage.vibe` | 10% → 90% | 0% → 83.33% | 0% → 81.81% | 7.14% → 85.71% |
| `worker/Objects.vibe` | 9.58% → 87.96% | 4% → 76.08% | 8.69% → 91.66% | 7.44% → 88.97% |
| `worker/Reply.vibe` | 59.81% → 65.44% | 61.33% → 51.85% | 58.82% → 58.82% | 59.05% → 63.46% |
| `worker/SandboxAccounts.vibe` | 10% → 100% | 2.7% → 100% | 0% → 100% | 7.69% → 100% |
| `worker/SandboxHttp.vibe` | 13.33% → 93.33% | 0% → 97.05% | 0% → 70% | 9.52% → 92.85% |
| `worker/SandboxMachine.vibe` | 1.51% → 100% | 0% → 100% | 0% → 100% | 1.05% → 100% |
| `worker/SandboxTools.vibe` | 72.72% → 72.72% | 50% → 50% | 70% → 70% | 75% → 75% |
| `worker/Sandboxes.vibe` | 0% → 100% | 0% → 100% | 0% → 100% | 0% → 100% |
| `worker/Sequencer.vibe` | 94.39% → 94.95% | 96.29% → 85.29% | 90.69% → 97.87% | 95.38% → 95.8% |
| `worker/SpecificationReviewers.vibe` | — → 32.25% | — → 25% | — → 10% | — → 26.19% |
| `worker/Tour.vibe` | 59.45% → 100% | 28.57% → 100% | 54.54% → 100% | 54.54% → 100% |
| `worker/Unreachable.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/VipDraft.vibe` | — → 73.33% | — → 60% | — → 33.33% | — → 65.85% |
| `worker/Wiki.vibe` | — → 74.34% | — → 76.52% | — → 54.9% | — → 67.42% |
| `worker/WikiDraft.vibe` | — → 43.75% | — → 14.28% | — → 22.22% | — → 36.36% |
| `worker/WikiTools.vibe` | — → 100% | — → 83.33% | — → 100% | — → 92.3% |
| `worker/accountObject.vibe` | — → 10.41% | — → 0% | — → 5.12% | — → 6.32% |
| `worker/agentContext.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/budgetDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/index.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/liveDispatchDecision.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `worker/machineObject.vibe` | — → 1.58% | — → 0% | — → 5.88% | — → 1.08% |
| `worker/replyProgressDecision.vibe` | — → 88.23% | — → 81.25% | — → 90% | — → 86.36% |
| `worker/replyReasons.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |

## Workerd — Node clients only

Previous snapshot: lines 11.7% (473/4042), branches 3.56% (119/3336), functions 4.72% (69/1459), statements 9.57% (484/5055).

At `9861d6f26e36`: lines 12.93% (938/7254), branches 4.75% (377/7934), functions 6.71% (182/2709), statements 10.6% (992/9351).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `infra/Stack.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `infra/WorkerBuild.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `scripts/agent-context.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/mythical-seed.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/actions/Actions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/LiveActions.vibe` | — → 93.02% | — → 71.42% | — → 80% | — → 83.33% |
| `src/actions/MockActions.vibe` | — → 1.75% | — → 0% | — → 5.55% | — → 1.32% |
| `src/actions/agent.vibe` | — → 36.36% | — → 100% | — → 16.66% | — → 29.41% |
| `src/actions/catalog.vibe` | — → 37.5% | — → 0% | — → 0% | — → 37.5% |
| `src/actions/execution.vibe` | — → 2.56% | — → 0% | — → 0% | — → 1.96% |
| `src/actions/tools.vibe` | — → 30.76% | — → 0% | — → 0% | — → 28.57% |
| `src/actions/wire.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/assets/wiki.generated.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/Factory.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/IssuesFactory.vibe` | 0% → 2.63% | 0% → 0.81% | 0% → 6.25% | 0% → 2% |
| `src/core/LiveAccounts.vibe` | 28% → 26.92% | 0% → 0% | 8.33% → 7.69% | 22.58% → 21.87% |
| `src/core/LiveFactory.vibe` | 62.85% → 66.23% | 23.33% → 23.33% | 61.11% → 65% | 53.65% → 57.3% |
| `src/core/LiveIssues.vibe` | — → 27.27% | — → 0% | — → 14.28% | — → 18.75% |
| `src/core/LiveWiki.vibe` | — → 26.66% | — → 0% | — → 10% | — → 19.04% |
| `src/core/MockAccounts.vibe` | 2.94% → 2.59% | 0% → 0% | 0% → 0% | 2.19% → 1.96% |
| `src/core/MockFactory.vibe` | 3.59% → 3.08% | 0% → 0% | 3.57% → 2.56% | 2.89% → 2.54% |
| `src/core/MockJournal.vibe` | — → 0% | — → 100% | — → 0% | — → 0% |
| `src/core/VipWriter.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `src/core/WikiFactory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/WikiWriter.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/accountCookieDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/accountCookies.vibe` | — → 88.88% | — → 81.81% | — → 50% | — → 66.66% |
| `src/core/conversation.vibe` | 19.23% → 39.83% | 10.99% → 33.83% | 13.04% → 39.74% | 14.48% → 31.11% |
| `src/core/decide.vibe` | — → 1.81% | — → 0% | — → 0% | — → 1.14% |
| `src/core/flowDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/flows.vibe` | 22.91% → 17.57% | 0% → 0% | 0% → 0% | 19.46% → 15.42% |
| `src/core/identityDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/issueFlows.vibe` | 0% → 31.25% | 0% → 55.55% | 0% → 22.22% | 0% → 29.72% |
| `src/core/issueSchemas.vibe` | 0% → 83.33% | 100% → 100% | 0% → 0% | 0% → 83.33% |
| `src/core/mockDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/mockReplies.vibe` | 60% → 57.89% | 0% → 0% | 16.66% → 16.66% | 54.16% → 52.17% |
| `src/core/protocolDecision.vibe` | 42.85% → 35.29% | 21.87% → 15.9% | 62.5% → 55.55% | 35% → 28% |
| `src/core/roles.vibe` | 100% → 80% | 100% → 0% | 100% → 0% | 100% → 80% |
| `src/core/sandboxDecision.vibe` | 1.81% → 1.81% | 0% → 0% | 0% → 0% | 1.31% → 1.31% |
| `src/core/sandboxHost.vibe` | 0.56% → 0.57% | 0% → 0% | 0% → 0% | 0.47% → 0.47% |
| `src/core/sandboxMeter.vibe` | 0% → 3.03% | 0% → 0% | 0% → 0% | 0% → 2.56% |
| `src/core/sandboxMock.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/sandboxPolicy.vibe` | 50% → 50% | 100% → 100% | 0% → 0% | 25% → 25% |
| `src/core/schemas.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sequenceDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/specification.vibe` | — → 18.75% | — → 0% | — → 20% | — → 13.63% |
| `src/core/tourStops.vibe` | 100% → — | 100% → — | 100% → — | 100% → — |
| `src/core/walkthroughSteps.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiFlows.vibe` | — → 31.25% | — → 47.61% | — → 22.22% | — → 29.72% |
| `src/core/wikiLinks.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 56% → 59.25% | 21.42% → 21.42% | 33.33% → 33.33% | 48.27% → 51.61% |
| `src/history/LiveMythical.vibe` | 71.79% → 73.17% | 38.46% → 41.66% | 56.25% → 56.25% | 63.63% → 63.82% |
| `src/history/MockMythical.vibe` | 2.94% → 0% | 100% → 0% | 3.57% → 0% | 2.43% → 0% |
| `src/history/MythicalHistory.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/history/Sequencer.vibe` | 2.08% → 2.08% | 0% → 0% | 0% → 0% | 1.76% → 1.76% |
| `src/history/flowMachine.vibe` | 33.33% → 21.56% | 23.68% → 12.9% | 22.22% → 13.63% | 28.12% → 17.39% |
| `src/history/flows.vibe` | 20.27% → 19.73% | 0% → 0% | 0% → 0% | 17.04% → 16.66% |
| `src/history/mythical.vibe` | 3% → 2.83% | 0% → 0% | 0% → 0% | 2.15% → 2.05% |
| `src/history/pages.vibe` | 8.33% → 8.33% | 0% → 0% | 0% → 0% | 6.52% → 6.52% |
| `src/history/roles.vibe` | 83.33% → 83.33% | 100% → 100% | 0% → 0% | 83.33% → 83.33% |
| `src/history/schemas.vibe` | 96.87% → 96.87% | 100% → 100% | 0% → 0% | 91.17% → 91.17% |
| `src/history/seed.vibe` | 9.94% → 9.94% | 0% → 0% | 0% → 0% | 8.45% → 8.45% |
| `src/history/seed/vibelang.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `src/history/tools.vibe` | 11.11% → 11.11% | 0% → 0% | 0% → 0% | 8.82% → 8.82% |
| `src/history/wire.vibe` | 51.35% → 54.28% | 10.25% → 11.42% | 20% → 20% | 40.42% → 44.18% |
| `src/surfaces/backend.vibe` | 92.3% → 62.22% | 75% → 45.71% | 50% → 35.71% | 86.66% → 51.72% |
| `src/surfaces/cli-entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/cli.vibe` | 93.75% → 93.75% | 62.5% → 70% | 83.33% → 83.33% | 88.88% → 88.88% |
| `src/surfaces/commandDecision.vibe` | 88.88% → 88.88% | 72.72% → 72.72% | 80% → 80% | 90% → 90% |
| `src/surfaces/commands.vibe` | 57.4% → 54.76% | 17.14% → 11.19% | 21.62% → 19.17% | 55.17% → 47.05% |
| `src/surfaces/manifest.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/surfaces/mcp-entry.vibe` | 0% → 100% | 100% → 100% | 0% → 100% | 0% → 100% |
| `src/surfaces/mcp.vibe` | 0% → 82.35% | 0% → 0% | 0% → 83.33% | 0% → 80% |
| `src/surfaces/session.vibe` | — → 84.12% | — → 66.66% | — → 63.63% | — → 78.66% |
| `src/surfaces/sessionFlow.vibe` | — → 96.55% | — → 100% | — → 80% | — → 94.28% |
| `src/surfaces/signin.vibe` | — → 87.96% | — → 74.46% | — → 50% | — → 74.64% |
| `src/web/actionModel.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/actionView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/backend.vibe` | 58.97% → 45.31% | 45.45% → 40% | 28.57% → 15.78% | 52.17% → 41.66% |
| `src/web/entry.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `src/web/historyApp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/historyBackend.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/historyStartup.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/historyView.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/issueDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/issues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/issuesView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/main.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/markdown.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/media.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/web/modeSwitch.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/modelDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/paneDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/roleView.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/sandboxView.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/screenDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/startup.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/startupDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/styles.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/web/theatre.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/theatreDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/tourDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/view.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/viewDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/viewport.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/web/wikiView.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Accounts.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ActionDirectory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionIdentity.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionRuns.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionsHttp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/AgentModel.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `worker/Api.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Budget.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryActions.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/HistoryObject.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryTools.vibe` | 25% → 25% | 0% → 100% | 0% → 0% | 25% → 25% |
| `worker/Http.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/IssueCredentials.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Issues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/MainLog.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ObjectStorage.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Objects.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Reply.vibe` | 12.14% → 10.29% | 0% → 0% | 0% → 5.88% | 10.23% → 8.97% |
| `worker/SandboxAccounts.vibe` | 0% → 0% | 0% → 0% | 0% → 100% | 0% → 0% |
| `worker/SandboxHttp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxMachine.vibe` | 0% → 0% | 0% → 100% | 0% → 100% | 0% → 0% |
| `worker/SandboxTools.vibe` | 18.18% → 18.18% | 0% → 0% | 0% → 0% | 16.66% → 16.66% |
| `worker/Sandboxes.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Sequencer.vibe` | 0.93% → 0.84% | 0% → 0% | 0% → 0% | 0.76% → 0.69% |
| `worker/SpecificationReviewers.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Tour.vibe` | 0% → 0% | 0% → 100% | 0% → 0% | 0% → 0% |
| `worker/Unreachable.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/VipDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiTools.vibe` | — → 11.11% | — → 0% | — → 16.66% | — → 15.38% |
| `worker/accountObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/agentContext.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `worker/budgetDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/index.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/liveDispatchDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/machineObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/replyProgressDecision.vibe` | — → 5.88% | — → 0% | — → 10% | — → 4.54% |
| `worker/replyReasons.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |

## Chromium — diagnostic mapping

Previous snapshot: lines 43.15% (1778/4120), branches 46.41% (2293/4940), functions 56.38% (1091/1935), statements 48.38% (3077/6360).

At `9861d6f26e36`: lines 44.02% (3252/7387), branches 50.45% (6254/12394), functions 55.09% (2012/3652), statements 47.72% (5581/11695).

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/SandboxImage.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `infra/Stack.vibe` | 0% → 0% | 0% → 0% | 100% → 100% | 0% → 0% |
| `infra/WorkerBuild.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `scripts/agent-context.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/mythical-seed.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `scripts/wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/actions/Actions.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/actions/LiveActions.vibe` | — → 4.44% | — → 0% | — → 0% | — → 4.65% |
| `src/actions/MockActions.vibe` | — → 94.11% | — → 54.16% | — → 70.45% | — → 88.26% |
| `src/actions/agent.vibe` | — → 58.33% | — → 100% | — → 42.85% | — → 48.38% |
| `src/actions/catalog.vibe` | — → 62.5% | — → 97.5% | — → 100% | — → 72.72% |
| `src/actions/execution.vibe` | — → 42.5% | — → 11.32% | — → 13.33% | — → 30.37% |
| `src/actions/tools.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/actions/wire.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/assets/wiki.generated.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/Factory.vibe` | 0% → 100% | 100% → 100% | 100% → 100% | 0% → 100% |
| `src/core/IssuesFactory.vibe` | 0% → 88.31% | 0% → 73.89% | 0% → 90% | 0% → 81.95% |
| `src/core/LiveAccounts.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/LiveFactory.vibe` | 14.1% → 12.64% | 1.92% → 1.92% | 22.72% → 20.83% | 16.27% → 14.89% |
| `src/core/LiveIssues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/LiveWiki.vibe` | — → 5.88% | — → 0% | — → 0% | — → 6.06% |
| `src/core/MockAccounts.vibe` | 95.89% → 97.61% | 54.54% → 55.55% | 76.66% → 83.87% | 92.53% → 94.66% |
| `src/core/MockFactory.vibe` | 89.26% → 90.84% | 57.57% → 60.91% | 81.69% → 79.79% | 86.7% → 87.2% |
| `src/core/MockJournal.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/VipWriter.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `src/core/WikiFactory.vibe` | — → 0% | — → 0% | — → 3.57% | — → 0% |
| `src/core/WikiWriter.vibe` | — → 0% | — → 100% | — → 100% | — → 0% |
| `src/core/accountCookieDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/accountCookies.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/conversation.vibe` | 74.03% → 70.53% | 58.29% → 70.4% | 82.19% → 85.71% | 71.22% → 62.78% |
| `src/core/decide.vibe` | — → 98.18% | — → 79.62% | — → 100% | — → 96.03% |
| `src/core/flowDecision.vibe` | 72.72% → 36.92% | 47.82% → 32.14% | 80% → 75% | 80% → 31.18% |
| `src/core/flows.vibe` | 79% → 77.38% | 65.88% → 61.18% | 61.7% → 53.03% | 78.53% → 79.18% |
| `src/core/identityDecision.vibe` | — → 50% | — → 75% | — → 100% | — → 33.33% |
| `src/core/issueFlows.vibe` | 0% → 91.17% | 0% → 75% | 0% → 91.66% | 0% → 92.98% |
| `src/core/issueSchemas.vibe` | 0% → 91.66% | 100% → 100% | 0% → 66.66% | 0% → 95.45% |
| `src/core/mockDecision.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/mockReplies.vibe` | 85% → 84.21% | 50% → 50% | 55.55% → 55.55% | 78.94% → 78.37% |
| `src/core/protocolDecision.vibe` | 0% → 11.76% | 0% → 0% | 0% → 33.33% | 0% → 8% |
| `src/core/roles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/core/sandboxDecision.vibe` | 78.18% → 78.18% | 64.7% → 64.7% | 96.55% → 96.55% | 71.28% → 71.28% |
| `src/core/sandboxHost.vibe` | 66.85% → 68.57% | 59.76% → 59.27% | 86.48% → 91.89% | 63.14% → 65.25% |
| `src/core/sandboxMeter.vibe` | 93.54% → 93.93% | 77.41% → 77.41% | 100% → 100% | 84.9% → 85.71% |
| `src/core/sandboxMock.vibe` | 96% → 96% | 25% → 29.76% | 86.66% → 90% | 92.45% → 93.39% |
| `src/core/sandboxPolicy.vibe` | 66.66% → 66.66% | 100% → 100% | 0% → 0% | 50% → 50% |
| `src/core/schemas.vibe` | 0% → 80% | 100% → 100% | 100% → 100% | 0% → 81.81% |
| `src/core/sequenceDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/core/specification.vibe` | — → 82.35% | — → 63.21% | — → 83.33% | — → 73.77% |
| `src/core/tourStops.vibe` | 100% → — | 100% → — | 100% → — | 100% → — |
| `src/core/walkthroughSteps.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wiki.vibe` | — → 93.33% | — → 57.77% | — → 100% | — → 84.37% |
| `src/core/wikiDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiFlows.vibe` | — → 38.23% | — → 47.61% | — → 16.66% | — → 38.59% |
| `src/core/wikiLinks.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/core/wikiSchemas.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/core/wire.vibe` | 28% → 33.33% | 0% → 0% | 0% → 0% | 31.42% → 36.84% |
| `src/history/LiveMythical.vibe` | 7.14% → 6.81% | 0% → 0% | 0% → 0% | 8.33% → 7.89% |
| `src/history/MockMythical.vibe` | 100% → 100% | 66.66% → 50% | 97.29% → 97.29% | 98.33% → 98.41% |
| `src/history/MythicalHistory.vibe` | 0% → 66.66% | 0% → 25% | 0% → 100% | 0% → 40% |
| `src/history/Sequencer.vibe` | 73.19% → 74.22% | 35.71% → 35.71% | 89.83% → 89.83% | 73.56% → 74.28% |
| `src/history/flowMachine.vibe` | 66.66% → 52.94% | 41.17% → 37.57% | 94.11% → 82.92% | 58.33% → 41.09% |
| `src/history/flows.vibe` | 83.11% → 82.05% | 52.5% → 47.22% | 62.16% → 63.15% | 80.57% → 80.28% |
| `src/history/mythical.vibe` | 0% → 78.01% | 0% → 67.25% | 0% → 84.61% | 0% → 74.15% |
| `src/history/pages.vibe` | 77.77% → 77.77% | 72.22% → 72.22% | 96.55% → 96.55% | 83.87% → 83.87% |
| `src/history/roles.vibe` | 57.14% → 71.42% | 100% → 100% | 0% → 100% | 70% → 80% |
| `src/history/schemas.vibe` | 0% → 62.5% | 100% → 100% | 0% → 33.33% | 0% → 64.1% |
| `src/history/seed.vibe` | 2.92% → 2.92% | 0% → 0% | 0% → 0% | 4.24% → 4.24% |
| `src/history/seed/vibelang.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/history/tools.vibe` | 11.11% → 11.11% | 0% → 0% | 0% → 5.88% | 13.33% → 14.89% |
| `src/history/wire.vibe` | 21.62% → 22.85% | 0% → 0% | 0% → 0% | 19.6% → 21.27% |
| `src/surfaces/backend.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/cli-entry.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/cli.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/commandDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/commands.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/manifest.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp-entry.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `src/surfaces/mcp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `src/surfaces/session.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/surfaces/sessionFlow.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/surfaces/signin.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `src/web/actionModel.vibe` | — → 100% | — → 68.42% | — → 100% | — → 96.96% |
| `src/web/actionView.vibe` | — → 90% | — → 82.71% | — → 87.5% | — → 90.56% |
| `src/web/backend.vibe` | 86.36% → 85.91% | 80.95% → 73.33% | 82.14% → 82.97% | 89.41% → 86.56% |
| `src/web/entry.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/historyApp.vibe` | 86.22% → 86.3% | 55.8% → 57.04% | 77.35% → 77.84% | 83.38% → 84.09% |
| `src/web/historyBackend.vibe` | 96.29% → 96.29% | 66.66% → 66.66% | 90.9% → 90.9% | 98.24% → 98.24% |
| `src/web/historyStartup.vibe` | 92.59% → 93.75% | 88.88% → 68.18% | 100% → 100% | 91.11% → 92.72% |
| `src/web/historyView.vibe` | 73.17% → 82.19% | 75.73% → 77.11% | 92.06% → 92.06% | 74.78% → 81.65% |
| `src/web/issueDecision.vibe` | — → 53.93% | — → 69.16% | — → 71.79% | — → 48.02% |
| `src/web/issues.vibe` | — → 100% | — → 85.13% | — → 100% | — → 97.05% |
| `src/web/issuesView.vibe` | — → 94.87% | — → 80.42% | — → 94.11% | — → 94.16% |
| `src/web/main.vibe` | 91.13% → 80.84% | 69.49% → 64.95% | 83.5% → 78.21% | 86.29% → 78.24% |
| `src/web/markdown.vibe` | 92.59% → 57.54% | 84.61% → 43.25% | 100% → 51.16% | 90.9% → 52.91% |
| `src/web/media.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/modeSwitch.vibe` | — → 100% | — → 100% | — → 100% | — → 100% |
| `src/web/modelDecision.vibe` | — → 48.14% | — → 46.66% | — → 65% | — → 38.8% |
| `src/web/paneDecision.vibe` | — → 36.84% | — → 30.95% | — → 37.5% | — → 36.36% |
| `src/web/roleView.vibe` | 95.83% → 95.83% | 92.96% → 93.18% | 100% → 100% | 94.87% → 94.87% |
| `src/web/sandboxView.vibe` | 94.11% → 94.11% | 71.11% → 71.11% | 100% → 100% | 96.66% → 96.66% |
| `src/web/screenDecision.vibe` | 75% → 68.29% | 86.61% → 78.04% | 100% → 94.54% | 62.16% → 56.6% |
| `src/web/startup.vibe` | 89.65% → 94% | 100% → 62.5% | 100% → 78.94% | 91.83% → 91% |
| `src/web/startupDecision.vibe` | — → 66.66% | — → 80.55% | — → 100% | — → 50% |
| `src/web/styles.vibe` | 100% → 100% | 100% → 100% | 100% → 100% | 100% → 100% |
| `src/web/theatre.vibe` | — → 100% | — → 93.67% | — → 100% | — → 100% |
| `src/web/theatreDecision.vibe` | — → 27.77% | — → 87.5% | — → 100% | — → 16.12% |
| `src/web/tourDecision.vibe` | — → 68.75% | — → 47.5% | — → 83.33% | — → 54.54% |
| `src/web/view.vibe` | 85.45% → 94.33% | 88.7% → 84.21% | 96.22% → 96.55% | 79.77% → 87.64% |
| `src/web/viewDecision.vibe` | — → 54.54% | — → 72.11% | — → 92.3% | — → 37.5% |
| `src/web/viewport.vibe` | 95.83% → 95.83% | 62.03% → 63.88% | 100% → 100% | 91.66% → 92.85% |
| `src/web/wikiView.vibe` | — → 96.42% | — → 63.18% | — → 83.33% | — → 93.54% |
| `worker/Accounts.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ActionDirectory.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionIdentity.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionRuns.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/ActionsHttp.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/AgentModel.vibe` | 0% → 0% | 100% → 100% | 0% → 0% | 0% → 0% |
| `worker/Api.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Budget.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryActions.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/HistoryObject.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/HistoryTools.vibe` | 0% → 0% | 0% → 100% | 0% → 0% | 0% → 0% |
| `worker/Http.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/IssueCredentials.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Issues.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/MainLog.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/ObjectStorage.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Objects.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Reply.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxAccounts.vibe` | 0% → 0% | 0% → 0% | 0% → 100% | 0% → 0% |
| `worker/SandboxHttp.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SandboxMachine.vibe` | 0% → 0% | 0% → 100% | 0% → 100% | 0% → 0% |
| `worker/SandboxTools.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Sandboxes.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/Sequencer.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/SpecificationReviewers.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Tour.vibe` | 0% → 0% | 0% → 100% | 0% → 0% | 0% → 0% |
| `worker/Unreachable.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `worker/VipDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/Wiki.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiDraft.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/WikiTools.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/accountObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/agentContext.vibe` | 0% → 0% | 100% → 100% | 100% → 100% | 0% → 0% |
| `worker/budgetDecision.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/index.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |
| `worker/liveDispatchDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/machineObject.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/replyProgressDecision.vibe` | — → 0% | — → 0% | — → 0% | — → 0% |
| `worker/replyReasons.vibe` | 0% → 0% | 0% → 0% | 0% → 0% | 0% → 0% |

## Client path regressions (Sol resume, 2026-11-08)

The new 54-case public-client matrix failed first in 14 cases (40 passed). `LiveFactory.openWiki` bypassed
identifier admission and sent a path containing `undefined` for empty, oversized or malformed UTF-16 conversation
IDs. It now uses the same admission as every other operation. `LiveActions` threw URIError for unpaired surrogates
in run filters/IDs; each method and stream now fails with typed `ActionFailure(input)` before transport. A faulty
Effect transport counts attempted calls; all invalid inputs require zero. Real loopback HTTP additionally preserves
a 128-code-unit identifier and an emoji/slash/query/fragment identifier, including the numbered wiki event and room
isolation. All 77 selected client/HTTP cases pass; no dependency, interception or compiler change is involved.

The real SQLite action-index/per-run tests additionally cover idempotent posts, changed-input conflicts, no-model
reply traces, tutorial park/cancel/rerun, current-grant checks, and Plan/Start/Note/Show through the actual history
flows. A role downgrade before alarm admission exposed an app bug: the SDK correctly cancelled the unadmitted
intent without an engine row, but the app then defected while polling that nonexistent row. The receipt adapter
now handles only `FlowExecutionNotFound` accompanied by the SDK's durable cancellation tombstone; an unexpected
missing row remains an error. Both reply and history hosts use it. The first runtime run failed one of four
cases; six action cases now pass, including a negative control without the tombstone. The new receipt path logs,
spans and counts only the bounded outcome `unadmitted-cancelled`.

The Alchemy graph matrix now also compiles the optional offline Container declaration, its machine/account DO
bindings and the linked Container resource, without provider initialization or deployment. The emitted wiki
command runs on real fixture files: nested/absolute/external/hash links, decision metadata and ruling deduplication,
ordering, non-Markdown omission, deterministic output and read failures preserving prior output. Its output lives
only in the ignored compiler fixture tree. No runtime source is excluded and no dependency was added.


## A refused history write is a failed run (2026-11-09)

Plan, Start and Note answer a refusal as a value, so their flow succeeds. The run settles as `failed` with the
refusal kept in its result, live and in mock mode, through `refused` in `src/actions/execution.vibe`.

## Paths a Node unit test can't close (2026-11-09)

The unit gate still fails below 100%. No file below is excluded and no threshold changed; each stays counted as uncovered.

| Path | Needs | Test that covers it once available |
| --- | --- | --- |
| `worker/SandboxMachine.vibe`, `worker/SandboxProbe.vibe`, Container paths of `worker/SandboxAccounts.vibe` | A real Container binding. Will ruled yes (VL-35, 2026-11-10); the `vl-test` stage declares one (0024). Its first live run (2026-11-10) refused the start with no cause; refusals now carry a content-free reason (0024), and the machine gives every Container its own entrypoint. `test/sandboxObjects.workerd.test.vibe` checks each machine reason, and an image whose command exits, in real workerd with faulty Container services. No scripted Container namespace. | `test/sandboxes.live.test.vibe` through `pnpm test:sandboxes-live` against the stage, on demand. Its body also runs in `pnpm test` over local processes (`test/sandboxProbe.test.vibe`), which covers `worker/sandboxProbeFetch.vibe` but not these bindings |
| `worker/Api.vibe` | Closed 2026-11-10 (vl-coverage-workerd): its wiring runs only in workerd, and the suite now loads it there as Alchemy builds and bridges it (`test/workerd/api.vibe`), measured in the unit and fuzz gates. | `test/alchemyApi.workerd.test.vibe`; fuzz target `workerd/alchemy-api-requests` |
| `worker/SpecificationReviewers.vibe` | Stays unbound by decision 0027. | None until it is bound |
| `worker/VipDraft.vibe`, model paths of `worker/Reply.vibe` | A model credential reference in the environment. | `test/live.workerd.test.vibe` covers Reply, opt-in on `CEREBRAS_API_KEY`. `test/vipDraft.test.vibe` covers `VipDraft`, opt-in on the same key |
| GitHub read, write, VIP proposal and label paths of `worker/Issues.vibe` (`githubHost`) | Covered. The happy paths replay real GitHub through smithers.sh's delegation (`test/issues.github.test.vibe`, recordings `issues.json` and `issues-read.json`, [0032](0032-record-replay.md)): every write, its refusals, verified and refused VIP claims, tasks, sub-issues and notes; the fault cases stay on the in-memory GitHub as wrapped client services. | `test/issues.github.test.vibe` (replay, no token) |
| GitHub write paths of `worker/Wiki.vibe` | Covered. Reads, kept drafts, a save, two proposals and the refusals before a write replay real GitHub through smithers.sh's delegation (recording `wiki.json`, [0032](0032-record-replay.md)). | `test/wikiEdit.github.test.vibe` (replay, no token) |

## Lane vl-coverage2 (2026-11-09)

A second unit lane beside vl-coverage, on the files vl-coverage does not own. Same provider, thresholds and
`pnpm test:coverage`; nothing excluded and no threshold changed. Unit suite only: the browser, workerd, fuzz and
benchmark suites were not measured by this lane.

Before is main `92651c71` (1407 passed / 3 skipped). After is this lane's last commit on a later main (1488 passed /
3 skipped); the All files row includes other lanes' work landed between them.

| File | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| `worker/Http.vibe` | 82/93 (88.17%) → 93/93 (100%) | 82/106 (77.35%) → 104/104 (100%) | 17/23 (73.91%) → 23/23 (100%) | 102/126 (80.95%) → 126/126 (100%) |
| `src/web/backend.vibe` | 52/73 (71.23%) → 64/64 (100%) | 18/25 (72%) → 15/15 (100%) | 22/38 (57.89%) → 38/38 (100%) | 55/86 (63.95%) → 72/72 (100%) |
| `src/core/MockFactory.vibe` | 239/254 (94.09%) → 254/259 (98.06%) | 126/152 (82.89%) → 135/141 (95.74%) | 75/80 (93.75%) → 78/78 (100%) | 290/311 (93.24%) → 306/314 (97.45%) |
| `src/actions/MockActions.vibe` | 114/118 (96.61%) → 114/114 (100%) | 73/95 (76.84%) → 89/89 (100%) | 31/40 (77.5%) → 36/36 (100%) | 139/159 (87.42%) → 151/151 (100%) |
| `src/actions/execution.vibe` | 32/41 (78.04%) → 39/39 (100%) | 32/38 (84.21%) → 36/36 (100%) | 13/17 (76.47%) → 17/17 (100%) | 43/53 (81.13%) → 51/51 (100%) |
| `src/core/conversation.vibe` | 232/241 (96.26%) → 241/241 (100%) | 378/402 (94.02%) → 402/402 (100%) | 74/78 (94.87%) → 78/78 (100%) | 310/331 (93.65%) → 331/331 (100%) |
| `src/core/LiveWiki.vibe` | 5/15 (33.33%) → 15/15 (100%) | 0/4 (0%) → 4/4 (100%) | 3/10 (30%) → 10/10 (100%) | 6/21 (28.57%) → 21/21 (100%) |
| All files | 6379/7178 (88.86%) → 6582/7251 (90.77%) | 6709/7843 (85.54%) → 6951/7936 (87.58%) | 2249/2677 (84.01%) → 2342/2709 (86.45%) | 7950/9249 (85.95%) → 8274/9354 (88.45%) |

**Bug fixed.** A tour or demo conversation's retained `MockJournal` can end mid-reply. Restoring it left the room
busy forever: later posts were never answered and a tour was refused `busy`. Restoring now fails that reply with the
live wording (0014). Regression: `test/mockFactory.coverage.test.vibe`, red first (reply unfinished after 10 s).

**Dead code deleted** (each named in its commit): tour-control's integer and negative step checks (`Seq` rejects
both); the browser factory's "unavailable" throws for issues, wiki and tour control (both selectable factories supply
them); `EndTour`'s action invocation kind, execute case and mock registration (internal, refused by every gate before
`prepare`); MockActions' `invalid-run` and `cancel-failed` mappings and missing-invocation checks; `Tours.finish`'s
unused reason; MockFactory's `account-unavailable` mapping, the scripted agent's wiki read, history and prompt
fallbacks and two always-defined `??` fallbacks.

**Left uncovered in `src/core/MockFactory.vibe`, not excluded:**

| Lines | Why a test can't reach it deterministically |
| --- | --- |
| 90-97 | Covered since 2026-11-09 by `test/mockReplyRace.coverage.test.vibe`. The mock reads `Digest` from context; a Digest that holds the reply's first journaled digest on a latch opens the window between dispatch and `StartReply`, and a second latch on the handed tour's `vibelang/tour/start` step opens the window before its run starts. |
| 102 | Deleted 2026-11-09. `StartReply` refused for a reason other than `busy` needs a second dispatch of the post, which the answer loop never makes, or 2^53 events. The start step now has no success value and every refusal is contention. |
| 327 | `Tours.ended` after the tour already ended: between `running` and the subscription. Nothing in that window calls a service a test can hold, so only the fiber scheduler reaches it; the check keeps `ended` from waiting forever. |

**Flow bodies (fixed 2026-11-09).** `src/core/flows.vibe` had 14 flows whose `body` was `() => Node.succeed(…)` and
whose behavior `engine.register` attached at registration, a second, opaque shape the flow package documents as
internal. Each body now sequences one declared action per step it journaled before, in the same order:
`vibelang/post/record` then `vibelang/post/dispatch`, `vibelang/tour/record` then `vibelang/tour/dispatch`,
`vibelang/tour/start` then `vibelang/tour/guide`, `vibelang/tour/end` then `vibelang/tour/wake`, and
`vibelang/tour/request/<control>` then `vibelang/tour/signal`. A step that runs only after an accepted one is a
`Node.branch`. Reply is one step, `vibelang/reply/answer`: what it does inside is its host's composition. The docs
and wiki tools are one `…/pane/open` step, and the sandbox flows their `…/commit` step. Each host attaches the steps'
implementations with `Interpreter.layerWithImplementations`; they read `Posts`, `Tours`, `SandboxHost` and
`ActionDevice` from context. Mock actions guide a tour by following the factory's events until that tour ends.
`test/flowBodies.test.vibe` pins every step name and both arms of each branch, so the journal, the Actions pane
(`bench/browser.spec.ts` "chat, scroll, home, tour and escape actions"), spans and metrics name real steps. The first
version of this fix (44053da0) wrapped each body in one `<flow>/perform` step, and the Actions pane showed
`perform · running` instead of the tour's `start` and `guide`. Resuming a run journaled before either change (a tour
parked across the deploy) is untested.

**More flow bodies (2026-11-09).** The same rule now holds for four more flows. `vibelang/GrantRole`
(`src/core/MockAccounts.vibe`) is its `vibelang/role/record` step. `vibelang/actions/Request`
(`worker/ActionDirectory.vibe`) is `vibelang/actions/index` then `vibelang/actions/start`, and `vibelang/actions/Cancel`
is `vibelang/actions/cancel`; the steps act on the request admitted at the door, so a replay's JSON conflict check
compares identical bytes. `vibelang/Session` (`src/surfaces/sessionFlow.vibe`) branches on its payload to
`vibelang/session/login`, `…/poll` or `…/logout`. 

**History flow bodies and the action host's caller (2026-11-10).** The seven history flows (`src/history/flows.vibe`,
`tools.vibe`) are now their steps too. Every write is `vibelang/history/<action>/authorize`, then, through a
`Node.branch` on the proved `canRecord`, `…/record`; a forbidden run answers `forbidden` with no other step. Plan
branches on `how` first, so an append journals `append/…` and an insert or amend `retell/…`, the names it journaled
before. Fold is `fold/authorize`, `fold/main`, `fold/read`, then `fold/commits`, which keeps one inline
`fold/<sha>` step per commit. Bootstrap is `bootstrap/load`; show is `show/authorize` then `show/read`. The action host
(`src/actions/execution.vibe`) implements the same steps: its authorize step reads `Caller`, as the History object's
does, and its record step asks the history through `HistoryReader`, which checks again; the old `…/call` step is gone.
The live host's `Caller` is `ActionRuns.callerOf`: the owner, name and actor the door stored from 0019's session, at
the owner's current grant each time a step asks; the payload never names it. Mock actions use the world's current
person. `test/historyCaller.coverage.test.vibe` runs Plan, Start, Note and show on the live host and pins their steps.
Its second case failed on main before this change (`refusal: "unknown"`: a contributor's insert reached the history
as its maintainer); it now stops at `retell/authorize` with `forbidden` and writes nothing. In the mock, the history
runs the same flow in memory inside the record step, so a mock action's trace shows the history's own authorize and
record after the host's. `Node.bindPlanned`'s callback needs `Node.capture`, or the engine refuses the graph as
process-local. Resuming a history run journaled before this change is untested.

**`worker/accountObject.vibe` (2026-11-10).** 10.41% of lines → 100% of lines, branches, functions and statements in
Node, with no workerd: `test/accountObject.coverage.test.vibe` wires the account object and its gateway as live over
SQLite storage and the machine object over local processes (`fuzz/machine-box.ts`), and injects a throwing namespace
binding and a failing container. It covers the owner's start, command, read, alarm and stop; the first owner keeping
the account; signed-out, policy-denied and viewer refusals at the gateway and at the object; unavailable bindings and
containers; and an unused account's alarm. No bug found.

**`worker/apiObjects.vibe` (2026-11-10).** 9/193 lines, 0/59 branches, 7/86 functions and 9/225 statements → 100%
of all four in Node, with no workerd. `test/apiObjects.coverage.test.vibe` (17 cases) drives every API route through
`apiFetch` signed in, signed out and from another origin; the conversation and action-run alarms with the scripted
model running the agent's tools; the sandbox gateway's identity; and each namespace unbound or unreachable, including
the accounts object lost mid-run. The in-process world moved out of `fuzz/api-objects.node.fuzz.vibe` into
`test/support/apiWorld.vibe`, which both now import, and gained a draft-only agent.

- **The unit suite could not run the agent's cells.** `vite.config.ts` did not resolve `#quickjs.wasm`, so every
  agent cell in a unit test failed with `flows/harness/SandboxError` and the reply read "The agent failed". The fuzz
  config's resolver moved to `quickjs.vite.ts`, which both configs use.
- **Bug fixed: an agent-started run was listed twice.** A run the agent starts inside another run is announced in that
  run's conversation, and `ActionDirectory.list` flattened every indexed run's conversation, so `/api/actions/runs`,
  the CLI and the agent's `vibelang/actions/List` returned it twice (the web pane merges by id). Each indexed run is now
  listed once, from its own conversation. Red first: the list held the agent's run id twice.
- **Bug fixed: account routes answered 500 for an unreachable accounts object.** `apiFetch` died on `Unreachable` for
  `/api/auth/*` and the other account routes; they now answer 503 `{ "error": "accounts" }`, as every other object's
  routes do. Red first: the request failed with the `Unreachable` defect.
- **Fuzz target fix.** Its requests carried no `content-length`, so every post and wiki open answered 413 and the walk
  never accepted a post. The unit tests run in Node (`@vitest-environment node`), because happy-dom's `Headers` drops
  `set-cookie` and no session could be signed in.
- **Found, kept:** losing the accounts object while the agent runs fails its whole reply ("The agent failed. Try
  again."), not just the tool: the history tools' role lookup (`identity.role`, line 239) dies. The person can retry.

**`worker/SpecificationReviewers.vibe` (2026-11-10).** 33/51 statements → 50/51, all branches, 15/16 functions.
`test/specificationReviewers.coverage.test.vibe` (7 cases) runs each of the four reviewers inside one durable
execution on the memory engine against the scripted model: no record, a record whose credential is missing, a record
that is not JSON (startup fails), an accepted verdict at the asked revision charged once, a rejected verdict or failed
model answered `review` and still charged, a refused or unreachable budget asking no model, and a charge the ledger
refuses once being retried. The execution helper and budget ledger moved from `fuzz/model-writers.node.fuzz.vibe` to
`test/support/durableWriters.vibe`. Deleted, not covered: the `ConfigurationError` mapping of `Budget.make({})` (a
constant valid policy) and the `review` mapping of the verdict decode (the agent already refused any output that is
not a `Verdict`; the decode now only types it, with `orDie`). Left uncovered, not excluded: line 48, `usageOf` failing
with `AccountingUnavailable`. That needs the journal unreadable while `review` reads its own run's usage, and no
service a test can replace reaches that read without also replacing the agent's journal.

**`worker/VipDraft.vibe`, `worker/WikiDraft.vibe` (2026-11-10).** `test/draftWriters.coverage.test.vibe` runs both
writers with their real agents against the scripted model: a draft answered and charged once, a non-draft, another
page, blank text or a failed model answered `draft`, a refused day answered `budget`, a charge refused once and
retried, and each agent seam asked directly without a model answering `no-model`. Deleted, as in the reviewers: the
`Budget.make({})` mapping and the decode's `draft` mapping (the agent already refused any output outside the schema).
Left uncovered, not excluded, for the reviewers' reason: `usageOf` failing (`VipDraft.vibe:55`, `WikiDraft.vibe:57`).

**`worker/Issues.vibe`, `worker/Wiki.vibe` (2026-11-10).** Measured over every unit test that imports either file:
Issues 60% lines, 53.91% branches, 54.54% functions, 56.67% statements → 100% of all four; Wiki 69.94%, 75%, 60.37%,
65.43% → 100% of all four. `test/issuesDelegated.coverage.test.vibe` (18 cases) and
`test/wikiDelegated.coverage.test.vibe` (12 cases) run the GitHub hosts as the site runs them after decision 0165:
every read and write goes through smithers.sh's real per-person connection host (`fuzz/delegated.vibe`) to the
in-memory GitHub (`fuzz/issues-node-fake.vibe`), on the durable engine over SQLite. A misbehaving GitHub is a wrapped
client service and a failing journal is `fuzz/faulty-store.ts`; nothing intercepts a request. The cases cover reads
(tasks, VIP markers that fail each check, timelines, deleted accounts, short pages, undecodable issues), every write
and its refusals, a role or credential lost between steps, an ended delegation falling back to public reads, kept wiki
drafts, retries and resumes, and the HTTP routes' store failures. Since 0032 (2026-11-10) the happy cases replay real
GitHub in `test/issues.github.test.vibe` and `test/wikiEdit.github.test.vibe`; the two coverage files keep 14 and 10
fault cases.

- **Bug fixed: a VIP proposal or wiki change could never be retried after its commit.** smithers.sh binds each write
  key to its operation's digest. On a retry, `branch.create`'s lookup adopts the branch, whose head is now the change's
  own commit, and the site built `commit.create` with `expectedHeadOid: branch.sha`, a different operation under the
  same key. smithers.sh refused it (`key_conflict`) and the person saw `invalid`. A flow's own retry of an
  `unavailable` answer (GitHub not yet showing the review) or an explicit Retry both hit it. The commit now names the
  commit the branch was cut from (`head.value.sha`), the same on every run. Red first: the one-time-lag cases in both
  tests answered `invalid`.
- **Deleted, not covered.** `engine.retryFrom === undefined` (EngineStore always supplies it); the inner
  `mapError(() => unavailable)` on journal inspection and `retryFrom`, which repeated the execution's outer mapping;
  the resume's poll mapping a store failure to `missing` (poll answers None for an unknown run, so its failures are
  the store's, now `unavailable` like every other store failure there); the resume's payload decode refusal and its
  op, key and flow recheck (the run id names the op and the key's digest, and only `executeIssues` starts a run
  there); and the receipt's `approvedAt ?? ""` (`approveVip` writes it with `approvedBy`). That deletion was wrong: a stored
  item may hold `approvedBy` alone, and `approvedAt!` then stored `approvedAt: undefined`, which the next read refused
  as `protocol`. The mapping now keeps `approvedAt` only when it was stored (vl-test-quality, 2026-11-10). `72225ac2` deleted the
  `match.index` default, the review rechecks `verifiedVip` already made and Wiki's final `invalid` branch.
- **Found, kept:** a journal that cannot record a step's attempt makes the engine interrupt the run
  (`EngineStore.actionExecute`), so the request ends interrupted rather than answering `unavailable`. That is
  engine-store's lease handling, outside this app; the wiki test pins it. `test/issues.github.test.vibe` now runs the
  issues flow through the delegation on a recording of real GitHub, on every run ([0032](0032-record-replay.md)).

**`worker/Reply.vibe`, `worker/ActionRuns.vibe` (2026-11-10).** Whole suite at `5540b9b2` → over every unit test that
imports each file. Reply: statements 144/157 → 157/157, branches 63/81 → 80/81, functions 18/18, lines → 100%.
ActionRuns: statements 154/164 → 161/164, branches 153/175 → 168/175, functions 34/36 → 36/36.
`test/replyAgent.coverage.test.vibe` (6 cases) runs the Reply flow on the memory engine with smithers.sh's agent
answering through the scripted model (`fuzz/model-server.vibe`): an answer that starts over is shown again from its new
start once (`ReplyRestarted`), an empty answer, a provider out of credit, usage the meter cannot count, a start that
waits behind another reply, an agent run interrupted inside a history tool (the reply's execution ends interrupted and
the reply is neither finished nor failed, so the engine resumes it), and an action asking for a seat the agent doesn't
declare. `test/actionRunsHeld.coverage.test.vibe` (7 cases) ports `fuzz/action-runs.node.fuzz.vibe`'s held replies:
a conversation log that dies on the reply's first settle write (the engine fails the open reply; the run ends failed),
a reply cancelled at a latch in its admission, a reply the agent answers (its agent-started run passes), an anonymous
tour admitted at its alarm, `callerOf` with no owner or name, a history host that cannot start, and a nameless post.

Left uncovered, not excluded:

| Line | Why no unit test reaches it |
| --- | --- |
| `Reply.vibe:359`, `canSettleReply` false | After start, compose and finish in order the proved kernel always allows the settle (`flowDecision.vibe`); the guard keeps the shell on vl-proveall's state machine. |
| `ActionRuns.vibe:77`, a post or tour operation that fails | Not reached here; the next seam to try is a faulty engine store under `Objects.post`. |
| `ActionRuns.vibe:125`, a tour that settles failed | A tour stays parked until the person ends it, and ending it settles it passed. |
| `ActionRuns.vibe:133`, an alarm whose reply host fails | Not reached here; the failing log and the latch both end in a successful alarm. |
| `ActionRuns.vibe:168`, admission with no stored request | Every alarm that admits reads the request the start stored first. |
| `ActionRuns.vibe:172-173`, a demotion while the reply is open | Admission runs before the reply's entry exists; it needs a second alarm racing the first. |

**A reply-started tour stayed parked (fixed 2026-11-09).** A reply refused `busy` by a tour accepted after its
dispatch ran that tour as its own child execution. Ending the tour woke only the tour the answer loop started, so the
child stayed parked forever with no `vibelang.tour.run` outcome, though the reply still answered. Now each room has one
tour sequencer, the only driver of `vibelang/Tour` runs: the answer loop and a contended reply both hand it the tour
and wait for that run to end, and `Tours.wake` resumes the sequencer's run. Regression: case 1 of
`test/mockReplyRace.coverage.test.vibe` (ending the tour logs the run's `inactive` outcome); it failed before the fix
with no outcome. The same case still asserts the reply answers, which caught the earlier two-driver hang.

**Service Shape spread.** `test/support/overlaidAccounts.vibe` lists the `Accounts` members, as `overlaid.vibe` does
`Factory`'s, because spreading a service Shape drops its methods in VibeLang 0.0.12. The upstream fix awaits
publication (roadmap, vl-actions); the helper can become a spread once 0.0.13 is consumed.

## vl-coverage, ninth session (2026-11-09)

Unit suite only, same provider and thresholds; nothing excluded, no threshold changed. Before is the run at
`5353bea5` (1561 passed / 3 skipped); after is the run on this session's last test commit (1655 passed / 3 skipped).
All files: lines 90.82% → 91.38%, branches 87.86% → 89.48%, functions 88.84% → 89.91%, statements 88.91% → 89.75%.
Counts are covered/total; lines count lines that start a statement.

| File | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| `src/web/main.vibe` | 665/665 → 664/664 | 836/841 → 821/823 | 371/371 → 370/370 | 883/883 → 882/882 |
| `src/surfaces/signin.vibe` | 106/108 → 108/108 | 85/94 → 93/94 | 16/26 → 25/26 | 127/142 → 141/142 |
| `src/web/actionView.vibe` | 26/30 → 30/30 | 106/125 → 123/123 | 21/27 → 27/27 | 35/41 → 41/41 |
| `src/web/view.vibe` | 53/53 → 53/53 | 143/173 → 160/163 | 33/33 → 33/33 | 57/58 → 58/58 |
| `src/web/issueDecision.vibe` | 90/91 → 91/91 | 230/257 → 257/257 | 21/22 → 22/22 | 141/142 → 142/142 |
| `src/core/IssuesFactory.vibe` | 74/76 → 74/75 | 105/122 → 114/120 | 16/16 → 16/16 | 90/100 → 96/99 |
| `src/web/startup.vibe` | 46/50 → 47/50 | 10/22 → 18/22 | 11/13 → 11/13 | 51/64 → 55/64 |
| `src/history/mythical.vibe` | 135/141 → 141/141 | 181/191 → 190/191 | 28/29 → 29/29 | 180/195 → 194/195 |
| `src/surfaces/backend.vibe` | 41/45 → 45/45 | 24/35 → 33/35 | 9/14 → 12/14 | 49/58 → 55/58 |

Types that forced a default that cannot happen were fixed instead of tested: `update` always answers a commands list
(`WithCommands`), `Model.theatre` is required (init sets it, nothing clears it), `fixtureHost`'s lock is required,
and `model.tourError ?? ""` and `split("/").at(-1) ?? name` are gone.

Left uncovered in these files, each still counted:

| Where | Why no test reaches it |
| --- | --- |
| `src/web/main.vibe:403`, two arms | The connect, fork and install wording; decision 0165's lane owns connect. |
| `src/surfaces/signin.vibe:88` | The session file removed by another process between `login` writing it and reading it back. |
| `src/surfaces/signin.vibe:116` | The durable wait's own journal failing after a poll succeeded; needs a FileSystem fault at one call. |
| `src/web/view.vibe:46`, `:147` | `WALKTHROUGH[step - 1]` missing; the theatre's step stays within 1 to 10. Indexed access types it optional. |
| `src/core/IssuesFactory.vibe:52` | The host's own permission and execution-id check; `act` authorizes and derives the id first. |
| `src/core/IssuesFactory.vibe:62` | An empty key; `IssueRequest`'s `DurableText` refuses it before a flow runs. |
| `src/core/IssuesFactory.vibe:93` | The `switch`'s `default`; every non-creating write is one of its cases. |
| `src/core/IssuesFactory.vibe:115`, `:123`, `:126` | A request op with no flow, and an engine failure other than an id conflict. |
| `src/history/mythical.vibe:562` | `rank < 0` after `epicOf` matched; the commit exists, so it has a rank. Kept for the proof. |
| `src/surfaces/backend.vibe:61` | A request to another origin; no live client sends one. Kept: it keeps the cookie on its origin. |
| `src/surfaces/backend.vibe:80`, `:83` | A mock session read that fails, and mock accounts missing; `mockFactoryFor` always has accounts (vl-coverage2's file). |
| `src/web/startup.vibe:72` to `:75` | Reachable, not yet tested: the browser journal of tour and demo conversations, reached by running a tour on the started page. |

## vl-coverage, tenth session (2026-11-10)

Unit suite only, same provider and thresholds; nothing excluded, no threshold changed. Before is the run at `7cd40f0f`
(1659 passed / 1 failed / 3 skipped; the failure was an MCP initialization deadline under load 102). That run overlapped
this session's sign-in edit, so `signin.vibe`'s before column merges two versions of the file. After is the run on this
session's last test commit (1783 passed / 3 skipped). All files, including other lanes' work landed between the runs:
lines 91.46% → 97.08%, branches 89.46% → 93.23%, functions 90.05% → 96.79%, statements 89.8% → 95.75%; 68 of 156
files remain below 100%. Counts are covered/total; lines count lines that start a statement.

| File | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| `src/surfaces/signin.vibe` | 108/108 → 111/111 | 120/126 → 105/106 | 33/36 → 27/28 | 197/207 → 145/146 |
| `src/web/startup.vibe` | 48/50 → 50/50 | 18/22 → 22/22 | 11/13 → 13/13 | 56/64 → 64/64 |
| `src/core/decide.vibe` | 55/55 → 55/55 | 102/107 → 107/107 | 6/6 → 6/6 | 84/87 → 87/87 |
| `src/core/sandboxDecision.vibe` | 53/55 → 55/55 | 63/72 → 72/72 | 14/15 → 15/15 | 68/76 → 76/76 |
| `src/core/sequencerDecision.vibe` | 14/16 → 16/16 | 22/28 → 28/28 | 7/8 → 8/8 | 20/23 → 23/23 |
| `src/core/wiki.vibe` | 14/15 → 15/15 | 20/26 → 22/22 | 10/10 → 10/10 | 26/27 → 27/27 |
| `src/surfaces/session.vibe` | 60/63 → 63/63 | 17/24 → 24/24 | 19/22 → 22/22 | 66/75 → 75/75 |
| `src/web/roleView.vibe` | 20/24 → 24/24 | 55/66 → 66/66 | 10/14 → 14/14 | 23/27 → 27/27 |
| `src/web/wikiView.vibe` | 26/28 → 28/28 | 81/95 → 91/95 | 15/19 → 19/19 | 35/39 → 39/39 |
| `src/core/sandboxMock.vibe` | 47/47 → 47/47 | 32/45 → 35/45 | 22/23 → 22/23 | 69/72 → 71/72 |
| `src/web/theatre.vibe` | 45/45 → 45/45 | 32/40 → 39/40 | 7/7 → 7/7 | 48/51 → 51/51 |
| `src/web/entry.vibe` | 0/8 → 8/8 | 0/4 → 4/4 | 0/0 → 0/0 | 0/8 → 8/8 |
| `src/core/LiveFactory.vibe` | 77/77 → 77/77 | 25/30 → 30/30 | 20/20 → 20/20 | 84/89 → 89/89 |
| `src/web/historyView.vibe` | 72/73 → 73/73 | 133/145 → 145/145 | 42/43 → 43/43 | 81/82 → 82/82 |

Dead code deleted: `requestedWiki`'s "rulings" and "roadmap" arms (`src/core/wiki.vibe`). A request naming either page
matches its id first, so the fallback can only answer "index".

`runningCountPrefix` and `restartsBefore` exist only for proof specifications. VibeLang has no specification-only
function, so they compile as exported runtime code; reproduction in `~/vl/vibelang-bugs/spec-only-function/`. They are
tested against the loops they specify, not removed.

Left uncovered in these files, each still counted:

| Where | Why no test reaches it |
| --- | --- |
| `src/surfaces/signin.vibe:99` | `stored?.login ?? ""` on a signed-in answer with no stored session; the session is written just before it is read. |
| `src/surfaces/signin.vibe:127` | The durable wait's own host failing after the poll step's host succeeded (was `:116`); needs a FileSystem fault at one call. |
| `src/web/wikiView.vibe:53`, three arms | "Connect GitHub." wording; decision 0165's lane owns connect. |
| `src/web/wikiView.vibe:72` | The outlined status of a decision that isn't Accepted; every decision in the wiki is Accepted. |
| `src/core/sandboxMock.vibe:41`, `:44` to `:46` | An engine failure other than Refused or Unavailable; each call's execution id is fresh, so none conflicts. |
| `src/web/theatre.vibe:49` | `WALKTHROUGH[step - 1]?.voice ?? ""`; the step stays within 1 to 10. |

`src/web/startup.vibe:72` to `:75`, listed as reachable last session, are now covered by running the first visit's tour on
the started page.

## Chromium merge (vl-fuzz2, 2026-11-10)

`e2e/coverage-reporter.ts` merged the compiler's structure of each source (the zero seed) and the bundle's with
Istanbul's `merge`, which keeps both shapes where it cannot match them. On the minified e2e bundle a file counted its
`if`s and their folded ternaries: `fixture.vibe` read 4 branches for its 2, `startupDecision.vibe` 36 for 18. Now the
seed is the structure and each bundle credits it through `test/support/coverageUnion.ts`, the fuzz and bench gates'
merge. That module now matches by source start: a statement's, a function body's, and a branch's type with its
ordered arm starts. Vite's composed maps keep starts and infer ends from the next mapped token (`answer`'s name ends
at column 29 in the compiler's map and 30 in the bundle's).

The e2e build (`--mode e2e`, also the fuzz suite's browser build) is unminified, as `bench-coverage` is: minification
renames and folds code, so few minified ranges start where the compiler's do. The deployed build is unchanged. The
coverage fixtures skip a re-export facade with or without whitespace.

| One `pnpm e2e` run's evidence | Files | Metrics below 100% | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | --- | --- | --- | --- |
| minified, Istanbul merge | 154 | 507 | 3341/7616 | 6353/12653 | 2123/3774 | 5680/11950 |
| minified, merge by full range | 154 | 541 | 2549/7479 | 384/8096 | 63/2803 | 2850/9577 |
| unminified, Istanbul merge | 154 | 499 | 3545/7644 | 6155/11922 | 2302/3991 | 5837/11867 |
| unminified, merge by start (landed) | 154 | 508 | 3343/7479 | 3445/8096 | 1345/2803 | 3903/9577 |

The landed denominators are the sources' own (7479 lines, 8096 branches). Tests: `test/browserCoverageMerge.test.vibe`
(a real minified Vite build of the fixture under native V8, through `measure`; failed on the old reporter with 4
branches for 2) and two cases in `test/fuzzCoverage.test.vibe` (same starts credit whatever the ends; other starts
credit nothing; the first failed on the full-range rule).

## Build structure (lane vl-sourcemaps, 2026-11-10)

The compiler's statement starts could not all be credited in Chromium: Rolldown prints no map segment at some of them
("Measurement blockers"). The browser denominator for a local run now comes from the build Chromium runs.
`e2e/coverage-reporter.ts` reads every chunk of `dist/assets` with its map (`readBuild`), converts each once with no
hits, and `builtStructure` (`test/support/coverageUnion.ts`) builds each source's structure from it:

```
source in a chunk?  ── no ──▶ compiler's structure (unloaded file)
        │ yes
        ▼
bundle's statements, functions, branches
  + each compiler item whose start no bundle statement or function range contains (tree-shaken code)
  − duplicates at one source start (Rolldown maps an inner `make` and its renamed `make_2` to one start)
  − each compiler branch the bundle has with the same kind, start and number of arms (2026-11-13)
```

The last rule (lane vl-coverage-core, 2026-11-13). The minified bundle's map can start a branch's later arm elsewhere
than the compiler's map does: a ternary's second arm at its first arm's start, an if/else printed as an `if` with no
else. Both copies stayed, Chromium's ranges credited only the bundle's, and the compiler's copy stayed open forever:
17 such branches in 12 files of the full gate `core1/s6full1` (`sandboxDecision.replaceSandbox`'s `if`, `MockAccounts`
`participated`'s `??`, `sandboxHost.observed`'s default argument, 4 in `src/history/export.vibe`). Those were the
"rises" in `sandboxDecision` (29 to 31) and `MockAccounts` (9 to 11) that no source change explained. Test:
`test/browserStructure.test.vibe` "the build's branch replaces the compiler's branch of the same kind, start and arm
count" (failed before the rule: 5 branches for 3).

Executed bundles still credit it by identical start (`unionEvidence`). Browser and unit structures differ only where
the bundler changed the code. A run against a deployment (`E2E_BASE_URL`) keeps the compiler's structure: its bundle
is not the local build. The reporter logs `Chromium structure: <n> build chunks.`

Same evidence (one `pnpm e2e` run, 291 passed, 19 chunks), measured both ways:

| Structure | Metrics below 100% | Lines | Branches | Functions | Statements |
| --- | ---: | --- | --- | --- | --- |
| compiler | 553 | 3494/7888 | 3500/8350 | 1430/2970 | 4054/10036 |
| build (landed) | 539 | 3639/7961 | 3515/8351 | 1491/3035 | 4302/10196 |

145 lines gained credit and none lost it; uncovered lines fell from 4394 to 4322. 95 compiler-only lines moved to the
line where the bundle starts the same statement (a name a line earlier). Of the 38 lines in `src/` the reproduction
listed as uncreditable, 29 are credited; the other 9 sit in code no browser test runs (live-mode `LiveIssues` and
`LiveWiki`, the wiki-edit submit path in `main.vibe`, `seed.vibe` 201), and each now carries the bundle's start, so a
test that runs it counts.

Tests: `test/browserCoverageBuild.test.vibe` (a real unminified Vite build of `e2e/coverage-fixtures/initializer.vibe`
under native V8, through `measure` with that build; failed on the old reporter with line 3 uncredited),
`test/browserStructure.test.vibe` (contained and shifted starts replaced, tree-shaken code kept, one item per start;
failed on a per-line rule with a shifted start counted twice) and `e2e/source-map.spec.ts` (the same fixture in
Chromium: only the tree-shaken line 10 stays uncovered).

## Lane vl-coverage3: surfaces, history and actions (2026-11-10)

Scope: every file under `src/surfaces/`, `src/history/` and `src/actions/` below 100% on any unit metric. At main
`88991cf3`, 17 files missed 103 items in all; after this lane and `70fb3ce6` (another lane's overlapping seed,
sequencer, flow machine and LiveMythical cases, kept; this lane's duplicates dropped), 7 files miss 15, every one
listed below. Whole unit suite at that run (main `93fb9651` plus this lane): lines 99.24%, branches 97.31%, functions 98.62%, statements 98.62% (97.18%, 93.42%, 96.82%, 95.84% at `88991cf3`; other lanes landed between).

Tests: `historyFlowEdges` (Fold with main unreadable through a faulty `MainLog`, a main listing a commit twice, a
second Bootstrap, on the engine in memory over the real sequencer), `commandsEdges` (history text with no commit, an
issue change's resume and recovery keys at the issues API, an issue draft, a wiki review, login's device code from a
loopback GitHub, a settings home that is a file), `surfaceSession` (the stored session only to its own origin, not a
look-alike port; none with no settings directory), cases in `actionClients.coverage` (follow skips other runs'
events; a JSON error that isn't the protocol), `cli.test` (a bare invocation shows the help, exit 0), `historyTools`,
`pages` and `seed`.

`src/surfaces/backend.vibe`'s per-request session guard is now `withStoredSession`, so a test reaches the cross-origin
arm no live client produces (every request URL is `origin + "/…"`). It is a trust boundary and stays.

Dead code deleted: `factory.accounts !== undefined` in the mock surface (the mock factory always has accounts),
`?? name` after `split("/").at(-1)` (catalog), the `mapError` on `MockMythical`'s page read (the sequencer's read
cannot fail), and `?? 0` for a commit's epic order (pages: decide admits no commit without its epic; no event
removes one).

Tool fix: `verify/inventory.cjs` parsed the gitignored `src/assets/wiki.generated.vibe` that `pnpm wiki:build` writes
(typecheck and test run it), overflowed the compiler pipe (ENOBUFS) and failed after any build. It now skips
`*.generated.vibe`; regression in `verify/inventory_test.cjs`, red first.

Second session (main `1e4176bc`): the cases that failed only under load are deterministic. The refused-wait case
in `signinEdges` raced a real 1,000 ms due time; `b6e944bf` landed the same fix first (GitHub answers the first
check "pending" and refuses every later poll; the case asserts two polls), and this lane kept it. `mcp.test` hosts the same server in process behind a
`ChildProcessSpawner` (`test/support/mcpInProcess.vibe`), so only the discovery case starts the built server; at
load 169 the spawned cases had missed the client's 10-second initialization deadline. Suites that sign in load
`@smthrs/platform-node` (about 600 modules) at collection rather than inside a case. Login and logout render,
including a refused mock sign-out and a refusal's own sentence, are covered in process (`commandsEdges`); the built
CLI case starts two processes instead of three. `commands.vibe` and `sessionFlow.vibe` are at 100% in the full run.

Third session (main `4513073e`): four of the six items are covered with faulty services, none by a code change.
`signinEdges` adds a settings directory whose `chmod` is refused once the device code is shown (the durable wait
fails as "Sign-in failed." after one poll, `signin.vibe:129`) and a mock session that can't be read back (signed in,
no login, `:101`). `mcpFailures` starts the MCP server against an unreachable live Factory (its sentence on stderr),
a settings store that dies (the defect on stderr) and one interrupted inside the server's own fiber (nothing
written): Effect runs `tapCause` for an interrupt the fiber raises itself, so `mcp.vibe:36` and `:38` are reached.
`mythicalEdges` plans before a commit whose rank is negative: no history `apply` builds holds one, but `decide` is
total over `History` and its proved contract promises a rank >= 0, so the guard (`mythical.vibe:562`) stays and is
tested at `decide`'s boundary rather than replaced by an unchecked `requires`. None of these files has a model path.

| Left | Why |
| --- | --- |
| `src/history/tools.vibe:93` | The implicit no-match path after an exhaustive `match`; no type-correct value reaches it. VibeLang reproduction `coverage-exhaustive-match` (nyc-01 `~/vl/vibelang-bugs/`); an emitted-output change needs Will |
| `src/history/flows.vibe:213` | V8, not the provider: line 211's conditional has a never-taken else arm that suspends (`try` compiles to `yield*`), and V8 14.6 (Node 26.5) reports that arm's 0 range through the end of the function, so lines 212-213 read 0 and the implicit else becomes 0 - 9. Plain JavaScript reproduces it (`await` too); then arms, call arms and if statements are right. Reproduction `coverage-v8-suspend-else-arm`; the source was not rewritten around it |

## Coverage inside workerd (lane vl-coverage-workerd, 2026-11-10)

`pnpm test:workerd:coverage` (PACKAGE target `workerdCoverage`, exclusive like the other coverage gates) measures the
code that runs inside workerd. V8's precise coverage is unavailable there (see "Measurement blockers"), so the
benchmark lane's Istanbul counters (0017) now serve this suite too:

```
.vibe ──vibelang esbuild plugin──▶ module JS + compiler map ──Istanbul instrumenter (input map = compiler map)──▶ bundle
  workerd isolate runs the bundle; on dispose, Runtime.evaluate reads globalThis.__coverage__ ──▶ coverage/workerd/workerd-raw/
  istanbul-lib-source-maps remaps each module's counters to .vibe through its own compiler map
Vitest V8 (Node side) ──▶ coverage/workerd/coverage-final.json
  test/workerdCoverageGate.vibe: Node's structure is the gate; workerd hits credit it by source start
  (test/support/coverageUnion.ts, vl-fuzz2's merge); a file Node never ran is gated on workerd's structure
  ──▶ coverage/workerd/merged/{coverage-final,per-file,summary}.json, 100% per file on all four metrics
```

`WORKERD_COVERAGE=1` selects measurement in `test/support/workerd.vibe` (`BENCH_COVERAGE` still selects the
benchmark's directory); every host writes its counters when it stops, and before a `reload` replaces its isolate. Each
dump's name is unique per process, so two suite workers stopping the same Worker in one millisecond keep both. A
measured Worker builds about 30% slower (88 s against 68 s for the API Worker on the shared host) and its bundle grows
from 18 MB to 30 MB, so a measured run scales every suite deadline by five (`deadline` in
`test/support/workerd.vibe`). The collection stage no longer applies Vitest's thresholds in `workerd` mode; the gate
applies them after the merge. VibeLang's maps needed no change: the compiler's per-module map locates statements at
the same source starts in both runtimes (`test/workerdCoverageShape.test.ts`).

Proof: `test/workerdCoverage.workerd.test.vibe` runs `test/support/coverageObject.vibe`'s Durable Object in local
workerd with only that module measured. An even number credits the even answer's line and not the odd one's; an odd
number moves the credit; both credit both; an even number, a reload and an odd number credit both across two dumps.

Bug fixed: `instrumentModules` replaced a module's compiler diagnostics with "compiled without a source map", because
the VibeLang plugin answers a failed compile with its errors and a stub module. It now passes the errors to esbuild.
Regression: the second case in `test/workerdCoverageShape.test.ts` (red on the old wrapper, green now).

Bug fixed: `Served.reload` replaces the isolate, so a measured Worker lost every count from before the reload. It
now dumps first. Regression: the reload case in `test/workerdCoverage.workerd.test.vibe` (red without the dump: one
dump, the even answer uncredited).

Measured on `main` at `d28aa766` plus this change, in one `pnpm test:workerd:coverage` run: before is that run's
Node-only report (what `pnpm test:workerd --coverage` reports), after is the merged gate. Same 160-file roster; all 15
suite files pass. The merged denominators are Node's to within five functions and one statement, where a file Node
never ran takes workerd's structure.

| Workerd suite | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| Node only | 13.01% (998/7671) | 4.64% (378/8143) | 6.91% (201/2907) | 10.8% (1058/9794) |
| Node and workerd | 44.88% (3443/7671) | 29.46% (2399/8143) | 33.51% (976/2912) | 40.29% (3947/9795) |

98 files carry workerd execution; 137 of 160 stay below 100%, so the gate exits 1. Every `worker/` file, before →
after (the lane report `~/vl/vl-coverage-workerd.REPORT.md` on nyc-01 holds all 160):

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `worker/Accounts.vibe` | 0 → 83.71 | 0 → 71.86 | 0 → 71.23 | 0 → 76.05 |
| `worker/ActionDirectory.vibe` | 0 → 100 | 0 → 76.92 | 0 → 100 | 0 → 96.15 |
| `worker/ActionIdentity.vibe` | 0 → 71.42 | 0 → 55 | 0 → 42.85 | 0 → 61.11 |
| `worker/ActionRuns.vibe` | 0 → 86.66 | 0 → 62.28 | 0 → 77.77 | 0 → 76.82 |
| `worker/ActionsHttp.vibe` | 0 → 97.56 | 0 → 82.1 | 0 → 70 | 0 → 81.96 |
| `worker/AgentModel.vibe` | 0 → 100 | 100 → 100 | 0 → 100 | 0 → 100 |
| `worker/Api.vibe` | 0 → 0 | 100 → 100 | 0 → 0 | 0 → 0 |
| `worker/Budget.vibe` | 0 → 90.9 | 0 → 73.68 | 0 → 100 | 0 → 87.5 |
| `worker/GitHubDelegate.vibe` | 0 → 100 | 0 → 75 | 0 → 100 | 0 → 83.33 |
| `worker/HistoryActions.vibe` | 0 → 54.54 | 0 → 21.05 | 0 → 81.81 | 0 → 54.05 |
| `worker/HistoryObject.vibe` | 0 → 91.52 | 0 → 100 | 0 → 75 | 0 → 87.83 |
| `worker/HistoryTools.vibe` | 25 → 62.5 | 100 → 100 | 0 → 50 | 25 → 62.5 |
| `worker/Http.vibe` | 0 → 97.84 | 0 → 80 | 0 → 60.86 | 0 → 86.5 |
| `worker/Issues.vibe` | 0 → 72.12 | 0 → 49.32 | 0 → 69.84 | 0 → 62.53 |
| `worker/MainLog.vibe` | 0 → 11.62 | 0 → 0 | 0 → 8.33 | 0 → 8.33 |
| `worker/ObjectStartup.vibe` | 0 → 82.6 | 0 → 63.15 | 0 → 66.66 | 0 → 81.03 |
| `worker/ObjectStorage.vibe` | 0 → 100 | 0 → 100 | 0 → 100 | 0 → 100 |
| `worker/Objects.vibe` | 0 → 88.39 | 0 → 71.42 | 0 → 86.88 | 0 → 85.81 |
| `worker/Reply.vibe` | 10.86 → 81.15 | 0 → 56.79 | 5.26 → 78.94 | 9.43 → 78.61 |
| `worker/SandboxAccounts.vibe` | 0 → 0 | 0 → 0 | 100 → 100 | 0 → 0 |
| `worker/SandboxHttp.vibe` | 0 → 80 | 0 → 58.82 | 0 → 60 | 0 → 64.28 |
| `worker/SandboxMachine.vibe` | 0 → 0 | 100 → 100 | 100 → 100 | 0 → 0 |
| `worker/SandboxTools.vibe` | 18.18 → 45.45 | 0 → 50 | 0 → 40 | 16.66 → 50 |
| `worker/Sandboxes.vibe` | 0 → 100 | 0 → 100 | 0 → 100 | 0 → 100 |
| `worker/Sequencer.vibe` | 0.84 → 83.05 | 0 → 51.61 | 0 → 88.63 | 0.71 → 79.28 |
| `worker/SpecificationReviewers.vibe` | 0 → 16.12 | 0 → 0 | 0 → 0 | 0 → 11.9 |
| `worker/Tour.vibe` | 0 → 50 | 100 → 100 | 0 → 0 | 0 → 50 |
| `worker/Unreachable.vibe` | 100 → 100 | 100 → 100 | 100 → 100 | 100 → 100 |
| `worker/VipDraft.vibe` | 0 → 60 | 0 → 30 | 0 → 12.5 | 0 → 48.78 |
| `worker/Wiki.vibe` | 0 → 29.65 | 0 → 20.43 | 0 → 14 | 0 → 24.05 |
| `worker/WikiDraft.vibe` | 0 → 12.5 | 0 → 0 | 0 → 0 | 0 → 9.09 |
| `worker/WikiTools.vibe` | 11.11 → 22.22 | 0 → 16.66 | 16.66 → 33.33 | 15.38 → 23.07 |
| `worker/accountObject.vibe` | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| `worker/agentContext.vibe` | 100 → 100 | 100 → 100 | 100 → 100 | 100 → 100 |
| `worker/apiObjects.vibe` | 0 → 28.77 | 0 → 19.71 | 0 → 22.34 | 0 → 29.76 |
| `worker/budgetDecision.vibe` | 0 → 100 | 0 → 80 | 0 → 100 | 0 → 83.33 |
| `worker/index.vibe` | 0 → 92.3 | 0 → 78.94 | 0 → 100 | 0 → 82.35 |
| `worker/liveDispatchDecision.vibe` | 0 → 100 | 0 → 50 | 0 → 100 | 0 → 63.63 |
| `worker/machineObject.vibe` | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| `worker/replyProgressDecision.vibe` | 5.88 → 52.94 | 0 → 31.25 | 10 → 50 | 4.54 → 54.54 |
| `worker/replyReasons.vibe` | 0 → 85.71 | 0 → 58.33 | 0 → 100 | 0 → 58.33 |

`worker/Api.vibe`, `worker/accountObject.vibe` and `worker/machineObject.vibe` stayed at 0% in that run: no suite host
loaded them. The second session loads all three ("Unit and fuzz gates inside workerd"). `worker/SandboxMachine.vibe` and `worker/SandboxAccounts.vibe` need a Container binding; `worker/WikiDraft.vibe`
and `worker/SpecificationReviewers.vibe` need a model. These are test gaps for the coverage lanes, not exclusions.

## Measuring every gate (lane vl-gatefix, 2026-11-10)

The audit could not complete the gates on the available hosts or 4-vCPU boxes. These commands include the app and
fuzz-flow install and the matching Chromium download. They retain the 100% thresholds: a coverage exit of 1 still
means the measured suite is below its gate, and a fuzz target with zero executions still fails.

**Required box image:** Node **>= 26.4** (`engines.node`; nyc-01 uses 26.5.0), git **>= 2.41** for jj's real repository
fixtures, Python 3, and the Playwright system libraries for browser gates. The current `node`/`playwright` boxes have
Node **24.22.2** and git **2.39.5**. Request to the lead: upgrade both images; keep the repository's engine requirement.
The old git fails `test/mythicalSeedProcess.test.vibe` and `bench/scripts.bench.vibe`. Receipts from that image are
identified below; they do not establish support for Node 24. Install the proof tools once with `bash verify/install.sh`.

From the lane workspace on nyc-01 (`ws` names that workspace), run one command per gate after these shell variables:

```sh
ws="$HOME/vl/ws-gatefix"
I='cd ../.. && pnpm install --frozen-lockfile --filter "@smthrs/vibelang-site..." --filter "@smithers/release-workflows..." && cd apps/vibelang'
B="$I && export PLAYWRIGHT_BROWSERS_PATH=\$PWD/node_modules/.cache/ms-playwright && pnpm exec playwright install chromium"
```

```sh
~/lanes/bin/run-heavy --name vl-gatefix:unit --image node --cores 4 "$ws/apps/vibelang" -- "$I && pnpm test:coverage"
~/lanes/bin/run-heavy --name vl-gatefix:fuzz --image playwright --cores 4 "$ws/apps/vibelang" -- "$I && E2E_PORT=4552 pnpm fuzz:coverage"
~/lanes/bin/run-heavy --name vl-gatefix:bench --image playwright --cores 4 --env BENCH_REVISION="$(cd "$ws" && jj log --no-graph -r @ -T commit_id)" "$ws/apps/vibelang" -- "$B && E2E_PORT=4552 pnpm bench:coverage"
~/lanes/bin/run-heavy --name vl-gatefix:e2e --image playwright --cores 4 "$ws/apps/vibelang" -- "$B && E2E_PORT=4552 pnpm e2e:coverage"
~/lanes/bin/run-heavy --name vl-gatefix:proofs --image node --cores 2 --add apps/vibelang/verify/.tools "$ws/apps/vibelang" -- "$I && pnpm verify"
~/lanes/bin/run-heavy --name vl-gatefix:mutations --image node --cores 2 --add apps/vibelang/verify/.tools "$ws/apps/vibelang" -- "$I && CHECK_JOBS=2 pnpm verify:broken"
```

`run-heavy` packs tracked sources, without node_modules or a jj checkout. Every command installs inside that tree;
proof commands also carry the downloaded Dafny files and rebuild vendored LemmaScript there. The fuzz flow installs
its matching Chromium itself. `BENCH_REVISION` is captured before packing; artifacts in a checkout prefer its own `@`.
Use `pnpm bench` instead of `pnpm bench:coverage` for timing measurements with the same install/revision arguments.
A box-image upgrade is a prerequisite for the supported configuration above, not a reason to lower `engines.node`.

What changed so these run anywhere:

- **Browser phases.** `playwright.config.ts`, `bench/playwright.config.ts`, `bench/playwright-faults.config.ts` and `fuzz/browser.config.ts` build the site
  inside Playwright's `webServer`. Its limit was 120 s (fuzz 180 s); the build takes longer on a box or a loaded host,
  so no browser phase ran there. The limit is now `E2E_SERVER_SECONDS`, default 600 s, and the fuzz flow passes it
  through (`.smithers/flows/vibelang-fuzz`, v7). The benchmark's global deadline and its parent Vitest timeout grow with it; the wrapper accepts the executed workload count instead of a stale fixed count.
- **Browser coverage on a small disk.** Each test's Chromium evidence repeated the whole bundle and its source map
  (about 20 MB), so `pnpm e2e:coverage` filled a box's disk (`ENOSPC`, then crashed pages: 70 of 300 checks) before
  the phone project ended. A test's file now keeps its ranges and names the script by content; `e2e/coverageStore.ts`
  writes each source and map once per run under `test-results/chromium-scripts` (`test/e2eCoverageStore.test.vibe`).
- **The fuzz flow's install.** `pnpm fuzz` runs `scripts/fuzz-preflight.vibe` first: when `.smithers/flows` lacks a
  package the flow imports, it names them and the install above instead of failing on `Cannot find module`
  (`test/fuzzPreflight.test.vibe`).
- **`lsc` link.** `verify/.tools/bin/lsc` was an absolute link into `packages/lemmascript`; `run-heavy --add` delivers
  it to a box as a copied file that cannot resolve `ts-morph`. `install-common.sh` makes it relative, and
  `lsc_fresh.py` (run first by `verify` and `verify:broken`) restores the link over a copy (`harness_test.py`).
- **Benchmark revision.** `bench/artifact.vibe` and `bench/browser.spec.ts` read the commit only from `jj`, so on a
  box 68 of 69 benchmark files, and every browser workload, failed before their work. `revision` takes the checkout's `@`, or `BENCH_REVISION` where there is no checkout,
  and still refuses anything but a 40-hex id (`test/benchArtifact.test.vibe`).
- **Fuzz budget floor.** A target whose saved failures replay inside the deadline before its first new execution ran
  none at the coverage budget of 5 s (`NoExecution`). `10b73c23` gave `run` a `minimum` (`REPLAY_FLOOR`, 15 s) for the
  steered-host targets; `surfaces/cli-arguments` and `surfaces/mcp-arguments` (4.6 s per replay and execution on an
  idle box) now declare it too. Instrumented cold replay also needs 60 s for `issues/steered-host`,
  `actions/object-lifecycles` and `api-objects/world`, and 30 s for `objects/conversation-host` and
  `storage/conversation-flows`. Workerd setup hooks get 600 s; each API-world operation remains bounded at 20 s,
  matching the object-host target. A target that executes nothing still fails.
- **Fuzz denominator.** `fuzz.config.ts` and `fuzz/coverage.vibe` counted `src/` and `worker/` without
  `worker/Api.vibe`; they now count the unit gate's roster, `src/`, `worker/`, `scripts/` and `infra/`, none excluded.
- **Proof inventory.** A function marked `//@ verify` read "Not yet proved" unless `verify/inventory.cjs` had a
  hand-written note for its module; `decide` (`src/core/decide.vibe:90`) and six other modules had none. The inventory
  now reads the mark (`inventory_test.cjs`): 79 rows read proved, and "Not yet proved" rows fall from 1017 to 958.

<!-- gatefix-measured -->


### Audit claim reconciliation

The audit's fourteen claims are reconciled as follows. Historical receipts retain their original revision; none is
presented as a current-main 100% result. Corrections from the proof, test-quality and workerd lanes are preserved.

| Claim audited | Current statement and evidence |
| --- | --- |
| Workerd execution remains uncredited | `pnpm test:workerd:coverage` uses 0017's per-module Istanbul counters; precise V8 coverage is still unavailable. |
| `worker/Api.vibe` must wait for a VibeLang release and precise workerd coverage | Closed by vl-coverage-workerd: the unit and fuzz gates load and instrument `worker/Api.vibe` through Alchemy's actual build and bridges ("Unit and fuzz gates inside workerd" below). |
| Every suite already counts every production source | The fuzz roster now matches `src/`, `worker/`, `scripts/`, `infra/`, including `worker/Api.vibe`; previous totals used smaller rosters. |
| Sandbox decision proves accrued minutes | 0018 distinguishes the decision's zero-elapsed call site from the actual meter; its separate meter contracts remain proof-lane work. |
| Marked `decide` is “Not yet proved” | Inventory status reads each function's `//@ verify`; the proof gate checks the marked modules. Custom notes describe scope, not discovery. |
| Every rejected mutation proves a postcondition in its function | 0018 explicitly includes a callee's failed precondition at a call in that function, and says generated-mutant rejection does not prove contract completeness. |
| Roadmap 1d has 17 modules / 962 mutations | Updated to the audit's dated 33 / 1601 receipt; current-run counts are reported separately below. |
| Production `/history` returns 404 | Rulings-status VL-3 records the audit's 200 response on 2026-11-10 and the deployed revision, which still predates main. |
| Sign-in has not landed, so every live caller is a viewer | 0020 restricts that statement to the older deployment; main derives history's principal from the session role. |
| No GitHub happy-path doubles exist | 0016 and 0017 name the existing protocol doubles and the unresolved ruling; this tooling change adds none and grants no exception. |
| The stored approval time is always present | 0015 and 0016 now record the tested mapping: preserve `approvedAt` only when stored; the old `approvedAt!` wrote an invalid undefined field. |
| Every benchmark passes on available machines | 0017 distinguishes the idle-host receipt, the audit's build-limit failure and these off-checkout measurements. |
| Roadmap benchmark coverage remains 82.82% / 95 files below | Updated to the lane's last 90.52% / 100-file receipt and the audit's 109-of-159 result without Chromium; all are dated evidence. |
| Designs only live in the host's handoff directory and the index lists two | `wiki/designs/index.md` lists all nine repository handoffs and their implementation decisions; VL-29 links there. |

The instrumented single-execution profile on an idle 4-vCPU box passed 201 checks and retained 200 target receipts,
all with at least one execution. The slowest fresh walks were `api-objects/world` (26.153 s) and
`issues/steered-host` (24.834 s, including one replay). `actions/object-lifecycles` took 8.195 s including one replay;
CLI and MCP argument targets took 5.521 s and 5.623 s. These support the explicit per-target floors above.
This is timing evidence for setup budgets, not a replacement for the ordinary multi-execution coverage command.

The proof harness also used `--cores 8` for assertion-isolated positive modules even when `run-heavy` requested two
cores. It now passes at most two (`verify/harness_test.py` checks the actual invocation receipt and the configured
command before starting a solver). Proof obligations, solver limits and the mutation rejection rules are unchanged.

The benchmark lane added `bench/playwright-faults.config.ts` during the gatefix rebase. Its build and global deadlines
also read `E2E_SERVER_SECONDS`. The moved artifact writer, `bench/browser-support.ts`, retains the same off-checkout
revision fallback for both browser phases; the benchmark lane's helper extraction and navigation evidence are preserved.

## vl-coverage, Codex continuation after session 13 (2026-11-10)

The lead's known-red gate ruling above is settled. All four coverage gates retain their 100% per-file thresholds and
stay exclusive until each passes and joins the default gate in that passing commit.

The fixture factories' unreachable flow/default arms and injected-engine seams landed in `10ae763b`; their cycle,
identity and multi-defect tests use faulty Effect runtimes over the real memory engine. The specification revision
decision in `605333cd` takes a policy and tests both keep and reset. Production stays keep; conversation.vibe and
its proved revision arms are unchanged.

The sandbox fixture now accepts the same engine seam. Every operation preserves Refused and Unavailable reasons;
a flow cycle becomes sandbox-flow unavailability. The signed-out policy determines the role. Wiki recovery scenes
retain the edit and assert the actual Connect, Fork and Install destinations. The wiki pane accepts its document
corpus (production: the built pages), so archived Replaced status is exercised through the real component.

Tour view/theatre callers use a total stop lookup. A first-failing boundary regression caught undefined results for
fractional/NaN inputs in the carried patch; the lookup rounds to the nearest stop, clamps the range and infinities,
and selects the first stop for NaN. A heading's anchor, ended-tour status, restarted wiki key on another page and
generator decisions without a Rulings line or with no named rulings are covered too.

The seed program is separate from its CLI entry so its output URL and Effect host services can be supplied. A faulty
ChildProcessSpawner still runs real jj but reports a shortened-hash collision while retaining distinct full hashes
and consistent parent links. The command refuses that replay, keeps the previous output and recovers byte-identical
output with the real host. Its Refused error now retains only a count: the previous serialized intent could expose
commit text in CLI error logs. Both failure regressions fail before their fixes. The refusal guard remains.

Three behavioral mutations are detected by five assertion failures; production files are restored and byte-checked.
No dependency is added. The same Vitest/V8 5.0.0 and original .vibe maps are used. No production source is excluded.
The remaining lane-owned unit gaps are the recorded V8 suspend/else range defect in history/flows and generated
exhaustive-match fallthrough in history/tools; their reproductions remain in the denominator. Current measurements,
including all worker/core gaps owned by the other coverage lane, follow below with exact snapshot provenance.


### Measured continuation snapshot

Runtime/test input: base main `f765f8ed` plus the three lane changes at `0852e764c332`; source archive and exact
input id are retained in session14/input-source.tgz and final-input-tip.txt. Tables were added after measurement.
The unit before-column is the retained 15:24 snapshot; the Chromium before-column is session 8's frozen report.
Source rosters and counter structures change, so these are dated snapshots. A dash is an absent source, never an
exclusion. Cells are covered/total, before → after; zero-runtime metrics retain their zero denominators.

Unit: 2,078 passed, one expected failure, four skipped; 239 files passed / three skipped. All ordinary assertions
pass. Coverage alone exits 1: lines 7,713/7,769 (99.27%), branches 8,096/8,221 (98.47%), functions 2,906/2,937
(98.94%), statements 9,816/9,920 (98.95%); 27 of 164 files are below 100%. Fresh-main typecheck, inventory,
target-index generation and target-index lint all exit 0.

The new main file scripts/fuzz-preflight.vibe remains at zero despite its CLI test passing. A five-line native Vibe
program and plain JavaScript control isolate the problem: two real subprocess assertions pass, JS gets 100%, and Vibe
gets zero while the provider reports a parse error at raw effect syntax. Reproduction and controls:
`~/vl/vibelang-bugs/coverage-native-loader/`. Exact-executable and source-map config probes do not fix it and were
reverted. This is a collection gap; no compiler behavior or provider code was changed. The zero stays in the gate.
Resolved later the same day: the cause is Vitest's subprocess transform, and the script now runs as emitted JavaScript
(the subprocess paragraph above).

| File | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | ---: | ---: |
| `infra/SandboxImage.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 2/2 → 2/2 |
| `infra/Stack.vibe` | 8/8 → 8/8 | 6/6 → 6/6 | 0/0 → 0/0 | 8/8 → 8/8 |
| `infra/WorkerBuild.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `scripts/agent-context.vibe` | 22/22 → 22/22 | 4/4 → 4/4 | 5/5 → 5/5 | 23/23 → 23/23 |
| `scripts/fuzz-preflight.vibe` | — → 0/16 | — → 0/4 | — → 0/3 | — → 0/18 |
| `scripts/mythical-seed-program.vibe` | — → 50/50 | — → 18/18 | — → 15/15 | — → 63/63 |
| `scripts/mythical-seed.vibe` | 51/51 → 1/1 | 17/18 → 0/0 | 15/16 → 0/0 | 63/65 → 1/1 |
| `scripts/wiki.vibe` | 30/30 → 30/30 | 28/28 → 28/28 | 8/8 → 8/8 | 38/38 → 38/38 |
| `src/actions/Actions.vibe` | 4/4 → 4/4 | 0/0 → 0/0 | 0/0 → 0/0 | 4/4 → 4/4 |
| `src/actions/LiveActions.vibe` | 43/43 → 43/43 | 21/21 → 21/21 | 25/25 → 25/25 | 54/54 → 54/54 |
| `src/actions/MockActions.vibe` | 114/114 → 114/114 | 85/85 → 85/85 | 40/40 → 40/40 | 153/153 → 153/153 |
| `src/actions/agent.vibe` | 11/11 → 11/11 | 0/0 → 0/0 | 12/12 → 12/12 | 17/17 → 17/17 |
| `src/actions/catalog.vibe` | 9/9 → 9/9 | 26/26 → 26/26 | 2/2 → 2/2 | 9/9 → 9/9 |
| `src/actions/catalogDecision.vibe` | 3/3 → 3/3 | 12/12 → 12/12 | 2/2 → 2/2 | 4/4 → 4/4 |
| `src/actions/execution.vibe` | 38/38 → 38/38 | 36/36 → 36/36 | 18/18 → 18/18 | 41/41 → 41/41 |
| `src/actions/tools.vibe` | 13/13 → 13/13 | 1/1 → 1/1 | 7/7 → 7/7 | 14/14 → 14/14 |
| `src/actions/wire.vibe` | 6/6 → 6/6 | 0/0 → 0/0 | 0/0 → 0/0 | 6/6 → 6/6 |
| `src/assets/wiki.generated.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 2/2 → 2/2 |
| `src/core/Factory.vibe` | 3/3 → 3/3 | 0/0 → 0/0 | 0/0 → 0/0 | 3/3 → 3/3 |
| `src/core/IssuesFactory.vibe` | 74/74 → 74/74 | 118/118 → 118/118 | 15/15 → 15/15 | 96/96 → 96/96 |
| `src/core/LiveAccounts.vibe` | 26/26 → 26/26 | 12/12 → 12/12 | 13/13 → 13/13 | 32/32 → 32/32 |
| `src/core/LiveFactory.vibe` | 77/77 → 77/77 | 30/30 → 30/30 | 20/20 → 20/20 | 89/89 → 89/89 |
| `src/core/LiveIssues.vibe` | 11/11 → 11/11 | 6/6 → 6/6 | 7/7 → 7/7 | 16/16 → 16/16 |
| `src/core/LiveWiki.vibe` | 15/15 → 15/15 | 4/4 → 4/4 | 10/10 → 10/10 | 21/21 → 21/21 |
| `src/core/MockAccounts.vibe` | 76/76 → 76/76 | 30/34 → 30/34 | 25/26 → 25/26 | 98/101 → 98/101 |
| `src/core/MockFactory.vibe` | 266/266 → 266/266 | 138/139 → 138/139 | 79/79 → 79/79 | 319/320 → 319/320 |
| `src/core/MockJournal.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 3/3 → 3/3 | 4/4 → 4/4 |
| `src/core/VipWriter.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `src/core/WikiFactory.vibe` | 62/62 → 62/62 | 69/69 → 69/69 | 21/21 → 21/21 | 85/85 → 85/85 |
| `src/core/WikiWriter.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `src/core/accountCookieDecision.vibe` | 5/5 → 5/5 | 15/15 → 15/15 | 3/3 → 3/3 | 7/7 → 7/7 |
| `src/core/accountCookies.vibe` | 7/7 → 7/7 | 0/0 → 0/0 | 2/2 → 2/2 | 8/8 → 8/8 |
| `src/core/conversation.vibe` | 246/246 → 246/246 | 410/410 → 410/410 | 80/80 → 80/80 | 339/339 → 339/339 |
| `src/core/decide.vibe` | 55/55 → 55/55 | 107/107 → 107/107 | 6/6 → 6/6 | 87/87 → 87/87 |
| `src/core/flowDecision.vibe` | 53/53 → 53/53 | 105/105 → 105/105 | 24/24 → 24/24 | 68/68 → 68/68 |
| `src/core/flows.vibe` | 196/196 → 196/196 | 62/66 → 62/66 | 72/72 → 72/72 | 204/206 → 204/206 |
| `src/core/followDecision.vibe` | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 | 2/2 → 2/2 |
| `src/core/identityDecision.vibe` | 2/2 → 2/2 | 4/4 → 4/4 | 1/1 → 1/1 | 3/3 → 3/3 |
| `src/core/issueFlows.vibe` | 34/34 → 34/34 | 20/20 → 20/20 | 11/11 → 11/11 | 40/40 → 40/40 |
| `src/core/issueSchemas.vibe` | 12/12 → 12/12 | 0/0 → 0/0 | 2/2 → 2/2 | 12/12 → 12/12 |
| `src/core/mockDecision.vibe` | 17/17 → 17/17 | 6/6 → 6/6 | 4/4 → 4/4 | 19/19 → 19/19 |
| `src/core/mockReplies.vibe` | 17/17 → 17/17 | 4/4 → 4/4 | 6/6 → 6/6 | 19/19 → 19/19 |
| `src/core/protocolDecision.vibe` | 22/22 → 22/22 | 54/54 → 54/54 | 14/14 → 14/14 | 30/30 → 30/30 |
| `src/core/roles.vibe` | 5/5 → 5/5 | 1/1 → 1/1 | 1/1 → 1/1 | 5/5 → 5/5 |
| `src/core/sandboxDecision.vibe` | 59/59 → 59/59 | 78/78 → 78/78 | 16/16 → 16/16 | 80/80 → 80/80 |
| `src/core/sandboxHost.vibe` | 175/175 → 175/175 | 137/137 → 137/137 | 27/27 → 27/27 | 209/209 → 209/209 |
| `src/core/sandboxMeter.vibe` | 33/33 → 33/33 | 35/35 → 35/35 | 7/7 → 7/7 | 39/39 → 39/39 |
| `src/core/sandboxMock.vibe` | 47/47 → 47/47 | 45/46 → 46/46 | 23/23 → 23/23 | 72/72 → 72/72 |
| `src/core/sandboxPolicy.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 3/3 → 3/3 | 4/4 → 4/4 |
| `src/core/schemas.vibe` | 30/30 → 30/30 | 0/0 → 0/0 | 0/0 → 0/0 | 30/30 → 30/30 |
| `src/core/sequenceDecision.vibe` | 23/23 → 23/23 | 18/18 → 18/18 | 10/10 → 10/10 | 27/27 → 27/27 |
| `src/core/sequencerDecision.vibe` | 16/16 → 16/16 | 28/28 → 28/28 | 8/8 → 8/8 | 23/23 → 23/23 |
| `src/core/specification.vibe` | 34/34 → 34/34 | 59/59 → 59/59 | 6/6 → 6/6 | 46/46 → 46/46 |
| `src/core/toolRefusal.vibe` | 5/5 → 5/5 | 18/18 → 18/18 | 1/1 → 1/1 | 6/6 → 6/6 |
| `src/core/tourDecision.vibe` | 9/9 → 9/9 | 23/23 → 23/23 | 4/4 → 4/4 | 14/14 → 14/14 |
| `src/core/walkthroughSteps.vibe` | 3/3 → 4/4 | 0/0 → 2/2 | 1/1 → 1/1 | 3/3 → 4/4 |
| `src/core/wiki.vibe` | 15/15 → 15/15 | 22/22 → 22/22 | 10/10 → 10/10 | 27/27 → 27/27 |
| `src/core/wikiDecision.vibe` | 1/1 → 1/1 | 3/3 → 3/3 | 1/1 → 1/1 | 1/1 → 1/1 |
| `src/core/wikiFlows.vibe` | 34/34 → 34/34 | 23/23 → 23/23 | 11/11 → 11/11 | 40/40 → 40/40 |
| `src/core/wikiLinks.vibe` | 15/15 → 15/15 | 29/29 → 29/29 | 1/1 → 1/1 | 18/18 → 18/18 |
| `src/core/wikiSchemas.vibe` | 5/5 → 5/5 | 0/0 → 0/0 | 0/0 → 0/0 | 5/5 → 5/5 |
| `src/core/wire.vibe` | 27/27 → 27/27 | 14/14 → 14/14 | 3/3 → 3/3 | 31/31 → 31/31 |
| `src/history/LiveMythical.vibe` | 41/41 → 41/41 | 12/12 → 12/12 | 16/16 → 16/16 | 47/47 → 47/47 |
| `src/history/MockMythical.vibe` | 35/35 → 35/35 | 5/5 → 5/5 | 27/27 → 27/27 | 42/42 → 42/42 |
| `src/history/MythicalHistory.vibe` | 2/2 → 2/2 | 2/2 → 2/2 | 1/1 → 1/1 | 3/3 → 3/3 |
| `src/history/Sequencer.vibe` | 94/94 → 94/94 | 36/36 → 36/36 | 35/35 → 35/35 | 110/110 → 110/110 |
| `src/history/flowMachine.vibe` | 50/50 → 50/50 | 91/91 → 91/91 | 21/21 → 21/21 | 68/68 → 68/68 |
| `src/history/flows.vibe` | 105/105 → 105/105 | 13/14 → 13/14 | 51/51 → 51/51 | 113/113 → 113/113 |
| `src/history/mythical.vibe` | 141/141 → 141/141 | 191/191 → 191/191 | 29/29 → 29/29 | 195/195 → 195/195 |
| `src/history/pageDecision.vibe` | 5/5 → 5/5 | 8/8 → 8/8 | 3/3 → 3/3 | 7/7 → 7/7 |
| `src/history/pages.vibe` | 36/36 → 36/36 | 26/26 → 26/26 | 20/20 → 20/20 | 46/46 → 46/46 |
| `src/history/roles.vibe` | 4/4 → 4/4 | 0/0 → 0/0 | 1/1 → 1/1 | 4/4 → 4/4 |
| `src/history/schemas.vibe` | 31/31 → 31/31 | 0/0 → 0/0 | 3/3 → 3/3 | 33/33 → 33/33 |
| `src/history/seed.vibe` | 161/161 → 161/161 | 87/87 → 87/87 | 25/25 → 25/25 | 185/185 → 185/185 |
| `src/history/seed/vibelang.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 2/2 → 2/2 |
| `src/history/seedDecision.vibe` | 25/25 → 25/25 | 40/40 → 40/40 | 7/7 → 7/7 | 38/38 → 38/38 |
| `src/history/stackDecision.vibe` | 15/15 → 15/15 | 25/25 → 25/25 | 7/7 → 7/7 | 23/23 → 23/23 |
| `src/history/tools.vibe` | 29/29 → 29/29 | 46/47 → 46/47 | 9/9 → 9/9 | 36/36 → 36/36 |
| `src/history/wire.vibe` | 35/35 → 35/35 | 35/35 → 35/35 | 5/5 → 5/5 | 43/43 → 43/43 |
| `src/surfaces/backend.vibe` | 45/45 → 45/45 | 31/31 → 31/31 | 15/15 → 15/15 | 58/58 → 58/58 |
| `src/surfaces/cli-entry.vibe` | 8/8 → 8/8 | 2/2 → 2/2 | 2/2 → 2/2 | 9/9 → 9/9 |
| `src/surfaces/cli.vibe` | 16/16 → 16/16 | 10/10 → 10/10 | 6/6 → 6/6 | 18/18 → 18/18 |
| `src/surfaces/commandDecision.vibe` | 22/22 → 22/22 | 64/64 → 64/64 | 17/17 → 17/17 | 23/23 → 23/23 |
| `src/surfaces/commands.vibe` | 171/171 → 171/171 | 112/112 → 112/112 | 73/73 → 73/73 | 207/207 → 207/207 |
| `src/surfaces/manifest.vibe` | 4/4 → 4/4 | 0/0 → 0/0 | 2/2 → 2/2 | 5/5 → 5/5 |
| `src/surfaces/mcp-entry.vibe` | 6/6 → 6/6 | 0/0 → 0/0 | 1/1 → 1/1 | 6/6 → 6/6 |
| `src/surfaces/mcp.vibe` | 17/17 → 17/17 | 4/4 → 4/4 | 6/6 → 6/6 | 20/20 → 20/20 |
| `src/surfaces/session.vibe` | 63/63 → 63/63 | 24/24 → 24/24 | 22/22 → 22/22 | 75/75 → 75/75 |
| `src/surfaces/sessionFlow.vibe` | 40/40 → 40/40 | 2/2 → 2/2 | 20/20 → 20/20 | 50/50 → 50/50 |
| `src/surfaces/signin.vibe` | 115/115 → 115/115 | 108/108 → 108/108 | 30/30 → 30/30 | 153/153 → 153/153 |
| `src/web/actionModel.vibe` | 14/14 → 14/14 | 19/19 → 19/19 | 7/7 → 7/7 | 16/16 → 16/16 |
| `src/web/actionView.vibe` | 30/30 → 30/30 | 123/123 → 123/123 | 27/27 → 27/27 | 41/41 → 41/41 |
| `src/web/backend.vibe` | 64/64 → 64/64 | 15/15 → 15/15 | 38/38 → 38/38 | 72/72 → 72/72 |
| `src/web/entry.vibe` | 8/8 → 8/8 | 4/4 → 4/4 | 0/0 → 0/0 | 8/8 → 8/8 |
| `src/web/historyApp.vibe` | 152/152 → 152/152 | 54/54 → 54/54 | 97/97 → 97/97 | 192/192 → 192/192 |
| `src/web/historyBackend.vibe` | 26/26 → 26/26 | 6/6 → 6/6 | 16/16 → 16/16 | 29/29 → 29/29 |
| `src/web/historyDecision.vibe` | 42/42 → 42/42 | 31/31 → 31/31 | 29/29 → 29/29 | 48/48 → 48/48 |
| `src/web/historyStartup.vibe` | 32/32 → 32/32 | 12/12 → 12/12 | 8/8 → 8/8 | 38/38 → 38/38 |
| `src/web/historyView.vibe` | 73/73 → 73/73 | 145/145 → 145/145 | 43/43 → 43/43 | 82/82 → 82/82 |
| `src/web/issueDecision.vibe` | 91/91 → 91/91 | 257/257 → 257/257 | 22/22 → 22/22 | 142/142 → 142/142 |
| `src/web/issues.vibe` | 21/21 → 21/21 | 36/36 → 36/36 | 6/6 → 6/6 | 26/26 → 26/26 |
| `src/web/issuesView.vibe` | 83/83 → 83/83 | 435/435 → 435/435 | 78/78 → 78/78 | 118/118 → 118/118 |
| `src/web/main.vibe` | 666/666 → 667/667 | 815/815 → 819/819 | 369/369 → 369/369 | 883/883 → 884/884 |
| `src/web/markdown.vibe` | 106/106 → 106/106 | 95/95 → 95/95 | 27/27 → 27/27 | 151/151 → 151/151 |
| `src/web/media.vibe` | 6/6 → 6/6 | 0/0 → 0/0 | 2/2 → 2/2 | 7/7 → 7/7 |
| `src/web/modeSwitch.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 1/1 → 1/1 | 2/2 → 2/2 |
| `src/web/modelDecision.vibe` | 78/78 → 78/78 | 112/112 → 112/112 | 51/51 → 51/51 | 95/95 → 95/95 |
| `src/web/paneDecision.vibe` | 18/18 → 20/20 | 42/42 → 48/48 | 15/15 → 17/17 | 20/20 → 22/22 |
| `src/web/roleView.vibe` | 24/24 → 24/24 | 66/66 → 66/66 | 14/14 → 14/14 | 27/27 → 27/27 |
| `src/web/sandboxView.vibe` | 19/19 → 19/19 | 88/88 → 88/88 | 6/6 → 6/6 | 21/21 → 21/21 |
| `src/web/screenDecision.vibe` | 46/46 → 46/46 | 102/102 → 102/102 | 30/30 → 30/30 | 58/58 → 58/58 |
| `src/web/startup.vibe` | 50/50 → 50/50 | 22/22 → 22/22 | 13/13 → 13/13 | 64/64 → 64/64 |
| `src/web/startupDecision.vibe` | 11/11 → 11/11 | 22/22 → 22/22 | 8/8 → 8/8 | 14/14 → 14/14 |
| `src/web/styles.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 2/2 → 2/2 | 2/2 → 2/2 |
| `src/web/theatre.vibe` | 45/45 → 45/45 | 38/38 → 38/38 | 7/7 → 7/7 | 51/51 → 51/51 |
| `src/web/theatreDecision.vibe` | 18/18 → 18/18 | 56/56 → 56/56 | 5/5 → 5/5 | 31/31 → 31/31 |
| `src/web/tourDecision.vibe` | 27/27 → 27/27 | 54/54 → 54/54 | 19/19 → 19/19 | 33/33 → 33/33 |
| `src/web/updateDecision.vibe` | 42/42 → 42/42 | 105/105 → 105/105 | 14/14 → 14/14 | 62/62 → 62/62 |
| `src/web/view.vibe` | 53/53 → 53/53 | 159/159 → 159/159 | 33/33 → 33/33 | 58/58 → 58/58 |
| `src/web/viewDecision.vibe` | 22/22 → 22/22 | 52/52 → 52/52 | 13/13 → 13/13 | 31/31 → 31/31 |
| `src/web/viewport.vibe` | 37/37 → 37/37 | 41/41 → 41/41 | 14/14 → 14/14 | 45/45 → 45/45 |
| `src/web/wikiView.vibe` | 28/28 → 27/27 | 91/95 → 96/96 | 19/19 → 19/19 | 39/39 → 38/38 |
| `worker/Accounts.vibe` | 286/312 → 286/312 | 310/361 → 310/361 | 66/73 → 66/73 | 391/430 → 391/430 |
| `worker/ActionDirectory.vibe` | 37/37 → 37/37 | 22/26 → 22/26 | 20/20 → 20/20 | 52/52 → 52/52 |
| `worker/ActionIdentity.vibe` | 14/14 → 14/14 | 19/20 → 19/20 | 7/7 → 7/7 | 18/18 → 18/18 |
| `worker/ActionRuns.vibe` | 120/120 → 120/120 | 173/178 → 173/178 | 36/36 → 36/36 | 161/163 → 161/163 |
| `worker/ActionsHttp.vibe` | 41/41 → 41/41 | 91/95 → 91/95 | 9/10 → 9/10 | 60/61 → 60/61 |
| `worker/AgentModel.vibe` | 9/9 → 9/9 | 0/0 → 0/0 | 3/3 → 3/3 | 9/9 → 9/9 |
| `worker/Api.vibe` | 46/46 → 46/46 | 0/0 → 0/0 | 0/1 → 0/1 | 46/47 → 46/47 |
| `worker/Budget.vibe` | 22/22 → 22/22 | 19/19 → 19/19 | 4/4 → 4/4 | 24/24 → 24/24 |
| `worker/GitHubDelegate.vibe` | 4/4 → 4/4 | 11/11 → 11/11 | 3/3 → 3/3 | 6/6 → 6/6 |
| `worker/HistoryActions.vibe` | 30/33 → 30/33 | 15/19 → 15/19 | 9/11 → 9/11 | 32/37 → 32/37 |
| `worker/HistoryObject.vibe` | 57/59 → 57/59 | 15/15 → 15/15 | 29/32 → 29/32 | 71/74 → 71/74 |
| `worker/HistoryTools.vibe` | 8/8 → 8/8 | 0/0 → 0/0 | 6/6 → 6/6 | 8/8 → 8/8 |
| `worker/Http.vibe` | 93/93 → 93/93 | 100/100 → 100/100 | 23/23 → 23/23 | 126/126 → 126/126 |
| `worker/Issues.vibe` | 297/298 → 297/298 | 450/453 → 450/453 | 64/66 → 64/66 | 399/401 → 399/401 |
| `worker/MainLog.vibe` | 42/42 → 42/42 | 26/27 → 26/27 | 12/12 → 12/12 | 57/58 → 57/58 |
| `worker/ObjectStartup.vibe` | 60/60 → 60/60 | 27/27 → 27/27 | 16/16 → 16/16 | 75/75 → 75/75 |
| `worker/ObjectStorage.vibe` | 10/10 → 10/10 | 6/6 → 6/6 | 11/11 → 11/11 | 14/14 → 14/14 |
| `worker/Objects.vibe` | 111/112 → 111/112 | 44/47 → 44/47 | 58/59 → 58/59 | 139/140 → 139/140 |
| `worker/PublicReads.vibe` | 12/12 → 12/12 | 6/6 → 6/6 | 12/12 → 12/12 | 19/19 → 19/19 |
| `worker/Reply.vibe` | 138/138 → 138/138 | 80/81 → 80/81 | 19/19 → 19/19 | 159/159 → 159/159 |
| `worker/SandboxAccounts.vibe` | 11/11 → 11/11 | 2/2 → 2/2 | 0/0 → 0/0 | 12/12 → 12/12 |
| `worker/SandboxHttp.vibe` | 28/30 → 28/30 | 33/34 → 33/34 | 7/10 → 7/10 | 39/42 → 39/42 |
| `worker/SandboxMachine.vibe` | 4/4 → 4/4 | 0/0 → 0/0 | 0/0 → 0/0 | 4/4 → 4/4 |
| `worker/SandboxTools.vibe` | 8/11 → 8/11 | 1/2 → 1/2 | 7/10 → 7/10 | 9/12 → 9/12 |
| `worker/Sandboxes.vibe` | 22/22 → 22/22 | 21/21 → 21/21 | 17/17 → 17/17 | 37/37 → 37/37 |
| `worker/Sequencer.vibe` | 118/118 → 118/118 | 60/62 → 60/62 | 44/44 → 44/44 | 140/140 → 140/140 |
| `worker/SpecificationReviewers.vibe` | 31/31 → 31/31 | 8/8 → 8/8 | 8/9 → 8/9 | 41/42 → 41/42 |
| `worker/Tour.vibe` | 1/2 → 1/2 | 0/0 → 0/0 | 0/1 → 0/1 | 1/2 → 1/2 |
| `worker/Unreachable.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `worker/VipDraft.vibe` | 30/30 → 30/30 | 10/10 → 10/10 | 7/8 → 7/8 | 40/41 → 40/41 |
| `worker/Wiki.vibe` | 175/175 → 175/175 | 234/234 → 234/234 | 49/49 → 49/49 | 240/240 → 240/240 |
| `worker/WikiDraft.vibe` | 32/32 → 32/32 | 14/14 → 14/14 | 7/8 → 7/8 | 43/44 → 43/44 |
| `worker/WikiTools.vibe` | 9/9 → 9/9 | 6/6 → 6/6 | 6/6 → 6/6 | 13/13 → 13/13 |
| `worker/accountObject.vibe` | 48/48 → 48/48 | 35/35 → 35/35 | 39/39 → 39/39 | 79/79 → 79/79 |
| `worker/agentContext.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `worker/apiObjects.vibe` | 214/214 → 214/214 | 70/73 → 70/73 | 94/94 → 94/94 | 254/254 → 254/254 |
| `worker/budgetDecision.vibe` | 5/5 → 5/5 | 5/5 → 5/5 | 4/4 → 4/4 | 6/6 → 6/6 |
| `worker/index.vibe` | 13/13 → 13/13 | 19/19 → 19/19 | 2/2 → 2/2 | 17/17 → 17/17 |
| `worker/liveDispatchDecision.vibe` | 7/7 → 7/7 | 8/8 → 8/8 | 3/3 → 3/3 | 11/11 → 11/11 |
| `worker/machineObject.vibe` | 62/63 → 62/63 | 57/83 → 57/83 | 17/17 → 17/17 | 77/92 → 77/92 |
| `worker/replyProgressDecision.vibe` | 17/17 → 17/17 | 32/32 → 32/32 | 10/10 → 10/10 | 22/22 → 22/22 |
| `worker/replyReasons.vibe` | 7/7 → 7/7 | 12/12 → 12/12 | 2/2 → 2/2 | 12/12 → 12/12 |


Chromium: 288 passed, 12 opt-in skips, no expected or unexpected failures. Coverage alone exits 1: lines
3,448/7,769 (44.38%), branches 3,466/8,203 (42.25%), functions 1,414/2,931 (48.24%), statements 4,001/9,897
(40.42%); 151 of 164 files below 100% (542 metrics). This is Chromium execution alone, with unloaded modules seeded
at zero. The unminified e2e build and original-map controls are retained. The run used gatefix's installed Chromium,
configurable build budget and content-addressed capture store on a Playwright box. Its Node 24.22.2 is below the
repository's >=26.4 engine requirement; this receipt records that limitation.

| File | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | ---: | ---: |
| `infra/SandboxImage.vibe` | 0/2 → 0/2 | 0/0 → 0/0 | 0/0 → 0/0 | 0/2 → 0/2 |
| `infra/Stack.vibe` | 0/8 → 0/8 | 0/6 → 0/6 | 0/0 → 0/0 | 0/8 → 0/8 |
| `infra/WorkerBuild.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `scripts/agent-context.vibe` | 0/22 → 0/22 | 0/4 → 0/4 | 0/5 → 0/5 | 0/23 → 0/23 |
| `scripts/fuzz-preflight.vibe` | — → 0/16 | — → 0/4 | — → 0/3 | — → 0/18 |
| `scripts/mythical-seed-program.vibe` | — → 0/50 | — → 0/18 | — → 0/15 | — → 0/63 |
| `scripts/mythical-seed.vibe` | 0/51 → 0/1 | 0/18 → 0/0 | 0/16 → 0/0 | 0/65 → 0/1 |
| `scripts/wiki.vibe` | 0/30 → 0/30 | 0/28 → 0/28 | 0/8 → 0/8 | 0/38 → 0/38 |
| `src/actions/Actions.vibe` | 5/5 → 4/4 | 0/0 → 0/0 | 0/0 → 0/0 | 6/6 → 4/4 |
| `src/actions/LiveActions.vibe` | 2/45 → 1/43 | 0/39 → 0/21 | 0/34 → 0/25 | 4/86 → 1/54 |
| `src/actions/MockActions.vibe` | 112/119 → 101/114 | 91/168 → 50/85 | 31/44 → 28/39 | 203/230 → 119/152 |
| `src/actions/agent.vibe` | 7/12 → 6/11 | 0/0 → 0/0 | 6/14 → 5/12 | 15/31 → 7/17 |
| `src/actions/catalog.vibe` | 5/8 → 6/9 | 78/80 → 26/26 | 4/4 → 2/2 | 8/11 → 6/9 |
| `src/actions/catalogDecision.vibe` | — → 3/3 | — → 12/12 | — → 2/2 | — → 4/4 |
| `src/actions/execution.vibe` | 17/40 → 7/38 | 6/53 → 6/36 | 4/30 → 3/18 | 24/79 → 7/41 |
| `src/actions/tools.vibe` | 0/13 → 0/13 | 0/1 → 0/1 | 0/7 → 0/7 | 0/14 → 0/14 |
| `src/actions/wire.vibe` | 6/6 → 6/6 | 0/0 → 0/0 | 0/0 → 0/0 | 8/8 → 6/6 |
| `src/assets/wiki.generated.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 4/4 → 2/2 |
| `src/core/Factory.vibe` | 4/4 → 3/3 | 0/0 → 0/0 | 0/0 → 0/0 | 6/6 → 3/3 |
| `src/core/IssuesFactory.vibe` | 68/77 → 66/74 | 150/203 → 89/118 | 18/20 → 13/15 | 109/133 → 74/96 |
| `src/core/LiveAccounts.vibe` | 0/26 → 0/26 | 0/20 → 0/12 | 0/22 → 0/13 | 0/51 → 0/32 |
| `src/core/LiveFactory.vibe` | 11/87 → 11/77 | 1/52 → 1/30 | 5/24 → 3/20 | 21/141 → 12/89 |
| `src/core/LiveIssues.vibe` | 0/11 → 0/11 | 0/12 → 0/6 | 0/9 → 0/7 | 0/26 → 0/16 |
| `src/core/LiveWiki.vibe` | 1/17 → 1/15 | 0/8 → 0/4 | 0/11 → 0/10 | 2/33 → 1/21 |
| `src/core/MockAccounts.vibe` | 82/84 → 66/76 | 35/63 → 21/34 | 26/31 → 23/26 | 142/150 → 78/100 |
| `src/core/MockFactory.vibe` | 248/273 → 223/266 | 159/261 → 97/139 | 79/99 → 64/78 | 443/508 → 251/318 |
| `src/core/MockJournal.vibe` | 2/2 → 1/1 | 0/0 → 0/0 | 5/5 → 3/3 | 8/8 → 3/4 |
| `src/core/VipWriter.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `src/core/WikiFactory.vibe` | 0/66 → 0/62 | 0/126 → 0/67 | 1/28 → 1/21 | 0/122 → 0/83 |
| `src/core/WikiWriter.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `src/core/accountCookieDecision.vibe` | 0/1 → 0/5 | 0/2 → 0/15 | 0/1 → 0/3 | 0/1 → 0/7 |
| `src/core/accountCookies.vibe` | 0/9 → 0/7 | 0/11 → 0/0 | 0/2 → 0/2 | 0/12 → 0/8 |
| `src/core/conversation.vibe` | 170/241 → 198/246 | 464/659 → 269/396 | 114/133 → 63/80 | 248/395 → 233/339 |
| `src/core/decide.vibe` | 54/55 → 49/55 | 168/211 → 77/107 | 9/9 → 6/6 | 97/101 → 58/87 |
| `src/core/flowDecision.vibe` | 24/65 → 21/53 | 54/168 → 22/105 | 36/48 → 13/24 | 29/93 → 22/68 |
| `src/core/flows.vibe` | 130/168 → 186/196 | 93/152 → 41/66 | 35/66 → 69/72 | 232/293 → 192/204 |
| `src/core/followDecision.vibe` | — → 2/2 | — → 1/2 | — → 2/2 | — → 2/2 |
| `src/core/identityDecision.vibe` | 1/2 → 2/2 | 6/8 → 4/4 | 2/2 → 1/1 | 1/3 → 3/3 |
| `src/core/issueFlows.vibe` | 31/34 → 29/34 | 27/36 → 16/20 | 11/12 → 10/11 | 53/57 → 32/40 |
| `src/core/issueSchemas.vibe` | 11/12 → 11/12 | 0/0 → 0/0 | 2/3 → 1/2 | 21/22 → 11/12 |
| `src/core/mockDecision.vibe` | 10/10 → 17/17 | 4/4 → 6/6 | 4/4 → 4/4 | 16/16 → 19/19 |
| `src/core/mockReplies.vibe` | 16/19 → 14/17 | 4/8 → 2/4 | 5/9 → 3/6 | 29/37 → 15/19 |
| `src/core/protocolDecision.vibe` | 2/17 → 2/22 | 0/50 → 0/54 | 4/12 → 2/14 | 2/25 → 2/30 |
| `src/core/roles.vibe` | 7/7 → 5/5 | 1/1 → 1/1 | 2/2 → 1/1 | 10/10 → 5/5 |
| `src/core/sandboxDecision.vibe` | 43/55 → 52/59 | 77/119 → 47/78 | 28/29 → 15/16 | 72/101 → 60/80 |
| `src/core/sandboxHost.vibe` | 120/175 → 120/175 | 147/248 → 85/137 | 34/37 → 24/27 | 201/308 → 132/209 |
| `src/core/sandboxMeter.vibe` | 31/33 → 31/33 | 48/62 → 27/35 | 11/11 → 7/7 | 48/56 → 32/39 |
| `src/core/sandboxMock.vibe` | 48/50 → 40/47 | 25/84 → 18/46 | 27/30 → 20/23 | 99/106 → 56/72 |
| `src/core/sandboxPolicy.vibe` | 2/3 → 1/2 | 0/0 → 0/0 | 0/4 → 0/3 | 3/6 → 1/4 |
| `src/core/schemas.vibe` | 24/30 → 23/30 | 0/0 → 0/0 | 0/0 → 0/0 | 27/33 → 23/30 |
| `src/core/sequenceDecision.vibe` | 0/20 → 0/23 | 0/12 → 0/18 | 0/8 → 0/10 | 0/23 → 0/27 |
| `src/core/sequencerDecision.vibe` | — → 0/16 | — → 0/28 | — → 0/8 | — → 0/23 |
| `src/core/specification.vibe` | 28/34 → 29/34 | 55/87 → 34/57 | 5/6 → 5/6 | 45/61 → 31/44 |
| `src/core/toolRefusal.vibe` | — → 0/5 | — → 0/18 | — → 0/1 | — → 0/6 |
| `src/core/tourDecision.vibe` | — → 3/9 | — → 5/23 | — → 2/4 | — → 3/14 |
| `src/core/walkthroughSteps.vibe` | 2/2 → 3/4 | 0/0 → 1/2 | 0/0 → 1/1 | 3/3 → 3/4 |
| `src/core/wiki.vibe` | 14/15 → 10/15 | 26/45 → 14/22 | 14/14 → 6/10 | 27/32 → 16/27 |
| `src/core/wikiDecision.vibe` | 0/1 → 0/1 | 0/6 → 0/3 | 0/2 → 0/1 | 0/1 → 0/1 |
| `src/core/wikiFlows.vibe` | 13/34 → 9/34 | 20/42 → 12/23 | 2/12 → 2/11 | 22/57 → 10/40 |
| `src/core/wikiLinks.vibe` | 0/14 → 0/15 | 0/59 → 0/29 | 0/2 → 0/1 | 0/25 → 0/18 |
| `src/core/wikiSchemas.vibe` | 5/5 → 5/5 | 0/0 → 0/0 | 0/0 → 0/0 | 10/10 → 5/5 |
| `src/core/wire.vibe` | 9/27 → 8/27 | 0/18 → 0/14 | 0/4 → 0/3 | 14/38 → 8/31 |
| `src/history/LiveMythical.vibe` | 3/44 → 3/41 | 0/16 → 0/12 | 0/24 → 0/16 | 6/76 → 3/47 |
| `src/history/MockMythical.vibe` | 41/41 → 33/35 | 6/12 → 3/5 | 36/37 → 25/26 | 62/63 → 38/41 |
| `src/history/MythicalHistory.vibe` | 2/3 → 2/2 | 1/4 → 1/2 | 1/1 → 1/1 | 2/5 → 2/3 |
| `src/history/Sequencer.vibe` | 72/97 → 72/94 | 25/70 → 17/36 | 53/59 → 30/35 | 130/175 → 76/110 |
| `src/history/flowMachine.vibe` | 27/51 → 25/50 | 59/157 → 30/91 | 34/41 → 14/21 | 30/73 → 25/68 |
| `src/history/flows.vibe` | 64/78 → 100/105 | 17/36 → 7/14 | 24/38 → 50/51 | 114/142 → 106/113 |
| `src/history/mythical.vibe` | 110/141 → 108/141 | 228/339 → 126/191 | 44/52 → 25/29 | 175/236 → 118/195 |
| `src/history/pageDecision.vibe` | — → 4/5 | — → 6/8 | — → 3/3 | — → 5/7 |
| `src/history/pages.vibe` | 28/36 → 28/36 | 39/54 → 18/26 | 28/29 → 19/20 | 52/62 → 37/46 |
| `src/history/roles.vibe` | 5/7 → 3/4 | 0/0 → 0/0 | 2/2 → 1/1 | 8/10 → 3/4 |
| `src/history/schemas.vibe` | 20/32 → 18/31 | 0/0 → 0/0 | 1/3 → 1/3 | 25/39 → 18/33 |
| `src/history/seed.vibe` | 5/171 → 5/161 | 0/115 → 0/87 | 0/36 → 0/25 | 9/212 → 5/185 |
| `src/history/seed/vibelang.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 4/4 → 2/2 |
| `src/history/seedDecision.vibe` | — → 0/25 | — → 0/40 | — → 0/7 | — → 0/38 |
| `src/history/stackDecision.vibe` | — → 6/15 | — → 7/25 | — → 2/7 | — → 8/23 |
| `src/history/tools.vibe` | 3/27 → 5/29 | 0/82 → 0/47 | 1/17 → 0/9 | 7/47 → 5/35 |
| `src/history/wire.vibe` | 8/35 → 8/35 | 0/35 → 0/35 | 0/6 → 0/5 | 10/47 → 8/43 |
| `src/surfaces/backend.vibe` | 0/45 → 0/45 | 0/35 → 0/31 | 0/14 → 0/15 | 0/58 → 0/58 |
| `src/surfaces/cli-entry.vibe` | 0/8 → 0/8 | 0/2 → 0/2 | 0/2 → 0/2 | 0/9 → 0/9 |
| `src/surfaces/cli.vibe` | 0/16 → 0/16 | 0/10 → 0/10 | 0/6 → 0/6 | 0/18 → 0/18 |
| `src/surfaces/commandDecision.vibe` | 0/9 → 0/22 | 0/33 → 0/64 | 0/5 → 0/17 | 0/10 → 0/23 |
| `src/surfaces/commands.vibe` | 0/168 → 0/171 | 0/134 → 0/112 | 0/73 → 0/73 | 0/204 → 0/207 |
| `src/surfaces/manifest.vibe` | 0/4 → 0/4 | 0/0 → 0/0 | 0/2 → 0/2 | 0/5 → 0/5 |
| `src/surfaces/mcp-entry.vibe` | 0/6 → 0/6 | 0/0 → 0/0 | 0/1 → 0/1 | 0/6 → 0/6 |
| `src/surfaces/mcp.vibe` | 0/17 → 0/17 | 0/4 → 0/4 | 0/6 → 0/6 | 0/20 → 0/20 |
| `src/surfaces/session.vibe` | 0/63 → 0/63 | 0/24 → 0/24 | 0/22 → 0/22 | 0/75 → 0/75 |
| `src/surfaces/sessionFlow.vibe` | 0/29 → 0/40 | 0/2 → 0/2 | 0/10 → 0/18 | 0/35 → 0/48 |
| `src/surfaces/signin.vibe` | 0/108 → 0/115 | 0/94 → 0/108 | 0/26 → 0/29 | 0/141 → 0/151 |
| `src/web/actionModel.vibe` | 17/17 → 14/14 | 39/57 → 16/19 | 17/17 → 7/7 | 32/33 → 15/16 |
| `src/web/actionView.vibe` | 27/30 → 27/30 | 201/243 → 104/123 | 35/40 → 22/27 | 48/53 → 36/41 |
| `src/web/backend.vibe` | 61/71 → 53/64 | 22/30 → 9/15 | 39/47 → 28/38 | 116/134 → 61/72 |
| `src/web/entry.vibe` | 8/8 → 8/8 | 8/8 → 4/4 | 0/0 → 0/0 | 13/13 → 8/8 |
| `src/web/historyApp.vibe` | 145/168 → 135/152 | 85/149 → 32/54 | 123/158 → 76/97 | 259/308 → 162/192 |
| `src/web/historyBackend.vibe` | 26/27 → 23/26 | 8/12 → 3/6 | 20/22 → 14/16 | 56/57 → 25/29 |
| `src/web/historyDecision.vibe` | — → 35/42 | — → 23/31 | — → 23/29 | — → 38/48 |
| `src/web/historyStartup.vibe` | 30/32 → 30/32 | 15/22 → 11/12 | 11/11 → 8/8 | 51/55 → 34/38 |
| `src/web/historyView.vibe` | 60/73 → 64/73 | 219/284 → 116/145 | 58/63 → 40/43 | 89/109 → 70/82 |
| `src/web/issueDecision.vibe` | 48/89 → 79/91 | 305/441 → 173/257 | 28/39 → 16/22 | 73/152 → 99/142 |
| `src/web/issues.vibe` | 21/21 → 21/21 | 63/74 → 31/36 | 12/12 → 6/6 | 33/34 → 25/26 |
| `src/web/issuesView.vibe` | 74/78 → 78/83 | 686/853 → 348/435 | 96/102 → 72/78 | 129/137 → 105/118 |
| `src/web/main.vibe` | 557/689 → 559/667 | 1151/1772 → 532/819 | 456/583 → 283/369 | 1054/1347 → 692/884 |
| `src/web/markdown.vibe` | 61/106 → 65/106 | 77/178 → 44/95 | 22/43 → 13/27 | 109/206 → 78/145 |
| `src/web/media.vibe` | 7/7 → 6/6 | 0/0 → 0/0 | 3/3 → 2/2 | 13/13 → 6/7 |
| `src/web/modeSwitch.vibe` | 2/2 → 2/2 | 8/8 → 0/0 | 2/2 → 1/1 | 3/3 → 2/2 |
| `src/web/modelDecision.vibe` | 26/54 → 53/78 | 56/120 → 74/112 | 52/80 → 37/51 | 26/67 → 60/95 |
| `src/web/paneDecision.vibe` | 7/19 → 7/20 | 26/84 → 12/48 | 12/32 → 6/17 | 8/22 → 7/22 |
| `src/web/roleView.vibe` | 23/24 → 21/24 | 123/132 → 62/66 | 21/21 → 12/14 | 37/39 → 24/27 |
| `src/web/sandboxView.vibe` | 16/17 → 18/19 | 128/180 → 70/88 | 10/10 → 6/6 | 29/30 → 19/21 |
| `src/web/screenDecision.vibe` | 28/41 → 45/46 | 128/164 → 87/102 | 52/55 → 30/30 | 30/53 → 54/58 |
| `src/web/startup.vibe` | 47/50 → 46/50 | 25/40 → 16/22 | 15/19 → 12/13 | 91/100 → 56/64 |
| `src/web/startupDecision.vibe` | 6/9 → 11/11 | 29/36 → 20/22 | 12/12 → 8/8 | 6/12 → 13/14 |
| `src/web/styles.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 2/2 → 2/2 | 2/2 → 2/2 |
| `src/web/theatre.vibe` | 46/46 → 42/45 | 74/79 → 35/38 | 10/10 → 7/7 | 85/85 → 48/51 |
| `src/web/theatreDecision.vibe` | 5/18 → 16/18 | 98/112 → 51/56 | 10/10 → 5/5 | 5/31 → 29/31 |
| `src/web/tourDecision.vibe` | 11/16 → 25/27 | 19/40 → 42/54 | 20/24 → 17/19 | 12/22 → 25/33 |
| `src/web/updateDecision.vibe` | — → 39/42 | — → 88/105 | — → 13/14 | — → 56/62 |
| `src/web/view.vibe` | 50/53 → 50/53 | 288/342 → 140/159 | 56/58 → 32/33 | 78/89 → 53/58 |
| `src/web/viewDecision.vibe` | 12/22 → 21/22 | 75/104 → 40/52 | 24/26 → 12/13 | 12/32 → 25/31 |
| `src/web/viewport.vibe` | 46/48 → 29/37 | 69/108 → 24/41 | 26/26 → 14/14 | 78/84 → 32/45 |
| `src/web/wikiView.vibe` | 27/28 → 26/27 | 115/182 → 60/96 | 20/24 → 15/19 | 58/62 → 31/38 |
| `worker/Accounts.vibe` | 0/267 → 0/312 | 0/342 → 0/361 | 0/62 → 0/73 | 0/369 → 0/430 |
| `worker/ActionDirectory.vibe` | 0/36 → 0/37 | 0/24 → 0/26 | 0/17 → 0/20 | 0/50 → 0/52 |
| `worker/ActionIdentity.vibe` | 0/14 → 0/14 | 0/20 → 0/20 | 0/7 → 0/7 | 0/18 → 0/18 |
| `worker/ActionRuns.vibe` | 0/117 → 0/120 | 0/168 → 0/178 | 0/34 → 0/36 | 0/160 → 0/163 |
| `worker/ActionsHttp.vibe` | 0/41 → 0/41 | 0/95 → 0/95 | 0/10 → 0/10 | 0/61 → 0/61 |
| `worker/AgentModel.vibe` | 0/9 → 0/9 | 0/0 → 0/0 | 0/3 → 0/3 | 0/9 → 0/9 |
| `worker/Api.vibe` | 0/231 → 0/46 | 0/59 → 0/0 | 0/79 → 0/1 | 0/263 → 0/47 |
| `worker/Budget.vibe` | 0/22 → 0/22 | 0/19 → 0/19 | 0/4 → 0/4 | 0/24 → 0/24 |
| `worker/GitHubDelegate.vibe` | — → 0/4 | — → 0/11 | — → 0/3 | — → 0/6 |
| `worker/HistoryActions.vibe` | 0/33 → 0/33 | 0/19 → 0/19 | 0/11 → 0/11 | 0/37 → 0/37 |
| `worker/HistoryObject.vibe` | 0/60 → 0/59 | 0/15 → 0/15 | 0/33 → 0/32 | 0/75 → 0/74 |
| `worker/HistoryTools.vibe` | 0/8 → 0/8 | 0/0 → 0/0 | 0/6 → 0/6 | 0/8 → 0/8 |
| `worker/Http.vibe` | 0/93 → 0/93 | 0/104 → 0/100 | 0/23 → 0/23 | 0/126 → 0/126 |
| `worker/IssueCredentials.vibe` | 0/16 → — | 0/9 → — | 0/11 → — | 0/24 → — |
| `worker/Issues.vibe` | 0/271 → 0/298 | 0/440 → 0/453 | 0/68 → 0/66 | 0/380 → 0/401 |
| `worker/MainLog.vibe` | 0/43 → 0/42 | 0/29 → 0/27 | 0/12 → 0/12 | 0/60 → 0/58 |
| `worker/ObjectStartup.vibe` | — → 0/60 | — → 0/27 | — → 0/16 | — → 0/75 |
| `worker/ObjectStorage.vibe` | 0/10 → 0/10 | 0/6 → 0/6 | 0/11 → 0/11 | 0/14 → 0/14 |
| `worker/Objects.vibe` | 0/108 → 0/112 | 0/46 → 0/47 | 0/60 → 0/59 | 0/136 → 0/140 |
| `worker/PublicReads.vibe` | — → 0/12 | — → 0/6 | — → 0/12 | — → 0/19 |
| `worker/Reply.vibe` | 0/136 → 0/138 | 0/81 → 0/81 | 0/17 → 0/19 | 0/155 → 0/158 |
| `worker/SandboxAccounts.vibe` | 0/12 → 0/11 | 0/2 → 0/2 | 0/0 → 0/0 | 0/13 → 0/12 |
| `worker/SandboxHttp.vibe` | 0/30 → 0/30 | 0/34 → 0/34 | 0/10 → 0/10 | 0/42 → 0/42 |
| `worker/SandboxMachine.vibe` | 0/4 → 0/4 | 0/0 → 0/0 | 0/0 → 0/0 | 0/4 → 0/4 |
| `worker/SandboxTools.vibe` | 0/11 → 0/11 | 0/2 → 0/2 | 0/10 → 0/10 | 0/12 → 0/12 |
| `worker/Sandboxes.vibe` | 0/22 → 0/22 | 0/21 → 0/21 | 0/17 → 0/17 | 0/37 → 0/37 |
| `worker/Sequencer.vibe` | 0/119 → 0/118 | 0/68 → 0/62 | 0/47 → 0/44 | 0/143 → 0/140 |
| `worker/SpecificationReviewers.vibe` | 0/31 → 0/31 | 0/8 → 0/8 | 0/10 → 0/9 | 0/42 → 0/42 |
| `worker/Tour.vibe` | 0/5 → 0/2 | 0/0 → 0/0 | 0/2 → 0/1 | 0/6 → 0/2 |
| `worker/Unreachable.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `worker/VipDraft.vibe` | 0/30 → 0/30 | 0/10 → 0/10 | 0/9 → 0/8 | 0/41 → 0/41 |
| `worker/Wiki.vibe` | 0/152 → 0/175 | 0/213 → 0/234 | 0/51 → 0/49 | 0/221 → 0/240 |
| `worker/WikiDraft.vibe` | 0/32 → 0/32 | 0/14 → 0/14 | 0/9 → 0/8 | 0/44 → 0/44 |
| `worker/WikiTools.vibe` | 0/9 → 0/9 | 0/6 → 0/6 | 0/6 → 0/6 | 0/13 → 0/13 |
| `worker/accountObject.vibe` | 0/48 → 0/48 | 0/35 → 0/35 | 0/39 → 0/39 | 0/79 → 0/79 |
| `worker/agentContext.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `worker/apiObjects.vibe` | — → 0/214 | — → 0/73 | — → 0/94 | — → 0/254 |
| `worker/budgetDecision.vibe` | 0/5 → 0/5 | 0/5 → 0/5 | 0/4 → 0/4 | 0/6 → 0/6 |
| `worker/index.vibe` | 0/13 → 0/13 | 0/19 → 0/19 | 0/2 → 0/2 | 0/17 → 0/17 |
| `worker/liveDispatchDecision.vibe` | 0/7 → 0/7 | 0/8 → 0/8 | 0/3 → 0/3 | 0/11 → 0/11 |
| `worker/machineObject.vibe` | 0/63 → 0/63 | 0/83 → 0/83 | 0/17 → 0/17 | 0/92 → 0/92 |
| `worker/replyProgressDecision.vibe` | 0/17 → 0/17 | 0/32 → 0/32 | 0/10 → 0/10 | 0/22 → 0/22 |
| `worker/replyReasons.vibe` | 0/7 → 0/7 | 0/12 → 0/12 | 0/2 → 0/2 | 0/12 → 0/12 |


Workerd: 73 passed / three skipped, 16 passing files / one skipped, no test failures. Coverage alone exits 1:
3,487/7,749 lines (~45.0%), 2,417/8,203 branches, 988/2,938 functions and 3,996/9,892 statements; 141 of 163
files below 100%, with counters from 100 isolate files. This earlier snapshot predates the final main rebase and
tour/error boundary refinements. Before below is this run's parent-Node coverage, after is parent plus isolate
execution from these same tests; unit/Chromium hits are never borrowed. Native/Istanbul counter structures can
differ, so both denominators are shown. The box also ran Node 24.22.2, below the repository engine requirement.

| File | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | ---: | ---: |
| `infra/SandboxImage.vibe` | 0/2 → 0/2 | 0/0 → 0/0 | 0/0 → 0/0 | 0/2 → 0/2 |
| `infra/Stack.vibe` | 0/8 → 0/8 | 0/6 → 0/6 | 0/0 → 0/0 | 0/8 → 0/8 |
| `infra/WorkerBuild.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `scripts/agent-context.vibe` | 0/22 → 0/22 | 0/4 → 0/4 | 0/5 → 0/5 | 0/23 → 0/23 |
| `scripts/mythical-seed-program.vibe` | 0/50 → 0/50 | 0/18 → 0/18 | 0/16 → 0/16 | 0/64 → 0/64 |
| `scripts/mythical-seed.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 0/1 |
| `scripts/wiki.vibe` | 0/30 → 0/30 | 0/28 → 0/28 | 0/8 → 0/8 | 0/38 → 0/38 |
| `src/actions/Actions.vibe` | 4/4 → 4/4 | 0/0 → 0/0 | 0/0 → 0/0 | 4/4 → 4/4 |
| `src/actions/LiveActions.vibe` | 40/43 → 40/43 | 15/21 → 15/21 | 20/25 → 20/25 | 45/54 → 45/54 |
| `src/actions/MockActions.vibe` | 2/114 → 2/114 | 0/85 → 0/85 | 2/40 → 2/40 | 2/153 → 2/153 |
| `src/actions/agent.vibe` | 4/11 → 5/11 | 0/0 → 0/0 | 2/12 → 3/12 | 5/17 → 7/17 |
| `src/actions/catalog.vibe` | 4/9 → 9/9 | 0/26 → 26/26 | 0/2 → 2/2 | 4/9 → 9/9 |
| `src/actions/catalogDecision.vibe` | 0/3 → 3/3 | 0/12 → 12/12 | 0/2 → 2/2 | 0/4 → 4/4 |
| `src/actions/execution.vibe` | 1/38 → 11/38 | 0/36 → 10/36 | 0/18 → 5/18 | 1/41 → 12/41 |
| `src/actions/tools.vibe` | 4/13 → 4/13 | 0/1 → 0/1 | 0/7 → 0/7 | 4/14 → 4/14 |
| `src/actions/wire.vibe` | 6/6 → 6/6 | 0/0 → 0/0 | 0/0 → 0/0 | 6/6 → 6/6 |
| `src/assets/wiki.generated.vibe` | 2/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 2/2 → 2/2 |
| `src/core/Factory.vibe` | 3/3 → 3/3 | 0/0 → 0/0 | 0/0 → 0/0 | 3/3 → 3/3 |
| `src/core/IssuesFactory.vibe` | 2/74 → 42/74 | 1/118 → 51/118 | 1/15 → 7/15 | 2/96 → 46/96 |
| `src/core/LiveAccounts.vibe` | 7/26 → 7/26 | 0/12 → 0/12 | 1/13 → 1/13 | 7/32 → 7/32 |
| `src/core/LiveFactory.vibe` | 51/77 → 51/77 | 7/30 → 7/30 | 13/20 → 13/20 | 51/89 → 51/89 |
| `src/core/LiveIssues.vibe` | 3/11 → 3/11 | 0/6 → 0/6 | 1/7 → 1/7 | 3/16 → 3/16 |
| `src/core/LiveWiki.vibe` | 4/15 → 4/15 | 0/4 → 0/4 | 1/10 → 1/10 | 4/21 → 4/21 |
| `src/core/MockAccounts.vibe` | 4/76 → 4/76 | 0/34 → 0/34 | 0/26 → 0/26 | 4/101 → 4/101 |
| `src/core/MockFactory.vibe` | 8/266 → 8/266 | 0/139 → 0/139 | 2/79 → 2/79 | 8/320 → 8/320 |
| `src/core/MockJournal.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/3 → 0/3 | 0/4 → 0/4 |
| `src/core/VipWriter.vibe` | 0/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 0/1 → 1/1 |
| `src/core/WikiFactory.vibe` | 0/62 → 40/62 | 0/69 → 30/67 | 0/21 → 13/21 | 0/85 → 49/83 |
| `src/core/WikiWriter.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `src/core/accountCookieDecision.vibe` | 4/5 → 5/5 | 10/15 → 12/15 | 2/3 → 3/3 | 4/7 → 5/7 |
| `src/core/accountCookies.vibe` | 6/7 → 6/7 | 0/0 → 0/0 | 1/2 → 2/2 | 6/8 → 7/8 |
| `src/core/conversation.vibe` | 96/246 → 186/246 | 137/410 → 274/410 | 31/80 → 57/80 | 103/339 → 223/339 |
| `src/core/decide.vibe` | 1/55 → 53/55 | 0/107 → 81/107 | 0/6 → 6/6 | 1/87 → 64/87 |
| `src/core/flowDecision.vibe` | 0/53 → 37/53 | 0/105 → 38/105 | 0/24 → 19/24 | 0/68 → 37/68 |
| `src/core/flows.vibe` | 48/196 → 186/196 | 0/66 → 42/66 | 0/72 → 69/72 | 48/206 → 190/206 |
| `src/core/followDecision.vibe` | 0/2 → 2/2 | 0/2 → 1/2 | 0/2 → 2/2 | 0/2 → 2/2 |
| `src/core/identityDecision.vibe` | 0/2 → 2/2 | 0/4 → 4/4 | 0/1 → 1/1 | 0/3 → 3/3 |
| `src/core/issueFlows.vibe` | 11/34 → 33/34 | 12/20 → 18/20 | 2/11 → 9/11 | 12/40 → 37/40 |
| `src/core/issueSchemas.vibe` | 10/12 → 10/12 | 0/0 → 0/0 | 0/2 → 0/2 | 10/12 → 10/12 |
| `src/core/mockDecision.vibe` | 0/17 → 0/17 | 0/6 → 0/6 | 0/4 → 0/4 | 0/19 → 0/19 |
| `src/core/mockReplies.vibe` | 11/17 → 11/17 | 0/4 → 0/4 | 1/6 → 1/6 | 12/19 → 12/19 |
| `src/core/protocolDecision.vibe` | 8/22 → 22/22 | 10/54 → 52/54 | 7/14 → 14/14 | 9/30 → 30/30 |
| `src/core/roles.vibe` | 4/5 → 5/5 | 0/1 → 1/1 | 0/1 → 1/1 | 4/5 → 5/5 |
| `src/core/sandboxDecision.vibe` | 1/59 → 57/59 | 0/78 → 57/78 | 0/16 → 15/16 | 1/80 → 65/80 |
| `src/core/sandboxHost.vibe` | 1/175 → 126/175 | 0/137 → 93/137 | 0/27 → 23/27 | 1/209 → 137/209 |
| `src/core/sandboxMeter.vibe` | 1/33 → 31/33 | 0/35 → 27/35 | 0/7 → 7/7 | 1/39 → 32/39 |
| `src/core/sandboxMock.vibe` | 0/47 → 19/47 | 0/46 → 9/46 | 0/23 → 8/24 | 0/72 → 26/72 |
| `src/core/sandboxPolicy.vibe` | 1/2 → 2/2 | 0/0 → 0/0 | 0/3 → 2/3 | 1/4 → 3/4 |
| `src/core/schemas.vibe` | 30/30 → 30/30 | 0/0 → 0/0 | 0/0 → 0/0 | 30/30 → 30/30 |
| `src/core/sequenceDecision.vibe` | 0/23 → 21/23 | 0/18 → 12/18 | 0/10 → 9/10 | 0/27 → 24/27 |
| `src/core/sequencerDecision.vibe` | 0/16 → 5/16 | 0/28 → 8/28 | 0/8 → 4/8 | 0/23 → 8/23 |
| `src/core/specification.vibe` | 6/34 → 27/34 | 0/59 → 27/59 | 1/6 → 4/6 | 6/46 → 30/46 |
| `src/core/toolRefusal.vibe` | 1/5 → 1/5 | 0/18 → 0/18 | 0/1 → 0/1 | 1/6 → 1/6 |
| `src/core/tourDecision.vibe` | 0/9 → 3/9 | 0/23 → 5/23 | 0/4 → 2/4 | 0/14 → 3/14 |
| `src/core/walkthroughSteps.vibe` | 2/3 → 2/3 | 0/0 → 0/0 | 0/1 → 0/1 | 2/3 → 2/3 |
| `src/core/wiki.vibe` | 0/15 → 6/15 | 0/22 → 7/22 | 0/10 → 2/10 | 0/27 → 8/27 |
| `src/core/wikiDecision.vibe` | 0/1 → 1/1 | 0/3 → 3/3 | 0/1 → 1/1 | 0/1 → 1/1 |
| `src/core/wikiFlows.vibe` | 11/34 → 30/34 | 12/23 → 22/23 | 2/11 → 8/11 | 12/40 → 35/40 |
| `src/core/wikiLinks.vibe` | 0/15 → 0/15 | 0/29 → 0/29 | 0/1 → 0/1 | 0/18 → 0/18 |
| `src/core/wikiSchemas.vibe` | 5/5 → 5/5 | 0/0 → 0/0 | 0/0 → 0/0 | 5/5 → 5/5 |
| `src/core/wire.vibe` | 16/27 → 25/27 | 3/14 → 12/14 | 1/3 → 3/3 | 16/31 → 27/31 |
| `src/history/LiveMythical.vibe` | 30/41 → 30/41 | 5/12 → 5/12 | 9/16 → 9/16 | 30/47 → 30/47 |
| `src/history/MockMythical.vibe` | 0/35 → 0/35 | 0/5 → 0/5 | 0/27 → 0/27 | 0/42 → 0/42 |
| `src/history/MythicalHistory.vibe` | 0/2 → 0/2 | 0/2 → 0/2 | 0/1 → 0/1 | 0/3 → 0/3 |
| `src/history/Sequencer.vibe` | 2/94 → 47/94 | 0/36 → 17/36 | 0/35 → 17/35 | 2/110 → 53/110 |
| `src/history/flowMachine.vibe` | 2/50 → 25/50 | 3/91 → 27/91 | 1/21 → 9/21 | 3/68 → 28/68 |
| `src/history/flows.vibe` | 39/105 → 84/105 | 0/14 → 7/14 | 2/51 → 39/51 | 39/113 → 88/113 |
| `src/history/mythical.vibe` | 4/141 → 60/141 | 0/191 → 48/191 | 0/29 → 13/29 | 4/195 → 64/195 |
| `src/history/pageDecision.vibe` | 0/5 → 4/5 | 0/8 → 6/8 | 0/3 → 3/3 | 0/7 → 5/7 |
| `src/history/pages.vibe` | 3/36 → 36/36 | 0/26 → 23/26 | 0/20 → 20/20 | 3/46 → 45/46 |
| `src/history/roles.vibe` | 3/4 → 3/4 | 0/0 → 0/0 | 0/1 → 0/1 | 3/4 → 3/4 |
| `src/history/schemas.vibe` | 30/31 → 31/31 | 0/0 → 0/0 | 0/3 → 1/3 | 30/33 → 31/33 |
| `src/history/seed.vibe` | 16/161 → 16/161 | 0/87 → 0/87 | 0/25 → 0/25 | 16/185 → 16/185 |
| `src/history/seed/vibelang.vibe` | 0/2 → 2/2 | 0/0 → 0/0 | 0/0 → 0/0 | 0/2 → 2/2 |
| `src/history/seedDecision.vibe` | 0/25 → 0/25 | 0/40 → 0/40 | 0/7 → 0/7 | 0/38 → 0/38 |
| `src/history/stackDecision.vibe` | 0/15 → 5/15 | 0/25 → 5/25 | 0/7 → 1/7 | 0/23 → 5/23 |
| `src/history/tools.vibe` | 5/29 → 25/29 | 0/47 → 26/47 | 0/9 → 8/9 | 5/36 → 29/36 |
| `src/history/wire.vibe` | 19/35 → 34/35 | 4/35 → 33/35 | 1/5 → 5/5 | 19/43 → 42/43 |
| `src/surfaces/backend.vibe` | 29/45 → 29/45 | 14/31 → 14/31 | 6/15 → 6/15 | 31/58 → 31/58 |
| `src/surfaces/cli-entry.vibe` | 8/8 → 8/8 | 2/2 → 2/2 | 2/2 → 2/2 | 9/9 → 9/9 |
| `src/surfaces/cli.vibe` | 15/16 → 15/16 | 7/10 → 7/10 | 5/6 → 5/6 | 16/18 → 16/18 |
| `src/surfaces/commandDecision.vibe` | 8/22 → 8/22 | 24/64 → 24/64 | 4/17 → 4/17 | 9/23 → 9/23 |
| `src/surfaces/commands.vibe` | 93/171 → 93/171 | 16/112 → 16/112 | 14/73 → 14/73 | 97/207 → 97/207 |
| `src/surfaces/manifest.vibe` | 4/4 → 4/4 | 0/0 → 0/0 | 2/2 → 2/2 | 5/5 → 5/5 |
| `src/surfaces/mcp-entry.vibe` | 6/6 → 6/6 | 0/0 → 0/0 | 1/1 → 1/1 | 6/6 → 6/6 |
| `src/surfaces/mcp.vibe` | 14/17 → 14/17 | 0/4 → 0/4 | 5/6 → 5/6 | 16/20 → 16/20 |
| `src/surfaces/session.vibe` | 53/63 → 53/63 | 16/24 → 16/24 | 14/22 → 14/22 | 59/75 → 59/75 |
| `src/surfaces/sessionFlow.vibe` | 40/40 → 40/40 | 1/2 → 1/2 | 19/20 → 19/20 | 49/50 → 49/50 |
| `src/surfaces/signin.vibe` | 101/115 → 101/115 | 74/108 → 74/108 | 16/30 → 16/30 | 114/153 → 114/153 |
| `src/web/actionModel.vibe` | 0/14 → 0/14 | 0/19 → 0/19 | 0/7 → 0/7 | 0/16 → 0/16 |
| `src/web/actionView.vibe` | 0/30 → 0/30 | 0/123 → 0/123 | 0/27 → 0/27 | 0/41 → 0/41 |
| `src/web/backend.vibe` | 29/64 → 29/64 | 6/15 → 6/15 | 6/38 → 6/38 | 30/72 → 30/72 |
| `src/web/entry.vibe` | 0/8 → 0/8 | 0/4 → 0/4 | 0/0 → 0/0 | 0/8 → 0/8 |
| `src/web/historyApp.vibe` | 0/152 → 0/152 | 0/54 → 0/54 | 0/97 → 0/97 | 0/192 → 0/192 |
| `src/web/historyBackend.vibe` | 0/26 → 0/26 | 0/6 → 0/6 | 0/16 → 0/16 | 0/29 → 0/29 |
| `src/web/historyDecision.vibe` | 0/42 → 0/42 | 0/31 → 0/31 | 0/29 → 0/29 | 0/48 → 0/48 |
| `src/web/historyStartup.vibe` | 0/32 → 0/32 | 0/12 → 0/12 | 0/8 → 0/8 | 0/38 → 0/38 |
| `src/web/historyView.vibe` | 0/73 → 0/73 | 0/145 → 0/145 | 0/43 → 0/43 | 0/82 → 0/82 |
| `src/web/issueDecision.vibe` | 0/91 → 0/91 | 0/257 → 0/257 | 0/22 → 0/22 | 0/142 → 0/142 |
| `src/web/issues.vibe` | 0/21 → 0/21 | 0/36 → 0/36 | 0/6 → 0/6 | 0/26 → 0/26 |
| `src/web/issuesView.vibe` | 0/83 → 0/83 | 0/435 → 0/435 | 0/78 → 0/78 | 0/118 → 0/118 |
| `src/web/main.vibe` | 0/666 → 0/666 | 0/815 → 0/815 | 0/369 → 0/369 | 0/883 → 0/883 |
| `src/web/markdown.vibe` | 0/106 → 0/106 | 0/95 → 0/95 | 0/27 → 0/27 | 0/145 → 0/145 |
| `src/web/media.vibe` | 0/6 → 0/6 | 0/0 → 0/0 | 0/2 → 0/2 | 0/7 → 0/7 |
| `src/web/modeSwitch.vibe` | 0/2 → 0/2 | 0/0 → 0/0 | 0/1 → 0/1 | 0/2 → 0/2 |
| `src/web/modelDecision.vibe` | 0/78 → 0/78 | 0/112 → 0/112 | 0/51 → 0/51 | 0/95 → 0/95 |
| `src/web/paneDecision.vibe` | 0/18 → 0/18 | 0/42 → 0/42 | 0/15 → 0/15 | 0/20 → 0/20 |
| `src/web/roleView.vibe` | 0/24 → 0/24 | 0/66 → 0/66 | 0/14 → 0/14 | 0/27 → 0/27 |
| `src/web/sandboxView.vibe` | 0/19 → 0/19 | 0/88 → 0/88 | 0/6 → 0/6 | 0/21 → 0/21 |
| `src/web/screenDecision.vibe` | 0/46 → 0/46 | 0/102 → 0/102 | 0/30 → 0/30 | 0/58 → 0/58 |
| `src/web/startup.vibe` | 0/50 → 0/50 | 0/22 → 0/22 | 0/13 → 0/13 | 0/64 → 0/64 |
| `src/web/startupDecision.vibe` | 0/11 → 0/11 | 0/22 → 0/22 | 0/8 → 0/8 | 0/14 → 0/14 |
| `src/web/styles.vibe` | 0/1 → 0/1 | 0/0 → 0/0 | 0/2 → 0/2 | 0/2 → 0/2 |
| `src/web/theatre.vibe` | 0/45 → 0/45 | 0/38 → 0/38 | 0/7 → 0/7 | 0/51 → 0/51 |
| `src/web/theatreDecision.vibe` | 0/18 → 0/18 | 0/56 → 0/56 | 0/5 → 0/5 | 0/31 → 0/31 |
| `src/web/tourDecision.vibe` | 0/27 → 0/27 | 0/54 → 0/54 | 0/19 → 0/19 | 0/33 → 0/33 |
| `src/web/updateDecision.vibe` | 0/42 → 0/42 | 0/105 → 0/105 | 0/14 → 0/14 | 0/62 → 0/62 |
| `src/web/view.vibe` | 0/53 → 0/53 | 0/159 → 0/159 | 0/33 → 0/33 | 0/58 → 0/58 |
| `src/web/viewDecision.vibe` | 0/22 → 0/22 | 0/52 → 0/52 | 0/13 → 0/13 | 0/31 → 0/31 |
| `src/web/viewport.vibe` | 0/37 → 0/37 | 0/41 → 0/41 | 0/14 → 0/14 | 0/45 → 0/45 |
| `src/web/wikiView.vibe` | 0/27 → 0/27 | 0/96 → 0/96 | 0/19 → 0/19 | 0/38 → 0/38 |
| `worker/Accounts.vibe` | 0/312 → 262/312 | 0/361 → 260/361 | 0/73 → 52/73 | 0/430 → 328/430 |
| `worker/ActionDirectory.vibe` | 0/37 → 37/37 | 0/26 → 20/26 | 0/20 → 20/20 | 0/52 → 50/52 |
| `worker/ActionIdentity.vibe` | 0/14 → 10/14 | 0/20 → 11/20 | 0/7 → 3/7 | 0/18 → 11/18 |
| `worker/ActionRuns.vibe` | 0/120 → 104/120 | 0/178 → 110/178 | 0/36 → 28/36 | 0/163 → 126/163 |
| `worker/ActionsHttp.vibe` | 0/41 → 40/41 | 0/95 → 78/95 | 0/10 → 7/10 | 0/61 → 50/61 |
| `worker/AgentModel.vibe` | 0/9 → 9/9 | 0/0 → 0/0 | 0/3 → 3/3 | 0/9 → 9/9 |
| `worker/Api.vibe` | 0/46 → 0/46 | 0/0 → 0/0 | 0/1 → 0/1 | 0/47 → 0/47 |
| `worker/Budget.vibe` | 0/22 → 20/22 | 0/19 → 14/19 | 0/4 → 4/4 | 0/24 → 21/24 |
| `worker/GitHubDelegate.vibe` | 0/4 → 4/4 | 0/11 → 7/11 | 0/3 → 3/3 | 0/6 → 5/6 |
| `worker/HistoryActions.vibe` | 0/33 → 18/33 | 0/19 → 4/19 | 0/11 → 9/11 | 0/37 → 20/37 |
| `worker/HistoryObject.vibe` | 0/59 → 54/59 | 0/15 → 15/15 | 0/32 → 24/32 | 0/74 → 65/74 |
| `worker/HistoryTools.vibe` | 2/8 → 5/8 | 0/0 → 0/0 | 0/6 → 3/6 | 2/8 → 5/8 |
| `worker/Http.vibe` | 0/93 → 91/93 | 0/100 → 80/100 | 0/23 → 14/23 | 0/126 → 109/126 |
| `worker/Issues.vibe` | 0/298 → 215/298 | 0/453 → 220/453 | 0/66 → 48/68 | 0/401 → 253/402 |
| `worker/MainLog.vibe` | 0/42 → 5/42 | 0/27 → 0/27 | 0/12 → 1/12 | 0/58 → 5/58 |
| `worker/ObjectStartup.vibe` | 0/60 → 50/60 | 0/27 → 16/27 | 0/16 → 12/16 | 0/75 → 61/75 |
| `worker/ObjectStorage.vibe` | 0/10 → 10/10 | 0/6 → 6/6 | 0/11 → 11/11 | 0/14 → 14/14 |
| `worker/Objects.vibe` | 0/112 → 99/112 | 0/47 → 33/47 | 0/59 → 52/60 | 0/140 → 120/140 |
| `worker/PublicReads.vibe` | 0/12 → 7/12 | 0/6 → 4/6 | 0/12 → 3/12 | 0/19 → 8/19 |
| `worker/Reply.vibe` | 15/138 → 112/138 | 0/81 → 46/81 | 1/19 → 15/19 | 15/159 → 125/159 |
| `worker/SandboxAccounts.vibe` | 0/11 → 0/11 | 0/2 → 0/2 | 0/0 → 0/0 | 0/12 → 0/12 |
| `worker/SandboxHttp.vibe` | 0/30 → 24/30 | 0/34 → 20/34 | 0/10 → 6/10 | 0/42 → 27/42 |
| `worker/SandboxMachine.vibe` | 0/4 → 0/4 | 0/0 → 0/0 | 0/0 → 0/0 | 0/4 → 0/4 |
| `worker/SandboxTools.vibe` | 2/11 → 5/11 | 0/2 → 1/2 | 0/10 → 4/10 | 2/12 → 6/12 |
| `worker/Sandboxes.vibe` | 0/22 → 22/22 | 0/21 → 21/21 | 0/17 → 17/17 | 0/37 → 37/37 |
| `worker/Sequencer.vibe` | 1/118 → 98/118 | 0/62 → 32/62 | 0/44 → 39/44 | 1/140 → 111/140 |
| `worker/SpecificationReviewers.vibe` | 0/31 → 5/31 | 0/8 → 0/8 | 0/9 → 0/9 | 0/42 → 5/42 |
| `worker/Tour.vibe` | 0/2 → 1/2 | 0/0 → 0/0 | 0/1 → 0/1 | 0/2 → 1/2 |
| `worker/Unreachable.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `worker/VipDraft.vibe` | 0/30 → 18/30 | 0/10 → 3/10 | 0/8 → 1/8 | 0/41 → 20/41 |
| `worker/Wiki.vibe` | 0/175 → 51/175 | 0/234 → 47/234 | 0/49 → 7/50 | 0/240 → 57/240 |
| `worker/WikiDraft.vibe` | 0/32 → 4/32 | 0/14 → 0/14 | 0/8 → 0/8 | 0/44 → 4/44 |
| `worker/WikiTools.vibe` | 1/9 → 2/9 | 0/6 → 1/6 | 1/6 → 2/6 | 2/13 → 3/13 |
| `worker/accountObject.vibe` | 0/48 → 0/48 | 0/35 → 0/35 | 0/39 → 0/39 | 0/79 → 0/79 |
| `worker/agentContext.vibe` | 1/1 → 1/1 | 0/0 → 0/0 | 0/0 → 0/0 | 1/1 → 1/1 |
| `worker/apiObjects.vibe` | 0/214 → 63/214 | 0/73 → 15/73 | 0/94 → 21/94 | 0/254 → 77/254 |
| `worker/budgetDecision.vibe` | 0/5 → 5/5 | 0/5 → 4/5 | 0/4 → 4/4 | 0/6 → 5/6 |
| `worker/index.vibe` | 0/13 → 12/13 | 0/19 → 15/19 | 0/2 → 2/2 | 0/17 → 14/17 |
| `worker/liveDispatchDecision.vibe` | 0/7 → 7/7 | 0/8 → 4/8 | 0/3 → 3/3 | 0/11 → 7/11 |
| `worker/machineObject.vibe` | 0/63 → 0/63 | 0/83 → 0/83 | 0/17 → 0/17 | 0/92 → 0/92 |
| `worker/replyProgressDecision.vibe` | 1/17 → 9/17 | 0/32 → 10/32 | 1/10 → 5/10 | 1/22 → 12/22 |
| `worker/replyReasons.vibe` | 0/7 → 6/7 | 0/12 → 7/12 | 0/2 → 2/2 | 0/12 → 7/12 |


Full raw reports, original-line counters, per-file CSV and experiment/check receipts remain in
`~/vl/vl-coverage-evidence/session14/`. `workerd-raw.tgz` retains isolate counters. All strict per-file thresholds
stay at 100%; all known-red targets remain exclusive under the lead's ruling. Whole-app 100% is still unachieved.

## Unit and fuzz gates inside workerd (lane vl-coverage-workerd, 2026-11-10)

The unit and fuzz gates now count execution inside workerd with the same per-module Istanbul counters as the workerd
suite and the benchmark gate (0017). Nothing waits on workerd's precise coverage or on VibeLang 0.0.13.

```
pnpm test:coverage
  vitest run --coverage                      Node suite ──▶ coverage/unit/coverage-final.json  (the structure)
  vitest run --mode workerd --coverage       Node side  ──▶ coverage/unit/workerd-node/coverage-final.json
    WORKERD_COVERAGE=1, WORKERD_COVERAGE_DIR  each workerd isolate's counters ──▶ coverage/unit/workerd-raw/
  test/unitCoverageGate.vibe                 merge by source position (test/support/coverageGate.vibe)
                                             ──▶ coverage/unit/merged/{coverage-final,per-file,summary}.json, 100% per file
pnpm fuzz:coverage
  targets stage: WORKERD_COVERAGE=1, counters ──▶ coverage/fuzz-unit/workerd-raw/   (flow vibelang-fuzz/v8)
  report stage:  fuzz/coverage.vibe merges Vitest, workerd and Chromium by source position ──▶ coverage/fuzz
```

`test/support/coverageGate.vibe` is the one gate: the first Node report is the structure, later Node reports and the
workerd counters credit it by source start (`test/support/coverageUnion.ts`). `test/workerdCoverageGate.vibe` and
`test/unitCoverageGate.vibe` only name their inputs. `test/workerdSuite.vibe` enables measurement when
`pnpm test:workerd` receives `--coverage`, then runs the gate even if Vitest fails. `pnpm test:coverage` sets `COVERAGE_MERGE=1`, which turns off
Vitest's own thresholds; a bare `vitest run --coverage` keeps the Node-only thresholds. The gate runs even when a test
fails, and the command fails if either Vitest run or the gate fails. PACKAGE target `coverage` now
allows 60 minutes.

**`worker/Api.vibe` in workerd.** `test/workerd/api.vibe` is the entry Alchemy generates for a Worker
(`makeEffectVirtualEntry` in `@alchemy.run/cloudflare`): `makeWorkerBridge` and `makeDurableObjectBridge` around
`worker/Api.vibe`'s default export, one bridge class per Durable Object. esbuild can't bundle it: Alchemy's provider
graph reaches vite, esbuild, tsx and proxy agents, and only Alchemy's rolldown plugins (unenv) make that graph load in
workerd. `test/support/alchemyBundle.vibe` therefore builds it with Alchemy's own `WorkerBundle` (the build
`alchemy dev` and a deploy use), unminified, with VibeLang's rolldown plugin wrapped by `instrumentRolldown`
(`test/support/workerdCoverage.ts`), the rolldown form of `instrumentModules`. `serveAlchemyApi`
(`test/support/workerd.vibe`) runs the result in Miniflare with each class bound under its own name, as `alchemy dev`
binds them. The suite's other hosts keep running the same bodies as plain objects.

- `test/alchemyApi.workerd.test.vibe`: every class finishes starting when the first requests reach them at once, and
  a post's reply is refused over Alchemy's RPC to the Budget object before any model call. 2 of 2 pass.
- `test/sandboxObjects.workerd.test.vibe`: `worker/accountObject.vibe` and `worker/machineObject.vibe` in real workerd
  SQLite through `test/workerd/sandbox-faults.vibe`, with a faulty Container Effect service. It covers generation
  fences, failed starts, stopped reads, persisted owner checks, and the actual storage alarm. The request path picks
  how the Container fails: a start that returns while the box never runs, a box whose setup command exits 1 and whose
  checkpoint fails, and a destroy that leaves it running (the machine reports `checkpoint-failed` once it stops).
  No command ever succeeds there; the successful paths run against the recorded real Container (below).
- Fuzz: `workerd/alchemy-api-requests` sends `workerd/api-requests`' generated requests to the Alchemy-built Worker,
  so `worker/Api.vibe` is back in the fuzz denominator (`fuzz.config.ts` and `fuzz/coverage.vibe` no longer exclude it).
- `test/workerdCoverageShape.test.ts` third case: Alchemy's rolldown build of a measured module puts a namespace call
  at its source column. Red when `instrumentRolldown` drops the compiler map (`expected [] to include 41`), green with it.

The inherited exploratory run on `4513073e` used the benchmark host's in-memory Container. Its sandbox numbers are
not final no-mocks evidence. Final validation uses the faulty Container service described above; measurements and
per-file comparisons are recorded below and in the lane report.

### Public workerd command, measured without successful Container simulation

`pnpm test:workerd --coverage`, on `0b937f1d` plus this lane's change, nyc-01 through `run-heavy`: 18 test files
passed, 1 skipped; 77 tests passed, 3 skipped. Vitest passed; the merged per-file gate exited 1 with 137 of 162 files
below 100%. The same run before and after adding its isolate counters:

| Workerd suite | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| Node only | 12.95% (1004/7749) | 4.62% (380/8209) | 6.85% (201/2932) | 10.75% (1064/9893) |
| Node and workerd | 47.20% (3658/7749) | 30.53% (2506/8207) | 35.39% (1040/2938) | 42.52% (4207/9892) |

107 files have workerd evidence. Files with no Node execution use the first evidence's structure, which accounts for
the small denominator differences; complementary shapes are not added together. The three requested modules now run:

| Module | Lines after merge | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `worker/Api.vibe` | 46/46 | 0/0 | 1/1 | 47/47 |
| `worker/accountObject.vibe` | 25/48 | 19/35 | 16/39 | 40/79 |
| `worker/machineObject.vibe` | 30/63 | 39/83 | 11/18 | 43/92 |

The two sandbox modules' successful Container paths stay uncovered in this suite; their faulty service never
simulates a successful start, command or checkpoint. Every per-file before/after comparison is retained in the lane
report and `~/vl/cw-evidence/s4/workerd-comparison.md` on nyc-01.

The fault modes (third session) raised `worker/machineObject.vibe` in the same command on `5e37278e` plus that change
from 30/63 lines, 39/83 branches, 11/18 functions and 43/92 statements to 39/63, 47/83, 12/18 and 56/92: the start
that never comes up, the failed setup, the failed checkpoint and the stuck destroy now run in workerd. 19 files / 81
tests passed (1 file, 3 tests skipped); the gate exits 1 with 140 of 164 files below 100%.

### Successful Container paths in workerd, held to the real run (2026-11-11)

The vl-test stage's first passing real-Container run (2026-11-10 18:32) is committed as
`test/recordings/sandboxes-live.json` (decision 0024). That makes the successful start, command, checkpoint and
restore measurable in workerd without a live binding, by the VL-38 pattern the lead set for this lane: an injected
Container Effect service, held to the real one by a conformance test. Nothing intercepts a request, and the Durable
Object namespaces are real workerd bindings.

```
lifecycle (test/support/sandboxesLive.vibe) ── HTTP ──▶ probe Worker body (sandboxProbeFetch)      ┐ test/workerd/
                                                        ├─ SandboxAccount body, workerd SQLite     │ sandbox-probe.vibe
                                                        └─ SandboxMachine body, workerd SQLite     │
                                                             └─ memoryContainer() (Effect service) ┘
recorded exchanges ── compared with ──▶ test/recordings/sandboxes-live.json (real Cloudflare Container)
```

- `test/workerd/memoryContainer.vibe`: the in-memory Container the benchmark host already used (moved out of
  `bench-sandbox.vibe`, unchanged in behaviour), plus `printf` writes, `&&` chains and a `dies` fault (the box stops
  while a command runs).
- `test/sandboxProbe.workerd.test.vibe`: runs the real-Container suite against the probe body in workerd, records the
  exchanges and compares every one with the committed recording. Comparison erases only `id` (allocated per owner),
  `used` and `resetAt` (wall clock); requests, statuses, outputs, generations, roles, allowance and `remaining`
  compare exactly. A changed fake fails it: making `printf` write a trailing newline fails the comparison. The same
  file asks the machine directly for a running status, refused lease durations, an expired lease, a receipt answer, a
  receipt conflict, a failing command and a box that stops mid-command, and asks the probe for its signed-out,
  sweep, deadline and broken-binding answers.
- `test/sandboxGateway.workerd.test.vibe`: the gateway through the 0019 policy adapter on the benchmark host:
  signed-out and Viewer reads, revoked grants, missing account and machine bindings, a stale generation, an account
  asked directly, the default `noIdentity` deployment, and the alarm of an account with no owner.

The fake answers only the commands the suite and these tests send; the real run is the authority for what they
return. A new command form needs a new real recording first.

### The real Container's calls, replayed behind the real objects (2026-11-11, rulings VL-36 and VL-38)

The lead's reading of VL-38 (2026-11-11 18:55): the in-process fake is allowed only for fuzz targets; every other happy
path runs on recordings. The section above held the in-memory Container to the real run's HTTP answers. This one moves
the record and replay seam down to the Container binding itself, so the machine object in workerd sees the real
Container's own answers.

```
vl-test stage (VIBELANG_SANDBOX_CONTAINER_MODE=record)            workerd suite (test/workerd/sandbox-probe.vibe)
  SandboxMachine body                                               SandboxMachine body (same code)
    └─ ContainerRecording.record(real Container)                      └─ ContainerRecording.replay(recorded calls)
         └─ each call ─▶ the object's DO storage                           ▲ strict order; a miss dies, remaining() = 0
  POST /api/probe/container ─▶ test/recordings/containers/<script>.json ─┘
```

- **SDK (SDK-1).** `@smthrs/testing/ContainerRecording`: passthrough, record and replay of the Container binding
  (`running`, `start`, `setInactivityTimeout`, the intercepts, `snapshotContainer`, `destroy`, `exec` with its output
  and exit, and failures by tag), with `normalize`, `encode` (scrubbed: named secrets, `redact`, then the
  `HttpRecording.scan` rules, refused on a match) and `decode`. It follows VIP-71's record and replay rules as
  `HttpRecording` does (replay never reaches the service, a miss is a failed test, the library reads no environment
  variable). It imports no Node module, so the deployed probe records and workerd replays. The credential rules moved
  to `src/internal/credentials.ts`, shared with `HttpRecording`. Guide: `packages/testing/docs/guides/record-a-container.md`.
  `test/ContainerRecording.test.ts`: 7 tests, 100% lines, branches, functions and statements.
- **Recording on the stage.** `worker/sandboxProbeContainer.vibe` wraps the probe machine's Container when the stage is
  deployed with `VIBELANG_SANDBOX_CONTAINER_MODE=record` (default `passthrough`), and keeps each call in that machine
  object's storage (at most 2,000; a call past that is logged and not kept). `normalizeCall` erases only what the clock
  decides: every inactivity timeout and the run script's timeout word. `POST /api/probe/container?conversation=` (token
  and a probe owner) answers a machine's calls. `POST /api/probe/machine` drives the owner's `direct` machine at
  generation 1, with its lease clamped like every probe lease, so the machine's own refusals are recorded on a real box.
  Production never declares the probe, so no product object records.
- **Scripts** (`test/support/sandboxesLive.vibe`), each one owner and one machine: `lifecycle`, `direct`,
  `sweep-before`, `deadline` and `unused`. `pnpm test:sandboxes-live` in record mode writes one recording per script,
  scrubbed of the token; `test/recordings.test.vibe` scans and decodes every file under `test/recordings/containers/`
  (a planted `ghp_` token fails it).
- **Mutation.** Replayed standard output changed (`saved` to `spoiled`) fails the record-read-replay test (exit 1);
  restored, it passes. A replayed call the recording does not hold is never answered: the probe request fails with a
  500 naming `No recorded container call left for running (call 0)`.

Which Container each test in `test/sandboxProbe.workerd.test.vibe` runs on:

| Test | Container | Why |
| --- | --- | --- |
| lifecycle, `direct` steps, a box that stops mid-command | replay of the committed recording | happy paths (VL-36), on the lead's second recording run |
| `unused`, `sweep-before`, `deadline` | replay of the committed recording (memory only without one) | happy paths; each checks every unpolled call was claimed |
| record, read through the probe, replay | memory recorded as the stage records, then replayed | proves the seam end to end in workerd before any real recording exists |
| limit, empty replay | memory recorded with `max: 2`; an empty replay | the recorder's limit and a replay miss |
| in-memory Container held to `sandboxes-live.json` | memory | `memoryContainer` serves the fuzz and benchmark hosts (VL-38), so it stays held to the real run |
| lease under one second, owner that is no probe owner | memory | inputs the probe's clamp never sends a real machine, so no real run can record them |
| signed out, route refusals, sweep refusals | none reached | no machine call, or a broken binding |

`test/sandboxGateway.workerd.test.vibe` and `bench/sandbox-objects.bench.vibe` stay on the benchmark host's memory
Container: the bench repeats calls no recording holds, and the gateway file asks refusals of bindings, not a box.

**The first recording run** (2026-11-12, main `93a77a10`, lead) passed four of five scripts. `deadline` failed: the
probe's sweep called `alarm` on the account over RPC, which workerd refuses (decision 0024, "Sweep"). The workerd host
had sent that call as a fetch, so it never saw the refusal. Now `AccountHost` (`test/workerd/sandbox-probe.vibe`)
extends workerd's `DurableObject` and the probe reaches it over native RPC through a stub built like Alchemy's
`makeRpcStub`. On the old sweep the workerd `deadline` test fails with the live run's answer (`running: true, status:
503`); the sweep now asks the account's `meter`, and it passes.

**The second recording run** (2026-11-12, main `bc00e97f`, lead) passed all five scripts live, and its replay failed
three workerd tests. Two causes, neither in the recordings:

- *Timer polls.* `admit` arms the account's alarm one second out while an operation is pending, and a real box takes
  seconds per call, so alarm meter passes (`running`, `running`, `setInactivityTimeout`: one lease) run during slow
  live calls. The lifecycle recording holds two lease passes between `start-1` and the first command, where the script
  makes one request. A replay answers at once, so those passes never happen, and the strict-order replay died at call
  10 (`running` where the recording holds `setInactivityTimeout`). `@smthrs/testing`'s `ContainerRecording.replay`
  now takes `polled` operations: they may be made more or fewer times than recorded, never answered across a start,
  command or destroy, and every unpolled call is still claimed in order. The probe host polls `running` and
  `setInactivityTimeout`.
- *Eviction.* The `deadline` script idles its machine object 60 s; workerd evicts it, and the host kept the Container
  in the instance, so the next instance started on memory and `remaining` read `undefined`. A real Container outlives
  its object, so the host now keeps each machine's Container by object id (log `vibelang.probe-host.machine`, outcome
  `restored`: one per run, the deadline machine).

The recordings are committed unchanged from the lead's evidence folder.

**`leaseFor`'s `?? now`** (`worker/sandboxProbeFetch.vibe:43`, a lease for a machine whose owner is no probe owner) is
reached in workerd: the probe host's `/clamped/<name>` route sends a lease through `leaseClamped` for `person-1/live`,
which is clamped to the one-second floor, and a command 1.1 s later is refused `lease-expired`.

**Coverage** (`pnpm test:workerd:coverage`, merged workerd gate, box `node26`, 22 files passed; the suite exits 1 on the
thresholds of other files, 172 of 203 below 100%):

| File | Lines | Branches | Functions | Statements |
| --- | ---: | ---: | ---: | ---: |
| `worker/machineObject.vibe` | 67/67 | 64/64 | 21/21 | 97/97 |
| `worker/accountObject.vibe` | 48/48 | 37/37 | 39/39 | 79/79 |
| `worker/sandboxProbeFetch.vibe` | 60/60 | 62/62 | 28/28 | 82/82 |
| `worker/sandboxProbeContainer.vibe` | 24/24 | 13/14 | 15/15 | 37/37 |

The one branch was `probeBox`'s unused `max` default, removed after the measurement. `worker/SandboxProbe.vibe` is
the Alchemy binding no workerd host loads (0% here, as before); the unit gate measures it. In the unit gate
(`pnpm test:coverage`) the four files above are at 100% lines and statements; 10 of 203 files are below 100% there.
These rows were measured on memory. Remeasured on the committed recordings (box `node26` job
`1f24121639471f5da06b976a`, `pnpm test:workerd:coverage`: 22 files, 102 tests passed, 2 skipped), none of the four is
below 100%; the suite exits 1 on the thresholds of other files (185 of 216 below 100%).

**LEAD RUNS** (to record again: on the Mac, with Cloudflare credentials):

```sh
cd apps/vibelang
export VIBELANG_SANDBOX_IMAGE=docker.io/library/debian:bookworm-slim
export VIBELANG_SANDBOX_PROBE_TOKEN="$(openssl rand -hex 32)"
VIBELANG_SANDBOX_CONTAINER_MODE=record pnpm deploy:sandboxes-test --yes      # prints the probe's workers.dev URL
VIBELANG_SANDBOX_MODE=record VIBELANG_SANDBOX_PROBE_URL=https://<probe>.workers.dev pnpm test:sandboxes-live
pnpm destroy:sandboxes-test --yes                                             # teardown: removes the stage
# then commit test/recordings/sandboxes-live.json and test/recordings/containers/*.json
```

Spend: five lite Container starts (lifecycle 2, direct, sweep-before, deadline), one at a time, about 12 minutes of
lite compute in total (the deadline script holds its box 60 s). At Cloudflare's published Containers rates for a lite
instance (1/16 vCPU, 256 MiB, 2 GB disk) that is under $0.01. Every script's owner deadline is at most 10 minutes
away; a failed script sweeps or stops its box; `destroy:sandboxes-test` removes the stage and its objects.

### Unit and fuzz results after the audit roster fixes

Measured on `8c5d65ae` plus this lane. Unit: the fresh Node run passed 238 files / 2066 tests (1 expected failure,
4 skips). Its own workerd stage, retained from the completed `pnpm test:coverage` run on `4d9ce9fc`, passed 18 files /
77 tests (3 skips). Every retained module's SHA-256 matches the current source; 37 dumps of the changed generated
wiki asset and its older Node entry were excluded. No hit or source position was edited. The fresh Node report
covers the current wiki asset. This preserves 106 files of unchanged unit workerd evidence alongside the new Node
report; it does not borrow fuzz or benchmark evidence. The merged gate exits 1 for 32 of 163 files.

| Unit | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| Node only | 99.27% (7712/7768) | 98.20% (8075/8223) | 98.84% (2903/2937) | 98.90% (9811/9920) |
| Node and retained workerd | 99.60% (7737/7768) | 98.75% (8121/8223) | 99.04% (2909/2937) | 99.28% (9849/9920) |

Unit files whose measured percentages change (the full per-file table is in the lane report):

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `src/history/flows.vibe` | 100 → 100 | 92.85 → 100 | 100 → 100 | 100 → 100 |
| `worker/Accounts.vibe` | 91.66 → 99.03 | 85.87 → 93.07 | 90.41 → 94.52 | 90.93 → 97.44 |
| `worker/ActionDirectory.vibe` | 100 → 100 | 84.61 → 96.15 | 100 → 100 | 100 → 100 |
| `worker/ActionIdentity.vibe` | 100 → 100 | 95 → 100 | 100 → 100 | 100 → 100 |
| `worker/ActionsHttp.vibe` | 100 → 100 | 95.78 → 96.84 | 90 → 90 | 98.36 → 98.36 |
| `worker/Api.vibe` | 100 → 100 | 100 → 100 | 0 → 100 | 97.87 → 100 |
| `worker/HistoryActions.vibe` | 90.9 → 90.9 | 78.94 → 84.21 | 81.81 → 81.81 | 86.48 → 86.48 |
| `worker/Issues.vibe` | 99.66 → 100 | 99.33 → 99.55 | 96.96 → 98.48 | 99.5 → 99.75 |
| `worker/Objects.vibe` | 99.1 → 100 | 93.61 → 100 | 98.3 → 100 | 99.28 → 100 |
| `worker/Sequencer.vibe` | 100 → 100 | 96.77 → 98.38 | 100 → 100 | 100 → 100 |
| `worker/machineObject.vibe` | 98.41 → 98.41 | 68.67 → 78.31 | 100 → 100 | 83.69 → 91.3 |

Fuzz: `E2E_PORT=4542 E2E_SERVER_SECONDS=600 pnpm fuzz:coverage`, default 5-second coverage budget plus the audit's
per-target floors, through durable flow v8. All 203 Vitest checks in 63 files and all five browser checks passed.
206 target receipts passed with 4,631,614 recorded executions; `workerd/alchemy-api-requests` ran 182 executions.
The final report stage exited 1 with 274 metric gates failing across 94 files. For the worker measurement's effect,
this table compares the same Node report before and after adding only that fuzz run's isolate counters:

| Fuzz, without Chromium | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| Node only | 90.29% (7014/7768) | 85.51% (7032/8223) | 88.15% (2589/2937) | 88.22% (8747/9914) |
| Node and workerd | 90.97% (7067/7768) | 85.72% (7049/8223) | 88.25% (2592/2937) | 88.81% (8805/9914) |

Below 100%: 97 → 96 of 163 files. Changed files:

| File | Lines | Branches | Functions | Statements |
|---|---:|---:|---:|---:|
| `infra/WorkerBuild.vibe` | 0 → 100 | 100 → 100 | 100 → 100 | 0 → 100 |
| `worker/Accounts.vibe` | 73.71 → 77.56 | 54.84 → 59.55 | 71.23 → 73.97 | 66.51 → 70.23 |
| `worker/Api.vibe` | 0 → 84.78 | 100 → 100 | 0 → 100 | 0 → 85.1 |
| `worker/PublicReads.vibe` | 50 → 58.33 | 50 → 50 | 25 → 25 | 36.84 → 42.1 |

The full fuzz report also merges its Chromium evidence: 7247/7768 lines (93.29%), 7156/8223 branches (87.02%),
2698/2942 functions (91.70%), 9037/9915 statements (91.14%). Browser line/statement attribution remains diagnostic
under the retained `coverage-source-ranges` negative control. The Node + workerd comparison above isolates this
lane's measurement change. Unit and fuzz gates both retain every source in the audit's roster and their 100%
thresholds. No dependency was added; no upstream compiler or package change was required for workerd measurement.

## Every browser check carries evidence (vl-coverage, 2026-11-10)

Chromium coverage is a Playwright fixture (`e2e/coverage.ts`): only a spec that imports `test` from `./coverage`
collects it. `e2e/wikiEdit.spec.ts` and `e2e/authbroker.spec.ts` imported `@playwright/test`, so their 5 checks per
project ran and passed while the report credited none of their code. In the last full snapshot `beginWikiEdit`,
`wikiEditScreen` and `knownWikiSource` (`src/web/main.vibe`) read 0 calls although the edit checks ran them. Both specs
now use the fixture. A focused dark-project run of the two: 6 passed, all with evidence, and the three functions read
called. The reporter now names every executed check without evidence (`missingEvidence`), and `pnpm e2e:coverage`
fails on one (`gateFailed`, `test/browserCoverageEvidence.test.vibe`), so a new spec can't hide its code again.

## Unrecordable steps answer unavailable (lane vl-coverage2, 2026-11-10)

A failed attempt admission or result write used to interrupt the caller of
`FlowRuntime.execute`, so Issues and Wiki could not map the failure to their
existing "unavailable" answer. The fix belongs to `@smthrs/engine-store` and
the `@smthrs/flow` runtime contract: `FlowRuntime.StoreUnavailable`, with
`code: "store_unavailable"` and the execution id, is a typed infrastructure
failure at the outermost execute boundary.

The step remains undecided and the durable run remains released. Child flows
propagate that release to their parent before the outermost caller receives
the typed failure. Cause annotations carry the reason to every caller joining
the same drive, without a consumable marker or an execution-id table. A caller's
own cancellation stays interruption. The existing metric, warning and dispatch
span still identify storage failure without recording payloads or credentials.

Package regression, faulty AttemptStore and Journal services over the real SQLite engine:
five cases fail with interruption on the old adapter; both interruption controls
already pass. With the fix, all seven pass: attempt admission, result recording,
actual step-journal refusal, nested child, eight joining callers, a step's own
interruption, and caller cancellation. Recovery tests
reuse the same execution id and retain the unfinished attempt. Issues and Wiki
retain their existing error mapping; their faulty-storage cases now assert the
typed unavailable answer and no GitHub write.

No dependency, coverage threshold change, source coverage exclusion or VibeLang behavior change.


The flow and engine strict gates retain 100% on lines, branches, functions and
statements. The durable store's SQLite/PostgreSQL matrix also passes at 100%
(7277 lines, 4565 branches, 2275 functions, 8127 statements). Its individual
backend runs pass 2400 and 2412 tests; the seven recording/cancellation cases also pass in a focused
SQLite run. An obsolete codec assertion was removed after the existing linter
refused it; the compiler accepts the same declared return type without it.
The engine's linter now ignores emitted `*.d.vibe.ts` declarations, as its
coverage config already does; the `.vibe` source remains measured.

The full app suite exposed a test lifecycle leak: entry tests imported a real
page and removed its DOM without leaving the page. Foldkit's delayed scan then
read globals Happy DOM had torn down. The initial pagehide regression checks
failed first and passed after waiting for disposal. Main subsequently added an
explicit page handle and teardown regression; the rebase retains that API and
its tests, which supersede this lane's temporary pagehide helper.


An unavailable engine result does not prove that a write was unwritten. The
fixture factories therefore report `unwritten: false` for StoreUnavailable,
as the live hosts already do. A faulty runtime over the real memory engine
loses one result after committing: the issue comment or wiki review exists,
and retrying the same key reads it once. Both cases failed first on the
unwritten claim; the pre-write fault cases also retain their no-mutation
assertions. No request interception or new GitHub double.

The issue fixture maps engine errors through the proved decisions in
`src/core/issueFixtureDecision.vibe` (main moved the reason there while this
change was open): `fixtureErrorReason` answers `unavailable` for
`@smthrs/flow/StoreUnavailable`, and `fixtureErrorUnwritten` is false only for
it. Four mutation cases in `verify/extended_mutations.py` cover both. Two
hand mutations each fail 3 of 16 unit cases (`issueFixtureDecision`,
`factoryEngineFaults`); `WikiFactory` keeps the same mapping inline.

## Closed sandbox boundaries (lane vl-coverage2, 2026-11-10)

The production closed SandboxAgent service now runs through all three real
FlowBinding tools in the unit suite. Each answers forbidden. The signedOut
policy is also exercised through sandbox creation: an explicit contributor
role hint cannot override it, and no generation or allowance is consumed.
Changing either refusal or signed-out authority deliberately made its new
assertion fail (two failed / two passed); sources were restored.

All three signed-out HTTP writes answer 403. A streaming body with no
Content-Length answers 413, and a faulty body stream answers 400. These are
Effect HTTP requests, with the failing stream injected at the body service;
there is no intercepted request, credential, external write, or new double.

The private sandbox-tool declaration helper receives only SandboxStart,
SandboxStop and SandboxCommand, all of which have descriptions. Its unused
name fallback was deleted. worker/Tour.vibe's spoken wrapper had no callers:
both deployed and workerd objects import tourAgentRegistration instead.
Deleted the wrapper, its unused imports and the unused test import.

Scoped unit coverage (Vitest/coverage-v8 5.0.0, the existing .vibe source maps):

| File | Before lines / functions / statements / branches | After |
| --- | --- | --- |
| worker/SandboxTools.vibe | 8/11; 7/10; 9/12; 1/2 | 11/11; 10/10; 12/12; 0/0 |
| src/core/sandboxPolicy.vibe | 2/2; 2/3; 3/4; 0/0 | 2/2; 3/3; 4/4; 0/0 |
| worker/Tour.vibe | 1/2; 0/1; 1/2; 0/0 | 1/1; 0/0; 1/1; 0/0 |
| worker/SandboxHttp.vibe | 28/30; 7/10; 39/42; 33/34 | 30/30; 10/10; 42/42; 34/34 |

All four files pass all four 100% thresholds together: 20 tests across four
files, 44/44 lines, 23/23 functions, 59/59 statements and 34/34 branches.
No coverage exclusions, new dependency or VibeLang semantics change.

## Worker recovery boundaries (lane vl-coverage2, 2026-11-10)

History's reader now plans, starts and notes over its real SQLite engine and
sequencer, then decodes the resulting epic and search pages. A faulty act
service answers unavailable without exposing its transport detail. The
history run host refuses another workflow, preserves an existing intent
when busy, and drives its default admission to a recorded receipt.

The three model writers also run on the real Cloudflare SQLite runtime.
Each healthy control calls the local scripted model once and records its
actual seven-token charge. The initial receipt below predates main's
c5bbf81b reserved-ceiling policy: then an accounting-read outage answered
budget, made no model call and wrote no charge. On fresh main, these tests
forward the complete reservation/settlement arguments and retain that
lane's policy: an unreadable usage journal refuses the draft/review, charges
the full reserved ceiling rather than zero, and releases the reservation.
Healthy controls still charge exactly seven tokens. The faulty read service
heals after the writer's answer so the engine can persist that answer;
an unavailable outcome journal is a different boundary. No request is
intercepted, and no new dependency or protocol double was added.

Five deliberately incorrect mappings made five new assertions fail, while
four healthy controls passed. Restoring the sources passes all nine new
tests. Together with the existing action, writer and deadline cases, 71
tests pass / one skips across twelve files, and all five sources reach 100%
for lines, functions, statements and branches:

| File | Before lines / functions / statements / branches | After |
| --- | --- | --- |
| worker/HistoryObject.vibe | 57/59; 29/32; 71/74; 15/15 | 59/59; 32/32; 74/74; 15/15 |
| worker/HistoryActions.vibe | 30/33; 9/11; 32/37; 15/19 | 33/33; 11/11; 37/37; 19/19 |
| worker/VipDraft.vibe | 30/30; 7/8; 40/41; 10/10 | 30/30; 8/8; 41/41; 10/10 |
| worker/WikiDraft.vibe | 32/32; 7/8; 43/44; 14/14 | 32/32; 8/8; 44/44; 14/14 |
| worker/SpecificationReviewers.vibe | 31/31; 8/9; 41/42; 8/8 | 31/31; 9/9; 42/42; 8/8 |

The grouped receipt covers 185/185 lines, 68/68 functions, 238/238 statements
and 66/66 branches. The existing 100% thresholds remain unchanged.

## Complete tour hosts (lane vl-coverage2, 2026-11-10)

Both production implementations of Tours (MockFactory and Objects.toursOf)
already provide current, drive and control. Every binding uses one of these
complete implementations. These methods are now required; the unused
partial-host fallbacks and corresponding non-null assertion were deleted.
Existing tour, flow-body and wiki-tool behavior remains covered.

The remaining narration-refusal guard stays. A new fault decorator for it
is retained outside the app's test glob because compiler 0.0.12 drops the
methods in a service Shape spread (service-method-spread reproduction).
Upstream baf0d9a0f54c9335d1e6061be7f4947b507d8da1 already fixes that
rejection on vibe, with positive and negative controls; it was not on green
main at this check. No compiler replacement or app workaround was added.

## Fixture recovery (lane vl-coverage2, 2026-11-10)

MockAccounts now covers a refused final-maintainer demotion, an idempotent
grant, a follower at the current event cut, and participation without an
explicit person id. A pregrant for a future person allows both fixture
maintainers to step down, so agent sign-in's no-fixture path is reachable:
it answers AccountUnavailable and preserves the selected person. That
guard was retained.

Wiki's missing-page read recovers to a known page; a second draft replaces
the first. Its proposal key also survives a fresh memory engine over the
same fixture repository: the same edit returns the same review, and a changed
edit is refused conflict without creating another proposal. The existing
proposal guard is necessary after an engine restart and was retained.

All four deliberately incorrect refusal/replay/filter mutations fail the
new cases. Restored sources pass 65 tests across eight files. Scoped
coverage is 100% on lines, functions, statements and branches for both
src/core/MockAccounts.vibe and src/core/WikiFactory.vibe: 138/138 lines,
47/47 functions, 183/183 statements and 103/103 branches.
Before this extension, the whole-suite report had MockAccounts at 88.23%
branches / 96.15% functions / 97.02% statements and WikiFactory at 98.59%
branches / 98.82% statements; both already had 100% lines.

The preceding whole unit run passed 2083 tests / one expected failure /
four skipped, with 241 files passing / three skipped. Its strict coverage
gate remains red: 99.42% lines, 98.29% branches, 99.38% functions and 99.11%
statements, 26 files below 100%. This predates the fixture extension above.
The newly measured fuzz-preflight script has zero native-loader coverage
despite its two passing process-boundary runs. The existing
coverage-native-loader reproduction records the provider's PARSE_ERROR on
raw effect syntax; no exclusion or emitted-JavaScript substitution was added.

## Action directory failure boundaries (lane vl-coverage2, 2026-11-10)

A legacy ownerless Tour is admitted as a guest and cancelled through the
real indexed host. A completed no-model Post reply can be cancelled under
its registered parent's permission without changing its settled result.
Faulty downstream start services retain an Unreachable failure or both
defects in a compound cause; neither invents a run or answers conflict.
Every other operation uses the real accounts, index, per-run hosts and SQLite.

The four new cases pass. Mutating the cause mapping and removing the parent
permission alias makes three fail, with the ownerless control still passing.
After restoring the source, the five-file group passes 36 tests and
worker/ActionDirectory.vibe is 100%: 40/40 lines, 22/22 functions,
55/55 statements and 30/30 branches. No production code changed.

## Recovered action and tour hosts (lane vl-coverage2, 2026-11-10)

The real tour flow pauses, resumes, seeks to the final stop and finishes at
its reading deadline. Idle controls refuse without changing the conversation;
an invalid wiki path opens nothing and a valid one opens the pane.
A failed narration closes the active answer and fails the registered run.
A failed alarm preserves its own cause and settles nothing; retrying the
healthy host keeps the question once. A host resumed after reply-start
refuses a demoted person and closes the unfinished answer while retaining
the already accepted Post's passed receipt.

All five new cases pass; five deliberately incorrect source mappings make
all five fail. Restoring both sources passes the current 45-file worker
group: 329 tests / one skipped, and all eight measured worker files reach
100% on every metric: ActionRuns, Objects, Sequencer, HistoryObject,
HistoryActions, WikiDraft, VipDraft and SpecificationReviewers.
Combined: 550/550 lines, 207/207 functions, 693/693 statements,
359/359 branches. Production code was unchanged by these tests.
The writer controls above also pass under main's reserved-ceiling policy.

## Dead budget charge (lane vl-coverage2, 2026-11-10)

`worker/budgetDecision.vibe` kept `charge`, the per-reply charge from before main's reservation change (`c5bbf81b`).
No source, test, benchmark or fuzz target imports it, and no mutation case names it: `worker/Budget.vibe` settles
through `reserve`, `settle` and `canCharge`. Its two lines and three branches were the file's whole gap, and the
benchmark lane had recorded it as unused (0017). Deleted with its `Charge` type instead of covered; the function
inventory in 0018 is regenerated, and the module's remaining proofs pass.

## Action protocol callers and refusals (lane vl-coverage2, 2026-11-10)

`worker/ActionsHttp.vibe` had five gaps. A rerun now runs as a maintainer without a name (the run records `Guest`)
and as an agent (`agent`); a start and a rerun the actions API refuses as `forbidden` answer 403; an unreadable rerun
body answers 400 without reaching the API (`test/actionsHttp.coverage.test.vibe`). The fifth, `parts[0] ?? ""`, could
not run: `split` always yields a first part, so the fallback is gone. Making a forbidden rerun answer 404 fails the new
case (1 of 10). The file has no uncovered statement, function or branch in the focused run.


## Worker, surfaces, history and actions gaps (lane vl-coverage2, 2026-11-10)

Measured first on main `2f002f18` (`pnpm test:coverage`, merged Node and workerd): 15 files in this lane's scope
(`worker/`, `src/surfaces`, `src/history`, `src/actions`) were below 100% on some measure. Each gap is now a test, a
deletion of code no production input reaches, or a wait on another lane.

Deleted, because no production input reaches it:

| Where | Why it can't run |
| --- | --- |
| `worker/Accounts.vibe`, the Connect callback's `pending.returnTo ?? "/?issues=1"` | Since Connect landed (`0643f98e`), a Connect press stores the pressing session and its destination in one write. The record now decodes as a union whose Connect member requires both. |
| `worker/Accounts.vibe`, `catch () => undefined` on `GitHub.Delegation.site` | `site` has no expected error: the compiler's EK9204 says only defects pass that catch, and the catch never handles one. |
| `worker/Budget.vibe`, `spend`'s recorded-but-still-held write and its early return | `admit` refuses a recorded reply, and `spend` writes the record and a zero hold in one write. So a recorded reply holds nothing, and `settle` answers `write: false` for it. |
| `worker/Reply.vibe`, `if (canSettleReply(run))` | `answer` returns unless `canComposeReply`. The proved contracts of `beginReplyComposition` and `finishReplyComposition` then give phase `ready`, one start, one composition, no settlement and answer `done`: exactly `canSettleReply`. |
| `src/history/Sequencer.vibe`, `trailerOf`'s `named === null` | `find` with a `!== null` predicate never answers null. The predicate is now a type guard. |
| `worker/sandboxProbeFetch.vibe`, `leaseFor`'s `split("/")[0] ?? ""` | `split` always yields a first part. |
| `worker/Issues.vibe`, the timeline read's `event.event ?? ""` | `GitHub.IssueChanges.TimelineEvent` requires `event` (since 2026-11-08): a timeline with an unnamed event fails to decode and the read answers unavailable. |
| `worker/ActionRuns.vibe`, the settled alarm's `isHistory(invocation) ? … : Option.none()` | The branch runs only for a flow that is neither a tour nor a post, and `prepare` answers kind `post` or `tour` only for those two names. `prepareHistory` (`src/actions/execution.vibe`) now says so in the type: it refuses a post or a tour as `not-found`. |
| `worker/accountObject.vibe`, `answer.reason ?? "unknown"` on a machine refusal | Every machine refusal goes through `refused(reason)`. The machine's `Answer` is now a union whose refusal member requires `reason`. |
| `worker/machineObject.vibe`, `result.tool === "run" ? … : ""` | A `run` call always answers a `RunResult`. Fixed upstream: `@smthrs/sandbox`'s `SandboxTools.execute` now answers `ResultOf<C>`, the call's own result type, with a type test. |

Specification functions (`src/history/replayDecision.vibe`, `seedInputDecision.vibe`, `pageDecision.vibe`) are
tested against the code they specify, as `runningCountPrefix` is above. VibeLang still has no specification-only
function (`~/vl/vibelang-bugs/spec-only-function`).

New tests:

| Test | Reaches |
| --- | --- |
| `test/historySpecifications.coverage.test.vibe` | `replayStep` inside and outside replay's domain, `replayedHistory`, `replayedHistoryPrefix`, `liveHistoryReplays`, `referenceList`, `selectedTitles`, `sumOf` |
| `test/accountsRoutes.coverage.test.vibe` | the GitHub App install link (with and without an App), Connect refused to a device agent, for an unknown wiki page and without a broker, a signed-out disconnect, a connected person whose role can't save, an untrusted broker secret, a device agent's wiki principal, an ended smithers.sh connection forgotten on a wiki read, a chat draft the engine can't record |
| `test/accountsBroker.coverage.test.vibe` | a Connect press's wiki and resumed-issue destinations through the real broker |
| `test/authBroker.workerd.test.vibe` | a Connect handoff finished in a browser without the pressing session: 403, nothing connected |
| `test/issuesDelegated.coverage.test.vibe` | the host alone searching from five minutes before now, a selected issue GitHub refuses, a timeline event with no actor, a host defect that stays a defect |
| `test/machineObject.coverage.test.vibe` | the running status, refused leases, a command before any lease, a receipt answer, a generation stopped mid-command |
| `test/sandboxProbe.test.vibe` | no owner header (signed out; sweep 400), a sweep before the deadline that stops a running sandbox |
| `test/actionRuns.coverage.test.vibe` | cancelling a run the agent announced in a conversation no action started |
| `test/apiObjects.coverage.test.vibe` | health for a deployment built without a commit |
| `test/mainLog.coverage.test.vibe` | a cursor not on main: a short page ends the search |
| `test/pages.test.vibe` | an absent epic on either side of the stack sort |
| `test/sequencerTrailer.test.vibe` | a trailer paragraph with a folded continuation line, and one whose later line is prose |
| `test/accountsConfig.test.vibe` | a configured GitHub App slug and API base |
| `test/accountsRoutes.coverage.test.vibe` (session 9) | a signed-in person with no connection disconnecting without a smithers.sh call; a wiki and an issues read whose person signs out (an injected network hook ends every session) while smithers.sh refuses the ended connection; an object restarted over migrated storage |
| `test/actionClients.coverage.test.vibe` | `prepareHistory` for a history run, a post and a tour |
| `test/accountObject.coverage.test.vibe` | the object's refusals of a bad operation id and a stale generation, carried through the gateway with no reason |

Waiting: `src/history/tools.vibe:93`, the `epic` arm's presence test for a `from` the type requires
(`~/vl/vibelang-bugs/coverage-exhaustive-match`; VL-37 approves the compiler change, in flight).

## The mock main's outside commits and the recorded Markdown reply (vl-coverage, session 26, 2026-11-12)

The lead's two calls on the browser gate's sites that mock mode could not reach:

1. **`areas.vibe` `areaOf`/`scopeOf` and `areaDecision.vibe`.** The sequencer calls `areaOf` only for a main commit
   without a `Mythical:` trailer, and the mock's main landed only trailered commits. Real main is mostly commits without
   one, so the mock's main now lands three real ones first (`AFTER_SEED`, decision 0020): a `type(scope):` title whose
   scope an area names, one whose scope none names, and an emoji title with no scope. Journey:
   `e2e/history-paths.spec.ts` "folds main's commits from outside the queue …"; unit: `test/historyFlows.test.vibe`
   "main's commits from outside the queue" (a test seed opens Foundations; another seed's main has none).
2. **Chat Markdown tables, lists and quotes.** The scripted mock agent answers plain text, and no model recording was
   committed. The recorded case `markdown` (`test/model.recorded.test.vibe`) posts `MARKDOWN_PROMPT` to the live API
   Worker in workerd, whose model is a local provider answering through the recording
   (`test/support/recordedProvider.vibe`); the browser journey `e2e/chat-markdown.spec.ts` replays the same file
   behind the preview build (`e2e/authbroker-host.vibe`) and asserts the table, list and quote render. Both skip until
   `test/recordings/model-markdown.json` exists. The provider's wiring is tested without the model:
   `test/recordedProvider.workerd.test.vibe` records a scripted provider's Markdown reply through a live Worker and
   replays it into a fresh one with the provider gone. One-turn replies key on the prompt alone (`promptOf`), so the
   browser's post finds the recorded calls. Waiting: `LEAD RUNS: cd apps/vibelang && pnpm record:model` (at most 40
   model calls, all five cases).

## The first model recordings (vl-coverage, session 27, 2026-11-12)

The lead's `pnpm record:model` on main `b576a99ff7fa` recorded `reply` and `markdown`
(`test/recordings/model-reply.json`, `model-markdown.json`, committed unchanged). Each recorded case now skips only
while its own recording is missing, so these two replay while the other three wait.

The VIP draft, wiki draft and specification reviewer cases failed in record mode only: they asserted the budget log
`{ admitted: 1, spent: 1 }`, and the log has since gained `calls`, `tokens` and `unreported` (one entry per physical
model call). The VIP draft logged `calls: 2, unreported: 0`. That is two agent frames (`VIP_FRAMES` is 8), not a
retry: the agent package records a reissued call as unsettled, which the ledger counts as unreported. No metering bug.
The three cases now check that the draft's own key is admitted and settled once, that nothing is unreported, that
tokens were charged, and that `calls` equals the model requests counted at the recording's `fetch`
(`recordedModel(...).requests`). Waiting: `LEAD RUNS: cd apps/vibelang && pnpm record:model -t "charged once"` (only
those three cases; the committed recordings are not opened).

## All five model recordings, and the agent's history runs (vl-coverage, session 28, 2026-11-12)

The lead's `pnpm record:model -t "charged once"` on main `24672a91f3ef` (exit 0, 3 passed) recorded `review`,
`vip-draft` and `wiki-draft` (`test/recordings/model-review.json`, `model-vip-draft.json`, `model-wiki-draft.json`,
committed unchanged). All five cases of `test/model.recorded.test.vibe` replay with no key; none skips.

**Bug: an agent-requested history write ran as the person in mock mode.** Live, `worker/ActionsHttp.vibe` starts an
agent-door run with actor `agent` (`startActor`), and `ActionRuns.callerOf` hands the history that actor, so the
agent's note is signed `name (agent)` and the agent never takes a person-only action. The browser's mock Actions world
is the person's (`src/web/backend.vibe`), and `MockActions`' history caller read only that world's actor, so a note
the scripted agent requested (`Run /note …`) was signed as the person. The caller now also reads the run's origin
(`RunMetrics.CurrentOrigin`), whose actor `run` sets with the proved `actionActor(door, actor)`; the run's usage
records name the agent too, as live's do. Unit: `test/agentDoorHistory.test.vibe` (failed first: the agent's note was
signed `rira`). Journey: `e2e/actions.spec.ts` "a history note the scripted agent requests is signed as the agent's".
It is also the browser's only path to `may`'s agent operand, `peopleOnly` and `historySignature`'s agent arm, and
`/history` reaches `leastRole("show")`.

`e2e/history.spec.ts` "shows a new member and a community member only what a viewer sees" covers `standing`'s `new`
and `community` arms: both rank below a contributor, so neither plans, notes, folds or exports.

The agent-note journey failed once in session 28's full gate (light project): it requested `/history` when the
Note run's card appeared, not when the run settled, so the read could overtake the write. It now waits for the card's
`Passed` badge; 18 of 18 runs passed across three projects and three repeats.

**Bug: the scripted agent could not request a hyphenated command.** Its pattern `^run\s+(\/[a-z]+…)$` stopped at a
hyphen, so `Run /sandbox-run …` and `Run /sandbox-stop …` got a plain reply instead of a run, though both are
registered commands (`src/actions/catalog.vibe`). The pattern now takes `[a-z][a-z-]*`. Unit:
`test/mockFactory.coverage.test.vibe` "the agent requests an action its poster may run …" (failed first). Journey:
`e2e/actions.spec.ts` "the agent runs each history and sandbox command a maintainer may run", one run of each kind
`src/actions/execution.vibe` prepares and executes: plan, start, sandbox start, command and stop.

### `src/history/flowMachine.vibe` sites the browser does not reach

| Site | Reason |
| --- | --- |
| `record`, `lawful`; `authorize`'s non-`begun` arm; `canRecord`'s repeated-fold operand | The proof's model of a run. Product code calls `begin`, `authorize` and `canRecord` once per run (`flows.vibe` `authorizer`) and journals its record steps itself. Proved (0018) and unit-tested (`test/flowMachine.test.vibe`); spec functions once the compiler parses VIP-43 (`~/vl/vibelang-bugs/spec-only-function/`). |
| `authorize`'s `forbidden` arm; `may`'s person-only refusal | The mock history page plays a person, and the same role hides every action it may not take; the agent's door has no command for approve, fold or export (`src/actions/catalog.vibe`). A refusal reaches the page only as the History's answer (`fault=refused`, `e2e/history-faults.spec.ts`). |
| `historyStatus`, `historyResponse`, `resolvedRole`'s and `signedRole`'s live arms | Live mode only: `historyStatus` runs in the Worker (`wire.vibe`), `historyResponse` in `LiveMythical`, which the browser gate has no host for yet. A live history host beside `test/workerd/live-issues.vibe` closes them in the browser; the unit and workerd gates measure them meanwhile. |
| `initialEpic`'s `"new"` arm | A history with no epics. The mock always bootstraps the seed, and the page shows Plan only after the outline loads. Unit: `test/flowMachineEdges.coverage.test.vibe`. |
| `validPlanField`'s operation checks | No view sends `UpdatedForm` with field `how` (`historyView.vibe` sends title, epic, newEpic and task); the guard refuses a forged message the fuzz lane found (0015). Dead in the browser: removing `how` from `UpdatedForm`'s field literals would delete it, a change to vl-fuzzpkg's fix that this lane proposes on the board rather than makes. |

## No execution is no coverage evidence

The strict browser gate fails a green selection with zero executed checks, including an all-skipped opt-in
selection and an empty selection. This check runs before any early return or source-map read. The ordinary
`pnpm e2e` reporting mode still permits skipped selections. `test/browserCoverageEvidence.test.vibe` exercises
`onTestEnd` and `onEnd` together in an isolated process with the actual strict-mode environment flag.

Tracked and fixed in [#5340](https://github.com/smithersai/smithers/issues/5340).

## Nested source obligations and fixture transaction isolation

The browser denominator retains unexecuted code removed from inside a retained function. Bundle statements replace
only corresponding compiler statements, paired by source start or by a single initializer's end when Rolldown omits
its start. Functions match by body start; branches match by type and ordered arm starts. An enclosing range alone
never removes a nested function, statement or branch. `test/browserStructure.test.vibe`,
`test/browserCoverageBuild.test.vibe` and `e2e/source-map.spec.ts` keep both synthetic and real bundled negative
controls: the outer function runs while its removed arrow and conditional remain uncovered.

The Node object-storage host serializes independent asynchronous transaction callbacks per storage. Calls made
inside an active callback retain savepoint nesting. Siblings serialize, and parents await their started children.
A rejected callback rolls back its own writes and preserves its error. Failed `BEGIN` leaves depth unchanged;
every opened transaction releases depth once, even when `COMMIT` fails. A failed commit rolls back before
the next caller enters. `test/objectStorage.test.vibe` exercises overlap with explicit barriers, nested rollback,
deferred foreign-key failure and recovery against real in-memory SQLite. These are test-host guarantees, not claims
about production Durable Object storage.

The SQL driver parks its storage callback while an Effect fiber runs the body. The fixture preserves ownership
across that boundary using the fresh public SQL transaction frame's identity in caller and owner contexts. It
never infers ownership from a global nesting depth or a reused level number. Tests in
`test/objectStorage.effect.test.vibe` cover sequential and forked savepoints, independent clients, rollback,
escaped contexts and a SQL client consumed as a layer dependency.

Tracked and fixed in [#5354](https://github.com/smithersai/smithers/issues/5354).

## Inspector failures during coverage collection

Inspector discovery, including its response body, and WebSocket opening each have a 15-second deadline. Opening and
CDP requests reject a premature socket close; each request removes its listeners and timer when it settles. Socket
cleanup encloses the handshake as well as counter collection. A failed dump still fails measurement and reaches the
measured worker's disposal finalizer, so an unavailable inspector cannot leave workerd running indefinitely.
`test/workerdCoverageShape.test.ts` exercises stalled discovery headers and bodies, an unanswered upgrade, and an
early close over real loopback connections; `test/workerdCoverage.workerd.test.vibe` checks successful collection.

## Writes held behind a saved write (vl-coverage, session 31, 2026-11-13)

`e2e/issue-paths.spec.ts` adds five journeys, four over `fault=issue-write` (the first write happens and its answer is
lost): Retry pressed twice files the issue once; a lost review request answers another reviewer with "Retry the saved
action." and resends when the same reviewer is asked again; a lost Decline holds Accept until Decline is sent again; a
viewer is offered no Retry for a maintainer's lost revision. The fifth uses the new `issue-assignee` fault. They close
`issueAction`'s retry guard, the spec-review `saved` and `blocked` arms, an operation's `saved` and `blocked` arms, and
`issueFailureText`'s `assignee` arm.

The double-click journey credits the retry guard only when the second click lands before the page renders the first
(Chromium dispatches both within one frame). Its assertion, one issue, holds either way. The same journey for Request
review is not kept: the mock answers a review before the second click arrives, so a double-click is two reviews, as
two separate clicks are.

### `src/web/issueDecision.vibe` sites the browser does not reach

| Site | Reason |
| --- | --- |
| `issueAction` spec-review `state.busy \|\| !f.allowed` (line 154) | Each Request review button is disabled while busy and rendered only for a role with `spec-review` permission; the mock settles a review before a second click lands (above). Unit: `test/issuesUpdate.coverage.test.vibe`. |
| `back` at step 1 and `continue` at step 4 (lines 173, 177) | The form renders Back only for a VIP past step 1 (`issuesViewDecision` `back: vip && step > 1`), and Continue only before the last step. The clamps keep the proved step within 1 to 4. |
| `new-form`, `vip-form` and the three dialogs' `!f.allowed` (lines 181, 186) | Each button is rendered only when `issuePermission` grants the same operation (`issuesView.vibe:142`, `:164`), and a role change re-renders before another click. |
| `propose` with a blank title (line 191) | Step 1's Continue refuses a blank title and only step 1 shows the Title field, so Submit VIP never sends one. |
| `issueDefaultRole` (line 264) | Both hosts answer every issue read and write with `role` (`src/core/IssuesFactory.vibe:125`, `worker/Issues.vibe:301`, `:427`); `IssuesState.role` is optional only because the stored projection has none. A response schema with a required role would delete it (`src/core`, vl-coverage-core). |
| `issueRecoveredView`'s specification arm (line 291) | Only a live resume reaches it; `e2e/live-issues.spec.ts` resumes new issues, comments and VIPs, and the issue recording has no specification write. |
| `issueFailed`'s irrelevant arm (line 361) | A failure that is not the pending retry's own answer needs a second failing write while one is held; every fault page fails one write. |

## Required Factory services (vl-coverage, session 31, 2026-11-13)

`accounts`, `issues` and `wiki` are required in `src/core/Factory.vibe`. Both selectable factories always supplied
them (`src/web/backend.vibe`), so every `=== undefined` guard on them was dead in the product: fourteen in
`src/web/main.vibe` (wiki read and save, the issue count, the role stream, load, choose, sign in, sign out, people,
grant, issue load, act, details and refresh), `src/actions/MockActions.vibe`'s Guest identity, and the CLI's
"Issues unavailable.", "Wiki unavailable." and "Sign-in isn't available." guards in `src/surfaces/commands.vibe` and
`src/surfaces/signin.vibe`. They are deleted, not tested. Unit tests that built a factory without the services now
supply failing ones (`test/commands.coverage.test.vibe` `closed`) or delete the case that tested only the guard;
`test/support/overlaid.vibe` can no longer remove a required service. Fuzz changes: 0015.

### `src/web/main.vibe` after session 31's gate (622/718 branches)

`e2e/actions.spec.ts` "a command picked from the slash menu starts its run and clears the composer" closes `PickedSlash`'s
action arm and `launchAction`'s slash text. Two classes of the remaining arms have no browser input:

| Class | Example | Reason |
| --- | --- | --- |
| A response to a pane the page never opened | `IssuesLoaded` and `IssuesFailed`'s `model.issues ?? initialIssues` (lines 401, 416) | Every `LoadIssues` sender (`init` with `openIssues`, `OpenIssueCard`, `ClickedIssues`) writes `model.issues` first, and no update clears it. The fuzz targets that send any Message in any Model (`fuzz/pane-messages.fuzz.vibe`) reach them. |
| A role-less issue answer | `?? IssueDecision.issueDefaultRole(...)` (lines 384, 1449, 1461) | Both hosts answer with `role` (session 31's `issueDecision` table). |

## Replies that arrive after the person moved on (vl-coverage, session 32, 2026-11-13)

`held-details` (`test/support/FaultyFactory.vibe`) runs live mode, holds the first issue's details read until the next
details read has answered, then fails it. `e2e/late-details.spec.ts` opens #42, goes back, opens #38, and checks that
#42's late failure shows no error on #38. It closes `IssueDetailsFailed`'s stale arm (`main.vibe` 415). The journey
waits on `faulted` in the page's snapshot, then two frames, before its check: no timer.

`IssueDetailsLoaded`'s stale arm (414) has no browser consequence: a details answer is the whole projection, so a late
one for #42 carries the same items #38 shows, and a journey asserting on it would pass with or without the guard. A
write between the two reads would make it visible, but live mode's only sign-in leaves the page
(`e2e/chat-paths.spec.ts`), so the browser has no live role that may write. The unit gate keeps it
(`ModelDecision.issueDetailsApply`).

`held-actions` (`test/support/heldActions.vibe`) wraps the host's MockActions: the first command list answered for a
maintainer waits until the page releases it. `e2e/late-actions.spec.ts` visits as maintainer, then as viewer, waits
until the page holds the viewer's list, releases the maintainer's, and checks that the viewer's slash menu never
offers `/post`, a contributor's command the late list holds. It closes `LoadedActions`' stale arm (`main.vibe` 511).
A first version released the held list when the viewer's list answered; with the guard removed it still passed,
because the late list reached the page first and the viewer's replaced it. Releasing from the page orders the two.

`held-start` and `held-start-failed` (same module) hold the first run start until the page releases it; the start
itself begins only then, so a list the page loads meanwhile holds no run of it. `e2e/late-start.spec.ts` presses Run on
Tour, visits as maintainer, releases the start, and checks that the old role's run joins no list (`StartedAction`,
`main.vibe` 515) and that its failure shows no error (`FailedActions`, 512); then Run again shows exactly one run, so
the new role can still start one. With both guards removed both journeys fail.

The failure journey found a bug: a page whose role had never changed holds no actions epoch, so its Run, Retry,
Select and slash-menu loads sent none, and `FailedActions` without an epoch applies under any role. A start that
failed after the first role change showed "Couldn't start the run." to the new role. Every load and start now carries
`epoch ?? 0`, `LoadedActions` and `StartedAction` require it, and the epoch-less paths are deleted. Only `ReadAction`
and `CancelAction` failures, which name one run, still carry none.

`FollowedAction`'s and `FailedActionFollow`'s stale arms (517, 518) are not reachable from a page. The follow
subscription's dependencies are exactly the guard's inputs (epoch, follow generation, watched ids), and Foldkit restarts
it with `Stream.switchMap` (`foldkit/dist/runtime/subscriptionFibers.js`), which interrupts the old stream when they
change. A stale follow message exists only when the old stream queued it after the changing message was queued and
before it was applied, an order Effect's scheduler decides and no page action sets. `test/actionFollow.test.vibe`
keeps both arms and their `?? []` defaults.

`issueDefaultRole` waits on vl-coverage-core: the board post of 2026-11-13 17:45Z asks for `role` to be required in
`IssuesState` (`src/core/issueSchemas.vibe`).

