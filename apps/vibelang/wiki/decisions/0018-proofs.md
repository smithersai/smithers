# 0018. Proofs of all app decisions

**Status:** in progress, 2026-11-07. **Rulings:** VL-9, VL-29. Lane `vl-proveall`.

The proof consumes production VibeLang modules in LemmaScript's plain TypeScript subset, with unchanged `//@`
contracts. Effect shells call those same decisions. The harness discovers every marked module under `src/`,
`worker/` and `scripts/`; omission of an emitted marked function fails. Mutations change executable text only,
strictly typecheck, and must fail a Dafny obligation in their named function. Tool errors never count as rejection.

## Proofs and boundaries

| Production module | What is proved | Boundary |
| --- | --- | --- |
| `src/history/mythical.vibe` | Numbered history events, identity/rank uniqueness, epic membership, preservation of epics, real-commit prefixes and every commit's notes (a prefix, at most one appended), exactly-one folds, and a trailer folding only into an approved or landed commit (`foldTarget`) (0020) | Sequencer locking, store-before-publish, the trailer regexp and the bootstrap's grouping are tested, not proved |
| `src/history/flowMachine.vibe` | Who may take each history action (the agent never approves or folds); each flow run is authorized once and records only after an allowed authorization, once but for a fold (0020) | Engine execution and journal replay, `Caller`'s source (0019) |
| `src/core/sandboxDecision.vibe` | Role admission, running count, elapsed usage, nonnegative remaining allowance, ledger uniqueness, sequence and clock high-water preservation, and lease bounds (0024) | Host normalization, external containers, durable scheduling and complete mutation coverage remain outside this batch |
| `src/core/mockDecision.vibe` | Keyword membership, first matching script and fallback only if none matches | Input is already normalized; Unicode casing and script constants are outside the proof |
| `src/core/protocolDecision.vibe` | Conversation/body length bounds; nonempty CLI/MCP identifiers and nonnegative cursors; exact method/subroute mapping; HTTP refusal/success; mock/live choice | Integer schema and URI/JSON/Schema decoding remain runtime boundaries; schema annotations are preserved |
| `src/web/screenDecision.vibe` | Escape priority, palette focus choice, minimizing eligibility, docs toggle, scroll revision/pausing/following, tour stream cursor, completion announcements and keyboard decisions | Dafny models numbers as integers. Fractional DOM coordinates, IEEE-754 arithmetic, native DOM effects and actual focus restoration are tested, not proved |
| `src/core/conversation.vibe` | Conversation sequence, entry identity and correlation, at most one answer per post, terminal replies/tours ignore later text, exact entry/state/role frames, admissible intent completeness, stable pending removal, unanswered order, replay bounds, reply/tour guards and pane ownership | Integer sequences below MAX_SAFE_INTEGER; dense readonly arrays; UTF-16 strings |
| `src/core/conversation.vibe` issue helpers (0022) | Exact numbered observations, operation-to-role policy, commitment/review field preservation and remaining actions after partial review; tree-walk termination and child-identity admission | Acyclicity is not yet a Dafny theorem; host cursor capacity and review-call preconditions remain to audit; GitHub execution is an Effect boundary |
| `worker/replyReasons.vibe` | Content policy → refused; credit and quota → credit; other model failures → unavailable. Agent precedence: unresolved seat, structured-output failure, model failure, generic failure | The observed tag and code are inputs; constant wording lookup and provider parsing are outside this decision |
| `worker/budgetDecision.vibe` | Strict admission, repeated charges add zero, exact nonnegative charge/total relation, and admission to the safe integer sum domain | Runtime guards now establish the integer domain; storage consistency, serialization and host rounding remain boundaries |
| `src/surfaces/commandDecision.vibe` | Own-post/reply correlation, exact event-number prefix/order, delta/restart/failure/finish accumulation, stream termination, outcome and error mapping | Effect stream execution, UUID generation, schema decoding and display formatting |
| `src/core/sequenceDecision.vibe` | First matching post prefix, every eligible source position exactly once in order, source role/text projection, exclusion of unfinished/failed/tour answers, and latest-turn window | The model call, storage and provider tokenization |
| `src/core/flowDecision.vibe` | Only accepted record dispatches; only matching attempt/offset appends; first undispatched source index; only the addressed terminal event ends a tour; repeated starts remain done; exact reading hold with a four-second floor and 200-word-per-minute rate | Durable engine journaling, scheduling, cancellation, storage and eventual completion are not proved |

A proof of these decisions does not prove Effect, Foldkit, HTTP, JSON, the compiler, Dafny/Z3, or Cloudflare.
Unproved logic remains explicitly visible below; a passing gate must never be reported as all functionality proved.

## Gate receipts, first module batch

Baseline: 33 Dafny obligations and 65/65 rejected mutations. This batch: 44 obligations across four production
modules and 84 executable mutations (19 new). The proof gate runs three harness regressions and four inventory
regressions; the inventory gate rejects a stale table. Both proof and mutation targets participate in ordinary CI.
Typechecking passes; 177 unit/integration tests and 13 local workerd tests pass (two opt-in live-model cases skipped).
After rebasing the mythical-history batch, the shared gate proves 63 obligations in five modules and the full suite
passes 203 tests. The original four proof sources and all 84 mutation inputs are unchanged from their green rerun.
The host report records receipts, exits and subsequent batch counts.

## Second module batch

The production gate proves 99 obligations across eight modules. The unchanged implementation of the conversation
machine carries stronger contracts; browser/protocol/mock shells call extracted policies. The unit suite remains
224/224 after the history-page and post/tour-ordering rebases. The browser suite passes 90 local cases after the history-page rebase (six live/deployment cases skipped). The full mutation gate rejects 163/163 executable mutations (79 new), all with unchanged contracts; the full run took 1,075.616 seconds with four workers on the shared host. After the next rebase, all 11 inherited history mutations also reject: 174/174 across the two invocations. Regenerating the full 174-case input set produces byte-identical copies and manifest entries for those receipts.

A mutation-generator defect counted identical text inside the next function's annotations as executable text.
The generator now excludes matches starting in contract lines and preserves multiline assertion anchors. Two
regressions join the harness; every mutation still preserves all contracts byte for byte. Large negative cases name
a specific production postcondition, selected within their function with fail-closed regression tests. Dafny checks
that postcondition in isolation; the positive gate still checks every obligation. Solver timeouts never count as
rejections. The harness now runs seven regressions. Positive batches have a 60-second solver budget; negative cases retain 30 seconds. No timeout counts as a proof or rejection.

## Third module batch: history and replay boundaries

The history machine now specifies every apply transition's full result and unchanged fields, exact first-match
lookups, the endOf helper's append rank, and refusal precedence. The accepted Plan decision's correspondence to
that append/insertion rank is still pending; its current contract establishes the bound, not that exact value. It proves `0 <= rank < seq` inductive through both decide and apply. The writer
uses a proved capacity guard before incrementing the cursor. Runtime schemas admit only safe integer sequences and
ranks, and ranks below their cursor; storage replay, follow rereads and bootstrap validate these boundaries. This
retains all existing mathematical contracts rather than weakening their domains to hide the JavaScript mismatch.

The client receiver additionally proves next-event advancement and gap closure, unchanged state/pending posts for
ahead-of-cursor events, and exact pending membership after acknowledging a post. At this batch, stable pending order/multiplicity and complete receiver fields were still unproved;
the fifth batch below adds explicit position witnesses and lifts every apply field relation to receive.
`annotation-lambda.ts` retains the exact ordered-filter specification and fails parsing; `method-spec.ts` retains
a verified loop-backed callee in a caller postcondition and fails Dafny expression resolution. Host reproductions
are `~/vl/vibelang-bugs/lemmascript-annotation-lambda/` and `~/vl/vibelang-bugs/lemmascript-method-spec/`.

`verify/bugs/unsafe-integer.ts` and `~/vl/vibelang-bugs/lemmascript-unsafe-integer/` reproduce the integer-model
boundary: native `2 ** 53 + 1` equals `2 ** 53`. The history regression suite fails before the boundary fixes and
passes afterward. After merging the current lanes, typechecking, 352 unit/integration tests, 19 local workerd tests (two opt-in skips), and 123 browser tests (six opt-in skips) pass. Exact mutation counts and exits are in the lane report.
The positive gate passes 117 obligations in eight modules. Isolating generated-source TypeScript projects
retains all inherited compiler options and produces byte-identical Dafny for all eight modules; all 117 obligations
pass in both configurations. Generation no longer reloads unrelated app/test files for each mutant. The current
proof modules are import-free; imported dependency and compiler-configuration drift are not yet covered by the
selected-source hash guard. After the history-flow rebase, the full gate passes 132 obligations in nine modules, including the incoming flow machine and reading-time policy. Mutation negatives now select 60 named production
postconditions, with whole-function checks retained where an earlier assertion is the first failure.
A source-argument regression also showed that extra CLI paths were silently ignored; the checker now validates
every requested path, detects late source edits/additions, and passes ten harness regressions. The inventory also distinguishes membership/numeric predicates from wiring,
and native DOM work from pure logic; a failing classification regression now passes with all five inventory tests. The capacity mutants expose the callee's safe-sequence preconditions; the
mutation gate now recognizes these actual Dafny contract failures, while rejecting successful checks, unrelated
functions, resolution errors and timeouts. A regression failed before this recognition was added.

After the sandbox rebase, the full production gate passes **161 obligations in ten modules** in 151.410 seconds.
The full 299-case mutation run passes; regenerating those inputs after rebase yields byte-identical sources and
manifest entries. The three added sandbox cases also fail their intended contracts: **302/302 rejected** across
these identical-input receipts. Typecheck, 411 unit tests, 22 local worker tests (four opt-in skips), and 132 browser tests (six opt-in skips) pass.
The inventory contains 1,303 functions, callbacks and effect blocks; unproved rows remain explicit.
The sandbox lane's exact integer division reproduction is retained at
`~/vl/vibelang-bugs/lemmascript-exact-integer-division/` (0024); integer rounding and host number normalization are
not silently included in the mathematical integer proof.

Additional tool probes distinguish supported operations from gaps. Guarded Map-count invariants, Set membership,
and comparator sort ordering all verify; these operations are not excuses for leaving selection logic unproved.
`date-day.ts` cannot lower `new Date`, and `nullish-contract.ts` reproduces unsupported `??` annotation syntax.
The latter has equivalent guarded specifications; no contract was weakened. Host fixtures are under
`~/vl/vibelang-bugs/lemmascript-date-day/` and `~/vl/vibelang-bugs/lemmascript-nullish-contract/`.

The rebase also exposed `record-literal-union.ts`: a literal union value inside a returned record
emits a string where Dafny requires the union datatype. The gate rejects this tool failure. Giving the same
wrong-reason mutation a typed local lets it reach the unchanged reason-preservation contract, which rejects it.
`sort-membership.ts` retains length, ordering and both exact membership clauses; the latter fail despite the
backend's permutation axiom. `record-identity.ts` demonstrates the backend's documented structural/reference
identity difference. Their host reproductions are under `~/vl/vibelang-bugs/lemmascript-<fixture-name>/`.
None of these failures is counted as a mutation rejection or a successful proof.

The remaining applicability work after the fifth batch includes the live storage dispatcher order, replay of a
maximum-capacity history snapshot with stale events, safe UI epoch/scroll-intent exhaustion and fractional DOM
coordinates. Conversation frames, pending order, mock FIFO selection, retained-log replay bounds and stored
conversation decoding are covered by that batch as scoped below. History-flow phase proofs do not establish
journal replay idempotency, main-commit traversal order or arbitrary execution interleavings.

## Fourth module batch: commands, context and accounting

The CLI and MCP now call the same proved reply accumulator and error mapper. The live sequencer's model context
uses the proved source-index selection, including the existing exclusion of tour narration; Reply uses the proved
latest-turn window. The index witnesses establish order and multiplicity, including repeated text values.

Budget admission and charging reject corrupt totals and unsafe new sums before writing. A repeated reply ignores
oversized telemetry and preserves the ledger; the final safe integer charge remains admissible. Three regressions
fail before the guards and pass afterward. The existing normalization of nonfinite and negative telemetry remains.

The full gate passes **182 obligations in twelve production modules** (100.802 seconds). All **346 executable
mutations** reject: 44 new cases, four regenerated budget cases, and 298 unchanged inherited inputs. Every current
source and manifest entry is byte-identical to its actual Dafny failure receipt. Typecheck and **416 unit tests**
pass, including shared CLI/MCP and model-history regressions. Local workerd passes 22 tests (four opt-in skips).
The inventory contains 1,317 executable items.

## Fifth module batch: exact conversation and ordered pending posts

`apply` specifies every existing entry field and every appended Posted, ReplyStarted and TourStarted field, plus
exact pane, agent and reply-owner transitions. `receive` carries those same field relations, its exact cursor/gap
behavior, and the new role ledger's exact head, length and preserved older-grant order. Incoming role-grant and
action-authorization policies from 0019 remain in the same machine and proof.

Pending acknowledgement uses an indexed loop with a recursive count of kept source positions. The proof relates
every surviving original position to its exact output position, preserving order and duplicate multiplicity, and
proves the exact output length. `pendingCount` is specification-only; its generated empty companion lemma receives
one explicit recursive proof step, checked afresh by Dafny. All generated contracts and executable bodies remain
unchanged, no axiom or assumption is added, and the harness rejects an unexpected signature or nonempty body.

Unanswered posts are selected by exact eligible source indexes in increasing order; their projection preserves
every selected ID in source order and multiplicity. The mock dispatcher selects the first ID absent from its dispatched set. The live storage
registry remains an Effect boundary; no proof of its interleavings or durable journal is claimed. Replay from
cursor zero proves `0 <= seq <= events.length`, with exact equality for contiguous event numbers. Its bound is
within the native array-length domain, below the safe integer limit. The worker now validates every stored
conversation event before replay, failing with a redacted error before any write or dispatch.

The pre-role-rebase positive receipt proves all twelve modules: 4,386 isolated conversation assertion batches and
150 ordinary obligations in the other eleven modules. Splitting changes the unit of counting, so these are not
summed or compared numerically with earlier unsplit conversation counts. The positive gate checks every assertion;
selected negative cases check the earliest relevant production postcondition or switch-case assertion. The harness
also rejects union-destructor errors mixed with ordinary contract failures; a failing-first regression covers it.
The merged role-policy gate passes all twelve modules: **5,420 isolated conversation assertion batches plus
150 ordinary obligations** in 393.293 seconds. After the issue-helper rebase and two derived receiver-frame
guarantees, the full positive gate passes **5,588 isolated conversation batches plus 150 ordinary obligations** in
235.479 seconds. All inherited contracts remain; issue acyclicity is explicitly still outside the proof.
All **435 current executable mutations** reject: 171 freshly checked conversation mutations, including the incoming
issue cases, and 264 byte-identical inherited sources/manifest entries matched to genuine Dafny failures. A previous
full 424-case run had seven receiver timeouts; a targeted follow-up also exposed one incorrectly selected assertion.
Those failed runs are retained as failures. The corrected targets select the first affected clause or assertion;
all original contracts remain in the positive check. The harness passes fourteen regressions; the installer adds
four download/cache regressions. The inventory contains **1,380 executable items** and remains checked by five
inventory regressions.

After the final rebase, all twelve positive source hashes and all 435 mutation inputs still match their proof
receipts. Typechecking and **453 unit/integration tests** pass after the final malformed-input rebase.
The full media-base browser suite passes **168 tests** (nine opt-in skips); all **45 affected history, recovery and
startup browser cases** pass after that later rebase. Local workerd also passes **23 tests** (four opt-in skips)
on that final malformed-input base. No dependency
was added by this batch. The CI mutation target allows 120 minutes for the complete growing suite with its
conservative two-worker default; every per-obligation limit and failure rule is unchanged.

`verify/bugs/readonly-set.ts` and `~/vl/vibelang-bugs/lemmascript-readonly-set/` reproduce unsupported ReadonlySet
lowering; the supported Set membership proof checks the same selection property. `conditional-method.ts` and
`~/vl/vibelang-bugs/lemmascript-conditional-method/` reproduce a loop-backed call hoisted before its ternary union
guard. The production receiver uses the equivalent guarded statement, preserving behavior and every contract.
Neither reproduction is counted as a rejected mutation.

## Product defects

- **Conversation storage bypassed its numeric and event-shape proof domain.** A faulty Log could supply negative,
  fractional or unsafe cursors, malformed text or unknown variants before replay. EventSchema decoding now rejects
  these rows with no write/dispatch and no stored content in diagnostics. The regression failed before the fix.


- **Unsafe history ranks broke distinct insertion positions.** Plain numeric schemas admitted negative, fractional,
  nonfinite and unsafe integer ranks. Safe integer plus `rank < seq` validation now protects every replay/bootstrap
  boundary, and the proved writer refuses capacity exhaustion. The final safe event is stored once; the next intent
  is refused without writes. Four regression tests failed before the fix; all six boundary tests now pass.
- **Cached history follow bypassed validation; snapshot errors exposed stored content.** A later store read could
  stream an invalid event, and HistoryObject's early JSON decode could reveal stored text in diagnostics. Follow
  validates each reread; stored JSON uses a redacted decoder. Both new regressions failed before the fixes.

- **Unsafe usage and corrupt totals bypassed accounting's proof domain.** Overflow could replace a valid daily sum
  with an inexact value; a negative total could be charged or admitted. Admission and spend now check persisted
  safe integers and a proved sum guard. Overflow and invalid totals fail without writes; exact maximum charging and
  repeated oversized telemetry are covered by regressions.

- **Non-finite usage poisoned the daily ledger.** A provider's NaN or Infinity made the total unusable. The regression
  `budgetProof.test.vibe` failed first with NaN instead of 13. Non-finite usage now adds zero; finite negative usage
  still clamps to zero and finite usage retains its rounding. Existing spends, the storage lock, logging and metrics remain.

- **The proof harness could check zero sources.** A prospective source nested under `.checks` was ignored by the
  directory scanner, so it said “0 files checked” and exited zero. `verify/harness_test.py` reproduces that failure
  first. The harness now supplies every staged source explicitly, rejects an empty selection, and runs its regression
  tests before every proof invocation. Production and mutation receipts preceding this fix checked 4 and 84 sources;
  the prospective receipts with zero checked sources are superseded, not counted as validation.

- **Lifecycle tests assumed Web Crypto had finished after 200 yields.** The baseline flow reproduced the failure.
  The concurrency and disposal tests now await real ReplyFinished/ReplyDelta events and retain their assertions,
  including live follower and worker shutdown. The repaired lifecycle suite passes 9/9 and the full suite 177/177.
- **Discovery and inventory could omit source.** Whitespace-aware marker discovery now has a regression. The
  inventory used UTF-16 positions against byte-based projection mappings; it now reads original-source ESTree,
  includes methods/effect blocks, rejects parse failures, and passes four source-enumeration regressions.

- **The startup browser check assumed health always beat its deadline.** The faulty transport now observes
  cancellation. Review rejected accepting either timeout or settlement, which could hide blocked keyboard handling.
  The browser host injects a Clock that holds the health deadline, while forwarding real time reads and other sleeps;
  startup passes its Clock service to the backend resource layer. Keyboard/post assertions deliberately run beyond
  the ordinary deadline and require health to remain uncancelled, then settle on release. The regression failed first;
  all 12 startup browser cases pass. Independent backend TestClock cases still require the exact three-second timeout.
  The 6,737-commit bootstrap integration exceeded the default five-second unit budget under shared host load; its
  integration budget is 20 seconds, with all replay equality, uniqueness and count assertions unchanged.

- **The announcement browser test could miss all partial renders.** Under shared host load, rendering coalesced the
  real deltas and terminal event before the browser observed a nonempty unfinished answer. The transport fault now
  holds each real ReplyFinished until the test observes the nonempty streaming text and unchanged announcement,
  then releases it. It preserves all event contents, order, accessibility checks and complete-answer assertions.

- **The sandbox alarm test assumed a fixed number of scheduler yields completed native asynchronous work.**
  The inherited test failed with no later meter event after startup. Its logger now signals an observer installed
  only after startup completes; the test awaits a real later alarm event and retains the idle/count-increase/stopped
  assertions. Review caught that an earlier observer could be satisfied by startup's own meter log; that preliminary
  receipt is superseded. The corrected focused test passes.

## Tool gaps

- `~/vl/vibelang-bugs/lemmascript-inline-record-parameter/`: LemmaScript 0.6.6 emits an invalid Dafny type name for an
  inline record parameter. The isolated reproduction and failing receipt are retained. The failure decision is now a
  code classifier; Reply retains the static product-wording lookup.
- LemmaScript 0.6.6 omits object-valued module constants (`REASONS`), producing unresolved identifiers. The failing reproduction is `verify/bugs/object-constant.ts` and
  `~/vl/vibelang-bugs/lemmascript-object-constant/`. No proof of the object lookup is claimed.
- Existing backend reproductions remain in `verify/bugs/` (0005). No contract is weakened to pass them.

- `~/vl/vibelang-bugs/lemmascript-string-slice-clamp/`: `post.slice(1)` is incorrectly lowered to a
  potentially out-of-bounds Dafny slice. Its total contract is preserved in the reproduction. `replyIdOf` remains
  unproved; no nonempty-string precondition was added to make it pass.

The new gap probes all strictly typecheck and fail as tool errors (0/9 files proved including the four existing
fixtures), retained in `~/vl/vl-proveall.gaps.log`:

| Reproduction in `verify/bugs/` | Failure | Unproved app boundary |
| --- | --- | --- |
| `finite-round.ts` | Unsupported `Number.isFinite`; `Math.round` has no lowering | Provider usage normalization and IEEE-754 inputs |
| `json-codec.ts` | Unsupported `JSON.stringify` | Schema/JSON encode-decode round trips and SSE payloads |
| `uri-codec.ts` | Unresolved `encodeURIComponent` and `decodeURIComponent` | URI encoding, malformed escape handling and lone surrogates |
| `regexp.ts` | Unsupported regular expression | Docs URL allowlist and Markdown fence/inline parsing |
| `object-constant.ts` | Unresolved object constant | Static reason wording lookup |

Two additional probes strictly typecheck but do not verify:

- `unicode-case.ts` / `~/vl/vibelang-bugs/lemmascript-unicode-case/`: JavaScript maps `K` to `k`, while
  Dafny's emitted StringToLower only maps ASCII A–Z. The correct contract fails. Unicode normalization in keyboard
  shortcuts and mock selection remains a runtime boundary; normalized-input policies can still be proved.
- `event-key.ts` / `~/vl/vibelang-bugs/lemmascript-event-key/`: production `String(seq).padStart(16, "0")`
  fails emission. The fixed-width key contract is retained; storage-key lexical ordering is not proved.

- `filter-method.ts` / `~/vl/vibelang-bugs/lemmascript-filter-method/`: a single-expression Array.filter callback
  calling a verified loop-backed predicate fails as an unsupported multi-statement Dafny lambda. The unanswered-post
  selector's complete production contract is retained in its prospective proof; no selection proof is yet claimed.

- `empty-string-union.ts` / `~/vl/vibelang-bugs/lemmascript-empty-string-union/`: an empty-string alternative in a
  string-literal union becomes an empty Dafny constructor (`Route.`), which the backend cannot parse. The typed route
  reproduction retains both exact outcomes; no production contract is suppressed.

Each new fixture also lives at `~/vl/vibelang-bugs/lemmascript-<name>/` with its command. These are not mutation
successes. Compiler/runtime execution of Effect, Schema and Foldkit remains outside LemmaScript's plain subset.

## Inventory

The compiler's original-source ESTree identifies executable functions, methods, effect blocks and nested callbacks
without counting generated wrappers or code examples inside strings. `node verify/inventory.cjs --write` refreshes this table; without `--write` it rejects drift. Pure
functions with unsupported library operations remain unproved until a documented reproduction or upstream fix exists.

Tourfix (0014) adds the exact reading-hold policy and its three executable mutations. The combined positive gate
passes 101 obligations across eight modules; all three new mutations fail their production contracts. Word
tokenization, rendering and durable execution retain the boundaries stated above.

<!-- inventory:start -->
1580 executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.

| File and line | Function | Class | Proof or reason |
| --- | --- | --- | --- |
| `src/core/conversation.vibe:144` | `apply` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:189` | `apply/callback@189` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:196` | `apply/callback@196` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:204` | `apply/callback@204` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:213` | `apply/callback@213` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:230` | `apply/callback@230` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:246` | `tourEntry` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:255` | `isTouring` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:265` | `isTour` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:282` | `isReplying` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:291` | `hasClientId` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:309` | `hasEntryId` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:327` | `canReplyTo` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:374` | `accepted` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:380` | `refused` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:416` | `decide` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:497` | `post` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:521` | `failPost` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:524` | `failPost/callback@524` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:537` | `retryPost` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:538` | `retryPost/callback@538` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:588` | `receive` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:606` | `resume` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:627` | `rank` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:643` | `leastRole` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:655` | `may` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:665` | `roleOf` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:681` | `ungranted` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:695` | `otherMaintainer` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:713` | `canGrant` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:720` | `grantPolicy` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:762` | `applyIssues` | pure logic | Exact next-numbered observation replacement and stale/future no-op; requires a safe sequence below capacity. The host cursor domain remains to audit (0022). |
| `src/core/conversation.vibe:775` | `issuePermission` | pure logic | Exact least-role permission for each issue operation, through the shared role policy (0022). |
| `src/core/conversation.vibe:787` | `issuePolicyAction` | pure logic | Exact mapping of each issue operation to the shared authorization action (0022). |
| `src/core/conversation.vibe:800` | `canLinkIssues` | pure logic | Termination, positive distinct identities and existence of the child only; acyclicity and parent-path completeness remain unproved (0022). |
| `src/core/conversation.vibe:801` | `canLinkIssues/callback@801` | pure logic | Termination, positive distinct identities and existence of the child only; acyclicity and parent-path completeness remain unproved (0022). |
| `src/core/conversation.vibe:808` | `canLinkIssues/callback@808` | pure logic | Termination, positive distinct identities and existence of the child only; acyclicity and parent-path completeness remain unproved (0022). |
| `src/core/conversation.vibe:824` | `setCommitment` | pure logic | Exact commit/uncommit assignment and task state; all issue identity, tree, content and review fields preserved. Commit requires nonempty assignee (0022). |
| `src/core/conversation.vibe:835` | `setVipReview` | pure logic | Exact accepted/declined review and closed-on-decline state, with every other field preserved; requires an in-review input (0022). |
| `src/core/conversation.vibe:844` | `reviewActions` | pure logic | Exact admissibility and remaining label/close actions after a partial review; GitHub action execution is outside this decision (0022). |
| `src/core/conversation.vibe:857` | `unansweredIndexes` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:882` | `unansweredSelection` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:884` | `unansweredSelection/callback@884` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:893` | `replayLog` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:914` | `pendingCount` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/conversation.vibe:924` | `acknowledgedPending` | pure logic | Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain. |
| `src/core/flowDecision.vibe:6` | `dispatches` | pure logic | Dispatch admission, append ordering, tour terminal events, reading-time policy and first undispatched source index; proved. |
| `src/core/flowDecision.vibe:13` | `appends` | pure logic | Dispatch admission, append ordering, tour terminal events, reading-time policy and first undispatched source index; proved. |
| `src/core/flowDecision.vibe:20` | `endsTourEvent` | pure logic | Dispatch admission, append ordering, tour terminal events, reading-time policy and first undispatched source index; proved. |
| `src/core/flowDecision.vibe:29` | `startAnswer` | pure logic | Dispatch admission, append ordering, tour terminal events, reading-time policy and first undispatched source index; proved. |
| `src/core/flowDecision.vibe:39` | `readingHold` | pure logic | Dispatch admission, append ordering, tour terminal events, reading-time policy and first undispatched source index; proved. |
| `src/core/flowDecision.vibe:49` | `firstUndispatched` | pure logic | Dispatch admission, append ordering, tour terminal events, reading-time policy and first undispatched source index; proved. |
| `src/core/flows.vibe:34` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:42` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:46` | `replyIdOf` | pure logic | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:51` | `unanswered` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:70` | `posted` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:86` | `callback@86` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:88` | `callback@86/callback@88` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:97` | `docsPage` | pure logic | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:124` | `endsTour` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:129` | `touring` | pure logic | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:138` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:146` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:154` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:164` | `counted` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:170` | `startTour` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:179` | `endTour` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:182` | `endTour/callback@182` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:188` | `openDocs` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:197` | `say` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:206` | `readingMillis` | pure logic | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:212` | `narrate` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:215` | `narrate/callback@215` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:224` | `walk` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:237` | `toured` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:246` | `callback@246` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:248` | `callback@246/callback@248` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:249` | `callback@246/callback@249` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:269` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:274` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:279` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:284` | `body` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:286` | `callback@286` | effectful shell | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:289` | `callback@286/callback@289` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:290` | `callback@286/callback@290` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:291` | `callback@286/callback@291` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:292` | `callback@286/callback@292` | wiring | Dispatch, terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/issueFlows.vibe:14` | `callback@14` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/issueFlows.vibe:19` | `callback@14/idempotencyKey` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/issueFlows.vibe:25` | `callback@14/callback@25` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/issueFlows.vibe:29` | `callback@29` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/issueFlows.vibe:30` | `callback@30` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/issueFlows.vibe:32` | `callback@30/callback@32` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/issueFlows.vibe:33` | `callback@30/callback@32/callback@33` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/issueFlows.vibe:33` | `callback@30/callback@32/callback@33/callback@33` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/issueFlows.vibe:45` | `authorizeIssue` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/issueFlows.vibe:45` | `authorizeIssue/callback@45` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/issueFlows.vibe:54` | `issueExecutionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/issueFlows.vibe:60` | `issueRecoveryId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/issueSchemas.vibe:25` | `vipDocument` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:9` | `item` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:35` | `personOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:41` | `fixtureHost` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:44` | `fixtureHost/perform` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/IssuesFactory.vibe:44` | `fixtureHost/perform/callback@44` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:52` | `fixtureHost/perform/callback@44/callback@52` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:71` | `fixtureHost/perform/callback@44/callback@71` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:73` | `fixtureHost/perform/callback@44/callback@71/event` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/IssuesFactory.vibe:66` | `fixtureHost/perform/callback@44/callback@66` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/IssuesFactory.vibe:93` | `makeIssueFactory` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:98` | `makeIssueFactory/act` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:100` | `makeIssueFactory/act/callback@100` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:105` | `makeIssueFactory/act/callback@105` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/IssuesFactory.vibe:112` | `makeIssueFactory/read` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:6` | `make` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:11` | `make/failed` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveAccounts.vibe:12` | `make/get` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:18` | `make/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:27` | `make/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:28` | `make/members` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveAccounts.vibe:29` | `make/grant` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveAccounts.vibe:30` | `make/signOut` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:31` | `make/choose` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:32` | `make/participated` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveAccounts.vibe:33` | `make/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveAccounts.vibe:33` | `make/events/callback@33` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveAccounts.vibe:38` | `make/events/callback@33/callback@38` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:19` | `unavailable` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:20` | `unavailable/callback@20` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:24` | `pathOf` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:31` | `sandboxPathOf` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:36` | `health` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:45` | `refusable` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:55` | `LiveFactory` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:56` | `LiveFactory/callback@56` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:62` | `LiveFactory/callback@56/post` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:69` | `LiveFactory/callback@56/tour` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:74` | `LiveFactory/callback@56/endTour` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:79` | `LiveFactory/callback@56/sandbox` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:84` | `LiveFactory/callback@56/startSandbox` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:91` | `LiveFactory/callback@56/stopSandbox` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:98` | `LiveFactory/callback@56/sandboxCommand` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:107` | `LiveFactory/callback@56/read` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:114` | `LiveFactory/callback@56/events` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:115` | `LiveFactory/callback@56/events/callback@115` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:123` | `LiveFactory/callback@56/events/callback@115/callback@123` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:131` | `sandboxRefusal` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/MockAccounts.vibe:14` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockAccounts.vibe:26` | `make` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:37` | `make/callback@37` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:39` | `make/callback@37/callback@39` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockAccounts.vibe:39` | `make/callback@37/callback@39/callback@39` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:40` | `make/callback@37/callback@39/callback@39/callback@40` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:48` | `make/callback@37/callback@39/callback@39/callback@40/callback@48` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockAccounts.vibe:55` | `make/callback@55` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:59` | `make/change` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:60` | `make/change/callback@60` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:64` | `make/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:67` | `make/current/callback@67` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:72` | `make/authorize` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:78` | `make/role` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:78` | `make/role/callback@78` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockAccounts.vibe:80` | `make/members` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:83` | `make/members/callback@83` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockAccounts.vibe:85` | `make/grant` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:92` | `make/signOut` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:93` | `make/choose` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:96` | `make/choose/callback@96` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:99` | `make/choose/callback@99` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:100` | `make/choose/callback@100` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:101` | `make/choose/callback@101` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:106` | `make/participated` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:110` | `make/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockAccounts.vibe:110` | `make/events/callback@110` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:112` | `make/events/callback@110/callback@112` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockAccounts.vibe:114` | `make/events/callback@110/callback@114` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/mockDecision.vibe:7` | `matches` | pure logic | Exact keyword membership, first-match priority and fallback; proved for normalized prompts. |
| `src/core/mockDecision.vibe:25` | `scriptIndex` | pure logic | Exact keyword membership, first-match priority and fallback; proved for normalized prompts. |
| `src/core/MockFactory.vibe:58` | `scripted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:73` | `scripted/callback@73` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:88` | `scripted/callback@88` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:97` | `scripted/callback@97` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:98` | `scripted/callback@97/callback@98` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:90` | `scripted/callback@90` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:93` | `scripted/callback@93` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:112` | `cryptoOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:119` | `mockFactoryFor` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:120` | `mockFactoryFor/callback@120` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:130` | `mockFactoryFor/callback@120/sandboxForOwner` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:130` | `mockFactoryFor/callback@120/sandboxForOwner/callback@130` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:133` | `mockFactoryFor/callback@120/sandboxForOwner/callback@130/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:139` | `mockFactoryFor/callback@120/callback@139` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:140` | `mockFactoryFor/callback@120/callback@139/callback@140` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:144` | `mockFactoryFor/callback@120/sandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:145` | `mockFactoryFor/callback@120/startSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:146` | `mockFactoryFor/callback@120/stopSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:147` | `mockFactoryFor/callback@120/sandboxCommand` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:152` | `mockFactoryFor/callback@120/callback@152` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:153` | `mockFactoryFor/callback@120/callback@152/callback@153` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:161` | `mockFactoryFor/callback@120/nextId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:162` | `mockFactoryFor/callback@120/nextId/callback@162` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:167` | `mockFactoryFor/callback@120/recorder` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:168` | `mockFactoryFor/callback@120/recorder/callback@168` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:168` | `mockFactoryFor/callback@120/recorder/callback@168/callback@168` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:169` | `mockFactoryFor/callback@120/recorder/callback@168/callback@168/callback@169` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:183` | `mockFactoryFor/callback@120/answer` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:205` | `mockFactoryFor/callback@120/openRoom` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:206` | `mockFactoryFor/callback@120/openRoom/callback@206` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:218` | `mockFactoryFor/callback@120/openRoom/callback@206/record` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:224` | `mockFactoryFor/callback@120/openRoom/callback@206/dispatch` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:229` | `mockFactoryFor/callback@120/openRoom/callback@206/accepted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:229` | `mockFactoryFor/callback@120/openRoom/callback@206/accepted/callback@229` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:231` | `mockFactoryFor/callback@120/openRoom/callback@206/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:235` | `mockFactoryFor/callback@120/openRoom/callback@206/dispatch` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:236` | `mockFactoryFor/callback@120/openRoom/callback@206/end` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:240` | `mockFactoryFor/callback@120/openRoom/callback@206/wake` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:244` | `mockFactoryFor/callback@120/openRoom/callback@206/running` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:244` | `mockFactoryFor/callback@120/openRoom/callback@206/running/callback@244` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:245` | `mockFactoryFor/callback@120/openRoom/callback@206/open` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:246` | `mockFactoryFor/callback@120/openRoom/callback@206/say` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:247` | `mockFactoryFor/callback@120/openRoom/callback@206/say/callback@247` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:250` | `mockFactoryFor/callback@120/openRoom/callback@206/finish` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:253` | `mockFactoryFor/callback@120/openRoom/callback@206/ended` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:253` | `mockFactoryFor/callback@120/openRoom/callback@206/ended/callback@253` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:257` | `mockFactoryFor/callback@120/openRoom/callback@206/ended/callback@253/callback@257` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:264` | `mockFactoryFor/callback@120/openRoom/callback@206/callback@264` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:266` | `mockFactoryFor/callback@120/openRoom/callback@206/callback@264/callback@266` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:267` | `mockFactoryFor/callback@120/openRoom/callback@206/callback@264/callback@266/startSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:269` | `mockFactoryFor/callback@120/openRoom/callback@206/callback@264/callback@269` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:269` | `mockFactoryFor/callback@120/openRoom/callback@206/callback@264/callback@269/callback@269` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:290` | `mockFactoryFor/callback@120/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:293` | `mockFactoryFor/callback@120/post/callback@293` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:298` | `mockFactoryFor/callback@120/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:300` | `mockFactoryFor/callback@120/tour/callback@300` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:304` | `mockFactoryFor/callback@120/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:306` | `mockFactoryFor/callback@120/endTour/callback@306` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:311` | `mockFactoryFor/callback@120/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:316` | `mockFactoryFor/callback@120/read/callback@316` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:316` | `mockFactoryFor/callback@120/read/callback@316` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:317` | `mockFactoryFor/callback@120/read/callback@317` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:319` | `mockFactoryFor/callback@120/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:320` | `mockFactoryFor/callback@120/events/callback@320` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:325` | `mockFactoryFor/callback@120/events/callback@320/callback@325` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:330` | `mockFactoryFor/callback@120/events/callback@320/callback@330` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:331` | `mockFactoryFor/callback@120/events/callback@320/callback@331` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/mockReplies.vibe:122` | `callback@122` | wiring | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:158` | `historyReply` | pure logic | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:159` | `historyReply/callback@159` | wiring | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:162` | `historyReply/callback@162` | wiring | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:168` | `mockReply` | pure logic | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:176` | `chunks` | pure logic | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/protocolDecision.vibe:6` | `validConversationLength` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:13` | `commandConversation` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:20` | `nonnegativeCursor` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:32` | `routeKind` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:44` | `validBodyLength` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:53` | `responseKind` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:61` | `liveHealth` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/protocolDecision.vibe:68` | `prefersMock` | pure logic | Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved. |
| `src/core/sandboxDecision.vibe:26` | `mayStart` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:36` | `runningCountPrefix` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:45` | `runningCount` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:63` | `intervalUsageMilliseconds` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:73` | `accumulateUsageMilliseconds` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:84` | `remainingMilliseconds` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:94` | `elapsedMilliseconds` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:102` | `distinctFrom` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:114` | `validSandboxes` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:171` | `emptySandboxLedger` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:180` | `replaceSandbox` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:206` | `sandboxIndex` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:235` | `decideSandbox` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:271` | `applySandbox` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxDecision.vibe:283` | `leaseMilliseconds` | pure logic | Sandbox integer kernel: running counts, exact interval usage and accumulation, remaining allowance, monotone clocks, identity/ownership and transition frames (0024). Date/IEEE-754 normalization, durable shell behavior and complete guard mutation coverage remain outside these clauses. |
| `src/core/sandboxHost.vibe:19` | `generationOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:23` | `outputOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:42` | `observed` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:44` | `observed/callback@44` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:45` | `observed/callback@45` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:46` | `observed/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:46` | `observed/callback@46/callback@46` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:54` | `makeSandboxHost` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:58` | `makeSandboxHost/locked` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:60` | `makeSandboxHost/load` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:63` | `makeSandboxHost/load/callback@63` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:72` | `makeSandboxHost/view` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:75` | `makeSandboxHost/arm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:80` | `makeSandboxHost/transition` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:86` | `makeSandboxHost/complete` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:130` | `makeSandboxHost/metered` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:158` | `makeSandboxHost/emergency` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:171` | `makeSandboxHost/sampled` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:172` | `makeSandboxHost/sampled/callback@172` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:177` | `makeSandboxHost/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:198` | `makeSandboxHost/admit` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:225` | `makeSandboxHost/run` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:233` | `makeSandboxHost/command` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:235` | `makeSandboxHost/command/callback@235` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:241` | `makeSandboxHost/command/callback@241` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:243` | `makeSandboxHost/command/callback@241/callback@243` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:262` | `makeSandboxHost/command/callback@262` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:265` | `makeSandboxHost/snapshot` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:265` | `makeSandboxHost/snapshot/callback@265` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:266` | `makeSandboxHost/start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:266` | `makeSandboxHost/start/callback@266` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:267` | `makeSandboxHost/stop` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:267` | `makeSandboxHost/stop/callback@267` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxHost.vibe:269` | `makeSandboxHost/tick` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxHost.vibe:269` | `makeSandboxHost/tick/callback@269` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMeter.vibe:8` | `millisecondOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMeter.vibe:14` | `monthOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxMeter.vibe:18` | `nextMonth` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMeter.vibe:24` | `meter` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMeter.vibe:50` | `snapshotOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMeter.vibe:51` | `snapshotOf/callback@51` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:13` | `makeMockSandboxes` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:15` | `makeMockSandboxes/execution` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:21` | `makeMockSandboxes/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:21` | `makeMockSandboxes/receipt` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxMock.vibe:21` | `makeMockSandboxes/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:21` | `makeMockSandboxes/write/callback@21` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:21` | `makeMockSandboxes/alarm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:32` | `makeMockSandboxes/callback@32` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:40` | `makeMockSandboxes/sandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:41` | `makeMockSandboxes/sandbox/callback@41` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:44` | `makeMockSandboxes/startSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:44` | `makeMockSandboxes/startSandbox/callback@44` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:45` | `makeMockSandboxes/stopSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:45` | `makeMockSandboxes/stopSandbox/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:46` | `makeMockSandboxes/sandboxCommand` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:46` | `makeMockSandboxes/sandboxCommand/callback@46` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:52` | `memoryMachines` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxMock.vibe:57` | `memoryMachines/start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxMock.vibe:57` | `memoryMachines/start/callback@57` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:58` | `memoryMachines/lease` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:59` | `memoryMachines/stop` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxMock.vibe:59` | `memoryMachines/stop/callback@59` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxMock.vibe:60` | `memoryMachines/command` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/sandboxPolicy.vibe:9` | `current` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxPolicy.vibe:10` | `mockPolicy` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sandboxPolicy.vibe:11` | `mockPolicy/current` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/sequenceDecision.vibe:7` | `promptEligible` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:15` | `firstEntryIndex` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:33` | `eligibleIndexes` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:52` | `prefixEnd` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:59` | `windowStart` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:74` | `selectModelTurns` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:78` | `selectModelTurns/callback@78` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/sequenceDecision.vibe:86` | `promptWindow` | pure logic | Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary. |
| `src/core/wire.vibe:47` | `conversationPath` | pure logic | Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts). |
| `src/core/wire.vibe:65` | `routeOf` | pure logic | Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts). |
| `src/core/wire.vibe:75` | `decodeSegment` | wiring | Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts). |
| `src/history/flowMachine.vibe:31` | `standing` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:48` | `leastRole` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:63` | `peopleOnly` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:72` | `may` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:92` | `begin` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:106` | `authorize` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:118` | `canRecord` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:128` | `record` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flowMachine.vibe:143` | `lawful` | pure logic | Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020). |
| `src/history/flows.vibe:68` | `counted` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:74` | `signature` | pure logic | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:79` | `authorized` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:86` | `guarded` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:106` | `body` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:114` | `body` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:122` | `body` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:130` | `body` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:138` | `body` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:146` | `body` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:150` | `planned` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:152` | `planned/callback@152` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:156` | `started` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:158` | `started/callback@158` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:162` | `noted` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:164` | `noted/callback@164` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:168` | `approved` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:170` | `approved/callback@170` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:177` | `folded` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:185` | `folded/callback@185` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:189` | `folded/callback@189` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:189` | `folded/callback@189/callback@189` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:207` | `bootstrapped` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:215` | `callback@215` | effectful shell | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:217` | `callback@215/callback@217` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:218` | `callback@215/callback@218` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:219` | `callback@215/callback@219` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:220` | `callback@215/callback@220` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:221` | `callback@215/callback@221` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/flows.vibe:222` | `callback@215/callback@222` | wiring | Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020). |
| `src/history/LiveMythical.vibe:17` | `unavailable` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:18` | `unavailable/callback@18` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:22` | `LiveMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:23` | `LiveMythical/callback@23` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:27` | `LiveMythical/callback@23/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:40` | `LiveMythical/callback@23/page` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:53` | `LiveMythical/callback@23/outline` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:54` | `LiveMythical/callback@23/epic` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:55` | `LiveMythical/callback@23/commit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:56` | `LiveMythical/callback@23/search` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:57` | `LiveMythical/callback@23/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:58` | `LiveMythical/callback@23/events/callback@58` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:67` | `LiveMythical/callback@23/events/callback@58/callback@67` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:71` | `LiveMythical/callback@23/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:72` | `LiveMythical/callback@23/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:75` | `LiveMythical/callback@23/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:78` | `LiveMythical/callback@23/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:81` | `LiveMythical/callback@23/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:19` | `seeded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:20` | `seeded/callback@20` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:25` | `landedSha` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:30` | `mockMain` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:32` | `mockMain/since` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:32` | `mockMain/since/callback@32` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:35` | `mockMain/since/callback@32/callback@35` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:34` | `mockMain/since/callback@32/callback@34` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:45` | `digestOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:52` | `MockMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:53` | `MockMythical/callback@53` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:68` | `MockMythical/callback@53/executionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:69` | `MockMythical/callback@53/executionId/callback@69` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:76` | `MockMythical/callback@53/paged` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:77` | `MockMythical/callback@53/paged/callback@77` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:83` | `MockMythical/callback@53/outline` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:84` | `MockMythical/callback@53/epic` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:84` | `MockMythical/callback@53/epic/callback@84` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:85` | `MockMythical/callback@53/commit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:85` | `MockMythical/callback@53/commit/callback@85` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:86` | `MockMythical/callback@53/search` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:86` | `MockMythical/callback@53/search/callback@86` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:87` | `MockMythical/callback@53/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:88` | `MockMythical/callback@53/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:91` | `MockMythical/callback@53/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:94` | `MockMythical/callback@53/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:97` | `MockMythical/callback@53/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:100` | `MockMythical/callback@53/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/mythical.vibe:157` | `apply` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:170` | `apply/callback@170` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:189` | `apply/callback@189` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:193` | `apply/callback@193` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:200` | `apply/callback@200` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:207` | `apply/callback@207` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:214` | `apply/callback@214` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:230` | `amended` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:245` | `started` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:262` | `approved` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:276` | `noted` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:291` | `landed` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:300` | `hasEpic` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:318` | `hasCommit` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:336` | `hasSha` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:351` | `isIn` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:368` | `taskOf` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:385` | `epicOf` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:402` | `rankOf` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:419` | `endOf` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:444` | `foldTarget` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:477` | `accepted` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:483` | `refused` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:540` | `decide` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:602` | `validRank` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:608` | `validRanks` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/mythical.vibe:623` | `decideWithinCapacity` | pure logic | Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts). |
| `src/history/MythicalHistory.vibe:35` | `settled` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:80` | `foldCounts` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:86` | `headOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:101` | `stacked` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:102` | `stacked/callback@102` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/pages.vibe:103` | `stacked/callback@103` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:106` | `outlineOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:117` | `outlineOf/callback@117` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:118` | `outlineOf/callback@118` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/pages.vibe:118` | `outlineOf/callback@118` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:123` | `epicPageOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:125` | `epicPageOf/callback@125` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:125` | `epicPageOf/callback@125` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:127` | `epicPageOf/callback@127` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/pages.vibe:130` | `commitPageOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:133` | `commitPageOf/callback@133` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:134` | `commitPageOf/callback@134` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:139` | `matchesOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:144` | `matchesOf/callback@144` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/pages.vibe:145` | `matchesOf/callback@145` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/pages.vibe:149` | `pageOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/roles.vibe:32` | `atLeast` | pure logic | may, leastRole, peopleOnly and standing are proved in flowMachine.vibe; this module re-exports them and builds the role tables from them (0020). |
| `src/history/schemas.vibe:51` | `callback@51` | wiring | Rank bounds call proved validRank/validRanks; Schema safe-integer and JSON decoding remain runtime boundaries (unsafe-integer.ts, json-codec.ts). |
| `src/history/schemas.vibe:91` | `decodeStoredHistory` | effectful shell | Rank bounds call proved validRank/validRanks; Schema safe-integer and JSON decoding remain runtime boundaries (unsafe-integer.ts, json-codec.ts). |
| `src/history/schemas.vibe:92` | `decodeStoredHistory/callback@92` | wiring | Rank bounds call proved validRank/validRanks; Schema safe-integer and JSON decoding remain runtime boundaries (unsafe-integer.ts, json-codec.ts). |
| `src/history/seed.vibe:30` | `bucketsOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:33` | `bucketsOf/callback@33` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:34` | `bucketsOf/callback@34` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:52` | `bucketsOf/callback@52` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:199` | `scopeOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:210` | `areaOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:224` | `sanitize` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:240` | `endsSentence` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:248` | `wholeSentences` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:253` | `wholeSentences/callback@253` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:254` | `wholeSentences/callback@254` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:264` | `titleOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:278` | `evidenceOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:293` | `evidenceOf/callback@293` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:293` | `evidenceOf/callback@293` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:311` | `pushOnce` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:323` | `seedOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:385` | `seedOf/callback@385` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:386` | `seedOf/callback@385/callback@386` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:394` | `seedOf/callback@394` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:408` | `clip` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:413` | `notesOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:419` | `notesOf/callback@419` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:420` | `notesOf/callback@420` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:431` | `intentsOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:459` | `replay` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:474` | `seedFrom` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:475` | `seedFrom/callback@475` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:479` | `seedFrom/callback@479` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:485` | `seedFrom/callback@479/callback@485` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:485` | `seedFrom/callback@479/callback@485/callback@485` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:484` | `seedFrom/callback@479/callback@484` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:483` | `seedFrom/callback@479/callback@483` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:487` | `seedFrom/callback@487` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:12` | `checkedHistory` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:12` | `checkedHistory/callback@12` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:13` | `checkedEvents` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:13` | `checkedEvents/callback@13` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:61` | `trailerOf` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:66` | `answered` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:71` | `make` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:76` | `make/current` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:88` | `make/record` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:98` | `make/locked` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:103` | `make/openEpic` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:109` | `make/planned` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:116` | `make/read` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:119` | `make/follow` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:120` | `make/follow/callback@120` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:122` | `make/follow/callback@120/callback@122` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:126` | `make/follow/callback@120/callback@126` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:130` | `make/follow/callback@120/callback@130` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:135` | `make/record` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:138` | `make/plan` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:139` | `make/plan/callback@139` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:170` | `make/fold` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:171` | `make/fold/callback@171` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:181` | `make/fold/callback@171/callback@181` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:195` | `make/bootstrap` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:196` | `make/bootstrap/callback@196` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:210` | `stackOf` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:211` | `stackOf/recorded` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:211` | `stackOf/recorded/callback@211` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:215` | `stackOf/start` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:216` | `stackOf/note` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:217` | `stackOf/approve` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:219` | `stackOf/bootstrap` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:227` | `memoryStore` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:230` | `memoryStore/load` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:231` | `memoryStore/since` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:231` | `memoryStore/since/callback@231` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:231` | `memoryStore/since/callback@231/callback@231` | pure logic | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:232` | `memoryStore/append` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:232` | `memoryStore/append/callback@232` | wiring | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/Sequencer.vibe:233` | `memoryStore/seed` | effectful shell | Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved. |
| `src/history/tools.vibe:44` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:56` | `requestOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:72` | `counted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:78` | `show` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:80` | `show/callback@80` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:91` | `answered` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:92` | `answered/callback@92` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:94` | `answered/callback@94` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:100` | `plan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:105` | `start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:110` | `note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:32` | `pageRequestOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:44` | `pathOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:58` | `historyRouteOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:60` | `historyRouteOf/callback@60` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:90` | `statusOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/backend.vibe:24` | `notDeployed` | wiring | Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved. |
| `src/surfaces/backend.vibe:28` | `unreachable` | wiring | Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved. |
| `src/surfaces/backend.vibe:33` | `callback@33` | effectful shell | Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved. |
| `src/surfaces/backend.vibe:35` | `callback@33/callback@35` | effectful shell | Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved. |
| `src/surfaces/backend.vibe:45` | `backend` | pure logic | Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved. |
| `src/surfaces/cli-entry.vibe:12` | `callback@12` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli-entry.vibe:15` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:10` | `run` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:13` | `commandFor` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:14` | `commandFor/callback@14` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:23` | `cli` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:26` | `cli/callback@26` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:29` | `cli/callback@29` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commandDecision.vibe:15` | `isOwnPost` | pure logic | Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping; UUID generation, streams and rendering are Effect/host boundaries. |
| `src/surfaces/commandDecision.vibe:21` | `isOwnReply` | pure logic | Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping; UUID generation, streams and rendering are Effect/host boundaries. |
| `src/surfaces/commandDecision.vibe:35` | `collectAnswer` | pure logic | Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping; UUID generation, streams and rendering are Effect/host boundaries. |
| `src/surfaces/commandDecision.vibe:54` | `answerOutcome` | pure logic | Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping; UUID generation, streams and rendering are Effect/host boundaries. |
| `src/surfaces/commandDecision.vibe:62` | `commandError` | pure logic | Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping; UUID generation, streams and rendering are Effect/host boundaries. |
| `src/surfaces/commands.vibe:30` | `ask` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:36` | `ask/callback@36` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:49` | `read` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:55` | `define` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:65` | `define/invoke` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:70` | `define/run` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:71` | `define/run/callback@71` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:79` | `define/render` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:89` | `callback@89` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:94` | `callback@94` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:95` | `callback@94/callback@95` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:144` | `brief` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:149` | `summaryOf` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:154` | `summaryOf/callback@154` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:164` | `summaryOf/callback@164` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:165` | `summaryOf/callback@165` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:171` | `showHistory` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:174` | `showHistory/callback@174` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:183` | `plan` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:197` | `start` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:202` | `note` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:212` | `callback@212` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:214` | `callback@212/callback@214` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:215` | `callback@212/callback@215` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:216` | `callback@212/callback@216` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:220` | `callback@212/callback@220` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:231` | `callback@231` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:236` | `callback@236` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:242` | `callback@242` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:250` | `callback@250` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:250` | `callback@250` | pure logic | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:251` | `callback@251` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:254` | `callback@254` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:255` | `callback@255` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:258` | `callback@258` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:259` | `callback@259` | effectful shell | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/commands.vibe:262` | `callback@262` | wiring | Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries. |
| `src/surfaces/manifest.vibe:8` | `callback@8` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/manifest.vibe:22` | `callback@22` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp-entry.vibe:10` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:7` | `callback@7` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/mcp.vibe:9` | `callback@9` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:13` | `callback@9/callback@13` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/mcp.vibe:13` | `callback@9/callback@13/callback@13` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:20` | `serve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:29` | `mcp` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:31` | `mcp/callback@31` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:13` | `BrowserFactory` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:14` | `BrowserFactory/callback@14` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:18` | `BrowserFactory/callback@14/callback@18` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:19` | `BrowserFactory/callback@14/callback@18/callback@19` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:24` | `BrowserFactory/callback@14/callback@18/callback@24` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:32` | `BrowserFactory/callback@14/mode` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:34` | `BrowserFactory/callback@14/current` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:35` | `BrowserFactory/callback@14/members` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:36` | `BrowserFactory/callback@14/grant` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:37` | `BrowserFactory/callback@14/signOut` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:38` | `BrowserFactory/callback@14/choose` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:39` | `BrowserFactory/callback@14/participated` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:40` | `BrowserFactory/callback@14/events` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:40` | `BrowserFactory/callback@14/events/callback@40` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:42` | `BrowserFactory/callback@14/post` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:46` | `BrowserFactory/callback@14/read` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:50` | `BrowserFactory/callback@14/events` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:50` | `BrowserFactory/callback@14/events/callback@50` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:54` | `BrowserFactory/callback@14/tour` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:58` | `BrowserFactory/callback@14/endTour` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:62` | `BrowserFactory/callback@14/sandbox` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:63` | `BrowserFactory/callback@14/startSandbox` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:64` | `BrowserFactory/callback@14/stopSandbox` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:65` | `BrowserFactory/callback@14/sandboxCommand` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:67` | `BrowserFactory/callback@14/callback@67` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/entry.vibe:9` | `callback@9` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:122` | `init` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:152` | `allowed` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:160` | `pageOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:161` | `pageOf/callback@161` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:165` | `shownCommit` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:170` | `merged` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:171` | `merged/callback@171` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:176` | `merged/callback@176` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:180` | `shownReads` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:193` | `write` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:197` | `update` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:200` | `update/ResolvedMode` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:202` | `update/GotOutline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:208` | `update/GotEpic` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:209` | `update/GotCommit` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:213` | `update/GotMatches` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:214` | `update/FailedLoad` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:216` | `update/FailedRead` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:217` | `update/ClickedRetry` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:218` | `update/Navigated` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:224` | `update/ToggledEpic` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:225` | `update/ToggledEpic/callback@225` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:229` | `update/ClickedMore` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:230` | `update/UpdatedFilter` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:231` | `update/OpenedPlan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:238` | `update/ClosedPlan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:239` | `update/UpdatedForm` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:243` | `update/SubmittedPlan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:254` | `update/UpdatedLane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:255` | `update/ClickedStart` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:256` | `update/ClickedApprove` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:257` | `update/ClickedFold` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:258` | `update/UpdatedNoteSection` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:259` | `update/UpdatedNote` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:260` | `update/SubmittedNote` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:262` | `update/Wrote` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:266` | `update/FailedWrite` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:269` | `update/ReceivedEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:274` | `update/FailedEvents` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:275` | `update/PressedEscape` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:276` | `update/Settled` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:283` | `message` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:288` | `reasonOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:293` | `failedRead` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:300` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:301` | `execute/callback@301` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:302` | `execute/callback@302` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:309` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:310` | `execute/callback@310` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:311` | `execute/callback@311` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:318` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:319` | `execute/callback@319` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:320` | `execute/callback@320` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:327` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:328` | `execute/callback@328` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:329` | `execute/callback@329` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:338` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:339` | `execute/callback@339` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:340` | `execute/callback@340` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:347` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:348` | `execute/callback@348` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:349` | `execute/callback@349` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:357` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:359` | `execute/callback@359` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:360` | `execute/callback@360` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:367` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:369` | `execute/callback@369` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:371` | `execute/callback@371` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:372` | `execute/callback@372` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:377` | `settledMessage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:384` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:386` | `execute/callback@386` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:389` | `execute/callback@389` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:390` | `execute/callback@390` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:397` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:399` | `execute/callback@399` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:402` | `execute/callback@402` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:403` | `execute/callback@403` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:410` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:412` | `execute/callback@412` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:415` | `execute/callback@415` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:416` | `execute/callback@416` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:423` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:425` | `execute/callback@425` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:428` | `execute/callback@428` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:429` | `execute/callback@429` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:436` | `subscriptions` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:437` | `subscriptions/callback@437` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:442` | `subscriptions/callback@437/filterMapEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:450` | `subscriptions/callback@437/filterMapEvent` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:456` | `subscriptions/callback@437/modelToDependencies` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:457` | `subscriptions/callback@437/dependenciesToStream` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:458` | `subscriptions/callback@437/dependenciesToStream/callback@458` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:460` | `subscriptions/callback@437/dependenciesToStream/callback@458/callback@460` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:462` | `subscriptions/callback@437/dependenciesToStream/callback@458/callback@462` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:465` | `subscriptions/callback@437/dependenciesToStream/callback@458/callback@465` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:469` | `subscriptions/callback@437/dependenciesToStream/callback@458/callback@469` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:470` | `subscriptions/callback@437/dependenciesToStream/callback@458/callback@470` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:17` | `BrowserMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:18` | `BrowserMythical/callback@18` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:22` | `BrowserMythical/callback@18/callback@22` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:23` | `BrowserMythical/callback@18/callback@22/callback@23` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:27` | `BrowserMythical/callback@18/callback@22/callback@27` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:34` | `BrowserMythical/callback@18/mode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:35` | `BrowserMythical/callback@18/outline` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:36` | `BrowserMythical/callback@18/epic` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:37` | `BrowserMythical/callback@18/commit` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:38` | `BrowserMythical/callback@18/search` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:39` | `BrowserMythical/callback@18/events` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:39` | `BrowserMythical/callback@18/events/callback@39` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:40` | `BrowserMythical/callback@18/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:41` | `BrowserMythical/callback@18/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:42` | `BrowserMythical/callback@18/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:43` | `BrowserMythical/callback@18/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:44` | `BrowserMythical/callback@18/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:46` | `BrowserMythical/callback@18/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:15` | `askedForMock` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:25` | `mockRole` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:34` | `mockRole/callback@34` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:37` | `backendMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:38` | `backendMode/callback@38` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:39` | `backendMode/callback@38/callback@39` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:41` | `backendMode/callback@38/callback@39/callback@41` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:47` | `historyMain` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:52` | `historyMain/callback@52` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:66` | `historyMain/callback@66` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:17` | `view` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:20` | `view/callback@20` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:43` | `body` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:60` | `top` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:71` | `away` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:75` | `loading` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:78` | `loading/callback@78` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:84` | `crumbs` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:87` | `crumbs/callback@87` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:100` | `list` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:113` | `list/callback@113` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:134` | `list/callback@134` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:138` | `list/callback@138` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:127` | `list/callback@127` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:144` | `commitList` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:148` | `commitList/callback@148` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:155` | `epicCard` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:162` | `epicCard/callback@162` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:182` | `row` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:183` | `row/callback@183` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:198` | `badgeOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:202` | `failure` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:207` | `refusalText` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:223` | `epicPage` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:240` | `commitPage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:241` | `commitPage/callback@241` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:243` | `commitPage/section` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:248` | `commitPage/notes` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:249` | `commitPage/notes/callback@249` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:249` | `commitPage/notes/callback@249` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:281` | `commitPage/callback@281` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:295` | `timeline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:298` | `timeline/step` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:305` | `timeline/callback@305` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:320` | `noteForm` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:322` | `noteForm/callback@322` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:327` | `noteForm/callback@327` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:334` | `plan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:346` | `plan/callback@346` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:353` | `plan/callback@353` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:354` | `plan/callback@354` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:361` | `plan/callback@361` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:371` | `plan/callback@371` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:49` | `accountOf` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:107` | `tourConversation` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:174` | `init` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:207` | `update` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:209` | `update/ObservedMedia` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:210` | `update/LoadedMedia` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:211` | `update/FailedMedia` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:212` | `update/ResolvedMode` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:213` | `update/AccountLoaded` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:230` | `update/AccountFailed` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:231` | `update/ClickedAccount` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:232` | `update/ClickedSignIn` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:235` | `update/ClickedSignOut` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:236` | `update/ChoseIdentity` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:237` | `update/ClickedPeople` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:238` | `update/LoadedPeople` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:239` | `update/ClosedPeople` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:240` | `update/ToggledPeople` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:241` | `update/SelectedRole` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:242` | `update/CancelledRole` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:243` | `update/ConfirmedRole` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:244` | `update/GrantedRole` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:245` | `update/ReceivedRole` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:253` | `update/ReceivedRole/callback@253` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:261` | `update/FailedRoles` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:262` | `update/RetriedAccount` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:271` | `update/DismissedAccountError` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:272` | `update/PressedCommandK` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:273` | `update/ClickedAsk` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:275` | `update/PressedEscape` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:288` | `update/ClickedLearnMore` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:289` | `update/ClickedEndTour` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:291` | `update/SucceededTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:293` | `update/FailedTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:295` | `update/FailedEndTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:296` | `update/ClickedSandboxes` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:297` | `update/MaximizedSandboxes` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:298` | `update/StartedSandbox` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:299` | `update/StoppedSandbox` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:300` | `update/UpdatedTerminal` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:301` | `update/SubmittedTerminal` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:302` | `update/LoadedSandbox` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:308` | `update/FailedSandbox` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:309` | `update/ClickedDocs` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:310` | `update/ClickedSplash` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:311` | `update/ClickedChat` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:312` | `update/UpdatedDraft` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:313` | `update/SubmittedDraft` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:314` | `update/SucceededPost` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:315` | `update/ClickedRetry` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:316` | `update/ClickedRetry/callback@316` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:323` | `update/FailedPost` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:324` | `update/ReceivedEvent` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:331` | `update/ReceivedEvent/callback@331` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:344` | `update/FailedEvents` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:345` | `update/ClickedReconnect` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:346` | `update/FocusedPrompt` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:347` | `update/ScrolledTranscript` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:352` | `update/ClickedLatest` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:360` | `learnMore` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:388` | `touringHere` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:393` | `endTour` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:397` | `openPalette` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:403` | `minimizeSplash` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:409` | `hasConversation` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:413` | `submit` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:439` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:441` | `execute/callback@441` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:446` | `message` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:459` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:460` | `execute/callback@460` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:462` | `execute/callback@462` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:470` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:473` | `execute/callback@473` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:474` | `execute/callback@474` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:482` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:484` | `execute/callback@484` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:486` | `execute/callback@486` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:487` | `execute/callback@487` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:494` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:496` | `execute/callback@496` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:499` | `execute/callback@499` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:500` | `execute/callback@500` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:508` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:510` | `execute/callback@510` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:513` | `execute/callback@513` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:514` | `execute/callback@514` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:525` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:527` | `execute/callback@527` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:530` | `execute/callback@530` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:531` | `execute/callback@531` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:538` | `keyMessage` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:546` | `subscriptions` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:548` | `subscriptions/scrolled` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:550` | `subscriptions/callback@550` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:555` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:569` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:575` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:581` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:587` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:592` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:593` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:598` | `subscriptions/callback@550/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:605` | `subscriptions/callback@550/modelToDependencies` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:612` | `subscriptions/callback@550/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:613` | `subscriptions/callback@550/dependenciesToStream/callback@613` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:615` | `subscriptions/callback@550/dependenciesToStream/callback@613/callback@615` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:617` | `subscriptions/callback@550/dependenciesToStream/callback@617` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:626` | `subscriptions/callback@550/modelToDependencies` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:631` | `subscriptions/callback@550/modelToDependencies/callback@631` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:633` | `subscriptions/callback@550/dependenciesToStream` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:634` | `subscriptions/callback@550/dependenciesToStream/callback@634` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:636` | `subscriptions/callback@550/dependenciesToStream/callback@634/callback@636` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:638` | `subscriptions/callback@550/dependenciesToStream/callback@634/callback@636/callback@638` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:639` | `subscriptions/callback@550/dependenciesToStream/callback@634/callback@639` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:639` | `subscriptions/callback@550/dependenciesToStream/callback@634/callback@639/callback@639` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:641` | `subscriptions/callback@550/dependenciesToStream/callback@641` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:648` | `subscriptions/callback@550/modelToDependencies` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:649` | `subscriptions/callback@550/dependenciesToStream` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:649` | `subscriptions/callback@550/dependenciesToStream/callback@649` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:653` | `subscriptions/callback@550/dependenciesToStream/callback@649/callback@653` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:654` | `subscriptions/callback@550/dependenciesToStream/callback@649/callback@654` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:655` | `subscriptions/callback@550/dependenciesToStream/callback@649/callback@655` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:663` | `subscriptions/callback@550/modelToDependencies` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:669` | `subscriptions/callback@550/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:671` | `subscriptions/callback@550/dependenciesToStream/callback@671` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:673` | `subscriptions/callback@550/dependenciesToStream/callback@671/callback@673` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:675` | `subscriptions/callback@550/dependenciesToStream/callback@671/callback@675` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:677` | `subscriptions/callback@550/dependenciesToStream/callback@671/callback@677` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:680` | `subscriptions/callback@550/dependenciesToStream/callback@680` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:693` | `viewTransition` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:696` | `sandboxAction` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:704` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:706` | `execute/callback@706` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:707` | `execute/callback@706/callback@707` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:708` | `execute/callback@706/callback@708` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:711` | `execute/callback@706/callback@711` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:712` | `execute/callback@712` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:712` | `execute/callback@712/callback@712` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:716` | `roleLabel` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:718` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:720` | `execute/callback@720` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:721` | `execute/callback@721` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:725` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:727` | `execute/callback@727` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:728` | `execute/callback@728` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:732` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:733` | `execute/callback@733` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:735` | `execute/callback@735` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:736` | `execute/callback@736` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:739` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:742` | `execute/callback@742` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:743` | `execute/callback@743` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:745` | `execute/callback@745` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:747` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:749` | `execute/callback@749` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:750` | `execute/callback@750` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:754` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:756` | `execute/callback@756` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:757` | `execute/callback@757` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:760` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:762` | `execute/callback@762` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:763` | `execute/callback@763` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:765` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:767` | `execute/callback@767` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:768` | `execute/callback@768` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:771` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:773` | `execute/callback@773` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:774` | `execute/callback@774` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/markdown.vibe:11` | `blocks` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:17` | `blocks/flushProse` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:44` | `inline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:49` | `render` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:50` | `render/callback@50` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:53` | `render/callback@50/callback@53` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/media.vibe:4` | `callback@4` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/media.vibe:11` | `observeMedia` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/media.vibe:12` | `observeMedia/callback@12` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:7` | `badge` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:11` | `identityNav` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:19` | `identityNav/callback@19` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/roleView.vibe:20` | `identityNav/callback@20` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/roleView.vibe:33` | `identityNav/callback@33` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:35` | `identityNav/callback@35` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:42` | `peoplePane` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:52` | `peoplePane/callback@52` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:59` | `peoplePane/callback@52/callback@59` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/roleView.vibe:60` | `peoplePane/callback@52/callback@60` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:60` | `peoplePane/callback@52/callback@60` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:66` | `accountOverlays` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:68` | `accountOverlays/callback@68` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/roleView.vibe:94` | `accountNotice` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/sandboxView.vibe:7` | `icon` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/sandboxView.vibe:10` | `minutes` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/sandboxView.vibe:14` | `sandboxPane` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/sandboxView.vibe:25` | `sandboxPane/button` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/sandboxView.vibe:49` | `sandboxPane/callback@49` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/sandboxView.vibe:56` | `sandboxPane/callback@56` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/screenDecision.vibe:12` | `escapeAction` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:22` | `canMinimize` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:29` | `hasContent` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:37` | `toggleDocs` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:49` | `scrollFollow` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:58` | `follows` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:65` | `nativeFollow` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:77` | `nativeScroll` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:85` | `canPause` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:92` | `wheelPauses` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:99` | `keyPauses` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:106` | `touchPauses` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:113` | `nearBottom` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:120` | `failedTourKeepsControl` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:131` | `paletteChange` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:142` | `tourStream` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:150` | `completedEvent` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:159` | `answerAnnouncement` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/screenDecision.vibe:168` | `screenKey` | pure logic | Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754. |
| `src/web/startup.vibe:20` | `askedForMock` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:30` | `backendMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:31` | `backendMode/callback@31` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:32` | `backendMode/callback@31/callback@32` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:35` | `backendMode/callback@31/callback@32/callback@35` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:41` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:48` | `main/callback@48` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:55` | `main/callback@55` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:62` | `main/callback@62` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/styles.vibe:9` | `stylesheet` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/styles.vibe:10` | `stylesheet/callback@10` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:19` | `failureOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:23` | `view` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:48` | `logo` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:52` | `top` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:65` | `away` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:73` | `paneIcon` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:78` | `githubMark` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:86` | `splash` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:115` | `splashPane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:125` | `control` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:133` | `docsPane` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:136` | `docsPane/callback@136` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:162` | `chat` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:174` | `chat/callback@174` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:175` | `chat/callback@175` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:190` | `entryView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:207` | `pendingView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:219` | `ownPost` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:224` | `postFailure` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:235` | `promptInput` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:243` | `promptInput/callback@243` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:244` | `promptInput/callback@244` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:250` | `composer` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:265` | `statusText` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:275` | `palette` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:298` | `mediaForStop` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:299` | `mediaForStop/callback@299` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:304` | `media` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:306` | `media/source` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:4` | `atBottom` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:11` | `transcriptViewport` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:16` | `transcriptViewport/active` | effectful shell | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:20` | `transcriptViewport/position` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:21` | `transcriptViewport/scrollable` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:22` | `transcriptViewport/pause` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:30` | `transcriptViewport/wheel` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:31` | `transcriptViewport/key` | effectful shell | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:48` | `transcriptViewport/touchStart` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:52` | `transcriptViewport/touchMove` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:53` | `transcriptViewport/touchMove/callback@53` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:59` | `transcriptViewport/touchEnd` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:60` | `transcriptViewport/scrolled` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:72` | `transcriptViewport/follow` | effectful shell | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `worker/Accounts.vibe:33` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:37` | `readSetup` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:47` | `readSetup/callback@47` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:49` | `readSetup/callback@49` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:53` | `readSetup/callback@53` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:60` | `configured` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:61` | `configured/callback@61` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:65` | `disabled` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:73` | `make` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:76` | `make/start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:76` | `make/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:79` | `make/authorize` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:83` | `make/contextOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:84` | `make/get` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:84` | `make/get/callback@84` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:85` | `make/put` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:85` | `make/put/callback@85` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:86` | `make/remove` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:86` | `make/remove/callback@86` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:87` | `make/cookie` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:89` | `make/json` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:90` | `make/redirect` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:101` | `make/session` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:104` | `make/session/callback@104` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:108` | `make/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:119` | `make/mutation` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:122` | `make/mutation/callback@122` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:124` | `make/mutation/callback@122/callback@124` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:124` | `make/mutation/callback@122/callback@124/callback@124` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:125` | `make/mutation/callback@122/callback@124/callback@124/callback@125` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:140` | `make/handle` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:147` | `make/handle/callback@147` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:154` | `make/handle/callback@154` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:159` | `make/handle/callback@154/callback@159` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:172` | `make/handle/callback@172` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:180` | `make/handle/callback@180` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:185` | `make/handle/callback@185` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:187` | `make/handle/callback@185/callback@187` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:190` | `make/handle/callback@185/callback@190` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:199` | `make/handle/callback@199` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:201` | `make/handle/callback@201` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:212` | `make/callback@212` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:216` | `make/role` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:217` | `make/allowed` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:217` | `make/allowed/callback@217` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:218` | `make/callback@218` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:228` | `make/callback@218/callback@228` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:233` | `make/callback@218/callback@233` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Accounts.vibe:233` | `make/callback@218/callback@233/callback@233` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:241` | `make/participation` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:241` | `make/participation/callback@241` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:249` | `sameOrigin` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Accounts.vibe:254` | `sandboxPrincipal` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/AgentModel.vibe:44` | `chatModel` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/AgentModel.vibe:47` | `chatModel/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/AgentModel.vibe:48` | `chatModel/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:62` | `callback@62` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:65` | `callback@62/callback@65` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:66` | `callback@62/callback@65/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:66` | `callback@62/callback@65/role` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:66` | `callback@62/callback@65/allowed` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:66` | `callback@62/callback@65/participation` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:67` | `callback@62/callback@65/callback@67` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:75` | `objectOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:76` | `objectOf/try` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:76` | `objectOf/catch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:80` | `reached` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:81` | `reached/callback@81` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:84` | `callback@84` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:87` | `callback@84/callback@87` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:89` | `callback@84/callback@87/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:93` | `callback@93` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:97` | `callback@93/callback@97` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:98` | `callback@93/callback@97/callback@98` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:105` | `callback@93/callback@97/page` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:105` | `callback@93/callback@97/page/callback@105` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:106` | `callback@93/callback@97/write` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:108` | `callback@93/callback@97/act` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:110` | `callback@93/callback@97/callback@110` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:118` | `callback@118` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:124` | `callback@118/callback@124` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:126` | `callback@118/callback@124/callback@126` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:129` | `callback@118/callback@124/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:132` | `callback@118/callback@124/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:133` | `callback@118/callback@124/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:135` | `callback@118/callback@124/callback@135` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:140` | `callback@118/callback@124/alarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:140` | `callback@118/callback@124/alarm/callback@140` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:143` | `callback@118/callback@124/alarm/callback@140/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:143` | `callback@118/callback@124/alarm/callback@140/admit/callback@143` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:147` | `callback@118/callback@124/alarm/callback@140/spend` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:147` | `callback@118/callback@124/alarm/callback@140/spend/callback@147` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:154` | `callback@118/callback@124/alarm/callback@140/callback@154` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:154` | `callback@118/callback@124/alarm/callback@140/callback@154/callback@154` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:158` | `callback@118/callback@124/alarm/callback@140/callback@158` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:158` | `callback@118/callback@124/alarm/callback@140/callback@158/callback@158` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:182` | `callback@182` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:185` | `callback@182/request` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:189` | `callback@182/request/callback@189` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:190` | `callback@182/request/callback@190` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:193` | `callback@182/role` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:203` | `callback@203` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:212` | `callback@203/callback@212` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:221` | `callback@203/callback@212/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:221` | `callback@203/callback@212/post/callback@221` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:230` | `callback@203/callback@212/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:230` | `callback@203/callback@212/read/callback@230` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:234` | `callback@203/callback@212/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:234` | `callback@203/callback@212/tour/callback@234` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:238` | `callback@203/callback@212/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:238` | `callback@203/callback@212/endTour/callback@238` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:242` | `callback@203/callback@212/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:242` | `callback@203/callback@212/events/callback@242` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:249` | `callback@203/callback@212/page` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:253` | `callback@203/callback@212/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:257` | `callback@203/callback@212/events` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Budget.vibe:15` | `replyKey` | wiring | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:24` | `make` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:28` | `make/admit` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:38` | `make/spend` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:39` | `make/spend/callback@39` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/budgetDecision.vibe:7` | `admits` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/budgetDecision.vibe:19` | `charge` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/budgetDecision.vibe:27` | `canCharge` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/HistoryObject.vibe:33` | `seeded` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:38` | `storeOver` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:40` | `storeOver/load` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:41` | `storeOver/load/callback@41` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:44` | `storeOver/load/callback@44` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:47` | `storeOver/load/callback@47` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:50` | `storeOver/since` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:51` | `storeOver/since/callback@51` | pure logic | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:54` | `storeOver/append` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:55` | `storeOver/append/callback@55` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:57` | `storeOver/seed` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:58` | `storeOver/seed/callback@58` | pure logic | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:67` | `storeOver/seed/callback@67` | pure logic | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:67` | `storeOver/seed/callback@67/callback@67` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:69` | `storeOver/seed/callback@69` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:75` | `principalOf` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:91` | `readerOver` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:96` | `readerOver/read` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:97` | `readerOver/read/callback@97` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:98` | `readerOver/read/callback@98` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:100` | `readerOver/written` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:101` | `readerOver/written/callback@101` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:106` | `readerOver/outline` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:107` | `readerOver/epic` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:108` | `readerOver/commit` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:109` | `readerOver/search` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:110` | `readerOver/plan` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:111` | `readerOver/start` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:112` | `readerOver/note` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:120` | `history` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:125` | `runtime` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:137` | `bootstrap` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:139` | `bootstrap/callback@139` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:159` | `write` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:171` | `write/callback@171` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryTools.vibe:22` | `declared` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryTools.vibe:35` | `historyTools` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:37` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:39` | `historyTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryTools.vibe:42` | `historyTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryTools.vibe:46` | `historyTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:54` | `eventStream` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:55` | `eventStream/callback@55` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:58` | `eventStream/callback@58` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:59` | `eventStream/callback@59` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:66` | `afterOf` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:73` | `json` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:77` | `answer` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:82` | `answer/callback@82` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:83` | `answer/callback@83` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:99` | `decodeWrite` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:110` | `answerHistory` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:120` | `answerHistory/callback@120` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:123` | `answerHistory/callback@123` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:130` | `handle` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:137` | `handle/callback@137` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:138` | `handle/callback@137/callback@138` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:146` | `handle/callback@146` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:147` | `handle/callback@146/callback@147` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/index.vibe:14` | `notFound` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/index.vibe:19` | `fetch` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/MainLog.vibe:28` | `newCommits` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/MainLog.vibe:31` | `newCommits/callback@31` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:39` | `newCommits/callback@39` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:42` | `newCommits/toCommit` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/MainLog.vibe:50` | `newCommits/callback@50` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:56` | `newCommits/callback@56` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:59` | `newCommits/callback@59` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/MainLog.vibe:66` | `githubMain` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:68` | `githubMain/since` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/MainLog.vibe:76` | `githubMain/since/callback@76` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:78` | `githubMain/since/callback@78` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/MainLog.vibe:79` | `githubMain/since/callback@79` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:32` | `executionIdOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:37` | `tourExecutionIdOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:41` | `dispatchedKey` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:44` | `executionStorage` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:46` | `executionStorage/get` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:46` | `executionStorage/get/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:47` | `executionStorage/put` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:47` | `executionStorage/put/callback@47` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:48` | `executionStorage/delete` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:48` | `executionStorage/delete/callback@48` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:49` | `executionStorage/setAlarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:49` | `executionStorage/setAlarm/callback@49` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:50` | `executionStorage/deleteAlarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:50` | `executionStorage/deleteAlarm/callback@50` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:59` | `dispatcher` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:62` | `dispatcher/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:64` | `dispatcher/tour/callback@64` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:67` | `dispatcher/tour/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:68` | `dispatcher/tour/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:71` | `dispatcher/tour/callback@71` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:73` | `dispatcher/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:75` | `dispatcher/start/callback@75` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:78` | `dispatcher/start/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:79` | `dispatcher/start/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:82` | `dispatcher/start/callback@82` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:90` | `conversation` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:95` | `budget` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:100` | `postsOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:105` | `toursOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:105` | `toursOf/callback@105` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:120` | `postExecutionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:127` | `wakeTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:129` | `wakeTour/callback@129` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:137` | `wakeTour/callback@137` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:149` | `tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:154` | `endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:158` | `asked` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:162` | `asked/callback@162` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:164` | `asked/callback@164` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:177` | `post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:189` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:201` | `repliesOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:214` | `start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:215` | `wake` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:225` | `alarm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:242` | `alarm/runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:22` | `eventKey` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:27` | `logOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:29` | `logOver/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:30` | `logOver/read/callback@30` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:33` | `logOver/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:34` | `logOver/write/callback@34` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:40` | `ledgerOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:42` | `ledgerOver/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:43` | `ledgerOver/read/callback@43` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:46` | `ledgerOver/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:47` | `ledgerOver/write/callback@47` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Reply.vibe:64` | `reasonOf` | wiring | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:69` | `failureReason` | wiring | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:95` | `dayOf` | pure logic | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:100` | `promptOf` | pure logic | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:108` | `promptOf/callback@108` | pure logic | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:130` | `tagOf` | pure logic | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:154` | `fold` | pure logic | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:178` | `agentOf` | wiring | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:202` | `agentOf/resolve` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:222` | `respond` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:226` | `respond/emit` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:227` | `respond/callback@227` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:252` | `run` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:254` | `run/callback@254` | wiring | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:262` | `compose` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:271` | `compose/callback@271` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:303` | `answer` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:311` | `answer/callback@311` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:322` | `answer/callback@322` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:329` | `answer/callback@329` | pure logic | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:338` | `callback@338` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:340` | `callback@338/callback@340` | effectful shell | Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved. |
| `worker/replyReasons.vibe:9` | `reasonCode` | pure logic | Failure precedence and model reason codes; proved. |
| `worker/replyReasons.vibe:22` | `failureCode` | pure logic | Failure precedence and model reason codes; proved. |
| `worker/SandboxAccounts.vibe:20` | `request` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:20` | `role` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:28` | `callback@28` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:32` | `callback@28/callback@32` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:34` | `callback@28/callback@32/call` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:36` | `callback@28/callback@32/call/callback@36` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:35` | `callback@28/callback@32/call/callback@35` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:35` | `callback@28/callback@32/call/callback@35` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:41` | `callback@28/callback@32/lease` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:41` | `callback@28/callback@32/lease/callback@41` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:41` | `callback@28/callback@32/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:41` | `callback@28/callback@32/stop` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:41` | `callback@28/callback@32/command` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:42` | `callback@28/callback@32/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:43` | `callback@28/callback@32/current/callback@43` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:47` | `callback@28/callback@32/callback@47` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:50` | `callback@28/callback@32/run` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:51` | `callback@28/callback@32/run/callback@51` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:52` | `callback@28/callback@32/run/callback@51/callback@52` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:55` | `callback@28/callback@32/run/callback@51/callback@55` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:59` | `callback@28/callback@32/run/callback@59` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:64` | `callback@28/callback@32/alarm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:66` | `callback@28/callback@32/alarm/callback@66` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:74` | `callback@74` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:77` | `callback@74/callback@77` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:80` | `callback@74/callback@77/request` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:87` | `callback@74/callback@77/request/callback@87` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:87` | `callback@74/callback@77/request/callback@87` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:94` | `callback@74/callback@77/sandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:94` | `callback@74/callback@77/sandbox/callback@94` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:95` | `callback@74/callback@77/startSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:95` | `callback@74/callback@77/startSandbox/callback@95` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:96` | `callback@74/callback@77/stopSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:96` | `callback@74/callback@77/stopSandbox/callback@96` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:97` | `callback@74/callback@77/sandboxCommand` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:97` | `callback@74/callback@77/sandboxCommand/callback@97` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:105` | `identityFromPolicy` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:111` | `identityFromPolicy/request` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:113` | `identityFromPolicy/request/callback@113` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxAccounts.vibe:116` | `identityFromPolicy/role` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxAccounts.vibe:117` | `identityFromPolicy/role/callback@117` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:9` | `open` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:10` | `open/callback@10` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:11` | `open/callback@11` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:13` | `open/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:14` | `open/read/callback@14` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:16` | `open/read/callback@16` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:18` | `open/receipt` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:19` | `open/receipt/callback@19` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:21` | `open/receipt/callback@21` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:23` | `open/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:23` | `open/write/callback@23` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:23` | `open/write/callback@23/callback@23` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:27` | `open/alarm` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sandboxes.vibe:27` | `open/alarm/callback@27` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:27` | `open/alarm/callback@27` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:31` | `runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Sandboxes.vibe:36` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxHttp.vibe:13` | `emptySnapshot` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxHttp.vibe:19` | `sandbox` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:20` | `startSandbox` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:21` | `stopSandbox` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:22` | `sandboxCommand` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:26` | `json` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:28` | `sandboxRequest` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxHttp.vibe:35` | `sandboxRequest/callback@35` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxHttp.vibe:40` | `sandboxRequest/callback@35/callback@40` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:41` | `sandboxRequest/callback@35/callback@41` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxHttp.vibe:48` | `sandboxRequest/callback@48` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:15` | `callback@15` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:18` | `callback@15/callback@18` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:20` | `callback@15/callback@18/callback@20` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:29` | `callback@15/callback@18/saved` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:29` | `callback@15/callback@18/saved/callback@29` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxMachine.vibe:30` | `callback@15/callback@18/apply` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:38` | `callback@15/callback@18/apply/callback@38` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:45` | `callback@15/callback@18/apply/callback@45` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxMachine.vibe:46` | `callback@15/callback@18/apply/start` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:50` | `callback@15/callback@18/apply/callback@50` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxMachine.vibe:65` | `callback@15/callback@18/apply/callback@65` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxMachine.vibe:68` | `callback@15/callback@18/apply/callback@68` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxMachine.vibe:72` | `callback@15/callback@18/apply/callback@72` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:75` | `callback@15/callback@18/apply/callback@72/callback@75` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:81` | `callback@15/callback@18/apply/callback@72/callback@81` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:89` | `callback@15/callback@18/apply/callback@89` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:92` | `callback@15/callback@18/apply/callback@89/callback@92` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxMachine.vibe:94` | `callback@15/callback@18/apply/callback@89/callback@94` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:99` | `callback@15/callback@18/apply` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxMachine.vibe:101` | `callback@15/callback@18/apply/callback@101` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxTools.vibe:14` | `startSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:15` | `stopSandbox` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:16` | `sandboxCommand` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:25` | `operation` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:26` | `operation/callback@26` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:28` | `declared` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:31` | `sandboxTools` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxTools.vibe:33` | `sandboxTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:34` | `sandboxTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:35` | `sandboxTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sequencer.vibe:43` | `attemptOf` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:44` | `attemptOf/callback@44` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:47` | `entryOf` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:48` | `entryOf/callback@48` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:52` | `make` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:57` | `make/state` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:61` | `make/state/callback@61` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:69` | `make/record` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:79` | `make/locked` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:84` | `make/ensureDispatched` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:93` | `make/accepted` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:94` | `make/accepted/callback@94` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:98` | `make/follow` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:99` | `make/follow/callback@99` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:102` | `make/follow/callback@99/callback@102` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:106` | `make/follow/callback@99/callback@106` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:112` | `make/settle` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:113` | `make/settle/callback@113` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:128` | `make/snapshot` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:129` | `make/allows` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:130` | `make/role` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:131` | `make/grant` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:131` | `make/grant/callback@131` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:141` | `make/post` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:142` | `make/post/callback@142` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:151` | `make/read` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:153` | `make/read/callback@153` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:153` | `make/read/callback@153` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:156` | `make/read/callback@156` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:164` | `make/history` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:170` | `make/start` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:172` | `make/start/callback@172` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:181` | `make/append` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:182` | `make/append/callback@182` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:192` | `make/restart` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:193` | `make/restart/callback@193` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:207` | `make/finish` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:208` | `make/finish/callback@208` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:216` | `make/finish/callback@216` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:220` | `make/fail` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:221` | `make/fail/callback@221` | pure logic | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:225` | `make/startTour` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:226` | `make/startTour/callback@226` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:235` | `make/endTour` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:236` | `make/endTour/callback@236` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:243` | `make/running` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:243` | `make/running/callback@243` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:246` | `make/open` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:249` | `make/say` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:249` | `make/say/callback@249` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:256` | `make/finishTour` | effectful shell | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:258` | `make/finishTour/callback@258` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:262` | `make/ended` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Sequencer.vibe:262` | `make/ended/callback@262` | wiring | Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved. |
| `worker/Tour.vibe:25` | `callback@25` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:39` | `prompt` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:45` | `guide` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:56` | `charged` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:57` | `charged/callback@57` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:58` | `charged/callback@57/callback@58` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:62` | `settle` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:68` | `spoken` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:77` | `spoken/callback@77` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:90` | `spoken/emit` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:90` | `spoken/emit/callback@90` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:107` | `callback@107` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:109` | `callback@107/callback@109` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/agent-context.vibe:11` | `callback@11` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `scripts/agent-context.vibe:17` | `generated` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/agent-context.vibe:33` | `generated/callback@33` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/agent-context.vibe:36` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/agent-context.vibe:41` | `main/callback@41` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `scripts/mythical-seed.vibe:37` | `log` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:38` | `log/callback@38` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:62` | `titlesOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:66` | `titlesOf/callback@66` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `scripts/mythical-seed.vibe:73` | `entriesOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:78` | `entriesOf/callback@78` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `scripts/mythical-seed.vibe:81` | `entriesOf/commitsOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:82` | `entriesOf/commitsOf/callback@82` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:82` | `entriesOf/commitsOf/callback@82` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `scripts/mythical-seed.vibe:84` | `entriesOf/callback@84` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:90` | `entriesOf/callback@84/callback@90` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:94` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:103` | `main/callback@103` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:104` | `main/callback@104` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:107` | `main/callback@107` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:108` | `main/callback@108` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `scripts/mythical-seed.vibe:110` | `main/callback@110` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
<!-- inventory:end -->
