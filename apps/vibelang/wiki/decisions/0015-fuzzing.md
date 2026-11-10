# 0015. Fuzzing

**Status:** package landed; app suite in progress. **Rulings:** VL-14, VL-15, VL-29.

## Package

`@smthrs/fuzz` copies `smithersai/effect` at `fc84e193be6b202f34a7351cdfb693629c95a38c` into `packages/fuzz`.
`Fuzz.ts`, `testing/FuzzSimulation.ts`, and `internal/fuzz/{engine,format,simulation,tape}.ts` remain TypeScript, file for file: the base copy changes only imports, followed by the documented large-tape mutation fix below. This is the code we intend to contribute to Effect; keeping the copy identical makes contribution and later syncs simple. The original five test files likewise change only imports.

The library catalog's existing `@smthrs/testing` owns Node test tooling: the fork's filesystem corpus store is `src/internal/fuzz.ts`, and `@smthrs/testing/Vitest` adds `it.effect.fuzz` and `it.fuzz` without mutating the peer runner. `FuzzCorpus` exposes corpus tooling from the root. No Node API enters `@smthrs/fuzz`.

### Internal imports

- `internal/arbitrary/model.ts`: Effect 4.1.1 exposes no public generation/shrink-pull helpers. Copy only `ShrinkPull`, `Sample`, `Discarded`, `Attempt`, `Computation`, `Generation`, `GenerationRandom`, `GenerationState`, `Generator`, `onTypedFailure`, `isAttempt` and `toEffectGeneration`. Comments name the fork file and commit. The installed source matches the fork's model byte for byte.
- `Arbitrary.gen` is present at runtime but stripped from the npm declarations by `@internal`. Mirror that single type-only member in the copied model protocol; no runtime patch. The package emits declarations with the fork's compiler settings (`noUncheckedIndexedAccess: false`) and exposes that declaration boundary to stricter consumers. Its install `prepare` builds those declarations. Copied Vitest tests have a separate compiler project using the same upstream setting.
- Formatting uses public `effect/Formatter`, identical to the fork's formatter. `encoding/Base64Url` is public too. No formatter is copied.
- No fork-only Effect runtime change is required. Effect stays pinned at 4.1.1.

The explicit contribution copy retains upstream JSDoc and formatting, checked separately from Smithers-authored adapter code. It is excluded only from Smithers-specific JSDoc rewrites and its formatting pass, never from coverage.

## Corpus and budgets

All-Schema targets save confirmed, shrunk values when their JSON codec encodes them; otherwise they save a revision-bound tape. Failures live beside each test in `__fuzz__`, committed as regressions. Search inputs live in the ignored `node_modules/.cache/effect-fuzz` cache. Failed confirmation is reported as flaky and is not committed as a regression. Distinct fixed counterexamples of the same signature are retained.

A saved JSON value must still decode under its target's schema, or the target fails before it runs. A new input field
is optional; a field a schema makes required is added to every saved value with the default `init` gives it
(`Model.theatre`, 2026-11-10: five `web/*` values had broken `web/view-branches`, `web/view-models` and
`web/subscriptions`).

A plain Vitest run replays saved failures and executes 100 fresh inputs. `EFFECT_FUZZ=1` searches all registered tests; `EFFECT_FUZZ_DURATION`, `EFFECT_FUZZ_EXECUTIONS`, and `EFFECT_FUZZ_SEED` set a session's budgets and seed. A duration also raises the runner timeout by 30 seconds for shrinking and cleanup. App targets will use short per-run defaults and `FUZZ_BUDGET` for campaigns.

## Executed package coverage

The eight package suites pass: 92 tests, 677/677 lines, 457/457 branches, 156/156 functions and 783/783 statements. This includes the fork's race, replay, corpus, confirmation, exhausted-run and Fable regression tests, plus an empty-cause shrink regression for the copied helper, a browser-global realm and Bun boundary executions. The package has no coverage exclusions.

## App targets and campaign

Pending after the package lands: conversation and delivery sequences, wire codecs, reply reasons and progress, sequencer, budget, tour, mock Factory, view and update, CLI/MCP arguments, and requests against the real API Worker in workerd. Concurrency uses `FuzzSimulation` with deterministic Effect services. App fuzz coverage will be measured independently using vl-coverage's V8 configuration, with any unreachable line named and justified here. The final record includes per-file lines and branches and the 30-minute campaign's findings.

## Confirmed app findings

**Delegated reads dropped their query (vl-fuzz2, 2026-11-10).** `GitHub.Delegation`'s site `client` ignored
`RequestOptions.query`, so `Contents.getText(..., { ref })` through smithers.sh read the branch tip. A wiki proposal
whose base main had moved past checks the base against the commit its branch will use (`Wiki` 146); that read
returned the tip, so the check passed and a review opened on a stale base. Found by `wiki/steered-host`
`delegated`; fixed in `@smthrs/integrations` (`Delegation.vibe`, test "a delegated read keeps its query"); both
`wiki/steered-host` and `wiki/host-calls` (which now asserts that a write behind an advanced main is a conflict) keep
their failing values.

The growing app suite retains every value under `fuzz/__fuzz__/` when its target lands. Unit regressions land with
these fixes first. Malformed UTF-16 conversation ids and history ids/queries previously threw `URIError` while
building URLs; public path helpers now refuse them and all nine live Factory operations, including the new sandbox operations, return typed `Unavailable` before HTTP.
Unpaired surrogates in write bodies cannot survive the durable store's canonical JSON contract; the wire schemas
refuse them with HTTP 400, and a direct conversation host call leaves storage unchanged. Valid paired emoji remain
accepted. No public sequencer refusal code changes.

An unknown `UpdatedForm.how` value previously corrupted the model's method enum; the update accepts only append,
insert and amend. Empty history metadata produced unnamed links and options; rows, crumbs and options now retain
names, and an absent main SHA produces no commit link. Reply failure tags now accept only string tags, including
hostile getters without a defect. Mythical rank validation also gained an explicit nonfinite/negative/fractional
regression against the `Seq` schema already maintained by the proof lane.

The completed 31.69-minute campaign (seed 20261107, 65 seconds per target, 62,059,364 executions across 55 completed
target receipts) found the surrogate storage defect and a fuzzer mutation crash. The latter's 200,000-word regression
and fix landed separately in `@smthrs/fuzz`; this is one documented follow-up delta to the otherwise identical fork
copy. The campaign's history file failed to load because of a test constant typo, and the native CLI's process
profile refused workerd's listener. Those failures are retained as harness evidence; they are not successful history,
workerd or browser campaign coverage. Current short runs use the same flow through the public durable Node host,
real SQLite and production file boundaries, and have passed real workerd and Chromium. App fuzz-only coverage
remains unfinished; no whole-app 100% claim follows from the configured threshold.


### Coverage measurement boundary

This suite uses the same patched Vitest/V8 5.0.0, ast-v8-to-istanbul 1.0.5, native Chromium ranges and source-checked
maps as 0016. The app now declares the monorepo's shared optional runner peers (`happy-dom` 20.13.2 and `@types/node`
26.4.1); differing direct peers had produced separate Vitest singletons and zero-test load failures. These are
existing test tools at monorepo versions, awaiting the VL-5 approval listed in 0008.

The retained 0016 reproduction at `~/vl/vibelang-bugs/coverage-source-ranges/` proves the bundled converter can credit
an unexecuted source return. Browser line/statement results are diagnostic, and a configured 100% gate cannot
establish the requested coverage until that defect is fixed. No compiler output or source maps were changed as a
workaround. Workerd's inspector also refuses precise V8 profiling; real workerd request evidence is separate from
Node coverage of the same shared Worker functions. Real-model happy paths still need an authorized model binding.

### Further generated boundary regressions

Page schemas now use the shared finite nonnegative safe-integer `Seq` for head ranks, note/fold counts, epic
counts and page offsets/totals. Schema-generated NaN and Infinity previously encoded as JSON null and failed
round-trip. The targets keep their broad original input schemas, replay those exact values and require typed
refusal before accepting valid round trips.

At `Number.MAX_SAFE_INTEGER`, `decide` previously accepted an event with an unsafe cursor. It now refuses
`full`, including tour commands; the last safe post still succeeds. The existing safety contracts remain,
acceptance contracts retain their domain below the limit, and new contracts cover the terminal cursor. The
web labels the refusal “Conversation full”. The latest isolated-assertion Dafny check verified 5,812 conversation and 22 screen obligations; a
negative control removing the boundary guard failed two obligations. The negative control used the preceding non-isolated verifier configuration; its two failed obligations
are a rejection receipt, not a comparable verification count.

A repeated agent tool call in product mock mode previously created a second history event. The mock now
uses the durable engine's execution identity derived from the operation key; human writes retain distinct
identities. The public HTTP client refuses this private agent capability before transport. The trusted
Worker adapter continues to supply its existing private replay identity. Plan/note replay has a failing-first
regression; fuzzing also exercises start and the typed public-boundary refusal.

## Status, 2026-11-09

**Not complete.** Goal 3, 100% fuzz-only coverage, is unmet: 5056/6850 lines (73.8%), 6330/11787 branches (53.7%); 35 of 134 files are at 100%. `pnpm fuzz:coverage` exits 1 with 360 per-file gates failing; its target and browser phases pass. Budgets are wall-clock, so totals move between runs under load: the preceding run measured 74.9% of lines.

Second campaign: seed 20261109, 32 seconds per target, 32.5 minutes, 118 vitest targets, 69,460,816 recorded executions. It stopped at the target phase with 6 failures, so its browser phase did not run. All 6 were fixed and replay from `fuzz/__fuzz__/`.

| Finding | Class | Fix |
| --- | --- | --- |
| Mock issue factory died on a lone surrogate | product | typed `invalid`, as the Worker answers |
| VIP aside link without a path was unnamed | product | names it "Files" |
| Tampered sign-out ended the modeled session | oracle | model ignores tampered sign-out |
| Reused bad GitHub id in lifecycle | oracle | resets the person, reconnects |
| `Digest` missing in the demoted-role path | harness | target provides `WebCrypto.layer` |
| Control character in a test cookie | harness | target sends printable text |

`fuzz/screens.fuzz.vibe` found earlier: a non-numeric parent sent `NaN`, which JSON carries as `null`; `spec-review` discarded a saved action and minted a new key for the same reviewer; a review link without a verdict, a blank assignee and untitled issue and action rows were unnamed.

`browser/random-interactions` flaked under load because the target modeled a returning visitor without saying so. A first visit to `/` starts the tour 1200 ms after boot unless the palette is open, and the running tour consumes Ctrl+K (0014). A key delivered after the timer opened nothing. Measured at 20x CPU throttle: the keydown listener attached 1 to 3 seconds before the press, the app called `preventDefault`, and no palette opened in 45 seconds, so a lost keypress is ruled out. Targets that drive the palette or the account menu now set `vibelang:toured`, as the e2e specs do. `browser/palette-after-tour-timer` holds 2 seconds past first paint and failed before the fix. The dialog wait is back to the 5-second default; the target passed 3 of 3 at host load 26.

With the tour out of the way the target found its own oracle error: `{"op":0,"text":"/"}` leaves the palette open after one Escape, because the first Escape dismisses the slash menu (0023). The target now requires both presses; the value stays in the corpus.

Third campaign: seed 20261110, 32 seconds per target, 35.2 minutes across 122 target receipts, 63,664,898 recorded executions. One failure, a harness defect: `wiki/github-host-operations` injected a 5xx, and the wiki flow retries `unavailable` for up to 120 seconds on the real clock, past Vitest's limit. The target no longer injects 5xx; `wiki/failure-mapping` covers that mapping. That target then passed at the same seed (209 executions), and the browser targets, which the stopped campaign did not reach, passed at the full 32-second budget at host load 69.

Seeding returning visitors removed the tour coverage that the race had supplied by accident, so `browser/first-visit-tour` now asserts it: the tour starts itself, Ctrl+K opens no palette, and Escape ends it.

Coverage budget: `pnpm fuzz:coverage` now defaults to 5 seconds per target, because the deadline starts before corpus loading and arbitrary construction. At 250 ms, 12 of 128 targets ran no fresh execution and passed anyway. At 5 seconds none did: 5412/6936 lines (78.02%), 7555/11895 branches (63.51%), load 16. `pnpm fuzz` keeps 250 ms and can still run a target zero times. Saved values from before `IssuesUi.connection` replay through `fuzz/issues-corpus.vibe`, which leaves their files unchanged.

Coverage is still bounded by decision 0016's bundled source-range defect and by workerd's refusal of precise V8 profiling. `worker/Api.vibe` remains the only exclusion: Alchemy evaluates it to build the Worker, and request code runs in `Http` and `Objects`.

`web/guided-commands`, `web/command-sequences` and `web/commands-from-any-model` run the Commands `update` returns against the real mock Factory and Actions, the same seen as live, a backend without optional services, and a backend that fails every call. Each Command's Message goes back through `update`. Random `Message` unions rarely reach a draft and then a submit: a `PostMessage` mutant survived 10 seconds of `web/command-sequences`, so `web/guided-commands` picks each gesture from what the screen offers and was confirmed to kill that mutant. Both of its findings were oracle errors, kept in the corpus: `IssueUi` carries a free string and `issuesUpdate` casts it, and the view only sends members of the union. The target sends the legal values.

`web/subscriptions` runs every subscription over arbitrary Models with native happy-dom events and the same backends. Its one finding was a harness error kept in the corpus: a plain `Event` named `touchmove` has no `touches`; the target now sends real `TouchEvent`s.

Fourth campaign: seed 20261111, 32 seconds per target, 35 minutes, 128 target receipts, 78,428,038 recorded executions, none with zero executions, frozen at `29feabbc`. One failure, an oracle error: `actions/object-lifecycles` assumed a refused `start` leaves no run. A `start` refused after recording its request settles a terminal failed row, and `cancel` on a terminal row answers `null`. `not-found` now requires that no row exists; the value stays in the corpus.

## Status, 2026-11-09 (later)

Fuzz-only: 85.96% of lines, 69.46% of branches; goal not met. Sandbox objects, action identity, wiki tools and writer, specification reviewers and device sign-in now have targets. `machineObject`, `accountObject` and `gatewayOf` are separated from Alchemy's `.make` so a container of local processes (`fuzz/machine-box.ts`) drives the real bodies; live Containers stay off. Commands in those targets come from a fixed list, because they execute. A successful model answer is not reached: it needs a scripted model server.

## Lines fuzzing cannot execute

Alchemy runs these only when it binds a Worker inside Cloudflare's runtime; `Cloudflare.DurableObjectState` and the Durable Object namespaces do not exist in a local target. Every body they call has a target through the exported function named.

| File | Lines | Runs in | Body reached through |
| --- | --- | --- | --- |
| `worker/SandboxMachine.vibe` | 11-13 | `SandboxMachine.make` | `machineObject` |
| `worker/SandboxAccounts.vibe` | 12-15 | `SandboxAccount.make` | `accountObject` |
| `worker/SandboxAccounts.vibe` | 22-25 | `gatewayWithIdentity` with a container image | `gatewayOf` |

Lines 20 and 21 of `worker/SandboxAccounts.vibe` are the no-image branch; `sandbox/gateway-without-image` runs them. These lines stay in the denominator: the record replaces an exclusion, so the 100% gate fails on them until a target can reach them or Will rules on excluding them.

`account.run` no longer reads a snapshot for a refused answer. The gateway never read it, and a refused snapshot died there.

`web/command-sequences` is folded into `web/guided-commands`: arbitrary Messages now arrive between gestures the screen offers. It had no retained regressions.

`fuzz/model-server.vibe` answers the provider's HTTP and SSE on a real local socket. `fuzz.config.ts` loads QuickJS's compiled module under Node so `Reply.answer`, the wiki writer and the reviewers run to a completed answer. The refused-port cases of `wiki/writer` and `specification/reviewers` now reach provider backoff, about 2 seconds per execution.

## Status, 2026-11-09 (sixth session)

Fuzz-only: 6284/7042 lines (89.23%), 8916/12110 branches (73.62%), 42 of 142 files at 100%, at a 5-second budget; goal not met. `worker/Http.vibe` is at 100%; `worker/Reply.vibe` is at 136/136 lines and 75/81 branches.

Fifth campaign: seed 20261112, 32 seconds per target, 41.7 minutes, 145 receipts, 60,449,973 recorded executions, none with zero executions. The browser phase did not run after the failure, so the five browser targets ran afterwards at the same seed and budget; all passed. One product bug: with a valid stored session and a device flow pending for another server, `login` answered signed-in with that flow's user code and URL. It now offers no code when signed in; the value stays in the corpus.

## Lane vl-fuzz2: worker and view branches, 2026-11-09

A second fuzz lane drove branch coverage of `worker/{Issues,Wiki,ActionRuns,Objects,Sequencer,HistoryActions}.vibe`
and `src/web/{view,viewDecision,theatreDecision,viewport,startupDecision}.vibe`. Its targets steer inputs toward the
states a branch needs (a started run before its alarm, a reply open when it is cancelled, a demotion between alarms)
instead of waiting for random sequences to find them, and throw a named `Finding` so a counterexample says which
invariant broke.

| Target | Checks |
| --- | --- |
| `web/decision-contracts` | startup and view decisions against their written contracts |
| `web/view-branches`, `web/chat-steered` | steered chat models render with every control named; the composer answers keys as its contract says |
| `web/viewport-gestures` | reader gestures over a happy-dom page, a windowless document and no host: a pause needs an active, scrollable page; follow scrolls only on the current intent |
| `sequencer/tour-and-settle`, `sequencer/stored-log` | tour controls, settle answers, grants and actions on the real sequencer; an undecodable stored log is one defect |
| `actions/run-hosts` | starts, retries, conflicts, alarms, cancels, demotions, hosts stopped mid-start or mid-reply, history hosts that refuse, fail or cannot cancel |
| `actions/run-answers` | posts answered by `fuzz/model-server.vibe`'s scripted model under a ledger that admits, refuses or dies; a reply's row agrees with the reply |
| `actions/history-host` | the history host over every flow kind: start, busy, alarms, receipt, cancel |
| `objects/conversation-host` | posts, tours, tour controls, wiki pages and alarms; each call returns within 20 s; a fresh incarnation replays the same conversation |
| `issues/host-writes` | link, commit, uncommit, accept, decline and read, checked against the scripted GitHub's state |
| `issues/journaled-writes` | replay joins, a changed payload is refused, a resumed read reports the outcome, recovery retries only a failure, HTTP names the reason |
| `wiki/host-calls`, `wiki/served-failures` | the wiki host's refusals before any write; HTTP status per reason; a host defect stays a defect |

Product bugs fixed, each with a regression test that failed first:

| Finding | Fix |
| --- | --- |
| A chat link with a blank label, `[\t](#issue-4)`, had no accessible name | Markdown shows the link's target as its text |
| The issue card's open button took the same blank label | it reads `Open #<number>` |
| A wiki save or propose whose credential went after the call began answered `connect`, but dropped the reviewed text and the fresh request's `unwritten` mark | both kept, as when the person arrived without a credential |
| A tour accepted after a post, before that post's reply started, deadlocked the conversation: the reply's start waited on the tour while the tour waited on the reply's held execution | Learn more answers `busy` while a dispatched reply's question is unanswered (`Objects.tour`) |
| Tour, alarm (the tour parks), end tour, a second tour, then seek: the seek signalled the second tour's gate, whose run did not exist yet (the first tour's execution was still held), and the engine store died with `FOREIGN KEY constraint failed` | `@smthrs/engine-store`: a deferred completed for an execution with no run is `NotFound` and stores, journals and wakes nothing, in the SQL and memory stores alike. The waiting tour restores the sought step from the sequencer when it starts. Tests: the store contract, `DeferredPersistence`, `RunDriverEdges`, and `test/tourSeekQueued.test.vibe`; the value is in `fuzz/__fuzz__/objects-conversation-host-1f5170fb7ee19c5a/` |

Unreachable fallbacks removed from `src/web/view.vibe`, behaviour unchanged: the tour narration's `?? false`/`?? ""`
after a length check, the video `loop` no asset leaves unset, the poster-still path (every poster asset has controls),
and a second `?? []` for issue items. External: happy-dom 20.13.2's `WheelEvent` drops `ctrlKey` from its init; the
viewport target passes the two fields it reads. happy-dom's `WheelEvent` extends `UIEvent` where the UI Events spec
says `MouseEvent`, so no `MouseEvent` field is read from the init; 21.0.4 has the same class. Minimal reproduction:
`~/vl/vibelang-bugs/external-happy-dom-wheel-ctrlkey/` on nyc-01 (`node repro.mjs <happy-dom directory>`, exit 1 while
the defect stands).

Fuzz-only coverage of the lane's files by `pnpm fuzz:coverage` (5 s per target, Node and happy-dom in
`coverage/fuzz-unit`, merged with Chromium in `coverage/fuzz`), 2026-11-10 on nyc-01 at load 20 to 25:

| File | Lines | Branches |
| --- | ---: | ---: |
| `src/web/startupDecision.vibe` | 9/9 | 18/18 |
| `src/web/theatreDecision.vibe` | 18/18 | 56/56 |
| `src/web/view.vibe` | 53/53 | 173/173 |
| `src/web/viewDecision.vibe` | 22/22 | 52/52 |
| `src/web/viewport.vibe` | 48/48 | 58/58 |
| `worker/HistoryActions.vibe` | 33/33 | 19/19 |
| `worker/Sequencer.vibe` | 118/118 | 62/62 |
| `worker/Objects.vibe` | 111/112 | 47/49 |
| `worker/ActionRuns.vibe` | 114/117 | 152/168 |
| `worker/Wiki.vibe` | 137/172 | 196/234 |
| `worker/Issues.vibe` | 256/290 | 429/460 |

`Objects` is that run's map merged with a rerun of `objects/steered-host` after its `tour-behind-reply` scenario was
added (108/112 and 46/49 before it). The merged map now reads the same as Node's for every file above. Wiki,
Issues and Objects no longer depend on load:
`wiki/steered-host`, `issues/steered-host` and `objects/steered-host` run every scenario in every execution on
fresh storage, so the first
execution of a 5 s budget reaches them, and the fuzzer varies only keys, titles and texts. The person is a connected
maintainer with no `GitHubDelegate` (0165), so every validation runs on a real read and the first GitHub write answers
`connect`. They check exact answers: Issues' title, missing, incomplete, empty, tree, closed, assignee and review
refusals marked unwritten; `connect` telling the authority once per answer; an approval recorded on an accepted
proposal and kept by the next read; resume of a failed, recovered, absent, malformed and completed write; the
specification gate; a person demoted to an agent, a viewer or signed out mid-request; reads of deleted users, null
bodies, out-of-range parents and task states; every HTTP failure status; broker refusal mapping. Wiki: recovery
through `retryFrom` and its join, a changed payload under a used key, an unknown page on a fresh execution, `lost`,
the host's defaults, `fork` and `install` statuses, broker refusals, and a connected person demoted before the
first step. Against the same 5 s budget before them: Wiki 137/172 and 181/234, Issues 203/290 and 285/460.

Not reached, with the reason; none is excluded:

- The person's own GitHub writes run through smithers.sh's real delegation (`fuzz/delegated.vibe`, vl-connect) since
  2026-11-10. Left: `Issues` 382 (`publicIssues` provides `FetchHttpClient`, the real network).
- A store fault reaches every typed engine failure (below). A store *write* that fails is a defect by engine-store's
  contract (`RunDriver.ensureCreatedRun` dies on `persistence_failed`; a journal read in `retryFrom` dies on
  `JournalError`), as `Objects.post` already states for its own store. So `retryFrom`'s typed refusal (`Issues`
  353, `Wiki` 245) stays unreached.
  `engine.retryFrom === undefined` (`Issues` 345, `Wiki` 237) and a source run without a perform step (`Issues`
  352, `Wiki` 244): the Cloudflare runtime always supplies both.
- Invariant guards no input reaches: `Issues` 369 (a run's own payload names its flow, operation and key). It reads
  stored data, so it stays; only a store that rewrites a recorded payload reaches it.
- `ActionRuns` 157: `admit` with no stored request. Admission runs from alarms that `ActionRuns.alarm` reaches only
  with a stored request, and nothing deletes it.
- `Objects` 155: the tour's poll failing during a control's wake.

Guards removed or targeted (vl-fuzz2, 2026-11-10). A guard the request schema provably excludes is deleted; one a
caller outside the schema reaches stays, and a target drives that caller:

| Guard | Outcome | Why |
| --- | --- | --- |
| `Wiki.githubWikiHost`: a write operation that is neither `propose` nor `save` answered `invalid` | deleted | `WikiOperation` is `read`, `save`, `propose`, `draft`; `read` and `draft` return first, and every caller passes a decoded `WikiRequest`. `request.op satisfies "propose" \| "save"` makes a fifth operation a compile error there (checked: narrowing it to `"propose"` fails with TS1360) |
| `Issues.githubHost`: an operation no branch handles answers `unsupported` | kept, targeted | `IssueOperation` admits `spec-revise` and `spec-review`; `executeIssues` answers them before `githubHost`, but `githubHost` is exported and called directly. `issues/host-perform-boundary` draws both and runs a permitted witness of each every execution: the host refuses after its read with no write. Mutating the refusal to `missing` fails it |
| `Issues` read: `vip.review` starts with the pull prefix; `vip.number` is a positive safe integer | deleted | `verifiedVip` returns a VIP only after both checks |
| `Issues.verifiedVip`: `match.index ?? 0` | deleted | `matchAll` yields `RegExpExecArray`, whose `index` is a number |
| `Issues` receipt: `approvedBy ?? ""` | deleted | the `find` that selects the receipt requires `approvedBy`; a type predicate now carries it. `approvedAt ?? ""` stays: a stored item may hold `approvedBy` without it |

Reached this session (vl-fuzz2, 2026-11-10), each by a steered scenario that runs every execution:

| Scenario | Fault or control | Reaches |
| --- | --- | --- |
| `issues/steered-host` `store` | `fuzz/faulty-store.ts`: SQL matching a pattern throws; a skip count, calibrated on a healthy request, fails only the run's own open | `Issues` 266 (503), 338, 347, 350, 376; a refused run row is a defect and leaves no run |
| `issues/steered-host` `running` | an `IssueHost` held by a `Deferred` latch | `Issues` 371, 373 (`running`, then `completed` with `selected`) |
| `wiki/steered-host` `store` | the same store; a served read; an unknown operation and a malformed key | `Wiki` 194, 199, 204, 205, 230, 239, 242, 249, 250 |
| `wiki/steered-host` `connected` | a connected read with no delegate | `Wiki` 169 (public page) |
| `objects/steered-host` `tour-seek-end` | a seek to step 11 | `Objects` 125 (`finish`) with no reading-hold wait |
| `actions/held-replies` | a conversation log whose `finish` and `fail` die once | `ActionRuns` 116-118: the reply execution completes as a failure, the reply and its run end failed |
| `actions/held-replies` | a ledger whose `admit` waits on a `Deferred` latch | `ActionRuns` 145-148: a person cancels the running reply; it ends cancelled |
| `issues/steered-host` `delegated` | smithers.sh's delegation over the in-memory GitHub; `end` revokes it | `Issues` 162, 171-175 (a new issue and a split, linked), 184-194 (a whole VIP proposal), 243 (a read after the delegation ended falls back to public issues and reports the loss) |
| `wiki/steered-host` `delegated` | the same, with an `authorize` and a kept draft | `Wiki` 103, 135, 137, 147 (main advanced past the base), 157 (the review replaces the kept text), 171 (the fallback read) |
| `objects/steered-host` `tour-during-reply` | the same latch | a tour while the reply runs is `busy`; after it, a tour is accepted behind the reply and ending it reaches `Objects` 150 (the wake finds the reply's intent); the alarms then end the tour and the reply |
| `objects/steered-host` `tour-dispatch-fault` | the object's storage rejects the held execution's intent write once | `Objects` 148: the tour is recorded and its dispatch dies, so no execution holds the object; Escape wakes nothing, ends the tour, and the alarms leave the agent idle with its entry done. Mutating the missing-intent return to a defect fails it |

A defect in a history tool or in the ledger's `spend` does not fail the reply execution: the agent sandbox and the
reply's composition catch both, and the reply ends "The agent failed. Try again." Only the reply's own sequencer
writes (`start`, `finish`, `fail`) fail it. A reply's run row exists only once an alarm starts the reply, so a cancel
before that answers `not-found`. `actions/run-answers` also takes an optional `settle: "dies-once"` per run.

The fuzz gate's Chromium merge now credits by source start, and the browser build is unminified (decision 0016,
"Chromium merge").

Campaign: seed 20261113, 240 s per target, 14 targets, 28.2 minutes wall on two workers, 19,491,917 executions in 13 receipts
(`objects/conversation-host` hung and wrote none). Two targets failed and were fixed or recorded: `actions/run-answers` (oracle: a lone surrogate post is `invalid` by
design; value kept) and `objects/conversation-host` (the deadlock above). Rerun at the same seed and budget: the
deadlock is gone and the target found the open foreign-key failure; `actions/run-answers` passed (326 executions).

## Status, 2026-11-09 (seventh session)

Fuzz-only at `6386c557` plus the targets below: 6052/7232 lines (83.68%), 6167/8018 branches (76.91%), 49 of 144 files at 100%, 5 seconds per target at host load 42 to 50; goal not met. Both denominators grew with other lanes' code since the sixth session. At that load a 5-second target ran as few as 22 executions (`web/guided-commands`), so branches a target reaches alone can drop out of a full run: `fuzz:coverage` is bounded by time, not executions.

`fuzz/web-tab.vibe` now holds the tab driver the web targets share. `fuzz/main-screens.fuzz.vibe` builds each screen the way a person reaches it, then drives the branches that only that screen reaches:

| Target | Exercises |
| --- | --- |
| `web/walkthrough-stops` | the agent drives stops 1 to 10 in any order; each shows its screen; ending by event, button, Escape, or a failed end that returns to the current stop |
| `web/escape-layers` | Escape closes only the innermost open layer, in the order `update` documents; a wiki save in flight stays open; wiki reads and writes from a mock with one injected fault |
| `web/role-events` | grants to the person, a listed member, a stranger or nobody, in every mode, with gaps, people shown or not, the role dialog open or not |
| `web/command-bodies` | every Command with gaps, from Schema-derived args, against mock, live, bare and failing backends: its declared Message, the failure Message for a missing or failing service, JSON input refused before a start, the epoch echoed |
| `web/conversation-events` | an answer linking an issue refreshes the projection and no other does; a wiki pane follows the page and shrinks maximized sandboxes; an action request is read; a gap resumes |
| `reply/actions-bound` | a real agent cell lists product actions and starts one; the start is announced once with the id the cell got |
| `reply/interrupted` | an interrupted model call reaches the flow as an interruption: no finish, no failure |

`wiki/writer` and `specification/reviewers` bound their failing models to a refused port and waited out provider backoff (36 and 10 executions per 32 seconds). They now use the scripted server's non-retryable 400, which fails at once: 264 and 249 executions per 3 seconds. The retry policy is not what they test.

| Finding | Class | Resolution |
| --- | --- | --- |
| An unpaired surrogate typed into the wiki editor reached the save request, which `DurableText` refuses, and left the Model invalid | product | `UpdatedWikiEdit` stores the text well-formed; value in the corpus (`3240715e`) |
| `web/guided-commands` drove tour stops with an empty target, which the fold ignores, so the walkthrough never ran | target | the stop's own target |
| `web/guided-commands` typed `/vibelang/Post` for a slash command; completions match `/post`, so no slash command launched | target | the command word |
| A cell call whose input holds an unpaired surrogate cannot be keyed; the reply fails with "The agent failed. Try again." | oracle | required; value in the corpus |
| `reply/interrupted` sent a text delta without an `id` | target | the delta carries one |
| `web/conversation-events` posted an empty question, which the fold ignores | oracle | a fixed question; value in the corpus |
| `objects/conversation-host`: tour, alarm (budget refused), end tour, tour, dispatch, pause dies decoding the stored log | product, open | the same family as vl-fuzz2's open tour-and-seek record above; counterexample at `~/vl/vl-fuzzpkg.finding-objects/` on nyc-01, not in `fuzz/__fuzz__/` |

`worker/Reply.vibe` line 356: `canSettleReply(run)` is always true there. `flowDecision.vibe`'s contracts take a run from `beginReply` through a `done` start, `beginReplyComposition` and `finishReplyComposition` to phase `ready` with one start, one composition and no settlement, which is exactly `canSettleReply`; an earlier refusal returns at line 340 and a compose failure is caught or re-raised as an interruption first. No input reaches the false branch. It stays in the denominator, recorded here.

The Alchemy rows above were tried under the repository's workerd host. A module importing `worker/SandboxMachine.vibe`, bundled with `test/support/workerd.vibe`'s esbuild settings, fails with 113 unresolved Node built-ins from 27 deploy-time packages that `@alchemy.run/cloudflare` imports, among them esbuild, vite, workerd, tsx, yargs, jiti and five proxy agents. Bundled or not, `.make` only hands its constructor to Alchemy's `Worker` service (`Worker.export`); lines 11 to 13 and 12 to 15 run when Alchemy's generated Worker instantiates the object, and 22 to 25 when `gatewayWithIdentity` builds with an image. Miniflare 5 can host a Container (`containerEngine`); the missing piece is Alchemy's runtime, not workerd.

Sixth campaign: seed 20261113, 20 seconds per target, 30.2 minutes, 166 receipts, 36,291,681 recorded executions, none with zero executions, at `46478e05`. Vitest: 163 passed, 3 failed; the flow stopped before the browser phase.

| Finding | Class | Resolution |
| --- | --- | --- |
| `web/commands-from-any-model`: Skip on a Model whose theatre step is not an integer made the mock Factory's `controlTour` die: `SeekTour`'s payload refused the step under `Effect.orDie` | product | the mock refuses a body outside `TourControlBody` with `Unavailable`, as the live Factory reads the Worker's 400. Regression: `test/mockTourControl.test.vibe`, which failed first; the 8.3 MiB value stays out of the corpus |
| `web/command-bodies`: a live backend with a wiki fault expected the fault | oracle | wiki faults apply only to the mock backend; value in the corpus |
| `objects/conversation-host` | product, open | the vl-fuzz2 record above |

## Status, 2026-11-10 (eighth session)

`worker/apiObjects.vibe` holds the API Worker's object bodies, which the benchmark lane separated from `worker/Api.vibe`. No target reached it (0/193 lines). `fuzz/api-objects.node.fuzz.vibe` now wires the five bodies to each other in one Node process over `TestNodeRuntime.sqliteObjectStorage()`. Each namespace has the shape of Alchemy's stub: `getByName` throws for an unbound binding, a method call is an Effect, and `fetch` takes the forwarded request. Objects are built on first use, and their storage outlives an incarnation.

| Target | Exercises |
| --- | --- |
| `api-objects/world` | A fixed walk, then up to 10 generated steps in a fresh world. The walk runs in both sign-in modes. It sends every route through `apiFetch` as a signed-in person (signed in through the accounts object's own callback) and as a visitor. It runs conversation and action alarms with a scripted model whose one cell calls every bound tool: wiki draft, history show and note, actions list and start. It also covers a host with no default entrypoint, the sandbox identity by trusted props and by cookie, each namespace unbound and unreachable, and the accounts binding lost after an action alarm's fourth call. Oracles: while every namespace is reachable, no defect and no 500. A 503 comes only from an unreachable object, or from an account route with sign-in unconfigured. An accepted post is in its conversation. A fresh incarnation replays the same conversations. Without sign-in, every role is viewer. Every step answers within 5 seconds |
| `api-objects/budget` | `budgetObject`'s ledger against a model. A reply is admitted while spent is below the limit. Each reply is charged once, at its rounded nonnegative tokens; NaN and the infinities are charged nothing. A total past `Number.MAX_SAFE_INTEGER` is refused and the day stays unchanged. A fresh incarnation agrees. A corrupt stored total (negative, fractional, NaN or infinite) is a defect for both `admit` and `spend` |

One `api-objects/world` execution takes about 15 seconds, mostly the walk, so at the 250 ms default it runs once. `api-objects/budget` runs about 650 executions at 250 ms and about 10,000 at 5 seconds.

Fuzz-only coverage of the two files, at 5 seconds per target:

| File | Lines | Branches | Functions |
| --- | ---: | ---: | ---: |
| `worker/apiObjects.vibe` | 193/193 (was 0/193) | 58/59 (was 0/59) | 86/86 |
| `worker/Budget.vibe` | 22/22 (was 20/22) | 19/19 (was 17/19) | 4/4 |

| Finding | Class | Resolution |
| --- | --- | --- |
| A visitor's `GET /api/wiki` while GitHub refuses answers 503 only after 120 seconds. The wiki read's `perform` retried `unavailable` for its 120-second window (`retries` in `src/core/wikiFlows.vibe`) inside the request | product, fixed in the ninth session | Measured at 120,217 ms to a 503 through `serveWiki` and `publicWiki`. The read flow now declares the engine's `deadline` (`wikiReadDeadline`, 5 seconds); `executeWiki` answers its `DeadlineExceeded` defect as `unavailable`, and the page shows "The wiki didn't load" with Retry. Writes keep the 120-second retry window. Regression: `test/wikiReadDeadline.test.vibe` (122 virtual seconds before the fix) |
| A reply whose Budget, Accounts or History object is unreachable never settles: its steps retry `Unreachable` under `patient`, which never expires, so the person never sees a failure | product, fixed in the ninth session (the lead's call: a reply has a deadline) | `answer` in `worker/Reply.vibe` runs `compose` under the engine's `Deadline.bound` (`replyDeadline`, 5 minutes, counted from the journaled start). Expiry is a defect that `answer` settles as `ReplyFailed` with `failed`, so the person sees it with Retry like any failed reply. Regression: `test/replyDeadline.test.vibe` (no settlement after 120 virtual minutes before the fix). The target still bounds a faulted alarm at 300 ms, or 3 seconds for a binding lost mid-alarm, because the 5-minute deadline is longer than a fuzz step |
| The target's first version reached the real `api.github.com`, because `publicWiki` and `publicIssues` provide `FetchHttpClient.layer` themselves | target | The target injects `WikiHost` and `IssueHost` over an in-process GitHub. These are the service seams that `executeWiki` and `executeIssue` read first |

No value is retained in the corpus: both stored values were target findings, recorded under an input schema that has since changed.

### Lines fuzzing cannot execute, continued

`worker/apiObjects.vibe` line 248, the alarm's wiki draft answered by the accounts object: reachable since the ninth session. `accountsObject` takes its GitHub client, as `historyObject` does; `worker/Api.vibe` passes the `fetch` client. `api-objects/world` passes `wikiGitHub`, which serves every wiki page, and no longer wraps `draftWiki` in the injected `WikiHost`. The scripted model routes the draft agent's own call by its system prompt (`Routed` in `fuzz/model-server.vibe`): `Shorter.` gets an edited page and is drafted; `Fuzz: no draft.` gets a broken stream and is refused as `draft`. A new oracle requires the signed-in maintainer's nonempty draft to be drafted (or `invalid` for a reused key); with the accounts client swapped back to the 404 GitHub, it fails with `draft: the maintainer's draft answered missing`. Fuzz-only coverage at 5 seconds: `worker/apiObjects.vibe` 193/193 lines, 59/59 branches, 86/86 functions.

### Containers: Alchemy's local runtime

The seventh session's record said Alchemy's runtime was the missing piece. That is wrong. Alchemy has a local runtime: `alchemy dev` (`LocalWorkerProvider` and `LocalContainerProvider` in `@alchemy.run/cloudflare` 2.0.0-beta.85) runs the generated Worker in workerd through `@alchemy.run/cloudflare-runtime/core`, and runs its Containers through a Docker Engine API socket (`DOCKER_HOST`, default `/var/run/docker.sock`). Two pieces are missing for the `SandboxMachine.make`, `SandboxAccount.make` and `gatewayWithIdentity` rows:

1. nyc-01 has no Docker Engine socket. Only the podman CLI is installed, and `podman.socket` is inactive. Enabling it is a local-ops change, not a product change.
2. `fuzz:coverage` collects V8 coverage of the Node process. These rows would run inside workerd, and nothing collects or merges coverage from workerd. Hosting them would not change the table until workerd's own precise coverage (taken through its inspector and remapped the way `fuzz/browser-reporter.ts` remaps Chromium's) is merged into `coverage/fuzz-unit`.

### Browser targets

The browser targets ran at the sixth campaign's seed (20261113) and budget (20 seconds), on port 4501. All five passed: `browser/random-interactions` 4 executions, `browser/first-visit-tour` 6, `browser/history-navigation-and-work` 5, `browser/accounts-and-authority` 6, and `browser/palette-after-tour-timer`. Playwright exited 1 only because the source-coverage reporter refused to merge (`Source map does not describe this checkout`): the checkout was rebased while the run was in flight. The reporter's check is correct.

### Seventh campaign

Seed 20261114, 20 seconds per target, at `b5f6b215`, from 02:12:54 to 02:50:00 UTC on 2026-11-10 (37.1 minutes). The flow exited 0: 173 receipts and 36,457,699 recorded executions, none at zero, none falsified. The browser phase ran: 5 passed. `objects/conversation-host`, which failed from the default seed in the seventh session, passed with 49 executions. Under the campaign's load, `api-objects/world` ran 1 execution in 20 seconds, and the browser targets ran 1 to 3 each. No new findings. Log: `~/vl/vl-fuzzpkg.campaign7.log` on nyc-01.

## Status, 2026-11-10 (ninth session)

**Goal 3 is still unmet.** Fuzz-only coverage across `src/` and `worker/` is 6,745/7,421 lines (90.89%) and 6,625/8,087 branches (81.92%); 62 of 149 files are at 100% of both. `pnpm fuzz:coverage` exits 1 on its 301 failing per-file gates.

### Product findings fixed

| Finding | Fix | Regression |
| --- | --- | --- |
| A wiki read while GitHub fails answered 503 after the flow's 120-second retry window | The read flow declares the engine's `deadline` (`wikiReadDeadline`, 5 seconds). `executeWiki` recognizes the journaled `DeadlineExceeded` defect with `RetryPolicy.errorTag` (it arrives as an `Error` named by its tag, not as the class) and answers `unavailable`; the page shows "The wiki didn't load" and Retry. Writes keep the 120-second window, and their retries stay in the durable flow | `test/wikiReadDeadline.test.vibe`: 503 by 10 virtual seconds (122 before the fix); a GitHub that recovers on its third answer still serves the page |
| A reply whose Budget, Accounts or History object is unreachable never settled | `answer` runs `compose` under `Deadline.bound` (`replyDeadline`, 5 minutes from the journaled start). Expiry is a defect that `answer` already settles as `ReplyFailed` with `failed`: the person sees it and Retry, like any failed reply | `test/replyDeadline.test.vibe`: `Posted`, `ReplyStarted`, `ReplyFailed` within 10 virtual minutes (no settlement after 120 before the fix) |
| `@smthrs/integrations` never logged or counted a failed GitHub revoke: `revoke(token) catch () => record(...)` returned the `record` Effect as data (compiler warning EK0508) | `catch effect () => try record("revoke", "failed")` | `Delegation.test.vibe`: "a failed revoke is logged and counted as revoke failed" |

Fixed in the tenth session (the lead's call): the wiki draft, VIP draft and specification reviewers charge their spend under `draftSpend` (`worker/Reply.vibe`), the engine's retry policy with `expirationMs: 120_000`, a deadline for the charge step alone, apart from the model call's. When it expires the draft fails with `budget`, which the page shows with Retry, and the step logs `vibelang.draft.spend` (`draft`, `outcome: unreachable`) and counts `vibelang_draft_spend_failures` (`draft`). Regression: `test/draftSpendDeadline.test.vibe`, one case per draft, no settlement after 600 virtual seconds before the fix, between 100 and 180 after.

### Suite changes

- `accountsObject` takes its GitHub client, as `historyObject` does. `api-objects/world` reaches the alarm's wiki draft both ways and asserts that the signed-in maintainer's draft succeeds (see "Lines fuzzing cannot execute, continued"). `worker/apiObjects.vibe`: 193/193 lines, 59/59 branches.
- `web/screen-answers` (`fuzz/main-screens.fuzz.vibe`): builds a screen with the person's gestures, then delivers the answers its Commands send back, in any order, while other Commands are outstanding (update alone), from a Model that may lack its optional fields. An answer for a request the screen no longer waits on must change nothing. A mutant without `FailedWikiEdit`'s request check is found in 84 executions. `src/web/main.vibe` under the web targets alone at 5 seconds: 725/815 branch arms before, 732 to 740 after (it varies by run); 741/815 in the merged run.
- Corpus: 707efb6c made `Model.theatre` required, so five saved values in `web/subscriptions`, `web/view-branches` and `web/view-models` no longer decoded and those targets failed before running. Each value now carries the model's initial theatre.

### `src/web/main.vibe`: what is left

74 branch arms. Most are `??` defaults for optional Model fields that every real path sets (`wikiEditRequest ?? 0`, `failedMedia ?? []`), DOM effects only a browser reaches (scroll, `history.pushState`, key and resize subscriptions), and live-mode Command bodies. `ClickedRetry` of a failed post is still not reached by `web/screen-answers`.

### Eighth campaign

Seed 20261115, `FUZZ_BUDGET=20 seconds`, 05:50:18 to 06:24:57 UTC (34.7 minutes). Exit 0: 177 receipts, 33,019,349 executions, none at zero, none falsified; browser phase 5 passed. `web/screen-answers` ran 369 executions. Log: `~/vl/vl-fuzzpkg.campaign8.log`.
