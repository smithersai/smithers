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
workaround. Workerd's inspector also refuses precise V8 profiling; per-module Istanbul counters now measure those
requests and merge with Node coverage by source position (0016). Real-model happy paths still need an authorized model binding.

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

Coverage budget: `pnpm fuzz:coverage` now defaults to 5 seconds per target, because the deadline starts before corpus loading and arbitrary construction. At 250 ms, 12 of 128 targets ran no fresh execution and passed anyway. At 5 seconds none did: 5412/6936 lines (78.02%), 7555/11895 branches (63.51%), load 16. `pnpm fuzz` keeps 250 ms. A target that runs its property zero times now fails with `NoExecution`, naming the budget and the host load (`gate` in `fuzz/run.vibe`, `test/fuzzGate.test.vibe`); `FUZZ_EXECUTIONS=0`, the replay-only mode, still passes. Saved values from before `IssuesUi.connection` replay through `fuzz/issues-corpus.vibe`, which leaves their files unchanged.

Coverage is still bounded by decision 0016's bundled source-range defect. Workerd's refusal of precise V8 profiling no longer bounds it, and `worker/Api.vibe` is no longer excluded: since 2026-11-10 (vl-coverage-workerd) the measured targets stage gives each workerd isolate Istanbul counters, the report stage merges them by source position, and `workerd/alchemy-api-requests` runs `worker/Api.vibe` as Alchemy builds and bridges it (0016, "Unit and fuzz gates inside workerd").

`web/guided-commands`, `web/command-sequences` and `web/commands-from-any-model` run the Commands `update` returns against the real mock Factory and Actions, the same seen as live, a backend without the tour control (`bare`), and a backend that fails every call. Each Command's Message goes back through `update`. Random `Message` unions rarely reach a draft and then a submit: a `PostMessage` mutant survived 10 seconds of `web/command-sequences`, so `web/guided-commands` picks each gesture from what the screen offers and was confirmed to kill that mutant. Both of its findings were oracle errors, kept in the corpus: `IssueUi` carries a free string and `issuesUpdate` casts it, and the view only sends members of the union. The target sends the legal values.

`web/subscriptions` runs every subscription over arbitrary Models with native happy-dom events and the same backends. Its one finding was a harness error kept in the corpus: a plain `Event` named `touchmove` has no `touches`; the target now sends real `TouchEvent`s. It forks the `keyboard` subscription last and fires Escape until that subscription answers `PressedEscape` (deadline 5 seconds) before the generated events, so every listener is attached and a silent keyboard is a finding; it replaced a 5 ms attach sleep that passed with nothing emitted.

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
- `ActionRuns`: `admit` no longer answers `false` for a missing request; it decodes the stored `RunRequest` or dies.
  `canStart` runs only inside `host.alarm()`, which `ActionRuns.alarm` calls only after it read that request, and
  nothing deletes it. `callerOf`'s `request.owner ?? ""` stays as the signed-out default: every history flow needs
  at least contributor and `role("")` is viewer, so `start` refuses an unowned history run before storing it.
  `cancel`'s `cancel-failed`: `ExecutionObject.cancel` fails only when the engine's interrupt fails
  (`CancelRequestFailed`), and a store write failure is a defect by engine-store's contract.
- `Objects` 155: the tour's poll failing during a control's wake.

Guards removed or targeted (vl-fuzz2, 2026-11-10). A guard the request schema provably excludes is deleted; one a
caller outside the schema reaches stays, and a target drives that caller:

| Guard | Outcome | Why |
| --- | --- | --- |
| `Wiki.githubWikiHost`: a write operation that is neither `propose` nor `save` answered `invalid` | deleted | `WikiOperation` is `read`, `save`, `propose`, `draft`; `read` and `draft` return first, and every caller passes a decoded `WikiRequest`. `request.op satisfies "propose" \| "save"` makes a fifth operation a compile error there (checked: narrowing it to `"propose"` fails with TS1360) |
| `Issues.githubHost`: an operation no branch handles answers `unsupported` | kept, targeted | `IssueOperation` admits `spec-revise` and `spec-review`; `executeIssues` answers them before `githubHost`, but `githubHost` is exported and called directly. `issues/host-perform-boundary` draws both and runs a permitted witness of each every execution: the host refuses after its read with no write. Mutating the refusal to `missing` fails it |
| `Issues` read: `vip.review` starts with the pull prefix; `vip.number` is a positive safe integer | deleted | `verifiedVip` returns a VIP only after both checks |
| `Issues.verifiedVip`: `match.index ?? 0` | deleted | `matchAll` yields `RegExpExecArray`, whose `index` is a number |
| `Issues` receipt: `approvedBy ?? ""` | deleted | the `find` that selects the receipt requires `approvedBy`; a type predicate now carries it. A stored item may hold `approvedBy` without `approvedAt`; the mapping keeps `approvedAt` only when stored (it had been deleted as `approvedAt!`, which wrote `approvedAt: undefined` and failed the next read's decode; `test/issuesBoundary.coverage.test.vibe`) |

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
| `actions/steered-runs` | each run object gets its own faulty storage or sequencer; every execution runs every case | a post with no text answers `input`; a history run behind a dispatched reply is `busy`; a run whose door names no person runs as Guest; a tour whose dispatch write fails answers `failed`; Escape, a repeated start before the settling alarm, and a signed-out visitor's tour; a tour whose admission read fails (`Retrying`) and one whose drive's intent read fails, both recovering on the next alarm; a tour whose spoken step dies ends failed; a post whose settle write failed, started again; a reply cancelled before its agent entry exists (latched `start`) |

A defect in a history tool or in the ledger's `spend` does not fail the reply execution: the agent sandbox and the
reply's composition catch both, and the reply ends "The agent failed. Try again." Only the reply's own sequencer
writes (`start`, `finish`, `fail`) fail it. A reply's run row exists only once an alarm starts the reply, so a cancel
before that answers `not-found`. `actions/run-answers` also takes an optional `settle: "dies-once"` per run.

Findings of `actions/steered-runs` (vl-fuzz2, 2026-11-10), both product bugs in `worker/ActionRuns.vibe`; the
target's value stays in `fuzz/__fuzz__/actions-steered-runs-335f8cfe50a08d6e/`:

- A post whose run's settle write failed after the post was recorded stayed `running` forever: the same start again
  answered `null` without settling it. Another lane found and fixed the same bug at the same time (`b22298a3`, "recover
  a post or tour whose host stopped mid-start", with its regression tests); its fix is kept, and this target's
  `resettled` case now passes on it.
- An alarm whose drive failed or retried died reading a receipt: `ExecutionObject` turns an admission failure into
  `Retrying`, and `alarm` then polled an execution never admitted (`FlowExecutionNotFound`), hiding the drive's cause.
  A drive that died outside the retry wrapper hit the same read. `alarm` now rethrows a failed drive before any
  settlement and reads no receipt for a retrying one. Mutating either change back fails the target.

The fuzz gate's Chromium merge now credits by source start, and the browser build is unminified (decision 0016,
"Chromium merge").

Campaign: seed 20261113, 240 s per target, 14 targets, 28.2 minutes wall on two workers, 19,491,917 executions in 13 receipts
(`objects/conversation-host` hung and wrote none). Two targets failed and were fixed or recorded: `actions/run-answers` (oracle: a lone surrogate post is `invalid` by
design; value kept) and `objects/conversation-host` (the deadlock above). Rerun at the same seed and budget: the
deadlock is gone and the target found the open foreign-key failure; `actions/run-answers` passed (326 executions).

Reached in the eighth session (vl-fuzz2, 2026-11-10). `fuzz/run.vibe`'s `stepped` runs a program under a test clock
stepped 250 ms at a time, so a flow's retries and engine deadlines pass in virtual time inside a live target. The
in-memory GitHub sends an ETag on every successful GET, as GitHub does, so `GitHub.ReadCache` keeps a copy; `outage`
fails every GET, `dropAfterLink` fails the GETs after a sub-issue link, and `hideVip` hides new VIP markers.

| Scenario | Fault or control | Reaches |
| --- | --- | --- |
| `issues/steered-host` `public` | a cached public client over GitHub, then an outage; `publicIssues` with and without the site's client; a malformed key; an `IssueHost` that never answers, stepped; endless comments | `Issues` 115 (`partial`), 138 (stale copy), 271 (400), 402 (read deadline), 411 |
| `issues/steered-host` `delegated` | GitHub fails three GETs after the link; GitHub never shows the VIP marker; both stepped | `Issues` 181 (the retried split sees its link and writes no second one), 203 (`unavailable` after the retry window) |
| `issues/steered-host` `reviews` | a label alone, then an approval stored without its time | `Issues` 333 (in review; approver kept, no time) |
| `wiki/steered-host` `signed-out` | the cached public client, then a refused read; a visitor proposal served | `Wiki` 93 (stale copy); a visitor's proposal is 403 `forbidden`, as `test/wikiBoundary.coverage.test.vibe` specifies |
| `wiki/steered-host` `deadline` | a `WikiHost` that never answers, stepped | `Wiki` 258-260 (`unavailable` at the read deadline) |
| `wiki/steered-host` `delegated` | a blank text, no base branch, a refused branch read, a kept draft read back, and a review GitHub attributes to someone else (stepped) | `Wiki` 92 (draft), 140 (blank), 150 (no base branch), 163 (another author) |
| `wiki/steered-host` `connected`, `served-reasons` | a keyless proposal on the host; `sign-in` and `connect` served | `Wiki` 95, 201 (401) |
| `actions/steered-runs` | a tour with null input, an unavailable history, a model that refuses the reply, an engine that cannot cancel, an ownerless caller | `ActionRuns` 68, 105, 135, `cancel-failed`, `callerOf`'s `owner ?? ""` |
| `actions/history-host` | now steered: every execution drives every flow, admitted and refused; declares `REPLAY_FLOOR` | `HistoryActions` stays 19/19 on a loaded host (a 5 s full run at load had dropped its `start` arms to 17/19) |

Fuzz-only coverage of this lane's files, all 63 Node fuzz files at 5 s (63 files, 202 targets, exit 0):
`worker/ActionRuns.vibe` 120/120 lines, 178/178 branches; `worker/Issues.vibe` 298/298, 452/453; `worker/Wiki.vibe`
175/175, 233/234; `Objects`, `Sequencer`, `HistoryActions` and the five view files 100%. The two open arms were one
guard, `retryFrom`'s `step === undefined` (`Issues` 375, `Wiki` 251). A store that lost the run's step events reaches
it: `faultyStore`'s `lose(pattern)` answers a matching read with no rows, as a store restored from an older copy
does, and the `store` scenarios of `issues/steered-host` and `wiki/steered-host` lose `RunInspection.inspect`'s node
events before a recovery, which answers `unavailable`; healed, the recovery retries the write (2026-11-10).

`test/entry.coverage.test.vibe` failed about half its runs with an unhandled teardown error: `src/web/entry.vibe`
started the page with `Runtime.run` and kept no handle. It now starts it with `Runtime.embed` and exports the handle;
each test disposes the page and waits until `#root` is empty. 20 consecutive runs passed.

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
| `api-objects/world` | A fixed walk, then up to 10 generated steps in a fresh world. The walk runs in both sign-in modes. It sends every route through `apiFetch` as a signed-in person (signed in through the accounts object's own callback) and as a visitor. It runs conversation and action alarms with a scripted model whose one cell calls every bound tool: wiki draft, history show and note, actions list and start. It also covers a host with no default entrypoint, the sandbox identity by trusted props and by cookie, each namespace unbound and unreachable, and the accounts binding lost after an action alarm's fourth call. Oracles: while every namespace is reachable, no defect and no 500, and the reads `read`, `events`, `history`, `history-events`, `actions`, `commands`, `runs`, `run-events`, `health`, `session` and `sandbox` answer exactly 200 (an `apiFetch` that answers 404 to every GET fails with `session: 404 with every object reachable`); without sign-in a history note answers 403. A 503 comes only from an unreachable object, or from an account route with sign-in unconfigured. An accepted post is in its conversation. A fresh incarnation replays the same conversations. Without sign-in, every role is viewer. Every step answers within 5 seconds |
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
2. ~~`fuzz:coverage` collects V8 coverage of the Node process only.~~ Fixed 2026-11-10 (vl-coverage-workerd): a measured targets stage dumps each workerd isolate's Istanbul counters to `coverage/fuzz-unit/workerd-raw`, and `fuzz/coverage.vibe` merges them by source position (0016). Hosting these rows inside workerd now changes the table.

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

## Status, 2026-11-10 (tenth session)

### `src/web/main.vibe`: in-flight screens

The ninth session's reading of the 74 arms was wrong about the `??` defaults: arbitrary Models omit optional fields, so both arms of most defaults are already reached. Most missing arms are screens a person meets while a request is still out. Every gesture target settled each gesture's Commands at once, so no target ever pressed Escape or edited while a wiki save was out.

- `tab.hold` (`fuzz/web-tab.vibe`) accepts a Message and leaves its Commands in flight; the next settled step answers them.
- `web/in-flight` (`fuzz/commands.fuzz.vibe`): a signed-in mock tab, up to 12 gestures from 16 ops that start or meet a request, each optionally holding its last Message, with the event stream pumped after each settled gesture. Property: Escape never discards a wiki edit being saved (read before the save answers), and every held Command still answers with a declared Message. A fixed witness (save, Escape, edit while the save is out) runs after the fuzzed budget and must reach that check. Mutation check: Escape's `none` arm returning without the editor is found by the witness.
- New arms in `src/web/main.vibe` against `web/guided-commands` at the same seed and budget: Escape's `none` arm, a submit while busy (`SubmittedWikiEdit`'s retry request), an editor opened while a save is out, a page the editor refuses, and the save's completion arms (lines 380, 383, 455, 463 to 465, 473, 607, 709, 939, 944, 948, 974 to 976).
- Holding gestures in `web/guided-commands` too was measured and dropped: at about 50 executions per 20 seconds it reached no new arm.

## Test-quality review fixes (lane vl-test-quality, 2026-11-10)

The review `~/vl/review-tests.REPORT.md` (lane vl-review-tests) found oracles a broken implementation passed. Each fix
below was checked by breaking the code, seeing the test fail, and restoring it.

- **Zero executions fail.** `gate` in `fuzz/run.vibe` fails a target that never ran its property with `NoExecution`,
  naming the budget and host load; `FUZZ_EXECUTIONS=0` replay still passes. At load 128 it failed
  `issues/steered-host` at 5 seconds, which passed at 60 seconds with one execution.
- **No target reaches the network.** `history/github-public-read` left the suite; `test/mainLog.github.test.vibe`
  replays a recording of real GitHub and records again only with `VIBE_GITHUB=record` and `GITHUB_TEST_TOKEN`
  ([0032](0032-record-replay.md)). Fuzz targets keep the in-memory GitHub by VL-38: a recording cannot hold generated requests.
  `test/fakeConformance.test.vibe` replays every committed real-GitHub recording through it on every `pnpm test`,
  comparing status and every field the app's production decoders read ([0032](0032-record-replay.md#fake-conformance-vl-38-lane-vl-fake-conformance)).
  The fake's visibility clock models delayed listings and timelines; no status or meaningful decoded value is
  normalized away. Normalization rules and reasons live together in `NON_SEMANTIC_DIFFERENCES`.
- **Named answers.** `sandbox/host-recovery`, `api-objects/world`, `web/subscriptions`, `wiki/tools`,
  `history/page-paths`, `reply/failure-tags`, `http/doors`, `actions/history-host`, `web/arbitrary-update`,
  `history/arbitrary-update` and `history/view-models` now require the expected outcome; the api-workerd bench reads one
  decoded event per SSE route.
- **Clocks and witnesses instead of sleeps.** Runtime tests check the messages that arrived before a window-resize
  witness; `sandbox/mock-meter-alarm` runs on the test clock; the first-visit timer runs on Playwright's page clock.
- **GitHub doubles refuse what GitHub refuses**: 422 for a pull request from a missing branch, form-encoded device
  answers without `Accept: application/json`.
- **Open.** `test/signin.coverage.test.vibe` (1100 ms) and `test/signinEdges.coverage.test.vibe` still wait on wall
  time: their checks run inside the durable session host (`sessionOperation`, `waitForSignIn` on `NodeRuntime`), which
  does not read the test clock (a check due at test-clock 1000 polled at test-clock 0). Whether protocol doubles may
  answer happy paths waits for Will (review finding 3).

## Lane vl-fuzz3: surfaces, history and actions, 2026-11-10

A third fuzz lane drove fuzz-only branch coverage of every file under `src/surfaces/`, `src/history/` and
`src/actions/`. The existing targets ran 0 to 6 executions in 5 seconds at host load 60 to 150 (`signin/device-flow`
6, `surfaces/cli-arguments` 0), so most arms depended on what one random input picked. The new targets follow
vl-fuzz2's steered form: each execution runs every scenario, and the fuzzer picks only values (texts, codes, logins,
intervals, roles). Where a target crosses a process or a socket it uses the real boundary: the emitted CLI and MCP
server, a scripted Factory and GitHub device flow on a loopback socket, the real durable session host, and the real
action handler over SQLite run hosts. Unhappy paths are faulty Effect services (an `HttpClient`, a `Factory`, a
history `Store`), never request interception.

| Target | File | Exercises |
| --- | --- | --- |
| `surfaces/every-command` | `fuzz/surfaces-commands.node.fuzz.vibe` | all 20 commands, every execution, over the CLI's own mock backend and a backend that fails every call; a fresh mock that reads the stored session; a viewer after sign-out |
| `surfaces/ask-correlation` | same | `ask` over a scripted event stream: its own post's reply only, the text after the last restart, why it failed or never finished |
| `surfaces/live-backend` | `fuzz/surfaces-backend.node.fuzz.vibe` | the live backend's health probe and session cookie over a real socket: explicit, stored, foreign and missing sessions |
| `surfaces/person-client` | same | an explicit session's cookie and origin reach only its own origin |
| `surfaces/process-edges` | same | the emitted CLI's `--llms`, help, a refused flag, no subcommand, and the CLI and MCP server against a Factory nothing answers |
| `signin/steered`, `signin/steered-waits`, `signin/steered-wait-refusals` | `fuzz/signin-steered.node.fuzz.vibe` | every sign-in and sign-out answer of the Factory and GitHub, slow-downs, stored sessions, waits, unwritable settings |
| `signin/session-files`, `signin/unwritable-settings` | same | missing, corrupt and foreign settings files, an expired flow, the explicit `VIBELANG_SESSION`, a settings place that can't be found or cleared |
| `actions/live-client`, `actions/live-faults` | `fuzz/actions-live.node.fuzz.vibe` | `LiveActions` against the real handler and run hosts; every verb over a transport that fails or answers any status and body |
| `actions/mock-steered`, `actions/mock-factories`, `actions/mock-closed`, `actions/device-default` | `fuzz/actions-mock.node.fuzz.vibe` | every action scenario on the in-memory engine for the fuzzed role and a maintainer: slash commands, history writes, tours cancelled or ended, sandboxes, the selection proxy, the agent's tool bindings, faulty and unpoliced factories, a closed world, a host without the person's device |
| `history/sequencer-operations`, `history/sequencer-corrupt-store` | `fuzz/history-sequencer.fuzz.vibe` | plans, approvals and folds with and without trailers, long and surrogate titles, a full history; a second sequencer and a follower over the same store; a corrupt store dies naming no stored text |
| `history/machine-contracts`, `history/wire-paths`, `history/apply-any-event`, `history/decide-refusals` | `fuzz/history-machine.fuzz.vibe` | `flowMachine.vibe`'s contracts as runtime oracles; page paths read back as their page; any event applied (malformed ones only advance the number); refusals |
| `history/seed-sentences`, `history/seed-buckets`, `history/seed-replay` | `fuzz/history-seed.fuzz.vibe` | notes cut at sentence ends; a merge's side commits bucketed with it; a seed's intents replayed |

### A target's minimum budget

`c3ff469d` made a target that runs no fresh execution fail (`NoExecution`), and `10b73c23` gave `run` a `minimum`
budget for targets whose saved values take the deadline to replay. This lane's steered targets declare one: one replay
of `surfaces/every-command` or `signin/steered` takes 10 to 30 seconds, so they declare 60 seconds (and a 300 s test
timeout); `actions/live-client`, `actions/mock-steered` and `signin/session-files` declare 10 to 15 seconds. `pnpm fuzz`
takes a few minutes longer.

A floor sized on one box still fails on a slower one. On 2026-11-12 two cfbox runs of `pnpm fuzz:coverage` at
`9fb56e70` (seeds 20261270 and 20261271) failed `issues/steered-host`, and the second also `signin/steered` and
`surfaces/every-command`, with `NoExecution` at 60 seconds: each replayed its one saved failure (`regressions: 1`)
and the deadline passed before the first fresh execution. Five earlier runs passed the same targets in 60 to 88
seconds. One `issues/steered-host` execution runs all 13 scenarios in about 20 seconds on nyc-01 (`delegated` 7.5 s,
`validations` 3.7 s). So `run` now judges the property, not the box: when a target's saved failures all replayed and
passed but no fresh execution started, it runs once more with `executions: 1`, replaying only saved inputs, and the
receipt and the `vibelang.fuzz.target` log say `oneMore: true`. A finding or `FUZZ_EXECUTIONS` keeps the first report,
and a target with nothing to replay still fails on zero executions. `FUZZ_CORPUS` moves both stores to one directory
for the test (`test/fuzzGate.test.vibe`: a 50 ms replay against a 1 ms budget; with the extra run removed it fails
with the box's `NoExecution`).

Two chosen cases follow product changes that landed after them. `history/command-arms`: since `72877048` (#5344) a
lost event stream and one that ends both deliver `FailedEvents` after the outline and follow once, until Reconnect
(it followed again after 2 s before). `screens/sandbox-states`: since `a44561eb` (#5346) the pane's sign-in is the
`ClickedSignIn` button, counted inside the pane because the header has its own; a new case holds it disabled and
named `Signing in…` while an account request runs. Mutants caught: an ended stream that never disconnects; a
sign-in button that stays enabled.

Runs 20261286 and 20261287 at `41e3b5a8` passed all 293 tests; 45 arms in 13 `src/web` files were reached by one
seed or neither, most of them in code landed that day (#5344 read failures, #5348 action follows). Each is now a
chosen case: `web/decision-arms` holds `actionFollowDecision` (`failed`, `settled`, `same`), a demotion, the People
size control, `issueRequestKind`, `kindKey`, `issueForm`, a retried issue request, and the wiki editor's waiting
submission, failure and request round trip to their contracts; `web/issue-decisions` holds `issueAction`'s retry
guards and an unnamed VIP; `screens/history-states` shows each read failure where its read belongs; the new
`screens/issue-arms` renders a child's parent link, the specification's failure with and without Retry, and a
non-arrow key on the kind control; `web/command-arms` adds the action clock (queued, running, finished, lost, and
actions without a disconnected list), a follow's first snapshot, and a wiki save refused as unwritten
(`wiki-unwritten`); `screens/wiki-and-people` shows the wiki pane after the reply that opened it, and not while the
docs are maximized. All 45 arms are hit at seeds 20261293 and 20261294. Mutants caught (7 of 7): `failed` appending
a known id, ArrowLeft moving right, retry ignoring `retryAllowed`, every commit failure shown on the list, no parent
link, the clock ticking for a lost follow, no wiki pane after its reply.

### Product findings fixed

| Finding | Target | Fix and regression |
| --- | --- | --- |
| `sandbox-run`, `sandbox-stop` and `sandbox-start` refusals read "The message was refused: stopped": the copy `ask` uses | `surfaces/every-command` | The four sandbox commands say "The sandbox refused it: <refusal>" (`SANDBOX_REFUSED`). `test/commands.test.vibe` "says the sandbox refused a sandbox command, not a message" failed first; the target fails on the old copy. `bench/cli-text.bench.vibe`'s two expected sentences follow the new copy |
| `logout` died with a defect when its private settings file could not be removed: the cleanup ran in an `ensuring` finalizer under `Effect.orDie`, so the CLI printed a stack instead of one sentence | `signin/session-files` | `signOutSurface` still tries the cleanup in the finalizer (so an interrupted sign-out forgets local state), then runs it again typed; a failure reaches `safeSettings` as "The sign-in settings couldn't be written." `test/signoutCleanup.test.vibe` (mock and live) failed first on `Cause.hasDies` |

### Oracle and harness corrections (values kept in `fuzz/__fuzz__/`)

| Finding | Kind | Resolution |
| --- | --- | --- |
| The live server answers an unknown flow `forbidden`; the mock answered `not-found` | product (VL-13) | An unknown flow is never runnable, and live checks the role first. `MockActions.start` now authorizes before reading the catalog. `test/actionsMockLive.test.vibe` runs the same start against both backends for every role: red (`not-found`), then green; both targets now require `forbidden` |
| Empty terminal output read as an unreadable answer | oracle | `ls` in a fresh sandbox prints nothing; only a refusal must be a sentence |
| A backend without accounts was expected to run history actions | oracle | Its actor is a viewer; only a tour is a viewer's |
| A tour action started while a reply ran failed | oracle | The conversation answers the tour `busy` (vl-fuzz2's deadlock fix); tours run before the post |
| `apply` accepted an event numbered 2^53 on a full history | oracle | `replayEvent` keeps a full snapshot; `apply` only receives decoded events, and the wire refuses unsafe numbers |
| A merge as the first commit | harness | A merge needs a main parent |
| The target removed a settings file sign-out had already removed | harness | `force: true` |
| A note of one space was expected to be written | oracle | It trims to empty and is refused `empty`; the target trims before its default |
| A title of a tab was expected to plan | oracle | `"\t"` is truthy but trims to empty, and the plan is refused `empty`; the target trims before its default |
| `"bad id!"` was expected to be refused as a conversation | oracle | Any nonempty id is one (the wire encodes it); `""` is the refused case |
| Page 1 of a one-commit epic was expected to count its commits | oracle | Past an epic's end the page is empty |
| A tour asked for after a post never settled | oracle | Whether the post's reply still runs is timing (a viewer's post run is accepted, its record refused): the tour is refused and settles, or begins and the target cancels it |
| `trailerOf` read the first `Mythical: m<n>` line anywhere in a message, so a squash or a body quoting another commit's trailer folded into the commit it named | product | `history/sequencer-operations`, with squash and quoted bodies. `trailerOf` reads only the trailer paragraph (0020); `test/sequencerTrailer.test.vibe` red, then green; the counterexample is in `fuzz/__fuzz__/` |
| `deferredActions` (`src/actions/agent.vibe`) had no caller outside its own test | dead code? | No: `src/web/backend.vibe` builds the web backend's actions with it. Kept; `actions/mock-steered` checks it answers what the service it selects answers |

### Not fixed: recorded for their owners

- `api-objects/world` (vl-fuzzpkg) failed once in the full run at host load 110: "alarm did not return", its 300 ms
  alarm bound. Its value was not committed.

### What is left, and why

2 lines and 20 branch arms in the three directories, listed by kind. None is excluded.

- Race guards: `MockActions` 112 (a run cancelled before its fiber starts) and 117 (the owner changes between the
  request and the run); `signin` 173 (the pending flow removed between the check and the poll).
- Fallbacks of total functions no caller reaches: `mythical` 377, 411 and 562 (`taskOf`, `rankOf` and an insert's
  rank, asked only about commits that exist: the 2 lines); `history/tools` 93 (the compiled end of an exhaustive
  `match`); `catalog` 23 (`split("/").at(-1)` is never undefined); `seed` 444 (a seeded real commit into a commit the
  seed lacks); `signin` 101 (a signed-in answer with no stored session).
- Defensive arms: `backend` 61 (a live request to another origin: every live client asks its own origin, and
  redirects are errors) and 83 (the CLI's mock always has accounts); `MockMythical` 78 and `schemas` 92 (decoders that
  die before their callback); `commands` 351 (`--wait` on a run whose stream ends before its first state);
  `LiveActions` 66 (an event the stream sends before its run exists).
- `mcp` 36 and 38: the server's own interruption by a host signal, and a defect, not a failure, at start.
  `test/support/processes.vibe` keeps a child's stdin open, so a client hanging up can't be simulated through it.
- `flows` 248 and 257, `seed` 355: a fold the main log repeats, a second bootstrap, and a queue entry whose landed
  title repeats. The mock never produces them; the History object's main log and the bootstrap's real queue do.
- `MockActions` 33, 68 and 102: a policy that refuses after the role allowed, a person with no login running a
  history action, and a guide whose event stream ends before the tour does.
- `signin` 129: the durable poll itself failing (not GitHub's answer, which is a status).

### Coverage (fuzz-only, `vitest --config fuzz.config.ts --coverage`, 5 s per target, Node and happy-dom)

The full suite with coverage (`build:surfaces`, then every target at 5 seconds, host load 110 to 150), unioned
measured at `4827dd9d` (before `d28aa766` removed `flowMachine.planAction` and other code the product never runs),
with three reruns of steered targets after their last scenarios landed (`actions/live-client`, the sign-in targets,
`surfaces/every-command`). Lines are statement start lines, as in vl-fuzz2's table. 25 of 36 files are at 100% of lines and branches.

| File | Lines | Branches | Before this lane |
| --- | ---: | ---: | --- |
| `src/actions/MockActions.vibe` | 114/114 | 81/85 | 88/114, 46/85 |
| `src/history/mythical.vibe` | 139/141 | 190/191 | 137/141, 173/191 |
| `src/history/flows.vibe` | 105/105 | 11/14 | 105/105, 11/14 |
| `src/surfaces/signin.vibe` | 115/115 | 106/108 | 59/112, 53/106 |
| `src/surfaces/mcp.vibe` | 17/17 | 2/4 | 14/17, 0/4 |
| `src/surfaces/backend.vibe` | 45/45 | 31/33 | 22/45, 7/33 |
| `src/history/seed.vibe` | 171/171 | 100/102 | 170/171, 98/104 |
| `src/surfaces/commands.vibe` | 171/171 | 111/112 | 123/170, 49/112 |
| `src/history/tools.vibe` | 29/29 | 46/47 | 29/29, 46/47 |
| `src/actions/catalog.vibe` | 9/9 | 27/28 | 9/9, 27/28 |
| `src/actions/LiveActions.vibe` | 43/43 | 20/21 | 20/43, 9/21 |
| `src/surfaces/sessionFlow.vibe` | 40/40 | 2/2 | 29/40, 2/2 |
| `src/surfaces/session.vibe` | 63/63 | 24/24 | 56/63, 16/24 |
| `src/surfaces/mcp-entry.vibe` | 6/6 | 0/0 | 100% |
| `src/surfaces/manifest.vibe` | 4/4 | 0/0 | 100% |
| `src/surfaces/commandDecision.vibe` | 22/22 | 64/64 | 15/22, 41/64 |
| `src/surfaces/cli.vibe` | 16/16 | 10/10 | 15/16, 8/10 |
| `src/surfaces/cli-entry.vibe` | 8/8 | 2/2 | 100% |
| `src/history/wire.vibe` | 35/35 | 35/35 | 34/35, 31/35 |
| `src/history/stackDecision.vibe` | 15/15 | 25/25 | 10/15, 15/25 |
| `src/history/seed/vibelang.vibe` | 2/2 | 0/0 | 100% |
| `src/history/schemas.vibe` | 32/32 | 0/0 | 100% |
| `src/history/roles.vibe` | 6/6 | 0/0 | 100% |
| `src/history/pages.vibe` | 36/36 | 30/30 | 100% |
| `src/history/pageDecision.vibe` | 5/5 | 8/8 | 100% |
| `src/history/flowMachine.vibe` | 51/51 | 93/93 | 45/51, 67/93 |
| `src/history/Sequencer.vibe` | 94/94 | 36/36 | 83/94, 25/36 |
| `src/history/MythicalHistory.vibe` | 2/2 | 2/2 | 100% |
| `src/history/MockMythical.vibe` | 35/35 | 5/5 | 100% |
| `src/history/LiveMythical.vibe` | 41/41 | 12/12 | 100% |
| `src/actions/wire.vibe` | 6/6 | 0/0 | 100% |
| `src/actions/tools.vibe` | 13/13 | 1/1 | 10/13, 0/1 |
| `src/actions/execution.vibe` | 38/38 | 36/36 | 25/38, 26/36 |
| `src/actions/catalogDecision.vibe` | 3/3 | 12/12 | 100% |
| `src/actions/agent.vibe` | 11/11 | 0/0 | 5/11, 0/0 |
| `src/actions/Actions.vibe` | 4/4 | 0/0 | 100% |
| **36 files** | **1546/1548** | **1122/1142** | 1293/1544, 821/1142 |

### Mutation checks

Each mutant changed one line, ran one target, and was restored: a session cookie sent to any origin
(`surfaces/live-backend`), a cancel that never settles (`actions/mock-steered`), a fold title cut inside a surrogate
pair (`history/sequencer-operations`), a live failure code replaced by `unavailable` (`actions/live-faults`), a search
query read from the wrong parameter (`history/wire-paths`), and GitHub's slow-down interval ignored
(`signin/steered`, after steering its interval above five seconds). Each target failed.

### Second session

`c0c76516` reads a mythical trailer from the trailer paragraph only, and `b362b0bd` makes mock actions refuse an
unknown flow `forbidden`, as live does; both are in the tables above. A fresh fuzz-only run of the whole suite at
`b362b0bd` (5 s per target, Node and happy-dom, exit 0, 256 targets) measured the three directories at 1564/1566
lines and 1146/1166 branches over 37 files: `seedDecision.vibe` is new (25/25, 39/40) and other lanes moved lines.
Three new scenarios then reached 4 more arms, measured on their own files: 1150/1166.

| Target | File | Exercises | Arm reached |
| --- | --- | --- | --- |
| `surfaces/stored-session` | `fuzz/surfaces-backend.node.fuzz.vibe` | `withStoredSession` on addresses that start with the origin's text but name another origin (a longer port, user info before another host), another scheme or host, the bare origin and its paths, under every stored session; the oracle compares WHATWG `URL` origins | `backend` 57 |
| `history/seed-entries` | `fuzz/history-seed.fuzz.vibe` | queue entries that carry up to three titles: the commits one landed entry carried form one mythical commit, any other commit is its own | `seed` 348, `seedDecision` 69 |
| `history/sequencer-operations` | `fuzz/history-sequencer.fuzz.vibe` | a trailer paragraph with a continuation line | `Sequencer` 75 |

Mutants, each caught and restored: `sameOriginRequest` without its `/` (`surfaces/stored-session`), the entry join
removed (`history/seed-entries`), continuation lines refused (`history/sequencer-operations`). Each target's
counterexample against its mutant stays in `fuzz/__fuzz__/` as a boundary value, with the harness's own
`"\ud800"` path (`encodeURIComponent` throws on a lone surrogate; the target encodes UTF-8 bytes).

What is left: 2 lines and 16 arms. Unchanged from the list above: `MockActions` 68, 102, 112, 117; `mythical` 377,
411 (the lines), 562; `signin` 101, 173; `mcp` 36, 38; `flows` 248, 257; `commands` 351; `history/tools` 93;
`LiveActions` 66; `seed` 437 (formerly 444). New: `MockActions` 130, the catalog lookup after the role check, now
reached only if the catalog lacks a flow the registry marks runnable. Covered or removed since the list above:
`backend` 61 and 83, `catalog` 23, `MockActions` 33, `MockMythical` 78, `schemas` 92, `seed` 355.

### Third session

Finding, fixed: a mock tour action cancelled before its run's fiber started settled `cancelled`, yet the tour then
began in the conversation (`TourStarted`, `WalkthroughDriven`, `ReplyDelta` after the cancel). `cancel` interrupted
only the engine's execution, which had not started, and recorded the cancellation; the queued fiber then read
`queued`, ran the flow and began the tour. `MockActions.cancel` now interrupts the run's own fiber first, then the
engine's execution. `test/actions.test.vibe` ("a tour cancelled before its run starts never begins") and
`actions/mock-before-run` failed before the fix and pass after. The live host records the cancellation before ending
the tour (`worker/ActionRuns.vibe` `cancel`), a different design not changed here.

| Target | File | Exercises | Arm reached |
| --- | --- | --- | --- |
| `actions/mock-tour-stream` | `fuzz/actions-mock.node.fuzz.vibe` | a Factory whose event stream closes right after `TourStarted`: the tour action fails, never passes or hangs | `MockActions` 102 |
| `actions/mock-before-run` | same | with scheduler yields off (`References.PreventSchedulerYield`), a cancel or a different person's sign-in before the run's fiber runs: cancelled and no tour, or `forbidden` | `MockActions` 117 |
| `actions/live-follow-stream` | `fuzz/actions-live.node.fuzz.vibe` | a run's event stream that also carries another run's request, for fuzzed run ids: only the followed run is yielded; an ill-formed id is `input` before any request | `LiveActions` 66 |

Removed: `MockActions` 130. `authorize` admits only runnable names, and `prepare` already answers `not-found` for any
other, so the catalog lookup after the role check could not fail. Mutants, each caught and restored: the guide passes
a tour whose stream closed (`actions/mock-tour-stream`), follow yields the first run instead of the followed one
(`actions/live-follow-stream`). Their values stay in `fuzz/__fuzz__/`.

What is left: 2 lines and 12 arms. `MockActions` 68 (a person without a login: no account has one) and 112 (a cancel
recorded between `start`'s request and its fork); `mythical` 377, 411 (the lines), 562 (proved fallbacks);
`signin` 101, 173; `mcp` 36, 38; `flows` 248, 257; `commands` 351; `seed` 437; `history/tools` 93, the fallback
after an exhaustive match that VL-37 removes in the compiler.

`surfaces/run-wait` (`fuzz/surfaces-commands.node.fuzz.vibe`) injects an `Actions` whose follow stream is a fuzzed list
of run states: `run --wait` answers the id only when the first settled state is `passed`, and fails "Action failed."
when the stream ends empty or unsettled or settles otherwise. It reaches `commands` 351 (no run seen). Mutant caught and
restored: waiting without `takeUntil`, which reads the stream's last run instead of its first settled one.

### Fourth session

Re-measured with the whole suite (`pnpm fuzz:coverage` on a box at `90f526f0`, 5 s per target; its targets phase
failed on three other lanes' targets, so the figures are the Node map `coverage/fuzz-unit`). Files under
`src/surfaces`, `src/history` and `src/actions` stood at 1583/1604 lines and 1154/1197 branches. Four files are new
since the third session (`actionHostDecision`, `replayDecision`, `seedInputDecision`, `pageDecision`'s `sumOf`).

Finding, fixed: a fold over a commit of main whose own Fold the history refuses (no sha, or a sha or change id longer
than `MAX_ID`) first planned a new mythical commit for it, opening its epic if needed, then had the Fold refused.
That commit stayed `planned` for ever, and every retry planned another. `Sequencer.fold` now answers the Fold's own
refusals (`empty`, `too-long`, `duplicate`, in `decide`'s order) before it plans anything. `test/sequencerFold.test.vibe`
failed before the fix (3 failed) and passes after; `history/fold-flows` fails on the old `Sequencer.vibe`.

Removed, unreachable since the third session's cancel fix (`ec6a03a9`): `mockState`'s interrupted arm and
`mockFailureText` (`actionHostDecision.vibe`). `cancel` interrupts the run's own fiber before the engine's execution,
so `run` never resumes after an interrupt-only exit; `cancel` records `cancelled` and "Cancelled" itself. `mockState`
takes two arguments; its contract, unit test, proof mutations and 0018 rows changed with it (`pnpm verify` on the
file: 0; `verify:broken --module`: 12/12 rejected).

| Target | File | Exercises | Arm reached |
| --- | --- | --- | --- |
| `history/lookups` | `fuzz/history-machine.fuzz.vibe` | `taskOf`, `epicOf`, `rankOf` against a first-match model; `decide`'s plan-before over any typed history, including negative ranks | `mythical` 377, 411, 562 |
| `history/seed-orphan` | `fuzz/history-seed.fuzz.vibe` | a real commit folding into a commit the seed lacks: its own title, refused `unknown` | `seed` 437 |
| `history/fold-flows` | `fuzz/history-flows.fuzz.vibe` | the Fold and Bootstrap flows over a `MainLog` service answering fuzzed commits; a second fold changes nothing; a second bootstrap loads nothing | `flows` 248, 257 |
| `history/replay-journal`, `history/seed-inputs`, `history/page-totals` | `fuzz/history-decisions.fuzz.vibe` | the specification-only functions against the code they specify: record equals replay, `referenceList` = `batchRevset`, `selectedTitles` = `knownTitles`, `totals` = `sumOf` | `replayDecision`, `seedInputDecision`, `pageDecision` 56-57 |
| `actions/mock-sign-out-mid-run` | `fuzz/actions-mock.node.fuzz.vibe` | accounts that answer the contributor for the first N checks, then the signed-out viewer (no login): the write passes exactly when every check it makes saw the contributor | `MockActions` 73 |
| `signin/steered-waits` (2 scenarios) | `fuzz/signin-steered.node.fuzz.vibe` | a device code that expires while GitHub says pending ("Sign-in expired."); a stored session that can't be read back (signed in, no login) | `signin` 173, 101 |
| `surfaces/mcp-stdio` | `fuzz/surfaces-backend.node.fuzz.vibe` | the stdio server in process with an injected `Stdio`: a signal and stdin's end print nothing; a settings read that dies prints the defect on stderr; one that is interrupted prints nothing | `mcp` 36, 38 |

Mutants, each caught and restored: no negative-rank refusal (`history/lookups`), an unknown fold target titled by its
id (`history/seed-orphan`), the history's caller keeping the world's role after a sign-out
(`actions/mock-sign-out-mid-run`; it survived the first oracle, which accepted any pass/fail split, now pinned to the
measured number of checks), the interrupt guard removed (`surfaces/mcp-stdio`), a refused record advancing the
history (`history/replay-journal`), a revset joined with `,` (`history/seed-inputs`).

Not fixed here, recorded: one malformed line on stdin leaves the stdio MCP server deaf (Effect's ndjson decoder:
`~/vl/vibelang-bugs/effect-mcp-ndjson-malformed-line`), so `surfaces/mcp-stdio` sends well-formed lines only. In the
same protocol a stdin read error is retried every 500 ms for ever and a stdout write that dies ends the server as an
interruption, so no defect reaches `mcp.vibe`.

What is left: 2 arms, neither the app's to change. `flows` 213: V8 credits a suspending conditional's untaken else
arm's zero to the code after it (`~/vl/vibelang-bugs/coverage-v8-suspend-else-arm`). `history/tools` 93: the no-match
fallthrough after an exhaustive `match` (`~/vl/vibelang-bugs/coverage-exhaustive-match`, VL-37).

## Measurable on any machine (lane vl-gatefix, 2026-11-10)

- `surfaces/cli-arguments` and `surfaces/mcp-arguments` spawn a process per execution: replay and the first execution
  take 4.6 s on an idle 4-vCPU box, so at the 5 s coverage budget they ran none (`NoExecution`). They declare
  `REPLAY_FLOOR` (15 s), as `issues`, `objects`, `wiki` and `actions` steered targets do. `NoExecution` still fails a
  target that executes nothing.
- The gate's roster is the unit gate's: every file under `src/`, `worker/`, `scripts/` and `infra/`, with no exclusion.
  `worker/Api.vibe` and the `scripts/` and `infra/` files count, and fail, until a target reaches them (VL-14).
- `pnpm fuzz` checks the flow's dependencies first (`scripts/fuzz-preflight.vibe`); install them with
  `--filter "@smithers/release-workflows..."` beside the app's filter. The browser stage's web-server limit is
  `E2E_SERVER_SECONDS` (default 600 s). Commands per gate: 0016, "Measuring every gate".


The coverage profile retained 200 target receipts for 201 passing checks on an idle 4-vCPU box; none recorded zero
executions. `issues/steered-host` took 24.834 s including replay and `api-objects/world` 26.153 s, so their 60 s floors
cover setup and exploration. Action lifecycle replay takes a 60 s floor; conversation-host and conversation-storage
targets take 30 s. Workerd setup hooks allow 600 s, and API-world operations stay bounded at 20 s. These are tooling
budgets, not coverage thresholds: zero executions and every below-100% file still fail. Full commands and the required
Node >= 26.4 box image are in [0016](0016-coverage.md#measuring-every-gate-lane-vl-gatefix-2026-11-10).

## Status, 2026-11-10 (eleventh session)

### Finding: a reused action-run id died

`actions/object-lifecycles` (campaign 9, seed 20261118) found that a start refused before its run stored the request
(`input`, `forbidden`) left only the `RequestAction` journal's record, so a different request under the same id died
with `ExecutionIdentityConflict`. `worker/ActionDirectory.vibe` now answers `conflict`, logs `vibelang.actions.start`
with `outcome: conflict` and counts `vibelang_action_start_conflicts`. The value is kept in
`fuzz/__fuzz__/actions-object-lifecycles-5d1960d89c610f6f/`; `test/actionDirectoryConflict.test.vibe` failed before
the fix and passes after.

### Honest coverage, idle box

`pnpm fuzz:coverage` (seed 20261120, 5 s) on a 4-vCPU Playwright box: all 63 target files passed, no `NoExecution`.

| Scope | Lines | Branches |
| --- | ---: | ---: |
| All files | 92.63% | 86.36% |
| `src/web/main.vibe` | 658/667 | 759/819 |

74 of 163 files are at 100% lines and branches; 281 per-file gates still fail. The tenth session's
`ClickedRetry` and sandbox minute-notice arms are reached: they were missing because 7 targets starved, not because
no target reached them.

### `src/web/main.vibe`: the last lines

| Lines | Path | Change |
| --- | --- | --- |
| 1259 | the role stream ends, so the tab shows `FailedRoles` | `closing` backend (`fuzz/web-backends.vibe`): the mock with a role stream the server closes at once |
| 1483 to 1486 | `FocusIssueControl` | `issue-key` gesture: open issues, choose a kind from the keyboard |
| 1365, 1366 | a sandbox command's success | `terminal-run` gesture: open sandboxes, start, type, submit. Not reached yet: a tab runs at most 48 Commands in total, so a late gesture's Commands do not run |
| 1030, 1031 | `CancelAction`'s success | open: every mock run settles before Cancel is pressed |

Measured on the web targets at seed 20261120, 5 s: lines 658 to 663 of 667. Branches 755 then 747 of 819: at 24 to
64 executions per target per 5 s the reached arms change between runs, so branch counts from one short run are noise.

Measured and dropped: a per-gesture Command cap in `tab` (instead of 48 per tab) lowered `main.vibe` to 648 lines and
721 branches, because each execution ran longer and fewer ran.

### Campaign 10

Seed 20261121, `FUZZ_BUDGET=20 seconds`, on a 4-vCPU Playwright box at `74f29e44`: exit 0, 205 receipts,
36,602,466 executions, none at zero, none falsified; 63 target files and 5 browser tests passed. No new finding.

## Status, 2026-11-10 (twelfth session)

### Two short-tab targets

A tab runs at most 48 Commands, so a long gesture sequence rarely reaches a late gesture's Commands. Two targets open a
fresh tab for one gesture each:

| Target | Input | Property | Arms reached in `src/web/main.vibe` | Mutant found |
| --- | --- | --- | --- | --- |
| `web/cancel-run` | role, flow, input, wait 0 to 15 ms, Cancel once or twice | Cancel on a run the person started leaves it `cancelled`, `passed` or `failed`, and the pane shows no error. A fixed maintainer witness must start a run | `CancelAction` succeeds (1028 to 1031) | `cancel` returning before the interrupt: found in 1 execution |
| `web/terminal` | role, 1 to 6 terminal commands, stop or not | Every command typed into a started sandbox answers: the terminal is never left busy | `SandboxAction` `command` succeeds (1363 to 1366) | busy kept after a command answers: found in 4 executions |

### Floor for long-tab targets

One execution of `web/commands-from-any-model` takes 563 ms (arbitrary Model and Message) and one of
`web/guided-commands` 235 ms with its two saved values, at load 24. At the 250 ms default both ran none
(`NoExecution`). They and `web/in-flight` declare `TAB_FLOOR` (3 s), as the steered targets declare `REPLAY_FLOOR`. A
target that executes nothing still fails.

### Finding: issue and wiki numbers JSON cannot carry

| Finding | Target, value | Fix | Regression |
| --- | --- | --- | --- |
| `IssuesState`, `IssueRequest` and `WikiState` accepted NaN, the infinities, fractions and negatives in counts, revisions and timestamps. JSON sends NaN and the infinities as `null`, so a state the schema called valid reached the client as `protocol` | new target `clients/issues-wiki-replies` (every reply to the issues and wiki clients; a state decodes, a refusal keeps its reason and `unwritten`, nothing dies) | every number in `src/core/issueSchemas.vibe` and `src/core/wikiSchemas.vibe` is `Seq` (safe, nonnegative integer) | corpus value `8d2032ccd6ffd1c4`; `test/issueWikiWireNumbers.test.vibe` 2 failed before, 3 passed after |

The target keeps the old broad number domain for its inputs (`RawIssuesState`, `RawWikiState`), so saved values still
cover states the server must refuse.

### Saved values moved into the narrower domain

Four saved values held issue numbers the new `Seq` refuses (`1.8e308`, `-0`, `6e-323`, `"Infinity"`), so their targets
stopped with `FuzzError` ("the json codec cannot decode a saved value"): `web/view-branches` (2), `web/view-models` (2),
`issues/role-gated-command-sequences` (1). Each failing number was moved to the nearest safe, nonnegative integer
(fractions truncated, negatives and `-0` to 0, values above `Number.MAX_SAFE_INTEGER` to it); nothing else in the
values changed. All three targets replay their saved values and pass. The package keeps refusing an undecodable saved
value: dropping it silently would lose a regression.

### Two oracles behind `c5bbf81b`

`c5bbf81b` (reserve daily model budgets) checks for a model before budget admission, so a reply with no model
reserves nothing. Two targets still assumed the old order:

| Target | Symptom at seed 20261122 | Fix |
| --- | --- | --- |
| `reply/answers` | `Falsified` in 8 executions: no model and a refusing budget answered `unconfigured`, the oracle wanted `budget` | the oracle checks `unconfigured` first and also asserts nothing was admitted; value kept as a regression |
| `objects/steered-host` | timed out (600 s on a box, 120 s on nyc-01): `tour-during-reply` held the reply at admission, which a reply with no model no longer reaches, and awaited that latch without a bound | the scenario gives the reply a scripted model, the held admission refuses, and the model must see 0 calls; the latch await is bounded (20 s), so a reorder is a `Finding`, not a hang |

The campaign at seed 20261123 found one more input outside the narrower domain: `web/screen-answers` built an "older"
issues answer as `seq - 1`, which is -1 at seq 0 and fails the Model's `Seq` (`PropertyError:UnknownError` in 14
executions). The client decodes every issues state, so the product never receives it. At seq 0 the target now sends no
older answer; 248 executions pass at that seed.

### Floor for steered targets under coverage

`pnpm fuzz:coverage` at seed 20261122 on an idle 4-vCPU box (load 2.2) ran `wiki/steered-host` (15 s floor) and
`actions/steered-runs` (5 s budget) for 0 executions, after 1 each in the run before: replaying the saved value and
one execution took 21.7 s and 8.5 s with coverage counters. Both declare `STEERED_FLOOR` (30 s) in `fuzz/run.vibe`.
With it, under coverage: `wiki/steered-host` 1 execution in 31.8 s, `actions/steered-runs` 7 in 31.7 s.

`web/terminal` also starts its sandbox by submitting `/sandbox` in the composer (`slash`), which reaches
`src/web/main.vibe` 795 and 796 (31 hits at seed 20261124). The web targets now leave 3 of 667 lines of `main.vibe`
unreached at seed 20261122 (795, 796 and the roles stream's end, 1258, which the `closing` backend reaches at other
seeds) and 70 of 823 branch arms.

## Status, 2026-11-10 (thirteenth session)

### Build scripts and the deploy stack

`fuzz/scripts.node.fuzz.vibe` drives every file under `scripts/` and `infra/` through its public entry. Each script runs
as its compiler-emitted CLI in a child process, as `pnpm` runs it; Vitest credits a child process's emitted JavaScript
through its source map, never native `.vibe` (decision 0016, `~/vl/vibelang-bugs/coverage-native-loader/`). The fuzz
config's `include` now lists `dist-scripts/**/*.js` and `dist-script-tests/**/*.js`, as the unit config does; without
them V8 drops the child profiles before remapping and the CLIs read 0.

| Target | Generated input | Oracle |
| --- | --- | --- |
| `scripts/fuzz-preflight` | a set of missing flow packages; bare directories | exit 0 exactly when none is missing; else exit 1 naming exactly the missing ones, in order, and the install command; the log counts them |
| `scripts/agent-context` | the generated file's prior state: absent, current, one changed byte, cut, longer | `--check` passes exactly on the current text, never writes, names the file without its content; the write leaves the current text, which `--check` then passes |
| `scripts/wiki` | wiki trees of up to 8 pages (headings, status and ruling lines, dates, links, tables, raw HTML, an unpaired surrogate) and each suite receipt's presence and status | a missing receipt fails and keeps the previous output; otherwise every page keeps its source and gets its title, label, decision flag, status, date and rulings, top-level links resolve, raw `<script>` never survives, suites read their status, and a rebuild from the tree written in reverse order gives the same bytes |
| `scripts/mythical-seed` | a real jj `main@github` of 1 to 4 commits, queue entries (state, lane, carried commits, receipt, known revision, gate, reason, junk lines), a fault, CLI or program | the program twice and the CLI write the same bytes; each main commit appears once, in order, under its title, folded into one of at most as many mythical commits; a missing repository (`JjFailed`), a missing queue, or two commits reported under one short id (`Refused`, through a faulty `ChildProcessSpawner`) fail and keep the previous seed |
| `infra/stack` | stage (`prod`, `coverage`, `vl-test`, other), dev, domain, image, probe token | `vl-test` declares only the probe Worker, its two objects and the image; every other stage the API Worker and the site (its domain only outside dev), with the sandbox image and machine exactly when an image is set; the only failure is the probe stage without its image or token, which the failure names |

`scripts/wiki` and `scripts/mythical-seed` declare `REPLAY_FLOOR`: one execution runs two CLIs or creates jj
repositories. Fuzz-only coverage of this file alone, 5 s per target: all 8 files 100% statements, branches, functions
and lines. A mutant that drops the stack's `vl-test` branch is falsified in 2 executions.

### `src/web/main.vibe`: replies before their pane

Web targets at seed 20261126, 5 s: 667/667 lines, 762/823 branches. `web/arbitrary-update` generates a whole `Model`
and ran 25 executions in 5 s, so the `??` fallbacks that only a reply arriving before its pane exists takes stayed
open. `web/pane-messages` (`fuzz/pane-messages.fuzz.vibe`) builds issue, wiki-edit and action replies from a few
generated fields over the mock Factory's issue records: 9,309 executions in 5 s. Oracles: the Model stays valid; a
wiki-edit reply without an editor, details without an issues pane, and a projection older than the one shown change
nothing. Its first run falsified the oracle, not the product: a projection at the shown seq applies
(`issueProjectionApplies` is `incoming >= current`, proved). It reaches 8 of the 61 open arms.

`LoadIssues` and `ActOnIssue` tested `result._tag === "Success"` again inside the success branch, a dead arm, and
repeated `IssueDecision.issueDefaultRole`. Both now read `result.success.role ?? IssueDecision.issueDefaultRole(factory.mode)`;
behavior is unchanged. The `roleless` web backend answers issues without a role, so the fallback runs, and
`web/command-bodies` checks that the mock then answers `maintainer`.

Still open (53 arms, seed 20261126 plus `web/pane-messages`): wiki-edit replies to a live editor (467 to 477), tour
plans (555, 561, 575, 585), Command bodies against specific Factory answers (911, 929, 966, 978, 1233, 1418, 1445,
1447, 1457, 1513, 1514), DOM effects and subscriptions without a document or with specific keys (1055 to 1142, 1281
to 1286), and the roles stream without accounts (1256).

### Script targets on a box

The first full run with these targets (`pnpm fuzz:coverage`, seed 20261127, 4-vCPU box) falsified
`scripts/mythical-seed` with `FixtureFailed`: `jj git fetch` needs git >= 2.41 and the cf-compute image has 2.39.5,
the gap that also fails `test/mythicalSeedProcess.test.vibe` there. The shrink then hid that cause behind "target repo
already exists", because a failed attempt's directory was reused. The fixture now builds one colocated repository and
writes `main@github` as the ref file `.git/refs/remotes/github/main` that `jj git import` reads, with no fetch and no
git CLI; each attempt gets a new directory. On the box all five targets pass (`scripts/mythical-seed` 30 executions)
and all 8 files reach 100% on every metric.

Every execution of `scripts/agent-context` also checks a missing file, and of `scripts/fuzz-preflight` installs exactly
the packages it named and checks again, so no arm depends on what a short run happens to draw. Both declare
`REPLAY_FLOOR`: under coverage on a loaded host they ran 2 executions in 5 s.

## Status, 2026-11-11 (fourteenth session)

### Failing targets seen by vl-fuzz3

vl-fuzz3's two whole-suite runs at `90f526f0` failed `screens/issues-view-names-controls` and `reply/answers`.

| Target | Failure | Cause | Kind | Fix | Evidence |
| --- | --- | --- | --- | --- | --- |
| `screens/issues-view-names-controls`, seed 20261107, 22 executions | `RangeError: Invalid time value` | `staleMark` formatted `new Date(stale).toISOString()`; a `Date` holds at most 8.64e15 ms, and `stale` is `Seq`, a safe cursor up to 2^53 - 1, so the issues list, an issue and the wiki editor threw for a decoded value | product | the mark shows without a time when the confirmation time is no valid `Date` | `test/issuesView.coverage.test.vibe` "past the last valid date": red (RangeError at `issuesView.vibe:81`), green after; target passes at 20261107 and 20261129 |
| `reply/answers`, seed 20261107, 2 executions | returned false | the stale oracle wanted `budget` where `c5bbf81b` answers `unconfigured`; fixed in `8d835fa6` (twelfth session), which landed after `90f526f0` | stale oracle | none needed | passes at 20261107, 20261122 and 20261129 on `6536883f` |

Neither target is flaky: each failure reproduces from its seed on its tree and is gone on current `main`.

### `src/web/issuesView.vibe`: the issues pane over real records

The full run at seed 20261128 (`6536883f`, box) read `issuesView.vibe` at 273/437 branch arms and 48/79 functions:
`screens/issues-view-names-controls` generates whole records, which rarely link to each other, so an issue's page, its
tree, notes, proposal gate and aside stayed unrendered. `screens/issues-records` (`fuzz/issues-view.fuzz.vibe`) renders
the pane through the real update and view over the mock Factory's records, with generated screen, role, filters,
query (none, a slice of the selected title, its number, or text), failure, retry, connection, dates, stale time,
reviewers, assignees, specification, its history and the accepted gate, plus overrides on the selected record (VIP and
task state, approval, notes with references, labels and code, body). Screen, status and dialog are weighted toward a
ready list or issue with no dialog.

| Oracle | Holds when |
| --- | --- |
| names | every control has an accessible name and no `script` is emitted |
| dialog | an open dialog is named for its action and the selected issue; with none open, no such dialog |
| issue | the page heading ends in the issue's number, or "Issue unavailable" shows for a number no record has |
| comment | the comment box shows exactly when the role may comment and the tracker is connected |
| commit | Commit or Uncommit shows exactly when the role may commit a non-VIP that is open or a task (no dialog open) |
| accept | Accept and Decline show exactly when the role may accept a VIP in review |
| specification | four review requests exactly when the role may request review; the editor exactly when it may revise; the suites exactly when `specificationAccepted` |
| list | New issue and Propose a VIP never show to a role that may not |

The view reads the role from the account (`issueStateOf`), so the target sets both. Alone, 10 s: 190 to 233
executions, `issuesView.vibe` 364/439 arms and 65/79 functions. Still open there: the keyboard handlers (kind arrows,
Enter on the comment box, title and assignee), which only a scene interaction fires and whose Commands a scene must
resolve, and `issueChatCard`, which the chat renders. Mutation: showing the comment box without the connection check
is falsified in 218 executions.

### `src/web/main.vibe`: wiki command bodies and restored editors

Two wiki faults join `fuzz/web-backends.vibe`: `stale` (a read answers a confirmation time) and `unlisted` (a write
answers without the page or a review). `web/command-bodies` checks that `OpenWikiEditor` carries the stale time into
`BeganWikiEdit` and that `SubmitWikiEdit` answers an empty revision and review; dropping the stale time from
`OpenWikiEditor` is falsified in 153 executions. `web/pane-messages` gains `restore-editor`: a schema-valid editor
installed directly, as a decoded Model can hold it, with or without the request and serial that opening one records,
and with a role set on the account and the issues pane together. It reaches `main.vibe`'s `?? 0` and `?? null`
fallbacks for an editor update never built (472, 477, 479, 481 on `83c6afb4`).

| Finding | Target, seed | Kind | Fix | Regression |
| --- | --- | --- | --- | --- |
| `IssueUi` `select` stored `Number(value)`: text such as `"\u0000"`, `"1.5"`, `"-1"` selected NaN, a fraction or a negative, and a comment on it sent a request whose `number` the wire refuses (the Model left the schema) | `web/pane-messages`, 20261134, after `restore-editor` gave the session a role that may comment | product | `issues.vibe`'s `issueNumber`: text that is not a whole non-negative number names no issue (0), as the parent field already did | `test/issuesUpdate.coverage.test.vibe` "selecting ... names no issue": 6 failed before, 6 passed after; saved value `5998fa97f74997a5` |
| `Flags.session` and `Model.session` were any string, but every request, retry and recovery key starts with the session and must be `DurableText`; a generated session with an unpaired surrogate made a wiki submission's recovery key invalid | `web/pane-messages`, 20261133 | schema | both are `DurableText`; startup always passes a fresh UUID, so no product input changes | the target passes at 20261133 to 20261135 |
| `restore-editor` first set the role on the account alone; update re-syncs the issues pane's role on the next message, so a stale projection "changed" the Model | `web/pane-messages`, 20261133 | target | the step sets both, as a sign-in does | same |

## Status, 2026-11-11 (fifteenth session)

### `src/web/issuesView.vibe`: one key per execution

The pane's keyboard handlers (kind arrows, j and k on a row, Enter with ⌘ or Ctrl in the comment box, Enter in a
VIP's title, Enter on the commit dialog's assignees) run only when a key reaches them in a scene, and a scene fails
unless every Command the key causes is answered. `screens/issues-keys` (`fuzz/issues-view.fuzz.vibe`) puts the
generated pane on the screen that shows the keyed control, presses one key (the control's own keys weighted, then
keys it must ignore) and runs each Command the key and its answers dispatch once against a fresh backend of a
generated kind (`fuzz/web-backends.vibe`: mock, live, bare, faulty, closing, roleless), feeding each answer back
through `update` until nothing is pending. Three times in four the control is enabled (not busy, nothing to retry).

| Oracle | Holds when |
| --- | --- |
| wiring | the scene's `expectHandled` or `expectIgnored` agrees with the control's key list |
| focus | arrows and j or k dispatch exactly one `FocusIssueControl`, naming the neighbouring kind or row, and leave the pane unchanged; no other key moves focus |
| same as click | after everything settles, the pane a handled key leaves equals the one its click leaves: the next kind's radio, Comment, Continue, the dialog's Commit |
| disabled | while that button is disabled, Enter on the assignees sends no request |
| ignored | any other key leaves the pane unchanged |

The pane alone is compared: any Message also lets `update` re-measure the splash. 10 to 20 s: 125 to 216
executions; every keyboard handler arm in `issuesView.vibe` runs. Mutations: ArrowLeft stepping forward is
falsified in 7 executions; Enter on the assignees sending `cancel` in 8.

### `src/web/main.vibe`: the 36 open arms

The full run at seed 20261136 left 36 of `main.vibe`'s 817 branch arms open. Each is now reached by a scenario or an
injected service, or deleted:

| Arms (lines on `ff5994bf`) | Reached by | Oracle |
| --- | --- | --- |
| role dialog closed by an account load or a role event (336, 373) | `web/role-events`: `dialog` signs in a maintainer with people shown; `switch` loads another member's account | the dialog's person is forgotten; a non-maintainer choosing a role opens nothing |
| issue dialog closed by the pane or by a role change (391, 591) | `web/pane-messages`: `dialog` step (account, issue, dialog, action) | an issue dialog the Model closes is closed by exactly one `CloseIssueDialog`; none closes one it keeps |
| actions epoch on the slash menu (499) | `web/pane-messages`: `account` and `draft` steps | `LoadActions` carries the Model's epoch |
| tour plans and launches (567, 730, 769, 802, 833) | `web/update-arms`: people maximized under a wiki pane, a repeated tour event, a sought stop whose end fails, `/sandbox` while busy, Run on a shown run | people shrink to the pane; a repeat changes nothing; the sought stop shows at its own target; nothing starts; Run retries the shown run |
| Command bodies (917, 968, 1236, 1392, 1414, 1422, 1438, 1465, 1467, 1468, 1475, 1477, 1523, 1525) | `web/command-arms`: each Command against the backend it needs: `bare`, `faulty`, `roleless`, a `reversed` mock (each failing member answers the other typed failure), a live mock whose writes fail kept, a live server answering a resumed write's saved state, another page's draft | the failure Message and reason; the address after a live write, a kept write (with its recovery) and a resumed completed write; the default role; the viewer after signing out without accounts; the sign-in route |
| roles stream without accounts (1259) | `web/command-arms`: `roles-bare`, `roles-faulty`, `roles-closing` | nothing without an accounts service; one `FailedRoles` for a failing or ended stream |
| DOM Commands (1058, 1075, 1082, 1083, 1085) | `web/dom-commands`: RevealWiki and WikiLocation over a happy-dom page holding the pane | the inline pane alone scrolls into view; the address is pushed unless already there, keeping the query; the hash's heading, else the content's top |
| window events with no window (1142, 1293, 1294) and back to a page outside the wiki (1145) | `web/subscriptions`: the page is the document, a document without a window, or none; `popstate-elsewhere` | the Model stays valid; back and forward follow wiki addresses only |

`web/command-arms` runs all 26 scenarios in every execution, so no arm depends on what a short budget draws, and
declares `REPLAY_FLOOR` (about a second per execution under coverage). `web/update-arms` runs its six likewise.
`fe285395` (another lane, the same day) added a retry to a lost action-run follow; `follow-lost` loses the first follow
and checks, in virtual time, that the run arrives after two seconds.

One arm was dead and is deleted: `knownWikiSource`'s `pages.find(...)?.source ?? ""`. An editor opens only on a page
`wikiEditable` admits, and `editable` is proved to hold only for ids of the build's index, which `scripts/wiki.vibe`
writes from the same tree as `pages`; `update-arms` checks that a draft review for a page outside the build opens no
editor even when the repository's overlay holds it.

| Finding | Target, seed | Kind | Fix | Regression |
| --- | --- | --- | --- | --- |
| An issue write answered `created` with no `selected` and no items set `selected` to `Math.max()` of nothing, `-Infinity`; the next request's `number` left the schema | `web/pane-messages`, 20261156 | product | `newestIssue`: the highest listed number, or 0 (no issue) | `test/mainRemainder.coverage.test.vibe` "a created answer that names no issue and lists none selects no issue": red (`-Infinity`), green after; saved value `e8f3efd8f9cb7485` |
| `act-live` assumed issue 1 exists; `follow-lost` started a run as a community member; `draft-outside-build` ignored the tour's `MeasureTheatre` | `web/command-arms`, `web/update-arms` | target | pick a listed issue; start as a maintainer; allow only `MeasureTheatre` | the targets pass at 20261150 to 20261157 |

### `src/web/main.vibe`: the last 14 arms (sixteenth session)

The fifteenth session's full run (seed 20261160) failed in `web/command-arms` on two findings: an issues-pane input
holding a lone surrogate was stored as is and the next request left `DurableText` (`9cb84ea7`: `IssueUi` stores
`value.toWellFormed()`, as `UpdatedWikiEdit` does), and `editor-other-draft` drew the decisions index, which is built,
not stored, and has no source to edit (it draws only `wikiEditable` pages).

A coverage run of the ten web targets (seed 20261171) then left 14 arms and functions of `main.vibe` open, each only
because no target chose its state. All are now chosen in every execution; none is dead:

| Arm | Reached by | Oracle |
| --- | --- | --- |
| `ControlTour` (refusal kept, failure lost) | `web/command-arms` `control-tour`: controls that succeed, refuse, fail, or are absent | `FocusedPrompt`, `FocusedPrompt`, `FailedTourEvents`, `FailedTourEvents` |
| `ReadAction` answered | `read-action`: a maintainer starts a run, then reads it | `ChangedAction` for that run |
| a failing actions load with its epoch | `actions-faulty-epoch` | `FailedActions` names the code and epoch |
| an issue write answered without a role | `act-roleless` | `IssuesLoaded` with the mock's default role |
| a chat draft link | `draft-link`: a happy-dom bubble with a link to a built page and one to no page | the first answer is `ClickedWikiDraft` for the built page |
| tour keys | `theatre-keys`: Tab (with or without Shift), Space, the arrows, Command-K, each after Control-A and a plain letter | exactly the key's Message; Shift moves backward |
| automatic tour | `auto-tour`, virtual time | `AutoTour` after the delay |
| a lost tour stream | `tour-events`: the first follow fails, the second delivers one event | two follows; the event arrives as `ReceivedTourEvent` |
| assignees without the agent or the saved assignee | `web/update-arms` `assignees-without-agent` | nobody is assigned |
| an editor without a request number | `submit-without-request` | one `SubmitWikiEdit` under request 0 |
| a fresh read naming a confirmation time | `began-stale` | the editor keeps the time and is focused |
| the walkthrough's message already posted | `walkthrough-posted`: a posted entry with or without the walkthrough's client id | step 2 posts the question only when it is not there |

Mutation: `ControlTour` treating `Unavailable` as the kept failure is falsified by `control-tour` in the first
execution (seed 20261173).

The full run at seed 20261178 then left 10 more arms open that earlier runs had reached only by draw. They are chosen
now too: `wiki-bare` (the editor's read and write without a wiki service fail unavailable), `wiki-unlisted` (a write
answered without its page or a review completes with neither), `details-bare`, `sign-in-mock` (no accounts: the
viewer; failing accounts: `AccountFailed`), `wiki-link` (a left click on a wiki link opens it; one elsewhere does
nothing), `read-action` also answers a start from an earlier actions epoch (nothing changes), and `web/update-arms`
gains `learn-more-palette` (a tour that starts closes the palette first) and `control-clears-error`. Two oracle
mistakes found on the way: `wiki-unlisted` sent a lone surrogate the editor never sends (it stores well-formed text),
and `learn-more-palette` assumed every drawn page starts a tour.

### `budget/physical-calls` after DUR-2 (sixteenth session)

`d94d65cc` (2026-11-11, another lane) removed the meter's own ledger retries: each operation is attempted once and a
failure is `AccountingUnavailable` (DUR-2, decision 0030). `budget/physical-calls` still expected three retries and
failed on its first execution at every seed, which stopped the full run at seed 20261175 before its report. Its
oracle now names `RETRIES = 0`; it passes at 20261175, 20261176 and 1, and a meter given back one retry is falsified
in the first execution (seed 20261177).

## Status, 2026-11-11 (seventeenth session)

### `src/web/main.vibe`: the last 8 arms, chosen

The sixteenth session's final run (seed 20261184) left 8 arms of `main.vibe` open that other runs had reached only by
some target's draw. `web-arms` now chooses each one, both sides, in every execution; none was dead:

| Arm | Reached by | Oracle |
| --- | --- | --- |
| a pane event closes the editor | `web/update-arms` `pane-closes-editor`: a `PaneOpened` for the other editable page, then for the editor's own | the other page closes the editor; its own page keeps it |
| a stale scroll | `scroll-stale`: a scroll older than the last, then one as new | the old one changes nothing; the new one is applied |
| a tour event past a missed one | `tour-gap`: a started tour, then an event two numbers ahead | the tour client starts over under the next epoch |
| `EndTour` failing | `web/command-arms` `end-tour`: an end that succeeds, is refused, or fails unavailable | `FocusedPrompt`, `FocusedPrompt`, `FailedEndTour` |
| a run with and without an epoch | `run-without-epoch` | `StartedAction` carries the epoch only when it was given |
| the issue count without and with an issues service | `issue-count`: the `issueCount` subscription over a bare and a mock backend | `IssueDialogFocused`, then `IssueProjectionLoaded` |
| issue details answered | `details-mock`: a real issue number from the mock's records | `IssueDetailsLoaded` for that number |

A `web-arms` coverage run alone reaches all 16 sides at seeds 20261193 and 20261194. Mutation: `EndTour` answering
`FocusedPrompt` for an unreachable agent is falsified by `end-tour` in the first execution (seed 20261192).

### `src/web/sandboxView.vibe`, `actionView.vibe`, `actionViewDecision.vibe`: every pane state, chosen

The final run of the sixteenth session left these three at 37/68, 57/77 and 75/94 arms: no target rendered an open
Sandboxes pane for a role that may start one, or the Actions pane with a selected run, so the trace and its step
choice never ran. `fuzz/web-views.fuzz.vibe` renders both panes over fixed lists of states in every execution; the
draw fills only free text and numbers:

| Target | States | Oracle |
| --- | --- | --- |
| `screens/sandbox-states` | 11: closed with and without a snapshot or any pane field; each gate (viewer, community, contributor); stopped without a sandbox, with one, with no allowance; starting; running; each failed operation; the minutes notice; maximized | Stop only while running; the sign-in prompt and link only for a viewer, the contributor gate for a role that may not start; the meter while stopped; New sandbox without a sandbox and Start with one; the terminal for a sandbox, disabled unless running and idle; Retry exactly for a failed start or stop; the minutes table only maximized; typed text is the terminal's value; every control named |
| `screens/action-states` | 24: closed with and without a run; loading; runs failed to load; another failure as a notice; each layout; text and JSON input; a live, finished, failed, cancelled and empty run; the person's own live reply with and without the right to post; a finished reply; the slash menu in live, mock and pending mode | the case's primary control (Cancel, Re-run, Run or none); skeleton, Retry and notice; the input's placeholder; the selected action's run rows or "No runs yet"; one button per step and the log of the chosen step, else the first failed, else the first live, else the last; the result bar only with a result; the menu's commands and the page's other mode; every control named |

A coverage run of this file alone reaches every arm of the three files at seeds 20261198 and 20261199. Mutations,
both falsified in the first execution (seed 20261200): the trace skipping the failed step (`action-states` case 11)
and a failed start offering no Retry (`sandbox-states` case 7). The slash menu is rendered twice, in the docked
composer and in the closed palette dialog; a closed dialog is outside the accessibility tree, so the oracle expects
both and is not a finding.

### `src/web/issuesView.vibe`, `issueDecision.vibe`: the issue arms, chosen

The final run of the sixteenth session left `issuesView.vibe` at 266/285 arms and 76/83 functions and
`issueDecision.vibe` at 220/257 arms and 21/22 functions; `screens/issues-records` reached the rest only by some
draws. Two targets now choose them in every execution:

| Target | Cases | Oracle |
| --- | --- | --- |
| `screens/issues-chosen` (`fuzz/issues-view.fuzz.vibe`) | Commit on an open issue; Uncommit on a task; a VIP's approval with no time; an event note with no age; the VIP form's prior-art step busy, waiting on a retry, and idle; the new-issue title; the list's search; an accepted specification; the chat's card for a parent and for a record with no labels | the case's control or text; every control named; text typed into the comment, title, prior art, search or specification box is its value (stored well formed); the parent's card lists its children; the unlabeled card names only its number and age |
| `web/issue-decisions` (`fuzz/web-views.fuzz.vibe`) | every action the pane knows and a drawn one; every VIP step with every blank field; every failure reason and a drawn one; an assignee present and gone; a repeated write and the same reviewer's review | each decision's written contract |

`issueKnownAction` runs only in contracts and the unit suite, never in the app, so its target calls it directly; it is
a contract, not dead code. Coverage runs of each target alone reach every arm and function these two files had open
(seeds 20261202, 20261203). Mutations, each falsified at seed 20261204: a task offering Commit, a VIP step 3 with blank
prior art passing, and the same reviewer's review sending a fresh request.

### `src/web/backend.vibe`: every forwarded member, over each backend

`clients/browser-fallback` called five of `BrowserFactory`'s members, so the file stood at 12/15 arms and 15/38
functions. `clients/browser-delegates` (`fuzz/client-faults.node.fuzz.vibe`) calls every Factory and Actions member in
every execution over four backends: a forced mock (maintainer) with the page's journal, a second forced mock over the
same journal, an unforced page whose health is unreachable, and a page whose health says live while every other
request fails in transport (a faulty `HttpClient` service, as `clients/conversation-faults` injects). Oracle: the forced
mock selects mock; a grant reaches the members list; a started run reads back as itself and follows; the journal
restores the conversation; unreachable health selects the mock as a viewer; health live selects live, and every live
member fails typed, none dies (live participation is recorded by the server, so the page's call succeeds). One
execution takes about two seconds, so the target has the replay floor. Coverage of this target alone: 72/72
statements, 15/15 arms, 38/38 functions at seeds 20261206 and 20261207. Mutations, both falsified at seed 20261208:
a grant that forwards nothing, and a run read that forwards another id.

### `src/web/historyApp.vibe`: every Command over a failing history

The history page's Commands ran only over the working mock, so their failure arms (13 arms and 19 functions in the
sixteenth session's final run) never did. `history/command-arms` (`fuzz/history-arms.fuzz.vibe`) runs in every
execution: every read and write over a history that can't be reached (`FailedRead`, `FailedWrite` "unavailable") and
every write over one that refuses (the refusal); the export over the product mock; the plan dialog opening and closing
without its element; Escape on the window; the history subscription over an unreadable outline (`FailedLoad`) and over a
stream lost once (the outline, then two seconds later the event); and a hash naming an epic not read yet (`ReadEpic`).
The failing histories are the product mock with members replaced by failing ones. The mock runs over a two-commit seed,
as `test/historyStartup.test.vibe` does: a whole export of the bootstrapped seed takes up to two minutes (its unit test
allows 120 s). Coverage of this target alone reaches every arm and function the file had open, at seeds 20261210 and
20261211.

### `src/web/historyStartup.vibe`: the page's own startup, every path

The sixteenth session's final run left the file at 32/51 lines and 7/27 arms: no target started the history page.
`history/startup` (`fuzz/history-startup.fuzz.vibe`) starts it over a real happy-dom window in every execution: the mock
role from four kinds of query and three stored values, with storage present and unavailable (a faulty `Window`
service); the agent choice (`?agent=mock` with storage refusing to keep it, `?agent=live` over a stored mock choice, a
stored mock choice, nothing); and live, over the project's real Accounts object and the Worker's history routes on a
loopback server, a signed-in person with a grant, a grant to someone else, a visitor, and a session and grant stream
each lost once. The page's test hosts are shared with `test/historyStartup.test.vibe` through
`test/support/historyApi.vibe`. Oracle: the role and agent rules above; the page asks the server only when it should;
`?agent=live` forgets the stored choice; live, the frame's role is the session's, a grant to someone else leaves it
(500 ms after the grant; it reaches the page within milliseconds on loopback), a visitor is a viewer who follows no
grants, and a lost session is a viewer asked about again two seconds later. Each scenario serves its own API: an
earlier draft shared one server across scenarios, and its saved `AccountUnavailable` failure was the target's, not the
product's. Coverage of this target alone: 62/62 statements, 25/25 arms, 18/18 functions at seeds 20261214 and
20261217. Mutation caught at 20261214: a grant applied whoever it names.

### Saved web models after `af2bca7b` (eighteenth session)

`af2bca7b` (another lane, 0016) made four of `Model`'s keys required: `account`, `sandboxRequest`, `wikiSerial` and
`wikiEditRequest`. Six saved values of `web/view-branches`, `web/subscriptions`, `web/view-models` and
`web/arbitrary-update` held models without them, so all four targets failed before their first execution (`the json
codec cannot decode a saved value: Missing key at ["model"]["account"]`) and both full measurements at `63a8ddd2`
(seeds 20261215, 20261216) stopped before the report. Each saved model now carries the value its missing key meant
before the change (`account` `signedOut`, the three counters 0), written before its own keys so any it had wins; nothing
else changed. All six decode and replay as regressions: 3 files, 10 tests passed. This is the second time (after
`6e6b721d`): a change that narrows a schema a fuzz target draws from should run `pnpm fuzz` over its saved values.

### `src/web/main.vibe` and `issueDecision.vibe`: the last draw-dependent arms (eighteenth session)

Two full runs at `13edee21` (seeds 20261219, 20261220) left no `main.vibe` arm unreached by both, but six reached by only
one, and `issueDecision.vibe`'s recovered specification write reached by neither. Each is now chosen:

| Arm | Reached by | Oracle |
| --- | --- | --- |
| a polled sandbox read failing unreachable | `web/command-arms` `sandbox-poll-unreachable` (the failing backend) | `FailedSandbox` names `fault`, the request and `polled` |
| `OpenWiki` failing | `open-wiki` over the mock and the failing backend | `SucceededWiki`, then `FailedWiki` with the request |
| a grant without accounts | `grant-bare` | `AccountFailed` |
| a blank JSON action input | `run-json-blank` | blank starts the run (an empty object); `{` fails as `input` |
| a polled failure with and without a waiting operation | `web/update-arms` `sandbox-polled-failure` | idle: the reason, not busy; waiting: unchanged |
| Chat on the splash | `chat-from-splash` | with a message: the chat and `FocusComposer`; without: nothing but an active tour's `MeasureTheatre` |
| `issueRecoveredView` for `spec-revise` and `spec-review` | `web/issue-decisions` | its contract over five operations, completed or not |

Coverage of the two files alone hits all seven at seeds 20261221 and 20261222. Mutations, each caught by its own case:
the polled reason lost, a grant without accounts succeeding, a blank JSON input refused, a polled failure overwriting a
waiting operation (20261223), an empty splash shrinking, and `spec-review` recovering to the issue.

### `src/web`'s decisions: every arm, chosen (eighteenth session)

The same two runs left 50 arms of `src/web`'s pure decisions (`accountViewDecision`, `issuesViewDecision`,
`markdownDecision`, `modelDecision`, `paneDecision`, `screenDecision`, `tourDecision`, `updateDecision`,
`viewDecision`, `wikiEditorDecision`, `wikiViewDecision`) reached by one seed or neither: `web/decision-contracts`
draws their inputs from a union, so a short budget reaches some words and not others. `web/decision-arms`
(`fuzz/decision-arms.fuzz.vibe`) calls each of them in every execution over fixed values that take every arm (every
named reason, retry, code and operation; boundary numbers and ages; every boolean combination; a waiting and an idle
operation; typed and untyped editors), with drawn text in the free strings, and checks each against its written
contract. Two arms have no app path: `roleRank` of an unknown name (`roleDialog` ranks only a found person, whose role is
typed) and `screenKept`, a proof lemma; both are contracts, as `issueKnownAction` is. Where the app does reach an arm,
`web/update-arms` reaches it through `update`: `account-retries` (Retry repeats people, a grant and sign-out, and resumes
a lost role stream under the next epoch; each failure's words), `sign-in-unavailable` (live sign-in the server calls
unavailable sends nothing) and `action-failures` (input, permission, run, cancel and load). Coverage of the two files
alone hits every listed arm at seeds 20261225 and 20261226. Mutations caught (seed 20261227): a roles retry keeping its
epoch, sign-in refused only in mock, a maintainer ranked as a contributor, the connection reason unnamed, a page key
below 40 pixels, and a saved wiki page kept twice. `compactAge` without its length check is an equivalent mutant: a
lone `d` or `w` leaves no digits, and `digits("")` is false.

### `src/web/historyView.vibe` and its decisions: every page state, chosen (eighteenth session)

`history/view-models` renders arbitrary `HistoryModel`s, so the two runs left 32 items of `historyView.vibe`, 17 of
`historyViewDecision.vibe` and 3 of `historyDecision.vibe` to the draw (the epic page, a failed commit read, notes by a
person, the timeline's task, the Plan dialog's target and new epic, the epic header's keys; epic pages merged after the
first was never run). `screens/history-states` (`fuzz/history-states.fuzz.vibe`) renders the page over fixed states in
every execution, with drawn titles and note text:

| States | Oracle |
| --- | --- |
| the list with an export, a failure, one epic open before its page and one with more commits; Enter, Space and `x` on an epic header | the export badge; the failure in the page and in the Plan dialog; a busy list and Show more; ToggledEpic twice, then Settled |
| a filter whose matches have and have not answered | 1 row and not busy; no rows and busy |
| an epic's hash; a commit hash read and failed, read and pending | the epic's heading and title; the alert and no heading; no alert |
| a landed commit for a viewer, a contributor and a maintainer; the section choice | the bootstrap's notes have no byline, a person's do; 4 notes; the note form only from contributor; no timeline without a task; Insert and Amend for a maintainer; UpdatedNoteSection evidence, superseded, tried |
| a commit outside the outline's epics in each state, with and without a task; the Plan dialog over it, over another commit and for a new epic | no epic crumb; 4 timeline steps, the task in the first; Amend only when landed; the target's title, else its id; the new epic field and its UpdatedForm |
| epic pages in order, older, and detached | the epic extended; unchanged; unchanged |

Coverage of this target alone hits every listed arm at seeds 20261229 and 20261230. Mutations, each caught
(20261231): Space not toggling, a stale page merged, the bootstrap signing its notes, a failed commit read left
loading, and `superseded` filed as tried. `timelineAt` of a state outside `CommitState` is a contract arm (the type
admits none); the target calls it directly.

### `src/web/markdown.vibe` and `startup.vibe`: one document and one page, chosen (eighteenth session)

`web/markdown-and-reasons` draws texts, so the two runs reached blockquotes, ordered lists, continued items, a marker
change, rulings' ids, unsafe links, a label with no visible text, a table row on the last line and rendered code only
by some draws. `web/markdown-arms` (`fuzz/markdown-arms.fuzz.vibe`) compiles one document holding every block kind and
every kind of link, with drawn words, in every execution; renders it as Foldkit nodes (through a one-line scene view)
and writes it as HTML. Oracle: the block sequence; prose stops at a heading; a continued item and a ruling's id; dashes
then numbers are two lists; quotes join; a control character, a backslash or a scheme other than http(s) leaves the
label as text; a link label with no visible text shows its target; `|` on the last line is prose; the HTML resolves
links and drops `javascript:`; rendered links, ids and the code block's class.

No fuzz target started the main page; the browser stage did, by its draws. `web/startup` (`fuzz/startup.fuzz.vibe`)
runs `main` over the real happy-dom window in every execution, from the unit suite's hosts (`test/support/browser.ts`,
`heldHealth`): the address's recovery, operation and key (drawn), issues, sign-in failure and wiki page as flags, and
none on a plain address; `?agent=mock` saved, kept and cleared by `?agent=live`; a finished tour not toured again;
refused storage (a faulty `Window`) starting a fresh session; the tour's journal kept, continued, unreadable (started
afresh) and refused (read once, nothing stored, the tour goes on); and a chat post in the mock, a conversation that is
not a tour, keeping no journal. One execution takes about eight seconds, so the target has a 30-second minimum.

Coverage of each target alone hits every arm the two runs left in these files, at seeds 20261232 and 20261234
(markdown) and 20261233 and 20261235 (startup). Mutations caught (20261236): control and backslash links allowed, a
marker change kept in one list, rendered code without its class, `?agent=live` keeping the mock, and the resume key
dropped. `toured ? "" : pathname` given the path always is an equivalent mutant: a finished tour turns the automatic
tour off whatever the path.

### The tour's voice and stage, and the history export's delegate (eighteenth session)

`theatre.vibe`'s speech and stored audio and `theatreDecision.vibe`'s menu frame were reached only by the browser
stage's draws. `web/theatre` (`fuzz/theatre.fuzz.vibe`) drives the real presentation service on an injected `Window`
(the unit suite's `speakingWindow`) in every execution, at a drawn step: speak, keep, pause, resume and cancel in a
tour's order; a browser without utterances only cancels; without a speech host nothing is called; stored audio that is
not the tour's (this step, a sound that is not a boolean) is ignored and the line spoken afresh; the stage frames the
composer, grows to its open completion menu, and frames the default box when the target is absent. Both seeds
(20261237, 20261238) reach every listed arm. Mutations caught: resume never called, the menu not raising the frame, and
foreign stored audio trusted (20261239; the first foreign value, a step out of range, spoke either way and did not
catch it, so the case uses this step).

`historyBackend.vibe`'s `publish` was the one `BrowserMythical` member no target called: the mock's export runs a whole
export flow, too slow per execution. `clients/browser-delegates` now also starts the history page's backend over the
page whose health says live and whose other requests fail: it selects live and the export fails typed. Mutation
caught (20261241): `publish` answering without forwarding.

### The wiki pane's ways out, the account menu, and the last small arms (eighteenth session)

`screens/wiki-and-people` (`fuzz/wiki-people.fuzz.vibe`) renders the main view over chosen states in every execution:
the wiki editor with each failure (Connect GitHub posts to the connect route; Fork and Install link out; a changed page
and no failure offer nothing) taking drawn text as `UpdatedWikiEdit`; the page finder sending `FilteredWiki`; a page the
repository changed rendered from its own source (read from the vnode's `innerHTML` property, as `h.InnerHTML` sets it)
with a relative link resolved to a wiki page and a web link kept; the account menu's ArrowDown and ArrowUp moving focus
(`FocusedPrompt`) while `x` and Enter send nothing; and a person's role chosen in the People pane (`SelectedRole`).
The menu oracle names its keys: a first draft computed the expectation with `menuKeyMoves` itself and let a mutant
through. `web/decision-arms` adds `completions` without a mode (the bench and unit suite call it so; the app always
has one), `resultText` of a refusal, and a specification revision sent with revision 0 before any. Both seeds
(20261243, 20261244) reach every listed arm. Mutations caught (20261245, 20261247): Install offering nothing, relative
wiki links left unresolved, and Enter moving the menu.

`modelWrite.vibe`'s `escapeWritesIssues` and `screenKept` are proof lemmas (decision 0018) with no app caller; the full
runs never called them. `web/decision-arms` now holds both to the code they specify, as `test/modelWrite.test.vibe`
does: `escapeWritesIssues` is true exactly when the proved `escapeWrite` changes an issues screen the page has (four
screens, every Escape route, with and without the wiki pane), and `screenKept` returns the Model unchanged. Seed
20261248 reaches both; Escape over an open list not counted as a write is caught (20261249).

The eighteenth session's final run (seed 20261251, `3372f524`) found the same draw-dependence in the browser stage:
`historyApp.vibe`'s successful writes and `SetHash`, `shownReads` over open epic pages (`historyDecision.readOffsets`)
and `historyView.vibe`'s input handlers had been reached at 20261219 only by `browser/history-navigation-and-work`'s
draw. `history/command-arms` now plans, starts, notes, approves and folds a commit over the working mock (each answers
`Wrote`) and moves the address with `SetHash`; `screens/history-states` types into the lane, note, plan title, epic
and task fields (each Message named) and checks that a newer outline reads again every epic page the reader has. Seed
20261254 reaches every one of those lines; a start that reports `busy` after writing is caught (20261255).

The same run left two single arms: `issuesViewDecision.ageText` for a long, non-compact age, and `modelWrite`'s
`tourStartWrite` keeping the client (Learn more in the tour's own conversation). `web/decision-arms` checks `ageText`
over blank, "just now", compact and other ages, absolute or not, long or short; `web/update-arms`
`learn-more-same-conversation` runs Learn more in the demo conversation (its messages kept) and from another (none).
Seed 20261256 reaches both; mutants caught (20261257): a long unknown age without "ago", and Learn more always fresh.

### `history/export-setting` after `e23e88dd` (eighteenth session)

`e23e88dd` (integrations, 2026-11-12 14:37 UTC) requires a GitHub `apiBaseUrl` to be HTTPS except on loopback. The
target's fixture `http://github.test` made `exporterOf` die (`IntegrationError`) whenever `api` was drawn, so the
target failed at every seed and stopped `pnpm fuzz:coverage` before its report (20261258, 20261259). The fixture is now
`https://github.test`; the target's client is unreachable, so no request is made. Seed 20261258: red before, 3 tests
passed after.

### The thirteen arms the eighteenth run left to the draw (nineteenth session)

The eighteenth session's last full run (seed 20261261, `9df38053`) left 13 arms in 8 web files, each reached in its
other runs only by a broad target's draw. Each is now a chosen case, run in every execution:

| Arm | Case |
| --- | --- |
| `historyApp` 223, `historyDecision.outlineArrival` 84: an older outline arriving late | `screens/history-states` "late outline": the ready page and no Command |
| `historyApp` 319: `ReadOutline` answered | `history/command-arms` runs every read over the working mock; none answers `FailedRead` |
| `historyView` 159: an epic read to its end | `screens/history-states` "read epic": its commits, no Show more |
| `issues` 83, `issuesViewDecision` 28: an action repeated after its failure | `web/decision-arms` "resend": `comment` and `spec-review` send the saved request itself, serial unchanged |
| `main` 1161: a finger moving | `web/subscriptions` fires each of the 14 DOM event kinds once before the drawn events |
| `main` 1394: People without an accounts service, and one that fails | `web/command-arms` `people-bare` (`LoadedPeople`, empty) and `people-faulty` (`AccountFailed`) |
| `wikiView` 79, `wikiViewDecision` 81: a pane on a page the build lacks | `screens/wiki-and-people` "missing page" (no page, failure or skeleton), "no match"; `web/decision-arms` checks `wikiContent` over all 16 inputs |

Each changed target alone reaches each of its arms at two seeds (history 20261262/63, web 20261262/63 and
20261264/65, wiki 20261266/67). Mutants caught (20261268), one per case: a repeated action sent fresh, a late outline
accepted, Show more on a read epic, a read outline answered as failed, People without accounts failing, a failed
member list loading empty, a missing page read as no match (caught by both targets), and a moving finger emitting an
undeclared Message.

## Lane vl-fuzz2: the rest of the server, 2026-11-10

Scope: every `worker/` file and every `src/core/` file outside vl-fuzzpkg's (`src/web/main.vibe`,
`worker/apiObjects.vibe`, the drafts) and vl-fuzz3's (`src/surfaces`, `src/history`, `src/actions`). The full
`pnpm fuzz:coverage` on `45f23a98` left 54 of these files below 100% of lines or branches; the lane report on nyc-01
lists them.

The verified decision modules are fuzzed on arbitrary arguments, lawful or not, and held to their own `//@ ensures`
clauses, written again in each oracle rather than read from the body: the emitted JavaScript must be the proved model.
Product flows call them only in lawful order, so only arbitrary input reaches the guards that leave a state unchanged.

| Target | Exercises |
| --- | --- |
| `sandbox/probe` | The vl-test probe Worker's body (`worker/sandboxProbeFetch.vibe`) over the product's account and machine objects, SQLite storage and a container of local processes: routes, token (right, wrong, blank, none, or a stage deployed without one), owner (inside the window, expired, beyond it, not a probe owner, none), an account binding that throws, box faults, alarms, and direct leases through the clamp. Oracles: 404 off its two routes, 403 without the token, 400 for a non-probe owner, 503 for an unreachable object; a signed-out read is the empty snapshot and a signed-out write is refused before any object; only the admitted owner starts a container; "not running" is the container's own state; no lease outlives the owner's deadline beyond the one-second floor |
| `wiki/links` | `wikiLink` against WHATWG URL resolution of the same link under its page's path: absolute links pass through; a link inside the wiki names a known page or its index under `/wiki/`, else its source file; one that climbs out keeps its `..` in the repository URL |
| `decisions/reply-run`, `decisions/tour-run` | The reply and tour state machines (`flowDecision.vibe`) from a fresh or an arbitrary run, any order of steps: each keeps a lawful run lawful, leaves a run it cannot act on unchanged, and moves its counters as proved |
| `decisions/flow-helpers` | `appends`, `endsTourEvent`, `startAnswer`, `readingHold` (to 2^32 - 1 words), `firstUndispatched`, the tour counters and choices |
| `decisions/mock-factory` | `mockFactoryDecision.vibe`'s ten decisions, including the journal key's separation of a person and their device |
| `conversation/sequences` (extended) | `replayDecision.vibe`: each intent's record equals decide and apply, the log's replay equals the live conversation, the specification fold agrees, and a conversation at the cursor's capacity, or below zero, takes no step |

`leaseFor`'s `id.split("/")[0] ?? ""` had an arm no input reaches (`split` returns at least one element); it is
`split("/")[0]!` now. Findings so far: two oracle errors, fixed in the targets (a signed-out read answers the empty
snapshot, not 503; a link climbing to `..` ends in `/..`). No product bug.

Second part, same lane and day:

| Target | Exercises |
| --- | --- |
| `clients/live-replies` | Every `LiveFactory` and `LiveAccounts` operation against any reply of an injected `HttpClient`, walked per execution with a fitting, a refusing, a broken (500) and an odd-shaped (200) reply, then a generated one. Oracles: 2xx accepts a conversation intent and 409 carries its refusal; a sandbox write's 403 or 409 carries its refusal and reason; a read succeeds only with 200 and a body of its schema; a role refusal on an account read is `Denied`; anything else is `Unavailable`, whose reason never repeats the reply's text; an identifier the protocol can't carry sends no request |
| `accounts/config` | `configured()`: a setup exists only with every credential, a 32-character signing secret, a numeric maintainer id, a valid encryption key and a canonical HTTPS or loopback origin; a walk breaks each value once |
| `accounts/sandbox-principal` | Only a verified session names an owner; a write needs the browser's own Origin; HTTPS presents only the host cookie |
| `decisions/account-cookies` | The cookie decisions and `validSessionCookie` against their contracts |
| `accounts/broker-sequences` | `worker/Accounts.vibe` with the real smithers.sh broker in process (VL-33) or GitHub's own OAuth: sign-in (tampered state, cookie, code, replay, expired record, null and foreign origins), Connect GitHub (every query form, consent and cancel, a failing credential custodian), device sessions, roles, events, issues and wiki writes, drafts, participation, oversized bodies. Oracles: sign-in names exactly GitHub's person, once; a tampered handoff never signs in; Connect needs a person's own session and stores a delegation only after consent; a device session stays an agent; no 500 |
| `mock/scripted-actions` | The mock agent's action replies (wiki page, draft, issue, split, sandbox, specification review, history) by each role, walked per execution |
| `decisions/issue-graph` | `issueGraphDecision.vibe` on generated forests and malformed graphs; each specification-only lemma runs where its premises hold and its claim is checked with `issueAncestorAt` |
| `issues/specification-transitions` | `performSpecification` and `revisedSpecificationState` with no reviewer, a scripted one, or an injected reviewer that answers, answers stale, answers without a link, or fails |
| `decisions/tool-refusal`, `decisions/sequencer-helpers`, `decisions/wiki-pages`, `conversation/helpers`, `decisions/host-rules` | The remaining verified helpers against their contracts |
| `objects/startup` | `ObjectStartup.make` with an initializer that succeeds, fails, dies, hangs past its deadline, fails once, or is interrupted by its host scope, in virtual time |

Finding (product): in mock mode, a viewer's, new person's or community member's request for a specification review
("Ask Claude Opus to review the specification") left the reply working until the engine's 5-minute reply deadline:
the refused `spec-review` died inside the reply step (`Effect.orDie`). It is now answered in words, as a refused draft
is ("Only contributors can request a specification review."). Regression: `test/mockSpecificationReview.test.vibe`,
which failed first (two 20-second timeouts), and the saved value in `fuzz/__fuzz__/mock-scripted-actions-*`.

Two more unreachable arms removed: `src/core/wiki.vibe`'s `raw ?? ""` and `split("#")[0] ?? ""` (`split` returns at
least one element).

### Unbounded waits in steered targets (vl-fuzz2, 2026-11-11)

The two steered failures vl-fuzz3 saw at `90f526f0` reproduce no more on `f84ddb86`: `objects/steered-host` passes
under coverage at seeds 20261107, 20261111 and 7 (4 to 6 executions in its 15 s floor), and `actions/steered-runs` at
20261107 (6 executions in 34 s). Their causes are recorded above: the latch `c5bbf81b` stopped reaching ("Two oracles
behind `c5bbf81b`", fixed in `8d835fa6`) and the missing floor ("Floor for steered targets under coverage", `9fea2b98`).

The first is a class, not a case: a steered scenario that awaits a latch or joins a held fiber without a bound turns
any reorder in the product into a test timeout that names nothing (600 s under coverage). `actions/steered-runs` and
`actions/held-replies` still had four such waits and `objects/steered-host` one. Each is now bounded at 20 s and
fails as a `Finding` naming the wait. Checked by mutation: with the `early` scenario's latch never entered, the old
target timed out at 120 s; the bounded one answers `Finding: reply start did not return`.

### Third measurement and draw-dependent arms (vl-fuzz2, 2026-11-11)

The third full `pnpm fuzz:coverage` (seed 20261107, 5 s, `f84ddb86` plus the bounded waits) passed every target: 83
files, 248 tests. Its browser phase needs a `playwright` box: on `node26`, Chromium exits 127 and its libraries cannot
be installed, so the merged map comes from the `playwright` run. In this lane's scope 32 files stay below 100%.

Two gaps were the draw's, not the code's:

| File | Why it moved | Closed by |
| --- | --- | --- |
| `worker/Accounts.vibe` (34 lines and 32 arms missed, from 11 and 37 before) | `accounts/broker-sequences` walks a fixed op list every execution since `59195ea1`; the list had no foreign origins, bad queries or bodies a route cannot take, and at 5 executions in 30 s the drawn ops rarely produced them | the walk now also runs `refusals` (another origin's issue, wiki and device writes; a device body too long by header and by chunked stream; a chunked roles body; a malformed callback post), `stall` (device and roles bodies that never end, answered 408 at the 3 s read deadline, in virtual time), a corrupt and an expired sign-in row and an id past 2^53 - 1 in GitHub's own OAuth, every query Connect refuses, a Connect handoff without the session that pressed it (403, nothing stored), issue and wiki writes by a person and by their agent, and a short walk where the site names a broker it has no secret for |
| `worker/CallBudget.vibe` (new in `a2de30ee`, 3 lines and 2 arms missed) | no target reached it | `budget/physical-calls`: the meter over a ledger that fails a drawn number of times and admits or refuses, with every ceiling and usage shape, in virtual time; each execution walks every refusal, each recovery inside the three retries, and every usage. Oracle: the handover comes first and is tried at most four times; a ceiling with no room for the 32,768-token input allowance is refused before admission; a retried admission keeps one key; a receipt names the day, a version-4 `model/` key and the ceiling; settling charges exactly the counted tokens; a foreign receipt charges nothing |

`CallBudget.vibe` is at 100% from its target alone; the Accounts targets alone leave 13 lines of `Accounts.vibe`: the
issue and wiki reads (each waits out its flow's deadline against an unreachable GitHub, 6 to 13 s, so the walk sends
only writes), the read-queue deadline, the `github/` migration, and the broker's local-development option.

`history/arbitrary-update` failed every run on `main` after `9380a9e6` (the mythical history export) added the required
`exported` key to `HistoryModel`: its saved value no longer decoded ("the json codec cannot decode a saved value:
Missing key at model.exported"), so `pnpm fuzz:coverage` stopped before its report. The value now carries `exported:
""`, the model's initial value, and replays as a regression again. A schema change to a fuzzed model migrates that
model's saved values in the same commit.

`mock/factory-edges` walks, every execution, the mock Factory's room states the scripted targets reach only by chance:
a journal retained mid-reply (the reply fails in words, the next post is answered) or with an unanswered post, tour
controls outside the protocol (Unavailable) or with no tour (Refused, nothing written), every control once the
walkthrough has driven its first step (a control before it is refused `not-replying`, as `decide` specifies), a post
behind a running tour, a tour asked for right after a post (the reply's start is contended and hands over), and a
closed Factory (Unavailable). Alone it reaches `MockFactory.vibe` 97-102, 297, 357-358, 402-411 and 481-485; about one
second per execution.

### Session 13: the mock sandboxes and the tour's steps (vl-fuzz2, 2026-11-11)

The fourth full measurement (`bc085386`, `playwright` box, seed 20261107, 5 s) passed every target, 86 files. In this
lane's scope the two largest gaps were `src/core/sandboxMock.vibe` (4 lines, 15 arms) and `src/core/flows.vibe` (2
lines, 12 arms).

| Target | Exercises |
| --- | --- |
| `sandbox/mock-device` | `memoryMachines` against a model of leases, files and answered operations, written from VL-13 and 0024: only the leased generation's commands run (else `stale-generation`); an operation answers once and replays that answer; a redirected echo writes, `cat` reads, `ls` lists in first-write order, `pwd`, a plain `echo`, a blank line, anything else unavailable in mock mode |
| `sandbox/mock-service` | `makeMockSandboxes` in virtual time. Each execution walks a contributor's sandbox (no meter while idle; a write, its read and the read's replay; a conflicting reuse of an operation; the alarm's meter within its minute while running; a stopped generation's command refused; a restart keeps the files), then fails every operation on an engine with a drawn fault (a typed refusal or unavailability reaches the caller as it is; a flow cycle is an unavailable sandbox), then runs drawn steps with a drawn role (only a contributor or maintainer starts one; fresh commands answer as the device rules say; a reused operation replays) |
| `tours/pane-steps` | `openDocs`, `say`, `openWiki`, `readingMillis` and the `OpenDocs` and `OpenWiki` flows over the live sequencer: a docs path opens only under the docs rule (0014), a wiki page only when the wiki has it, words only when there are some, nothing once the reply finished; the person's own Open opens any known page; a stop is read 1 s plus 300 ms a word, at least 4 s |
| `tours/walk-restore` | The Tour flow on the engine over a walkthrough the conversation already holds (none, no target, running, paused, past the script): a restored stop is shown again with no second drive or narration; otherwise its step is driven and narrated; past the end the tour finishes; a narration the tour no longer takes ends the run; a seek signalled on the gate the run waits on drives the requested stop next |

Mutants, each caught and restored: the device's answer replay removed; a refused command mapped to an unavailable
sandbox; the alarm metering two minutes late, and metering while idle; any path opened as a docs page; empty words
said; the restored stop driven again; a seek ignored; the restored step forgotten. From these targets alone
`sandboxMock.vibe` is at 100%, and every `flows.vibe` arm the measurement missed is reached.

`OpenDocs`'s body (`flows.vibe` 477) runs in no product host: `worker/WikiTools.vibe` binds the reply's docs tool to
`openDocs` directly and uses the flow only for its name, schema and description. `tours/pane-steps` runs the flow on
the engine with `openDocs` as its step, as `bench/src-edges.bench.vibe` does.

`flows` 213 above (vl-fuzz3) is `src/history/flows.vibe`, now line 245. Re-checked 2026-11-11: the plain-JavaScript
reproduction (`~/vl/vibelang-bugs/coverage-v8-suspend-else-arm`, `node variants.mjs`) still reports a never-taken
suspending else arm's zero to the end of the function on Node 26.5.0 (V8 14.6.202.34-node.24), so the record stands.
`src/core/flows.vibe` has the same shape at 257, 266, 338, 347 and 494, but each of those else arms is taken, so no
count there is misreported.

Two more targets close the next two gaps, `src/core/sandboxHost.vibe` (4 lines, 11 arms) and
`src/core/WikiFactory.vibe` (3 lines, 11 arms):

| Target | Exercises |
| --- | --- |
| `sandbox/host-races` | `makeSandboxHost` while a command is held on the machine, against 0024: the generation stopped meanwhile is `stale-generation`; a lost machine is `command-uncertain`; a second writer over the same storage that meets the running command records it `command-uncertain`; whichever writer records the operation first decides its one answer; a refused command adds no output line, an answered one adds exactly one; `failureReason` over drawn values |
| `wiki/fixture-edges` | `makeWikiFactory` and the fixture host on faulty engines (a flow cycle is `failed` and unwritten; a lost receipt is `unavailable`, written, and its retry reads the one review; a lone held identity is `conflict`; other defects reach the caller unchanged); writers with their own engines over one repository (the repeated key answers the first review, the key reused for other words is refused); a person who changes between request and step; a factory with its own repository |

The first version of `wiki/fixture-edges` sent the repeated key and then the other words to one second writer. Its
engine already held that execution, so it refused the other words itself and the repository's own check
(`WikiFactory.vibe` 63) never ran. Each reuse now gets a writer with its own engine, and one engine that ran the key is
checked separately.

Mutants, each caught and restored: the repository's reuse check removed; a refused receipt replayed as output; a
stopped sandbox's command not stale; `failureReason` ignoring an Unavailable's reason. From these two targets alone
every `sandboxHost.vibe` and `WikiFactory.vibe` line and arm the fourth measurement missed is reached.

`worker/VipDraft.vibe` (16 lines, 8 arms in the fourth measurement) was reached only through `issues`, which drew two
drafts through the writer in 5 s and never ran the real draft agent. `vip/writer` walks every agent under an admitted
budget in each execution, then the drawn agent and admission:

| Agent | Holds |
| --- | --- |
| none, or no model | `no-model`; nothing admitted, spent or called; the agent itself also refuses `no-model` when asked directly |
| any, admission refused or unreachable | `budget`; the agent never runs; nothing spent |
| failing; usage the meter can't read | `draft`; `budget`; charged once |
| scripted model: a VipDraft; not a VipDraft; prose; a provider 400 | the draft exactly; `draft`; `draft`; `draft`; charged once |
| scripted model, its call refused by the day, or the ledger down | `budget`, after at least one call admission |
| final charge never taken (virtual time) | the engine retries it, then `budget`; `vibelang_draft_spend_failures{draft=vip}` counts one |

Mutants, each caught and restored: the spend failure not counted; a refused model call reported as `draft`; a ledger
outage passed as the agent's failure; a refused admission ignored. Alone it reaches all of `VipDraft.vibe` except 63-64:
the catch for a run whose usage can't be read. The writer builds its own memory meter, whose `usageOf` fails only when
recovering the run's journal entries fails, so reaching it needs an engine whose journal reads alone fail. No target
builds one; `WikiDraft.vibe` and `SpecificationReviewers.vibe` share the shape.

`worker/apiObjects.vibe` 347-368 (11 lines, 10 arms) is the `/api/health/objects` route, added after `api-objects/world`
was written; its `health` op asks `/api/health` only. A `health-objects` op joins the walk, signed in and as a visitor,
and every namespace's unbound and faulty walk: the route answers 200 whatever is unreachable, names the deployment's
commit (none for a build without one), and calls exactly the unreachable objects `unreachable` (an object lost after N
calls may be either, so it is not checked). Mutants caught: an unreachable object reported `ready`; a build without a
commit named `unknown`. From `api-objects` alone `apiObjects.vibe` is at 100%.

`worker/SandboxTools.vibe` (6 lines) was reached by no target: no host provides `SandboxAgent`, so a reply binds the
closed tools, and no scripted cell called them. `reply/sandbox-tools` (in `model-writers`) runs a reply whose cell
starts a sandbox, runs one command twice and stops it, three ways each execution: closed (every call `forbidden`, the
Factory never reached); a viewer's mock Factory (each call reaches it once, refused `forbidden`); a contributor's (the
start runs generation N, both commands answer, the stop stops N). Every call names the reply's conversation and a
distinct `agent/` operation id, the repeated command included. Mutants caught: the stop sent to another conversation;
the closed command refused `unavailable`; the call's ordinal left out of its operation id (caught only once the cell
repeated a command). Alone it reaches all of `SandboxTools.vibe`. A tool answers its value, or `{ ok: false, error }`
when refused (`QuickJSSandbox.ts`), not a thrown error.

`worker/Issues.vibe` missed seven lines, each a refusal the drawn ops reached by chance or never. The `steered-host`
target's `shapes` scenario now asks, in order: a list holding a malformed issue (`protocol`); a selected issue the list
does not show yet (the fake's `issueVisibleAt`), read by itself and shown; that issue's own read refused 403 (the fake's
new `issueStatus`: `forbidden`, not a list without it); saved gates that are not the protocol, and saved gates at the
last revision (both `protocol`, then restored); an injected host answering revision -1 (`protocol`).
`issues/http-surface` posts every body kind before its drawn request, so a body that is not JSON and an oversized one
reach the server each execution. Mutants caught: the unlisted issue not added; its refused read ignored; the saved
revision's room unchecked; GitHub's revision range unchecked. The seven lines are reached from `issues` alone.

`worker/PublicReads.vibe` 30-31 and 37-39 (a configured read setup; the cache store's storage failures) had no target.
`public/reads` reads the setup from drawn configuration (through smithers.sh only with both `VIBELANG_ORIGIN` and
`AUTH_BROKER_SITE_SECRET`, at `https://smithers.sh` unless `AUTH_BROKER_ORIGIN` names another) and walks the store
over storage whose get, put, delete or all operations reject: each failure is a miss, never a failed read. Mutants
caught: a failed get or remove failing the read; another default broker. The setup's both-or-nothing condition admits
no compiling mutant (`.value` needs both options narrowed). About 2,000 executions in 3 s.

`worker/WikiDraft.vibe` and `worker/SpecificationReviewers.vibe` share VipDraft's shape. `wiki/writer` now first asks the
wiki agent directly with no model (`no-model`) and drafts once against a ledger that never takes the final charge;
`specification/reviewers` first reviews against that ledger, and with a record whose key the deployment lacks
(`HostModel.make` refuses it, so the reviewer has no model: `no-model`, nothing admitted, no model call). The
never-charged runs execute in virtual time through `virtually` (`fuzz/run.vibe`, now shared with `vip/writer`): the
engine retries the charge through `draftSpend`'s 120 s, then the draft is `budget` and
`vibelang_draft_spend_failures{draft}` counts one. Mutants caught: the wiki and review spend failures not counted;
the wiki agent's own refusal as `draft`; an unusable reviewer record stopping the reviewers. Both files are reached
except the unreadable-usage catch (VipDraft above).

`worker/HistoryObject.vibe` 102-106 and 185-188 (the reader's unreachable and non-protocol answers; the export
branch) were never asked. `storage/history-write-flows` now reads through a reader whose page and write are
unreachable (`history unreachable`, both) and one whose page is not the protocol (`history is not the protocol`), and
ends with an export: with the exporter off nothing is published (an agent `forbidden`, a person `unsupported`, no
commit written, no tip). Mutants caught: the export's refusal dropped; a non-protocol page reported as unreachable.

`worker/Http.vibe` 127 (the history `export` write's body) was never routed: `http-routes` drew every write but
`export`. It is now a route like `fold`: an empty or unread body is the empty object and accepted, any other body
must match `ExportBody`, and its answer maps as every write's does.

The sixth full measurement (`efd13057`, `playwright` box) failed 7 targets in 3 files before its report:
`history/codecs`, `history/view-models` and five `protocol/history-*-roundtrip` targets. `6e6b721d` (0016, session 23)
made history ids, titles and SHAs a non-blank `Name`, and eight saved values from `bdf29302` held blank ones, so
they no longer decoded (`the json codec cannot decode a saved value: Expected <filter>`). Each is a regression for
another property (the head's, for one, is `folds: Infinity`); the blank names were incidental shrink results. Every
blank `id`, `title` and `sha` in them (JavaScript `trim` semantics; 2 to 5 per value, 22 in all) is now a fixed
non-blank name and nothing else changed. All 8 decode and replay as regressions: 3 files, 25 tests passed.
A change that narrows a schema a fuzz target draws from should run `pnpm fuzz` over its saved values before it lands.

`worker/Budget.vibe` 61 and 90-92 are ledger states only an older or interrupted writer leaves. `api-objects/budget`
now starts each execution by writing them: a charged reply that still holds its reservation is only released (hold
and reservation 0, the day's charge and the reply's receipt unchanged), and a hold that is not a count makes the
next admission a defect. Mutants caught: the release written as a full settlement (it rewrites the receipt; the
totals alone did not show it); a negative hold admitted.

`worker/machineObject.vibe` 64, 85 and 109 waited on box faults the draw rarely paired with the right step.
`sandbox/machine-object` now walks every box fault each execution at a start, a leased command and a stop, then a
container that stops while an admitted command runs (a new `dies` fault in `fuzz/machine-box.ts`; `FAULTS` is
unchanged, so saved values keep their meaning): that command is `not-current` and never runs again. Mutant caught:
the box's running state left out of the command's last check.

The wiki writer, the reviewers and the reply now also each meet a model call the day refuses, and one whose charge
the ledger cannot record (`physicalLedger` in `model-writers`): all three answer the budget's failure, never the
model's. Each reply execution also starts over once (`corrected`): only the second text is shown. Mutants caught:
the wiki's refused call reported `draft`; the reviewers' and the reply's ledger outage passed on as the model's
failure; a reply that never starts over.

`worker/Accounts.vibe` 398 and 480-482 had no world to reach them. The walking worlds of `accounts/broker-sequences`
now start over storage that holds two per-site tokens from the 0165 connect path; the object deletes both and marks
the migration before answering anything. A `lost` step makes every storage read and write reject: GitHub's callback
POST answers 503 (the broker's callback refuses the body first, 400), sign-in returns to `/?sign-in=failed`, and the
session is 503 when a session cookie is presented and 200 as a viewer without one (it reads nothing). The first gate
drew `lost` as a fresh brokered world's first step, with no cookie, and refuted an expectation of 503: the property was
too narrow, not the product. Every execution now also runs that fresh-world step. The target's test timeout is 300 s:
one execution walks three worlds, about 20 s on nyc-01 and over a minute on a 4-vCPU box, after the 30 s floor, and
120 s timed out on a box. Mutants caught: the migration keeping the tokens; a failed sign-in returning unmarked. Still unreached: the read-queue deadline (217-220), issue and wiki writes that need
a reachable GitHub (433-445) and the local-development broker (123).

`worker/Accounts.vibe` 217-220 and the refusal arrow on 433: the brokered walk now holds the issue lock with a
connected write that waits on an unreachable GitHub (`queued`); a read queued behind it answers 503 after at least 13
virtual seconds, never left waiting. Signed in without a connection (`reads`), issue and wiki reads answer 503, an
issue write is asked to connect (401), and a merge (`spec-revise`) a community member cannot make is refused by the
role policy (403) before any flow runs. A connected write has no read deadline: it keeps retrying for over a minute of
virtual time, by design (writes resume by key). Mutants caught: the queue deadline at an hour; the policy's refusal
reported unavailable. Still unreached: the participation grant after a write GitHub accepts (437) and the
local-development broker (123).

`src/core/wikiBuildDecision.vibe` (32 lines in the eighth measurement): each scan is a recursive specification that
only the proofs used and a loop the build runs. `decisions/wiki-build` draws pages from 21 tokens (line terminators,
headings, `VL-` numbers, dates, field keys, status words) and a start from -2 past the text, and holds every loop to
its specification and both to the regular expression the build used before (`/^# (.+)$/m`, `/VL-[0-9]+/g`,
`/word/i`, `/2026-[0-9]{2}-[0-9]{2}/`, `indexOf`), and `decisionLabel` to its replace. Whole dates are single tokens:
built from four, a draw almost never made one, and a `firstDate` stepping by two survived. Mutants caught:
`findRulings` skipping the unit after a ruling; `firstDate` stepping by two.

`worker/sandboxProbeContainer.vibe`, `sandboxProbeFetch.vibe`'s direct and recording routes: `sandbox/probe` builds its
machines with `probeMachine` over a box that counts every Container call beneath the recorder. The live conversation's
machine draws passthrough or record mode and a limit of 0 to 7; the direct conversation's always records at the
deployed limit. Every execution drives the direct machine (start, lease, command, status, stop, a malformed body), reads
both recordings, a third conversation and none, and both routes with the machine binding unreachable (503). A recording
holds exactly the calls the box ran, up to its limit, none in passthrough, with every inactivity timeout and the run
script's timeout word erased. Each machine call runs in its own scope, as a Durable Object RPC does: sharing the
execution's scope left a command's exec unsettled, so unrecorded, until the execution ended (a harness artifact; the
workerd host runs each call through its own `runPromise`). Mutants caught: `recordSlot` keeping one call past the
limit; the erased word moved from the fourth to the third; the recording read's 503 answered as 502.

`worker/machineObject.vibe` 54, 95 and 97 and `machineDecision.vibe`'s receipt arms waited on draws over real
processes. `sandbox/machine-object` now stops the machine and starts a new generation every execution, then asks a lease
of 5 ms (refused `lease-duration`), runs a command, repeats it (answered from its receipt with the same output, never run
again), changes the command under the same operation (`receipt-conflict`), leaves a receipt pending with a failed exec
(its retry is `receipt-conflict`) and runs a command after the lease's end is moved to the past (`lease-expired`).
Mutants caught: a receipt that ignores its command; a lease that ends a second late; a 1 ms lease floor.

`worker/ActionDirectory.vibe` 57 and 88: `api-objects/world`'s walk ends by listing the first flow's runs (by then a0,
a2 and a3) and having a visitor cancel a2. Every run list must be newest first, and a visitor's cancel may succeed only
for a Tour run, the one flow a viewer may run (its least role is `viewer`; the walk's visitor pass starts one). Mutant
caught: the list oldest first. Equivalent: removing the directory's cancel role check, since the action object
refuses the same cancel.

`src/core/IssuesFactory.vibe` 67 and 70, the fixture's durable step checking its person again: `issues/identity-changes`
admits a maintainer, then lets the step find the same person, that person as a viewer, another person, or their agent,
for a read, an accept, a comment and a drawn request, each in a fresh fixture. Another person is always forbidden (the
execution id names the admitted person), a viewer is forbidden what its role cannot do, an agent is forbidden to accept
or decline, and a forbidden step writes nothing; the same person is never forbidden. Mutants caught: the execution id
check removed; the agent check removed.

`worker/HistoryObject.vibe`'s publisher (10 lines in the ninth measurement; decision 0020, "Publishing and following
main"): `history/publisher` (new, `fuzz/history-publisher.node.fuzz.vibe`) tells a random story to a History object,
starts its publisher twice (the same intent before its first alarm answers `started` again, as
`test/historyPublish.test.vibe` pins), drives its alarms in virtual time at a drawn pace (1, 3 or 50 writes a batch),
and holds the published refs to those a person's export of the same story publishes. After the first round a start
answers `running`, a quiet round moves no ref, and a commit main gains is folded and published by the next round. The
story generator moved to `fuzz/history-stories.vibe`, shared with `history/export-flow`. Mutants caught: the start's
outcomes swapped; the publisher's next round not continued in its object.

`worker/sandboxBenchmark.vibe` (8 lines, the test stage's counter export from the benchmarks lane):
`sandbox/benchmark-coverage` drives `benchmarkFetch` over every path, method and an owner or none. Any other path is
the probe's own response, untouched and asking no identity; at `/api/probe/coverage` a caller without an owner gets 403
and any method but POST 405, both before any object is asked; a POST answers this Worker's, the owner's account's and
the owner's probe machine's counters, in that order, asking exactly those two objects. Mutants caught: the owner check
removed; the account and machine snapshots swapped.

`worker/accountsDecision.vibe` 110 and 153's arm: `decisions/account-tokens` holds `resumeToken` to
`/^[A-Za-z0-9-]{1,100}$/` on drawn texts from empty to 220 characters (a 60- and a 40-character token make exactly 101),
and `connectReturn` to its contract over every present or absent wiki page, operation, key and recovery. Mutants
caught: a 101-character limit; the hyphen dropped.

`worker/SandboxHttp.vibe` 23 (the signed-out gateway's stop) waited on a draw of POST, `stop`, a valid body, a true
length and the signed-out gateway together. `sandbox/http-surface` now checks the three signed-out writes with
well-formed bodies every execution, then the drawn request. Mutant caught: the signed-out stop answering unavailable.

`src/core/conversation.vibe` 275, `apply`'s guard for a `TourSought` step outside 1 to 11: the sequencer refuses such a
seek before writing it, so only a log from an older or foreign writer holds one. `conversation/tour-sought` builds a
touring conversation through the sequencer, applies a seek to a drawn step (-2 to 14, and 1.5 and 10.5) and holds the
walkthrough to the contract: unchanged for a step outside the range, `soughtWalkthrough` for one inside. Mutant
caught: the range ending at 12.

`worker/Reply.vibe` 355, a reply whose answer has no text: `reply/answers` drew the `empty` and `blank` answers, rare at
the full run's budget. Each execution now also answers once with `""` and once with spaces, and the reply must fail as
empty, never finishing blank. Mutant caught: an empty answer reported as failed.

`src/core/sandboxMeter.vibe` 40, a stored month bucket an older or broken writer left: `sandbox/meter-corrupt-bucket`
meters 1 to 120 ms past November's last 10 ms with 0 to 3 sandboxes running and December's bucket holding -1, 0.5, NaN,
0 or 7. A broken bucket fails as `meter-domain`, never a defect; a valid one gains each running sandbox's December
milliseconds. Mutant caught: a negative bucket accepted.

`worker/mainLogDecision.vibe` 175 and 197 and `MainLog.vibe` 58: `history/main-first-parent-graph` built only acyclic
graphs whose merge parents were listed. Two optional node fields (saved values still decode) add a first parent newer
than its child (`back`, a cycle a corrupt listing could hold) and a merge whose second parent is unlisted (`side`). The
oracle answers nothing when the first-parent line meets a commit twice, and nothing when a commit the tip reaches,
outside the cursor's ancestry, has a parent that is neither listed nor in that ancestry; an unlisted parent id reached
from the cursor counts as folded, as `ancestryShas` says. The first run refuted an oracle that left those ids out (the
product was right: the tip's unlisted side parent was also an older merge's). Mutants caught: the cycle answering an
empty list; the unlisted-parent check disabled.

`src/core/MockAccounts.vibe` 130, the live half of the account event stream: `accounts/live-events` has a follower
replay everything, then grants a new person a drawn role; the follower sees exactly the one grant, live, as a later
replay records it, and a grant of `new` (no change) publishes nothing. Mutant caught: the live half dropped. Line 102
(`signInAgent` with no maintainer) is unreachable: `grantPolicy` never demotes the last maintainer, and the fixture
starts with one.

`src/core/MockFactory.vibe` 470: `mock/factory-edges` now opens a project wiki page (`index`, which must open) and a
page the wiki doesn't have (refused as `empty`, never a defect) every execution. Mutant caught: the empty refusal
removed.

The proof lanes' newer regular-expression kernels, each held to the expression its doc names: `decisions/sandbox-
conversation` holds `sandboxConversation` (src/core/sandboxHostDecision.vibe) to `/^[a-zA-Z0-9._-]{1,120}$/` on
drawn ids from empty to 121 units and past; `decisions/wiki-links` holds `sectionAnchor` (wikiPageDecision.vibe) to
`/^[a-z0-9-]+$/`, and `foldedPrefix` (wikiLinkDecision.vibe) to its doc: no empty or `.` segment, a `..` only after
another, and exactly as many `..` and named segments as the parts leave. Mutants caught: a 121-unit limit; an empty
section accepted; a `..` climbing out of another `..`.

### Session 16: an unreadable usage journal and the suite's log level (vl-fuzz2, 2026-11-13)

`worker/VipDraft.vibe` 64-65, `WikiDraft.vibe` 66-67 and `SpecificationReviewers.vibe` 56-57: a writer whose meter
cannot read the run's usage. `vip/writer`, `wiki/writer` and `specification/reviewers` each run one more draft with
`unreadableJournal` (`test/support/durableWriters.vibe`), `@smthrs/journal`'s closed `Journal` with a working flush, so
the budget's recovery fails on its page read. The VIP and wiki drafts still return the agent's draft; the reviewer's
budget cannot recover the run, so it calls no model and answers `review`. Each is charged once and logs
`vibelang.budget.usage` with `outcome: unavailable`. Mutants caught, for each writer: the warning removed; the catch
turned into a defect.

Finding in the suite itself: `fuzz/run.vibe` set `References.MinimumLogLevel` to `"Warning"`, which is not an Effect
level (`"Warn"`), so no log at any level reached a logger under fuzzing, and no target could observe one. TypeScript
accepts it because `Effect.provideService` infers the service type from both arguments; a direct `LogLevel` annotation
rejects it. Fixed to `"Warn"`, with no console logger: `fuzz2-full13` printed every warning, 28,833 of them from
`vibelang.sandbox` alone, which doubled the log and added about 340 s. A target that observes logs provides its own
logger (`capturedLogs`), which replaces the empty one.

Session 15's three surviving mutants, each now caught:

- `worker/Wiki.vibe` 102's reason: already caught in the suite by `wiki-host`'s `connected` scenario ("a connected
  proposal with no storage answered forbidden"); it survived only `accounts/broker-sequences`, the one target it was
  run against.
- `worker/Accounts.vibe`'s `lost`, forgetting the connection, on the wiki route (443) and the issue route (425):
  `accounts/broker-sequences` walks one more world each execution, where person 7's Connect installs smithers.sh's
  real delegation (`fuzz/delegated.vibe`) and the site's delegate calls smithers.sh's real route. A new `revoke` step
  ends that delegation at smithers.sh; the site still holds its copy. The next proposal answers `connect` and the copy
  is gone (check 261); connected again with the same ended delegation, a new `file` step's issue answers `connect`
  and the copy is gone (check 272). Removing either `forget` is caught.
- `worker/ActionDirectory.vibe` 82, a Post whose reply id names a stored run: `start-conflicts` starts a reply id's
  run, removes its route key (as a run stored before route keys existed, which `root` already reads), and requires
  the Post to answer 409. Removing the run-request term answers 202.

`fuzz2-full13` (`playwright` box, job `3a88ed79e59d7e0687299966`, base `4ce616cb`, 2,196 s, exit 1 on thresholds
only): 104 fuzz files and 5 browser tests passed; 23 lines missed in scope. Chosen cases for 8 of them, each with its
mutant caught:

| Lines | Target | Case | Mutant |
| --- | --- | --- | --- |
| `MockFactory.vibe` 138 | `mock/scripted-actions` | a maintainer posts `run /history` behind a running tour and signs out before it ends: the reply says "Action unavailable." and requests nothing | the poster check removed |
| `MockFactory.vibe` 310-311 | `mock/factory-edges` | a journal with one number repeated and one skipped: the room keeps the applied events, counts 2 dropped, numbers its events from 1 without a gap, and answers the kept post | the count removed; the whole journal kept |
| `Reply.vibe` 384-385 | `reply/answers` | a start the conversation refuses, every execution (the target runs about 7 executions in 5 s, so the draw missed it) | the refusal composes |
| `Issues.vibe` 365 | `issues/journaled-writes` | a malformed recovery key, every execution, writing nothing | the key check removed |
| `LiveIssues.vibe` 14, `LiveWiki.vibe` 15 | `clients/issues-wiki-replies` | each of the four calls over a 200 that is not JSON and one that is not a state | `protocol` answered as `unavailable`, in each client |
| `ReplyAccounting.vibe` 100, 103 | `objects/reply-cleanup` (new) | a reply whose settlement transport is interrupted for 1 to 3 alarms, with 0 to 20 checkpointed tokens: the main drive settles, each interrupted alarm tries the charge once and keeps the hold and its receipt, the recovered cleanup settles in its own alarm, the next forgets the main intent, and exactly the checkpointed tokens are spent | the cleanup's early return removed (a second charge attempt in one alarm); the settled cleanup's return removed (the main intent forgotten in the same alarm) |
| `apiObjects.vibe` 153, 167 | `api-objects/history-publish` (new) | the History object with a drawn export setting and token, then its alarm or a page: publishing on stores the Publish intent with its first round due, and an alarm drives that round, which finds GitHub offline and schedules the next later; publishing off stores no intent | the start removed; the start made unconditional; the alarm made a no-op |

`fuzz2-full14` (job on base `bbe14456`) falsified `sandbox/host-recovery` after 615 executions at seed 20261107: a
contributor's pending command came back still pending. `b49d96d4` (main, 2026-11-13) made that the rule: the shared
host leaves a pending command to its fiber, and only the Worker's store settles one no fiber runs. The oracle still
expected the removed `settle-command` arm, so the suite, not the product, was wrong. The oracle now requires a pending
command to stay pending with no receipt, unless the meter finds the allowance spent and stops the sandbox (an
`exhaust/` receipt, as for a viewer's running sandbox). Mutant caught: the host completing a pending command.
`sandbox/host-races` (`fuzz/sandbox-races.node.fuzz.vibe`) failed `full14` on its first execution for the same
reason: a second writer whose read meets the running command no longer records it `command-uncertain`; the command's
fiber answers it. Mutant caught: the same.

The 30-minute campaign (`campaign16`, `node26` box, job `3f32518c9d5a6ae9379977dc`, seed `fuzz2-20261113`, 150 s per
target, the 23 targets of the 8 files this session changed, 1,856 s): 20 passed and 2 falsified, 4,211,415
executions over 22 receipts; `api-objects/world` wrote none. All three failures were in the suite, none in the
product:

- `mock/factory-edges` (5 executions): a seek to the walkthrough's last stop lets it finish on its own before the
  target ends it, and `endTour` is then refused `not-replying`, as it should be. The target accepts that refusal
  (check 16) and still requires the post behind the tour to be answered.
- `accounts/broker-sequences` (7 executions): the `reads` and `queued` steps hold rules for one state each (signed in
  and unconnected; connected), which only the walk guaranteed. Drawn in another state they refuted (checks 240, 250).
  Each now skips a state its rule does not describe.
- `api-objects/world`: no receipt; the test timed out. A target checks its budget only between executions, and one
  execution of this target takes about 12 s on nyc-01, more on a loaded box, past the 30 s of slack `fuzz.config.ts`
  gave. The slack is now 120 s. At the same seed on nyc-01 it passed, 13 executions in 157 s.

## Complete browser sources and settled history receipts

The browser fuzz reporter uses the e2e reporter's source measurement: every requested file is seeded from the
compiler, including tree-shaken exports in a file whose other exports the bundle runs. The build's structure and
Chromium hits join by source position. The final fuzz merge keeps the Node report's whole-source denominator even
when Node recorded no hits, so a partial browser or workerd report cannot remove uncovered code. Other suites keep
their existing merge policy.

The history-host oracle requires a present, `Complete` receipt after an admitted execution's alarm reports
`Settled`. A missing receipt is a finding as surely as a suspended one. The SDK also settles an intent refused
before admission; its cancellation tombstone has no execution row or receipt (`ExecutionObject.drive` in
`@smthrs/platform-cloudflare`). The oracle checks that separate case has no receipt, and findings name the actual
flow and admission choice. `test/historyReceiptOracle.test.vibe` checks the settlement/receipt
combinations and removes the observed receipt after a real history run settles as a negative control.
`test/browserCoverageMerge.test.vibe` runs the fuzz reporter over a real minified bundle with an unused export;
`test/fuzzCoverage.test.vibe` checks that partial and empty reports preserve the whole-source denominator.

Tracked and fixed in [#5340](https://github.com/smithersai/smithers/issues/5340).

## Required Factory services (vl-coverage, 2026-11-13)

`src/core/Factory.vibe` now requires `accounts`, `issues` and `wiki` (lead's approval on the platform board,
2026-11-13 07:55Z): both selectable factories always supplied them, so the browser's absent-service guards were dead
code (0016). The `bare` web backend (`fuzz/web-backends.vibe`) keeps the mock's services and drops only the tour
control. Scenarios that asserted only an absent service's answer went with their arms: `web/command-arms`'
`load-bare`, `act-bare`, `refresh-bare`, `people-bare`, `sign-out-bare`, `roles-bare`, `wiki-bare`, `details-bare` and
`grant-bare`; the bare halves of `sign-in-mock` and `issue-count` (the latter now checks the failing backend instead);
`web/command-bodies`' bare expectations; `surfaces/every-command`'s `bare` kind; and `signin-steered`'s
`mock-no-accounts`. The sections above record what each target fuzzed when it was written.

