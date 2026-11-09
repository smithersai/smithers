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

A plain Vitest run replays saved failures and executes 100 fresh inputs. `EFFECT_FUZZ=1` searches all registered tests; `EFFECT_FUZZ_DURATION`, `EFFECT_FUZZ_EXECUTIONS`, and `EFFECT_FUZZ_SEED` set a session's budgets and seed. A duration also raises the runner timeout by 30 seconds for shrinking and cleanup. App targets will use short per-run defaults and `FUZZ_BUDGET` for campaigns.

## Executed package coverage

The eight package suites pass: 92 tests, 677/677 lines, 457/457 branches, 156/156 functions and 783/783 statements. This includes the fork's race, replay, corpus, confirmation, exhausted-run and Fable regression tests, plus an empty-cause shrink regression for the copied helper, a browser-global realm and Bun boundary executions. The package has no coverage exclusions.

## App targets and campaign

Pending after the package lands: conversation and delivery sequences, wire codecs, reply reasons and progress, sequencer, budget, tour, mock Factory, view and update, CLI/MCP arguments, and requests against the real API Worker in workerd. Concurrency uses `FuzzSimulation` with deterministic Effect services. App fuzz coverage will be measured independently using vl-coverage's V8 configuration, with any unreachable line named and justified here. The final record includes per-file lines and branches and the 30-minute campaign's findings.

## Confirmed app findings

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
