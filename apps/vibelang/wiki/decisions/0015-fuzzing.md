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

`web/guided-commands`, `web/command-sequences` and `web/commands-from-any-model` run the Commands `update` returns against the real mock Factory and Actions, the same seen as live, a backend without optional services, and a backend that fails every call. Each Command's Message goes back through `update`. Random `Message` unions rarely reach a draft and then a submit: a `PostMessage` mutant survived 10 seconds of `web/command-sequences`, so `web/guided-commands` picks each gesture from what the screen offers and was confirmed to kill that mutant. Both of its findings were oracle errors, kept in the corpus: `IssueUi` carries a free string and `issuesUpdate` casts it, and the view only sends members of the union. The target sends the legal values.

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
| `surfaces/every-command` | `fuzz/surfaces-commands.node.fuzz.vibe` | all 20 commands, every execution, over the CLI's own mock backend, a mock without accounts, issues and wiki, and a backend that fails every call; a fresh mock that reads the stored session; a viewer after sign-out |
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

