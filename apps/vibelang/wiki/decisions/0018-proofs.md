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
| `src/core/conversation.vibe` | Conversation sequence, entry identity and correlation, at most one answer per post, terminal replies/tours ignore later text, exact streamed/finished/failed text, admissible intent completeness, pending posts, reply/tour guards and pane ownership | Integer sequences below MAX_SAFE_INTEGER; dense readonly arrays; UTF-16 strings |
| `worker/replyReasons.vibe` | Content policy → refused; credit and quota → credit; other model failures → unavailable. Agent precedence: unresolved seat, structured-output failure, model failure, generic failure | The observed tag and code are inputs; constant wording lookup and provider parsing are outside this decision |
| `worker/budgetDecision.vibe` | Strict admission, repeated charges add zero, exact nonnegative charge/total relation, and admission to the safe integer sum domain | Runtime guards now establish the integer domain; storage consistency, serialization and host rounding remain boundaries |
| `src/surfaces/commandDecision.vibe` | Own-post/reply correlation, exact event-number prefix/order, delta/restart/failure/finish accumulation, stream termination, outcome and error mapping | Effect stream execution, UUID generation, schema decoding and display formatting |
| `src/core/sequenceDecision.vibe` | First matching post prefix, every eligible source position exactly once in order, source role/text projection, exclusion of unfinished/failed/tour answers, and latest-turn window | The model call, storage and provider tokenization |
| `src/core/flowDecision.vibe` | Only accepted record dispatches; only matching attempt/offset appends; only the addressed terminal event ends a tour; repeated starts remain done; exact reading hold with a four-second floor and 200-word-per-minute rate | Durable engine journaling, scheduling, cancellation, storage and eventual completion are not proved |

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
ahead-of-cursor events, and exact pending membership after acknowledging a post. Stable pending order/multiplicity
and a full compositional equality with `apply` are still unproved; these are not implied by membership.
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

The applicability audit leaves explicit work: complete Posted fields and remaining conversation frames; ordered
pending removal and FIFO dispatch; the composed bound `conversation.seq <= retained log length`; decoding of
conversation storage rows before replay; replay of a maximum-capacity history snapshot with stale events; safe
UI epoch/scroll-intent exhaustion and fractional DOM coordinates. History-flow phase proofs do not establish
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

## Product defects

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
1325 executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.

| File and line | Function | Class | Proof or reason |
| --- | --- | --- | --- |
| `src/core/conversation.vibe:122` | `apply` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:167` | `apply/callback@167` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:174` | `apply/callback@174` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:182` | `apply/callback@182` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:191` | `apply/callback@191` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:208` | `apply/callback@208` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:224` | `tourEntry` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:233` | `isTouring` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:243` | `isTour` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:260` | `isReplying` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:269` | `hasClientId` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:287` | `hasEntryId` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:305` | `canReplyTo` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:352` | `accepted` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:358` | `refused` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:394` | `decide` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:475` | `post` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:499` | `failPost` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:502` | `failPost/callback@502` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:515` | `retryPost` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:516` | `retryPost/callback@516` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:532` | `receive` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:538` | `receive/callback@538` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:551` | `resume` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:572` | `rank` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:588` | `leastRole` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:600` | `may` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:610` | `roleOf` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:626` | `ungranted` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:640` | `otherMaintainer` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:658` | `canGrant` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:665` | `grantPolicy` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/flowDecision.vibe:6` | `dispatches` | pure logic | Dispatch admission, append ordering, tour terminal events and reading-time policy; proved. |
| `src/core/flowDecision.vibe:13` | `appends` | pure logic | Dispatch admission, append ordering, tour terminal events and reading-time policy; proved. |
| `src/core/flowDecision.vibe:20` | `endsTourEvent` | pure logic | Dispatch admission, append ordering, tour terminal events and reading-time policy; proved. |
| `src/core/flowDecision.vibe:29` | `startAnswer` | pure logic | Dispatch admission, append ordering, tour terminal events and reading-time policy; proved. |
| `src/core/flowDecision.vibe:39` | `readingHold` | pure logic | Dispatch admission, append ordering, tour terminal events and reading-time policy; proved. |
| `src/core/flows.vibe:31` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:39` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:43` | `replyIdOf` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:48` | `unanswered` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:52` | `unanswered/callback@52` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:51` | `unanswered/callback@51` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:70` | `posted` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:86` | `callback@86` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:88` | `callback@86/callback@88` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:97` | `docsPage` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:139` | `endsTour` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:144` | `touring` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:153` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:161` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:169` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:179` | `counted` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:185` | `startTour` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:194` | `endTour` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:197` | `endTour/callback@197` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:203` | `openDocs` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:212` | `say` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:221` | `readingMillis` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:227` | `narrate` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:230` | `narrate/callback@230` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:239` | `walk` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:252` | `toured` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:261` | `callback@261` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:263` | `callback@261/callback@263` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:264` | `callback@261/callback@264` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:284` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:289` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:294` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:299` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:301` | `callback@301` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:304` | `callback@301/callback@304` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:305` | `callback@301/callback@305` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:306` | `callback@301/callback@306` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:307` | `callback@301/callback@307` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved. |
| `src/core/LiveFactory.vibe:18` | `unavailable` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:19` | `unavailable/callback@19` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:23` | `health` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:32` | `refusable` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:42` | `LiveFactory` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:43` | `LiveFactory/callback@43` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:48` | `LiveFactory/callback@43/post` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:55` | `LiveFactory/callback@43/tour` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:60` | `LiveFactory/callback@43/endTour` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:65` | `LiveFactory/callback@43/sandbox` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:70` | `LiveFactory/callback@43/startSandbox` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:77` | `LiveFactory/callback@43/stopSandbox` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:84` | `LiveFactory/callback@43/sandboxCommand` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:93` | `LiveFactory/callback@43/read` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:100` | `LiveFactory/callback@43/events` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:101` | `LiveFactory/callback@43/events/callback@101` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:109` | `LiveFactory/callback@43/events/callback@101/callback@109` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:117` | `sandboxRefusal` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/mockDecision.vibe:7` | `matches` | pure logic | Exact keyword membership, first-match priority and fallback; proved for normalized prompts. |
| `src/core/mockDecision.vibe:25` | `scriptIndex` | pure logic | Exact keyword membership, first-match priority and fallback; proved for normalized prompts. |
| `src/core/MockFactory.vibe:55` | `scripted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:70` | `scripted/callback@70` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:85` | `scripted/callback@85` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:94` | `scripted/callback@94` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:95` | `scripted/callback@94/callback@95` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:87` | `scripted/callback@87` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:90` | `scripted/callback@90` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:109` | `cryptoOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:116` | `mockFactoryFor` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:117` | `mockFactoryFor/callback@117` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:127` | `mockFactoryFor/callback@117/callback@127` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:128` | `mockFactoryFor/callback@117/callback@127/callback@128` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:136` | `mockFactoryFor/callback@117/nextId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:137` | `mockFactoryFor/callback@117/nextId/callback@137` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:142` | `mockFactoryFor/callback@117/recorder` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:143` | `mockFactoryFor/callback@117/recorder/callback@143` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:143` | `mockFactoryFor/callback@117/recorder/callback@143/callback@143` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:144` | `mockFactoryFor/callback@117/recorder/callback@143/callback@143/callback@144` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:158` | `mockFactoryFor/callback@117/answer` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:170` | `mockFactoryFor/callback@117/answer/callback@170` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:178` | `mockFactoryFor/callback@117/openRoom` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:179` | `mockFactoryFor/callback@117/openRoom/callback@179` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:189` | `mockFactoryFor/callback@117/openRoom/callback@179/record` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:194` | `mockFactoryFor/callback@117/openRoom/callback@179/dispatch` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:199` | `mockFactoryFor/callback@117/openRoom/callback@179/accepted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:199` | `mockFactoryFor/callback@117/openRoom/callback@179/accepted/callback@199` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:201` | `mockFactoryFor/callback@117/openRoom/callback@179/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:205` | `mockFactoryFor/callback@117/openRoom/callback@179/dispatch` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:206` | `mockFactoryFor/callback@117/openRoom/callback@179/end` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:210` | `mockFactoryFor/callback@117/openRoom/callback@179/wake` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:214` | `mockFactoryFor/callback@117/openRoom/callback@179/running` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:214` | `mockFactoryFor/callback@117/openRoom/callback@179/running/callback@214` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:215` | `mockFactoryFor/callback@117/openRoom/callback@179/open` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:216` | `mockFactoryFor/callback@117/openRoom/callback@179/say` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:217` | `mockFactoryFor/callback@117/openRoom/callback@179/say/callback@217` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:220` | `mockFactoryFor/callback@117/openRoom/callback@179/finish` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:223` | `mockFactoryFor/callback@117/openRoom/callback@179/ended` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:223` | `mockFactoryFor/callback@117/openRoom/callback@179/ended/callback@223` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:227` | `mockFactoryFor/callback@117/openRoom/callback@179/ended/callback@223/callback@227` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:234` | `mockFactoryFor/callback@117/openRoom/callback@179/callback@234` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:236` | `mockFactoryFor/callback@117/openRoom/callback@179/callback@234/callback@236` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:237` | `mockFactoryFor/callback@117/openRoom/callback@179/callback@234/callback@237` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:237` | `mockFactoryFor/callback@117/openRoom/callback@179/callback@234/callback@237/callback@237` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:257` | `mockFactoryFor/callback@117/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:259` | `mockFactoryFor/callback@117/post/callback@259` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:263` | `mockFactoryFor/callback@117/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:265` | `mockFactoryFor/callback@117/tour/callback@265` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:269` | `mockFactoryFor/callback@117/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:271` | `mockFactoryFor/callback@117/endTour/callback@271` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:276` | `mockFactoryFor/callback@117/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:281` | `mockFactoryFor/callback@117/read/callback@281` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:281` | `mockFactoryFor/callback@117/read/callback@281` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:282` | `mockFactoryFor/callback@117/read/callback@282` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:284` | `mockFactoryFor/callback@117/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:285` | `mockFactoryFor/callback@117/events/callback@285` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:290` | `mockFactoryFor/callback@117/events/callback@285/callback@290` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:295` | `mockFactoryFor/callback@117/events/callback@285/callback@295` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:296` | `mockFactoryFor/callback@117/events/callback@285/callback@296` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/core/wire.vibe:44` | `conversationPath` | pure logic | Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts). |
| `src/core/wire.vibe:57` | `routeOf` | pure logic | Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts). |
| `src/core/wire.vibe:67` | `decodeSegment` | wiring | Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts). |
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
| `src/history/LiveMythical.vibe:51` | `LiveMythical/callback@23/outline` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:52` | `LiveMythical/callback@23/epic` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:53` | `LiveMythical/callback@23/commit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:54` | `LiveMythical/callback@23/search` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:55` | `LiveMythical/callback@23/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:56` | `LiveMythical/callback@23/events/callback@56` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:65` | `LiveMythical/callback@23/events/callback@56/callback@65` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:69` | `LiveMythical/callback@23/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:70` | `LiveMythical/callback@23/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:73` | `LiveMythical/callback@23/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:76` | `LiveMythical/callback@23/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:79` | `LiveMythical/callback@23/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/history/tools.vibe:33` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:45` | `requestOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:61` | `counted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:67` | `show` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:69` | `show/callback@69` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:80` | `answered` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:81` | `answered/callback@81` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:83` | `answered/callback@83` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:89` | `plan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:94` | `start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:99` | `note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:31` | `pageRequestOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:43` | `pathOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:53` | `historyRouteOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:55` | `historyRouteOf/callback@55` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:85` | `statusOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/surfaces/commands.vibe:30` | `ask` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:36` | `ask/callback@36` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:49` | `read` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:55` | `define` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:65` | `define/invoke` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:70` | `define/run` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:71` | `define/run/callback@71` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:79` | `define/render` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:89` | `callback@89` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:94` | `callback@94` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:95` | `callback@94/callback@95` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:144` | `brief` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:149` | `summaryOf` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:154` | `summaryOf/callback@154` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:164` | `summaryOf/callback@164` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:165` | `summaryOf/callback@165` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:171` | `showHistory` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:174` | `showHistory/callback@174` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:183` | `plan` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:197` | `start` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:202` | `note` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:212` | `callback@212` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:214` | `callback@212/callback@214` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:215` | `callback@212/callback@215` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:216` | `callback@212/callback@216` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:220` | `callback@212/callback@220` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:231` | `callback@231` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:236` | `callback@236` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:242` | `callback@242` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:250` | `callback@250` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:250` | `callback@250` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:251` | `callback@251` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:254` | `callback@254` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:255` | `callback@255` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:258` | `callback@258` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:259` | `callback@259` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:262` | `callback@262` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
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
| `src/web/backend.vibe:33` | `BrowserFactory/callback@14/post` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:37` | `BrowserFactory/callback@14/read` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:41` | `BrowserFactory/callback@14/events` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:41` | `BrowserFactory/callback@14/events/callback@41` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:45` | `BrowserFactory/callback@14/tour` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:49` | `BrowserFactory/callback@14/endTour` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:53` | `BrowserFactory/callback@14/sandbox` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:54` | `BrowserFactory/callback@14/startSandbox` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:55` | `BrowserFactory/callback@14/stopSandbox` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:56` | `BrowserFactory/callback@14/sandboxCommand` | effectful shell | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
| `src/web/backend.vibe:58` | `BrowserFactory/callback@14/callback@58` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
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
| `src/web/historyApp.vibe:239` | `update/UpdatedForm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:240` | `update/SubmittedPlan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:251` | `update/UpdatedLane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:252` | `update/ClickedStart` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:253` | `update/ClickedApprove` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:254` | `update/ClickedFold` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:255` | `update/UpdatedNoteSection` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:256` | `update/UpdatedNote` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:257` | `update/SubmittedNote` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:259` | `update/Wrote` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:263` | `update/FailedWrite` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:266` | `update/ReceivedEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:271` | `update/FailedEvents` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:272` | `update/PressedEscape` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:273` | `update/Settled` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:280` | `message` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:285` | `reasonOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:290` | `failedRead` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:297` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:298` | `execute/callback@298` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:299` | `execute/callback@299` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:306` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:307` | `execute/callback@307` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:308` | `execute/callback@308` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:315` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:316` | `execute/callback@316` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:317` | `execute/callback@317` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:324` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:325` | `execute/callback@325` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:326` | `execute/callback@326` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:335` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:336` | `execute/callback@336` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:337` | `execute/callback@337` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:344` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:345` | `execute/callback@345` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:346` | `execute/callback@346` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:354` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:356` | `execute/callback@356` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:357` | `execute/callback@357` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:364` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:366` | `execute/callback@366` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:368` | `execute/callback@368` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:369` | `execute/callback@369` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:374` | `settledMessage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:381` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:383` | `execute/callback@383` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:386` | `execute/callback@386` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:387` | `execute/callback@387` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:394` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:396` | `execute/callback@396` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:399` | `execute/callback@399` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:400` | `execute/callback@400` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:407` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:409` | `execute/callback@409` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:412` | `execute/callback@412` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:413` | `execute/callback@413` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:420` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:422` | `execute/callback@422` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:425` | `execute/callback@425` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:426` | `execute/callback@426` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:433` | `subscriptions` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:434` | `subscriptions/callback@434` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:439` | `subscriptions/callback@434/filterMapEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:447` | `subscriptions/callback@434/filterMapEvent` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:453` | `subscriptions/callback@434/modelToDependencies` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:454` | `subscriptions/callback@434/dependenciesToStream` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:455` | `subscriptions/callback@434/dependenciesToStream/callback@455` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:457` | `subscriptions/callback@434/dependenciesToStream/callback@455/callback@457` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:459` | `subscriptions/callback@434/dependenciesToStream/callback@455/callback@459` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:462` | `subscriptions/callback@434/dependenciesToStream/callback@455/callback@462` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:466` | `subscriptions/callback@434/dependenciesToStream/callback@455/callback@466` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:467` | `subscriptions/callback@434/dependenciesToStream/callback@455/callback@467` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/web/historyView.vibe:87` | `crumbs/callback@87` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/web/historyView.vibe:281` | `commitPage/callback@281` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/web/main.vibe:81` | `tourConversation` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:127` | `init` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:157` | `update` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:159` | `update/ResolvedMode` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:160` | `update/PressedCommandK` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:161` | `update/ClickedAsk` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:163` | `update/PressedEscape` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:172` | `update/ClickedLearnMore` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:173` | `update/ClickedEndTour` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:175` | `update/SucceededTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:177` | `update/FailedTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:179` | `update/FailedEndTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:180` | `update/ClickedSandboxes` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:181` | `update/MaximizedSandboxes` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:182` | `update/StartedSandbox` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:183` | `update/StoppedSandbox` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:184` | `update/UpdatedTerminal` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:185` | `update/SubmittedTerminal` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:186` | `update/LoadedSandbox` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:192` | `update/FailedSandbox` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:193` | `update/ClickedDocs` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:194` | `update/ClickedSplash` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:195` | `update/ClickedChat` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:196` | `update/UpdatedDraft` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:197` | `update/SubmittedDraft` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:198` | `update/SucceededPost` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:199` | `update/ClickedRetry` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:200` | `update/ClickedRetry/callback@200` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:207` | `update/FailedPost` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:208` | `update/ReceivedEvent` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:215` | `update/ReceivedEvent/callback@215` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:228` | `update/FailedEvents` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:229` | `update/ClickedReconnect` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:230` | `update/FocusedPrompt` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:231` | `update/ScrolledTranscript` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:236` | `update/ClickedLatest` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:244` | `learnMore` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:272` | `touringHere` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:277` | `endTour` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:281` | `openPalette` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:287` | `minimizeSplash` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:293` | `hasConversation` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:297` | `submit` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:320` | `message` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:333` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:334` | `execute/callback@334` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:336` | `execute/callback@336` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:344` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:347` | `execute/callback@347` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:348` | `execute/callback@348` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:356` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:358` | `execute/callback@358` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:360` | `execute/callback@360` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:361` | `execute/callback@361` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:368` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:370` | `execute/callback@370` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:373` | `execute/callback@373` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:374` | `execute/callback@374` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:382` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:384` | `execute/callback@384` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:387` | `execute/callback@387` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:388` | `execute/callback@388` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:399` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:401` | `execute/callback@401` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:404` | `execute/callback@404` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:405` | `execute/callback@405` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:412` | `keyMessage` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:420` | `subscriptions` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:422` | `subscriptions/scrolled` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:424` | `subscriptions/callback@424` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:429` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:443` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:449` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:455` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:461` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:466` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:467` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:472` | `subscriptions/callback@424/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:479` | `subscriptions/callback@424/modelToDependencies` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:486` | `subscriptions/callback@424/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:487` | `subscriptions/callback@424/dependenciesToStream/callback@487` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:489` | `subscriptions/callback@424/dependenciesToStream/callback@487/callback@489` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:491` | `subscriptions/callback@424/dependenciesToStream/callback@491` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:498` | `subscriptions/callback@424/modelToDependencies` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:499` | `subscriptions/callback@424/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:500` | `subscriptions/callback@424/dependenciesToStream/callback@500` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:502` | `subscriptions/callback@424/dependenciesToStream/callback@500/callback@502` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:504` | `subscriptions/callback@424/dependenciesToStream/callback@500/callback@502/callback@504` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:505` | `subscriptions/callback@424/dependenciesToStream/callback@500/callback@505` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:505` | `subscriptions/callback@424/dependenciesToStream/callback@500/callback@505/callback@505` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:506` | `subscriptions/callback@424/dependenciesToStream/callback@506` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:513` | `subscriptions/callback@424/modelToDependencies` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:519` | `subscriptions/callback@424/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:521` | `subscriptions/callback@424/dependenciesToStream/callback@521` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:523` | `subscriptions/callback@424/dependenciesToStream/callback@521/callback@523` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:525` | `subscriptions/callback@424/dependenciesToStream/callback@521/callback@525` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:527` | `subscriptions/callback@424/dependenciesToStream/callback@521/callback@527` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:530` | `subscriptions/callback@424/dependenciesToStream/callback@530` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:543` | `viewTransition` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:546` | `sandboxAction` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:554` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:556` | `execute/callback@556` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:557` | `execute/callback@556/callback@557` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:558` | `execute/callback@556/callback@558` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:561` | `execute/callback@556/callback@561` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:562` | `execute/callback@562` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:562` | `execute/callback@562/callback@562` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/markdown.vibe:11` | `blocks` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:17` | `blocks/flushProse` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:44` | `inline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:49` | `render` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:50` | `render/callback@50` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:53` | `render/callback@50/callback@53` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/web/startup.vibe:19` | `askedForMock` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:29` | `backendMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:30` | `backendMode/callback@30` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:31` | `backendMode/callback@30/callback@31` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:34` | `backendMode/callback@30/callback@31/callback@34` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:40` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:47` | `main/callback@47` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:54` | `main/callback@54` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:59` | `main/callback@59` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/styles.vibe:9` | `stylesheet` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/styles.vibe:10` | `stylesheet/callback@10` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:17` | `failureOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:21` | `view` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:45` | `logo` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:49` | `top` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:62` | `away` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:70` | `paneIcon` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:75` | `githubMark` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:83` | `splash` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:114` | `splashPane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:124` | `control` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:132` | `docsPane` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:135` | `docsPane/callback@135` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:155` | `chat` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:162` | `chat/callback@162` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:163` | `chat/callback@163` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:178` | `entryView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:195` | `pendingView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:207` | `ownPost` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:212` | `postFailure` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:223` | `promptInput` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:231` | `promptInput/callback@231` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:232` | `promptInput/callback@232` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:238` | `composer` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:253` | `statusText` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:263` | `palette` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `worker/AgentModel.vibe:44` | `chatModel` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/AgentModel.vibe:47` | `chatModel/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/AgentModel.vibe:48` | `chatModel/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:55` | `objectOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:56` | `objectOf/try` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:56` | `objectOf/catch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:60` | `reached` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:61` | `reached/callback@61` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:64` | `callback@64` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:67` | `callback@64/callback@67` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:69` | `callback@64/callback@67/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:73` | `callback@73` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:77` | `callback@73/callback@77` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:78` | `callback@73/callback@77/callback@78` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:85` | `callback@73/callback@77/page` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:85` | `callback@73/callback@77/page/callback@85` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:86` | `callback@73/callback@77/write` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:88` | `callback@73/callback@77/act` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:90` | `callback@73/callback@77/callback@90` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:98` | `callback@98` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:104` | `callback@98/callback@104` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:106` | `callback@98/callback@104/callback@106` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:109` | `callback@98/callback@104/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:112` | `callback@98/callback@104/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:113` | `callback@98/callback@104/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:115` | `callback@98/callback@104/callback@115` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:120` | `callback@98/callback@104/alarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:120` | `callback@98/callback@104/alarm/callback@120` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:123` | `callback@98/callback@104/alarm/callback@120/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:123` | `callback@98/callback@104/alarm/callback@120/admit/callback@123` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:127` | `callback@98/callback@104/alarm/callback@120/spend` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:127` | `callback@98/callback@104/alarm/callback@120/spend/callback@127` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:134` | `callback@98/callback@104/alarm/callback@120/callback@134` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:134` | `callback@98/callback@104/alarm/callback@120/callback@134/callback@134` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:138` | `callback@98/callback@104/alarm/callback@120/callback@138` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:138` | `callback@98/callback@104/alarm/callback@120/callback@138/callback@138` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:162` | `callback@162` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:170` | `callback@162/callback@170` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:173` | `callback@162/callback@170/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:173` | `callback@162/callback@170/post/callback@173` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:177` | `callback@162/callback@170/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:177` | `callback@162/callback@170/read/callback@177` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:181` | `callback@162/callback@170/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:181` | `callback@162/callback@170/tour/callback@181` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:185` | `callback@162/callback@170/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:185` | `callback@162/callback@170/endTour/callback@185` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:189` | `callback@162/callback@170/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:189` | `callback@162/callback@170/events/callback@189` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:196` | `callback@162/callback@170/page` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:200` | `callback@162/callback@170/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:204` | `callback@162/callback@170/events` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `worker/HistoryObject.vibe:90` | `readerOver` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:94` | `readerOver/read` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:95` | `readerOver/read/callback@95` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:96` | `readerOver/read/callback@96` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:98` | `readerOver/written` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:99` | `readerOver/written/callback@99` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:104` | `readerOver/outline` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:105` | `readerOver/epic` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:106` | `readerOver/commit` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:107` | `readerOver/search` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:108` | `readerOver/plan` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:109` | `readerOver/start` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:110` | `readerOver/note` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:118` | `history` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:123` | `runtime` | wiring | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:135` | `bootstrap` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:137` | `bootstrap/callback@137` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:153` | `write` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryObject.vibe:164` | `write/callback@164` | effectful shell | Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved. |
| `worker/HistoryTools.vibe:21` | `declared` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryTools.vibe:34` | `historyTools` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:36` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:37` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:38` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:41` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `worker/Http.vibe:119` | `answerHistory/callback@119` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:120` | `answerHistory/callback@120` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:127` | `handle` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:134` | `handle/callback@134` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:135` | `handle/callback@134/callback@135` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:143` | `handle/callback@143` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:144` | `handle/callback@143/callback@144` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
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
| `worker/Objects.vibe:31` | `executionIdOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:36` | `tourExecutionIdOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:40` | `dispatchedKey` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:43` | `executionStorage` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:45` | `executionStorage/get` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:45` | `executionStorage/get/callback@45` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:46` | `executionStorage/put` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:46` | `executionStorage/put/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:47` | `executionStorage/delete` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:47` | `executionStorage/delete/callback@47` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:48` | `executionStorage/setAlarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:48` | `executionStorage/setAlarm/callback@48` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:49` | `executionStorage/deleteAlarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:49` | `executionStorage/deleteAlarm/callback@49` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:58` | `dispatcher` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:61` | `dispatcher/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:63` | `dispatcher/tour/callback@63` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:66` | `dispatcher/tour/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:67` | `dispatcher/tour/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:70` | `dispatcher/tour/callback@70` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:72` | `dispatcher/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:74` | `dispatcher/start/callback@74` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:77` | `dispatcher/start/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:78` | `dispatcher/start/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:81` | `dispatcher/start/callback@81` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:89` | `conversation` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:94` | `budget` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:99` | `postsOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:104` | `toursOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:104` | `toursOf/callback@104` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:119` | `postExecutionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:126` | `wakeTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:128` | `wakeTour/callback@128` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:136` | `wakeTour/callback@136` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:148` | `tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:153` | `endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:157` | `asked` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:161` | `asked/callback@161` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:163` | `asked/callback@163` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:176` | `post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:186` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:198` | `repliesOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:211` | `start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:212` | `wake` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:222` | `alarm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:239` | `alarm/runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `worker/Reply.vibe:64` | `reasonOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:69` | `failureReason` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:95` | `dayOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:100` | `promptOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:108` | `promptOf/callback@108` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:130` | `tagOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:148` | `fold` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:172` | `agentOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:196` | `agentOf/resolve` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:216` | `respond` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:220` | `respond/emit` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:221` | `respond/callback@221` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:246` | `run` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:248` | `run/callback@248` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:256` | `compose` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:265` | `compose/callback@265` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:297` | `answer` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:305` | `answer/callback@305` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:316` | `answer/callback@316` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:323` | `answer/callback@323` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:332` | `callback@332` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:334` | `callback@332/callback@334` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
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
| `worker/SandboxTools.vibe:22` | `operation` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:23` | `operation/callback@23` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:25` | `declared` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:28` | `sandboxTools` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/SandboxTools.vibe:30` | `sandboxTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:31` | `sandboxTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/SandboxTools.vibe:32` | `sandboxTools/handler` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Sequencer.vibe:42` | `attemptOf` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:43` | `attemptOf/callback@43` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:46` | `entryOf` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:47` | `entryOf/callback@47` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:51` | `make` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:56` | `make/state` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:66` | `make/record` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:76` | `make/locked` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:81` | `make/ensureDispatched` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:90` | `make/accepted` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:91` | `make/accepted/callback@91` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:95` | `make/follow` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:96` | `make/follow/callback@96` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:99` | `make/follow/callback@96/callback@99` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:103` | `make/follow/callback@96/callback@103` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:109` | `make/settle` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:110` | `make/settle/callback@110` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:130` | `make/post` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:131` | `make/post/callback@131` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:140` | `make/read` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:142` | `make/read/callback@142` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:142` | `make/read/callback@142` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:145` | `make/read/callback@145` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:153` | `make/history` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:159` | `make/start` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:161` | `make/start/callback@161` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:170` | `make/append` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:171` | `make/append/callback@171` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:181` | `make/restart` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:182` | `make/restart/callback@182` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:196` | `make/finish` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:197` | `make/finish/callback@197` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:205` | `make/finish/callback@205` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:209` | `make/fail` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:210` | `make/fail/callback@210` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:214` | `make/startTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:215` | `make/startTour/callback@215` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:224` | `make/endTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:225` | `make/endTour/callback@225` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:232` | `make/running` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:232` | `make/running/callback@232` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:235` | `make/open` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:238` | `make/say` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:238` | `make/say/callback@238` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:245` | `make/finishTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:247` | `make/finishTour/callback@247` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:251` | `make/ended` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:251` | `make/ended/callback@251` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
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
