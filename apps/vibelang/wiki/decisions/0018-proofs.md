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
| `src/core/mockDecision.vibe` | Keyword membership, first matching script and fallback only if none matches | Input is already normalized; Unicode casing and script constants are outside the proof |
| `src/core/protocolDecision.vibe` | Conversation/body length bounds; nonempty CLI/MCP identifiers and nonnegative cursors; exact method/subroute mapping; HTTP refusal/success; mock/live choice | Integer schema and URI/JSON/Schema decoding remain runtime boundaries; schema annotations are preserved |
| `src/web/screenDecision.vibe` | Escape priority, palette focus choice, minimizing eligibility, docs toggle, scroll revision/pausing/following, tour stream cursor, completion announcements and keyboard decisions | Dafny models numbers as integers. Fractional DOM coordinates, IEEE-754 arithmetic, native DOM effects and actual focus restoration are tested, not proved |
| `src/core/conversation.vibe` | Conversation sequence, entry identity and correlation, at most one answer per post, terminal replies/tours ignore later text, exact streamed/finished/failed text, admissible intent completeness, pending posts, reply/tour guards and pane ownership | Integer sequences below MAX_SAFE_INTEGER; dense readonly arrays; UTF-16 strings |
| `worker/replyReasons.vibe` | Content policy → refused; credit and quota → credit; other model failures → unavailable. Agent precedence: unresolved seat, structured-output failure, model failure, generic failure | The observed tag and code are inputs; constant wording lookup and provider parsing are outside this decision |
| `worker/budgetDecision.vibe` | Strict budget admission; repeated charges add zero; a new charge is nonnegative and total increases by exactly that charge | Nonnegative integer values and a safe sum; storage serialization and floating-point normalization are not proved |
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

## Product defects

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
1051 executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.

| File and line | Function | Class | Proof or reason |
| --- | --- | --- | --- |
| `src/core/conversation.vibe:118` | `apply` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:158` | `apply/callback@158` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:165` | `apply/callback@165` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:173` | `apply/callback@173` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:182` | `apply/callback@182` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:199` | `apply/callback@199` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:215` | `tourEntry` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:224` | `isTouring` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:234` | `isTour` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:251` | `isReplying` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:260` | `hasClientId` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:278` | `hasEntryId` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:296` | `canReplyTo` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:341` | `accepted` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:347` | `refused` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:380` | `decide` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:455` | `post` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:479` | `failPost` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:482` | `failPost/callback@482` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:495` | `retryPost` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:496` | `retryPost/callback@496` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:507` | `receive` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:513` | `receive/callback@513` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:524` | `resume` | pure logic | Production state machine; contracts and executable mutations. |
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
| `src/core/LiveFactory.vibe:17` | `unavailable` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:18` | `unavailable/callback@18` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:22` | `health` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:31` | `refusable` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:41` | `LiveFactory` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:42` | `LiveFactory/callback@42` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:47` | `LiveFactory/callback@42/post` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:54` | `LiveFactory/callback@42/tour` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:59` | `LiveFactory/callback@42/endTour` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:64` | `LiveFactory/callback@42/read` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:71` | `LiveFactory/callback@42/events` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:72` | `LiveFactory/callback@42/events/callback@72` | effectful shell | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/LiveFactory.vibe:80` | `LiveFactory/callback@42/events/callback@72/callback@80` | wiring | HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts). |
| `src/core/mockDecision.vibe:7` | `matches` | pure logic | Exact keyword membership, first-match priority and fallback; proved for normalized prompts. |
| `src/core/mockDecision.vibe:25` | `scriptIndex` | pure logic | Exact keyword membership, first-match priority and fallback; proved for normalized prompts. |
| `src/core/MockFactory.vibe:53` | `scripted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:66` | `scripted/callback@66` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:81` | `scripted/callback@81` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:87` | `scripted/callback@87` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:88` | `scripted/callback@87/callback@88` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:102` | `cryptoOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:109` | `callback@109` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:118` | `callback@109/callback@118` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:119` | `callback@109/callback@118/callback@119` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:127` | `callback@109/nextId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:128` | `callback@109/nextId/callback@128` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:133` | `callback@109/recorder` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:134` | `callback@109/recorder/callback@134` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:134` | `callback@109/recorder/callback@134/callback@134` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:135` | `callback@109/recorder/callback@134/callback@134/callback@135` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:149` | `callback@109/answer` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:161` | `callback@109/answer/callback@161` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:169` | `callback@109/openRoom` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:170` | `callback@109/openRoom/callback@170` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:180` | `callback@109/openRoom/callback@170/record` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:185` | `callback@109/openRoom/callback@170/dispatch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:190` | `callback@109/openRoom/callback@170/accepted` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:190` | `callback@109/openRoom/callback@170/accepted/callback@190` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:192` | `callback@109/openRoom/callback@170/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:196` | `callback@109/openRoom/callback@170/dispatch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:197` | `callback@109/openRoom/callback@170/end` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:201` | `callback@109/openRoom/callback@170/wake` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:205` | `callback@109/openRoom/callback@170/running` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:205` | `callback@109/openRoom/callback@170/running/callback@205` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:206` | `callback@109/openRoom/callback@170/open` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:207` | `callback@109/openRoom/callback@170/say` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:208` | `callback@109/openRoom/callback@170/say/callback@208` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:211` | `callback@109/openRoom/callback@170/finish` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:214` | `callback@109/openRoom/callback@170/ended` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:214` | `callback@109/openRoom/callback@170/ended/callback@214` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:218` | `callback@109/openRoom/callback@170/ended/callback@214/callback@218` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:225` | `callback@109/openRoom/callback@170/callback@225` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:227` | `callback@109/openRoom/callback@170/callback@225/callback@227` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:228` | `callback@109/openRoom/callback@170/callback@225/callback@228` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:228` | `callback@109/openRoom/callback@170/callback@225/callback@228/callback@228` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:248` | `callback@109/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:250` | `callback@109/post/callback@250` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:254` | `callback@109/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:256` | `callback@109/tour/callback@256` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:260` | `callback@109/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:262` | `callback@109/endTour/callback@262` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:266` | `callback@109/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:271` | `callback@109/read/callback@271` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:271` | `callback@109/read/callback@271` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:272` | `callback@109/read/callback@272` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:274` | `callback@109/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:275` | `callback@109/events/callback@275` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:280` | `callback@109/events/callback@275/callback@280` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:285` | `callback@109/events/callback@275/callback@285` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:286` | `callback@109/events/callback@275/callback@286` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/history/MockMythical.vibe:32` | `mockMain/since` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:32` | `mockMain/since/callback@32` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:35` | `mockMain/since/callback@32/callback@35` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:34` | `mockMain/since/callback@32/callback@34` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:45` | `digestOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:52` | `MockMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:53` | `MockMythical/callback@53` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:68` | `MockMythical/callback@53/executionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:69` | `MockMythical/callback@53/executionId/callback@69` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:76` | `MockMythical/callback@53/paged` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/history/mythical.vibe:134` | `apply` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:147` | `apply/callback@147` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:166` | `apply/callback@166` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:170` | `apply/callback@170` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:177` | `apply/callback@177` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:184` | `apply/callback@184` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:191` | `apply/callback@191` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:199` | `amended` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:206` | `started` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:215` | `approved` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:224` | `noted` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:231` | `landed` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:240` | `hasEpic` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:258` | `hasCommit` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:276` | `hasSha` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:291` | `isIn` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:305` | `taskOf` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:318` | `epicOf` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:331` | `rankOf` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:346` | `endOf` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:370` | `foldTarget` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:402` | `accepted` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:407` | `refused` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
| `src/history/mythical.vibe:423` | `decide` | pure logic | Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020). |
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
| `src/history/seed.vibe:30` | `bucketsOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:33` | `bucketsOf/callback@33` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:34` | `bucketsOf/callback@34` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:52` | `bucketsOf/callback@52` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:199` | `scopeOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:210` | `areaOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:224` | `sanitize` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/history/Sequencer.vibe:56` | `trailerOf` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:61` | `answered` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:66` | `make` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:71` | `make/current` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:81` | `make/record` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:91` | `make/locked` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:96` | `make/openEpic` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:102` | `make/planned` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:109` | `make/read` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:112` | `make/follow` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:113` | `make/follow/callback@113` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:115` | `make/follow/callback@113/callback@115` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:119` | `make/follow/callback@113/callback@119` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:123` | `make/follow/callback@113/callback@123` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:128` | `make/record` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:131` | `make/plan` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:132` | `make/plan/callback@132` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:163` | `make/fold` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:164` | `make/fold/callback@164` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:174` | `make/fold/callback@164/callback@174` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:188` | `make/bootstrap` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:189` | `make/bootstrap/callback@189` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:202` | `stackOf` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:203` | `stackOf/recorded` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:203` | `stackOf/recorded/callback@203` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:207` | `stackOf/start` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:208` | `stackOf/note` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:209` | `stackOf/approve` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:211` | `stackOf/bootstrap` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:219` | `memoryStore` | effectful shell | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:222` | `memoryStore/load` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:223` | `memoryStore/since` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:223` | `memoryStore/since/callback@223` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:223` | `memoryStore/since/callback@223/callback@223` | pure logic | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:224` | `memoryStore/append` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:224` | `memoryStore/append/callback@224` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/Sequencer.vibe:225` | `memoryStore/seed` | wiring | Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020). |
| `src/history/tools.vibe:33` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:45` | `requestOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:61` | `counted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:67` | `show` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:69` | `show/callback@69` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:80` | `answered` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:81` | `answered/callback@81` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:83` | `answered/callback@83` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/tools.vibe:89` | `plan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:94` | `start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/tools.vibe:99` | `note` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/surfaces/cli.vibe:10` | `run` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:13` | `commandFor` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:14` | `commandFor/callback@14` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:23` | `cli` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:26` | `cli/callback@26` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:29` | `cli/callback@29` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:29` | `ask` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:40` | `ask/callback@40` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:59` | `read` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:65` | `define` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:75` | `define/invoke` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:80` | `define/run` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:81` | `define/run/callback@81` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:89` | `define/render` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:99` | `callback@99` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:104` | `callback@104` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:105` | `callback@104/callback@105` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:154` | `brief` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:159` | `summaryOf` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:164` | `summaryOf/callback@164` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:174` | `summaryOf/callback@174` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:175` | `summaryOf/callback@175` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:181` | `showHistory` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:184` | `showHistory/callback@184` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:193` | `plan` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:207` | `start` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:212` | `note` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:222` | `callback@222` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:224` | `callback@222/callback@224` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:225` | `callback@222/callback@225` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:226` | `callback@222/callback@226` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:230` | `callback@222/callback@230` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:241` | `callback@241` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:246` | `callback@246` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:252` | `callback@252` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/manifest.vibe:8` | `callback@8` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/manifest.vibe:22` | `callback@22` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp-entry.vibe:10` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:7` | `callback@7` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/mcp.vibe:9` | `callback@9` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:13` | `callback@9/callback@13` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/mcp.vibe:13` | `callback@9/callback@13/callback@13` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:20` | `serve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:29` | `mcp` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:31` | `mcp/callback@31` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/web/backend.vibe:54` | `BrowserFactory/callback@14/callback@54` | wiring | Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior. |
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
| `src/web/historyApp.vibe:434` | `subscriptions/callback@434` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:439` | `subscriptions/callback@434/filterMapEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:447` | `subscriptions/callback@434/filterMapEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/web/historyBackend.vibe:39` | `BrowserMythical/callback@18/events` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:39` | `BrowserMythical/callback@18/events/callback@39` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:40` | `BrowserMythical/callback@18/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:41` | `BrowserMythical/callback@18/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:42` | `BrowserMythical/callback@18/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:43` | `BrowserMythical/callback@18/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:44` | `BrowserMythical/callback@18/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:46` | `BrowserMythical/callback@18/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:15` | `askedForMock` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:25` | `mockRole` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:34` | `mockRole/callback@34` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:37` | `backendMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:38` | `backendMode/callback@38` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:39` | `backendMode/callback@38/callback@39` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:41` | `backendMode/callback@38/callback@39/callback@41` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyStartup.vibe:47` | `historyMain` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:52` | `historyMain/callback@52` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyStartup.vibe:66` | `historyMain/callback@66` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/web/historyView.vibe:222` | `epicPage` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:239` | `commitPage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:240` | `commitPage/callback@240` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:242` | `commitPage/section` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:247` | `commitPage/notes` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:248` | `commitPage/notes/callback@248` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:248` | `commitPage/notes/callback@248` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:280` | `commitPage/callback@280` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:294` | `timeline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:297` | `timeline/step` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:304` | `timeline/callback@304` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:319` | `noteForm` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:321` | `noteForm/callback@321` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:326` | `noteForm/callback@326` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:333` | `plan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:345` | `plan/callback@345` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:352` | `plan/callback@352` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:353` | `plan/callback@353` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:360` | `plan/callback@360` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:370` | `plan/callback@370` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:69` | `tourConversation` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:107` | `init` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:137` | `update` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:139` | `update/ResolvedMode` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:140` | `update/PressedCommandK` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:141` | `update/ClickedAsk` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:143` | `update/PressedEscape` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:151` | `update/ClickedLearnMore` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:152` | `update/ClickedEndTour` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:154` | `update/SucceededTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:156` | `update/FailedTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:158` | `update/FailedEndTour` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:159` | `update/ClickedDocs` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:160` | `update/ClickedSplash` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:161` | `update/ClickedChat` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:162` | `update/UpdatedDraft` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:163` | `update/SubmittedDraft` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:164` | `update/SucceededPost` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:165` | `update/ClickedRetry` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:166` | `update/ClickedRetry/callback@166` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:173` | `update/FailedPost` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:174` | `update/ReceivedEvent` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:181` | `update/ReceivedEvent/callback@181` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:194` | `update/FailedEvents` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:195` | `update/ClickedReconnect` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:196` | `update/FocusedPrompt` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:197` | `update/ScrolledTranscript` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:202` | `update/ClickedLatest` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:210` | `learnMore` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:238` | `touringHere` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:243` | `endTour` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:247` | `openPalette` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:253` | `minimizeSplash` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:259` | `hasConversation` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:263` | `submit` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:287` | `message` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:300` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:301` | `execute/callback@301` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:303` | `execute/callback@303` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:311` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:314` | `execute/callback@314` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:315` | `execute/callback@315` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:323` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:325` | `execute/callback@325` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:327` | `execute/callback@327` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:328` | `execute/callback@328` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:335` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:337` | `execute/callback@337` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:340` | `execute/callback@340` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:341` | `execute/callback@341` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:349` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:351` | `execute/callback@351` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:354` | `execute/callback@354` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:355` | `execute/callback@355` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:366` | `execute` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:368` | `execute/callback@368` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:371` | `execute/callback@371` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:372` | `execute/callback@372` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:379` | `keyMessage` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:387` | `subscriptions` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:389` | `subscriptions/scrolled` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:391` | `subscriptions/callback@391` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:396` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:410` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:416` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:422` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:428` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:433` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:434` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:439` | `subscriptions/callback@391/filterMapEvent` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:446` | `subscriptions/callback@391/modelToDependencies` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:453` | `subscriptions/callback@391/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:454` | `subscriptions/callback@391/dependenciesToStream/callback@454` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:456` | `subscriptions/callback@391/dependenciesToStream/callback@454/callback@456` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:458` | `subscriptions/callback@391/dependenciesToStream/callback@458` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:465` | `subscriptions/callback@391/modelToDependencies` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:471` | `subscriptions/callback@391/dependenciesToStream` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:473` | `subscriptions/callback@391/dependenciesToStream/callback@473` | effectful shell | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:475` | `subscriptions/callback@391/dependenciesToStream/callback@473/callback@475` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:477` | `subscriptions/callback@391/dependenciesToStream/callback@473/callback@477` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:479` | `subscriptions/callback@391/dependenciesToStream/callback@473/callback@479` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:482` | `subscriptions/callback@391/dependenciesToStream/callback@482` | wiring | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/main.vibe:495` | `viewTransition` | pure logic | Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved. |
| `src/web/markdown.vibe:11` | `blocks` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:17` | `blocks/flushProse` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:44` | `inline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:49` | `render` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:50` | `render/callback@50` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:53` | `render/callback@50/callback@53` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/web/startup.vibe:18` | `askedForMock` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:28` | `backendMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:29` | `backendMode/callback@29` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:30` | `backendMode/callback@29/callback@30` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:33` | `backendMode/callback@29/callback@30/callback@33` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:39` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:46` | `main/callback@46` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:56` | `main/callback@56` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/styles.vibe:9` | `stylesheet` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/styles.vibe:10` | `stylesheet/callback@10` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:16` | `failureOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:20` | `view` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:44` | `logo` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:48` | `top` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:61` | `away` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:69` | `paneIcon` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:74` | `githubMark` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:82` | `splash` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:113` | `splashPane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:123` | `control` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:131` | `docsPane` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:134` | `docsPane/callback@134` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:154` | `chat` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:160` | `chat/callback@160` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:161` | `chat/callback@161` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:176` | `entryView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:193` | `pendingView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:205` | `ownPost` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:210` | `postFailure` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:221` | `promptInput` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:229` | `promptInput/callback@229` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:230` | `promptInput/callback@230` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:236` | `composer` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:251` | `statusText` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:261` | `palette` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:4` | `atBottom` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:11` | `transcriptViewport` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:16` | `transcriptViewport/active` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:20` | `transcriptViewport/position` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:21` | `transcriptViewport/scrollable` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:22` | `transcriptViewport/pause` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:30` | `transcriptViewport/wheel` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:31` | `transcriptViewport/key` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:38` | `transcriptViewport/touchStart` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:42` | `transcriptViewport/touchMove` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:43` | `transcriptViewport/touchMove/callback@43` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:49` | `transcriptViewport/touchEnd` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:50` | `transcriptViewport/scrolled` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `src/web/viewport.vibe:60` | `transcriptViewport/follow` | pure logic | Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries. |
| `worker/AgentModel.vibe:44` | `chatModel` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/AgentModel.vibe:47` | `chatModel/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/AgentModel.vibe:48` | `chatModel/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:54` | `objectOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:55` | `objectOf/try` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:55` | `objectOf/catch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:59` | `reached` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:60` | `reached/callback@60` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:63` | `callback@63` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:66` | `callback@63/callback@66` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:68` | `callback@63/callback@66/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:72` | `callback@72` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:76` | `callback@72/callback@76` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:77` | `callback@72/callback@76/callback@77` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:84` | `callback@72/callback@76/page` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:84` | `callback@72/callback@76/page/callback@84` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:85` | `callback@72/callback@76/write` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:87` | `callback@72/callback@76/act` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:89` | `callback@72/callback@76/callback@89` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:97` | `callback@97` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:103` | `callback@97/callback@103` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:105` | `callback@97/callback@103/callback@105` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:108` | `callback@97/callback@103/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:111` | `callback@97/callback@103/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:112` | `callback@97/callback@103/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:114` | `callback@97/callback@103/callback@114` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:119` | `callback@97/callback@103/alarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:119` | `callback@97/callback@103/alarm/callback@119` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:122` | `callback@97/callback@103/alarm/callback@119/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:122` | `callback@97/callback@103/alarm/callback@119/admit/callback@122` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:126` | `callback@97/callback@103/alarm/callback@119/spend` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:126` | `callback@97/callback@103/alarm/callback@119/spend/callback@126` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:133` | `callback@97/callback@103/alarm/callback@119/callback@133` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:133` | `callback@97/callback@103/alarm/callback@119/callback@133/callback@133` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:137` | `callback@97/callback@103/alarm/callback@119/callback@137` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:137` | `callback@97/callback@103/alarm/callback@119/callback@137/callback@137` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:161` | `callback@161` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:168` | `callback@161/callback@168` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:171` | `callback@161/callback@168/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:171` | `callback@161/callback@168/post/callback@171` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:175` | `callback@161/callback@168/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:175` | `callback@161/callback@168/read/callback@175` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:179` | `callback@161/callback@168/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:179` | `callback@161/callback@168/tour/callback@179` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:183` | `callback@161/callback@168/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:183` | `callback@161/callback@168/endTour/callback@183` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:187` | `callback@161/callback@168/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:187` | `callback@161/callback@168/events/callback@187` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:194` | `callback@161/callback@168/page` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:198` | `callback@161/callback@168/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:202` | `callback@161/callback@168/events` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Budget.vibe:15` | `replyKey` | wiring | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:24` | `make` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:28` | `make/admit` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:35` | `make/spend` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:36` | `make/spend/callback@36` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/budgetDecision.vibe:7` | `admits` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/budgetDecision.vibe:19` | `charge` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/HistoryObject.vibe:34` | `seeded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:39` | `storeOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:41` | `storeOver/load` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:42` | `storeOver/load/callback@42` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:45` | `storeOver/load/callback@45` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:48` | `storeOver/load/callback@48` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:51` | `storeOver/since` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:52` | `storeOver/since/callback@52` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:55` | `storeOver/append` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:56` | `storeOver/append/callback@56` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:58` | `storeOver/seed` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:59` | `storeOver/seed/callback@59` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:68` | `storeOver/seed/callback@68` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:68` | `storeOver/seed/callback@68/callback@68` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:70` | `storeOver/seed/callback@70` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:76` | `principalOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:91` | `readerOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:95` | `readerOver/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:96` | `readerOver/read/callback@96` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:97` | `readerOver/read/callback@97` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:99` | `readerOver/written` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:100` | `readerOver/written/callback@100` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:105` | `readerOver/outline` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:106` | `readerOver/epic` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:107` | `readerOver/commit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:108` | `readerOver/search` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:109` | `readerOver/plan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:110` | `readerOver/start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:111` | `readerOver/note` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:119` | `history` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:124` | `runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:136` | `bootstrap` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:138` | `bootstrap/callback@138` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:154` | `write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:165` | `write/callback@165` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryTools.vibe:21` | `declared` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryTools.vibe:34` | `historyTools` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:36` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:37` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:38` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryTools.vibe:41` | `historyTools/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Http.vibe:53` | `eventStream` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:54` | `eventStream/callback@54` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:57` | `eventStream/callback@57` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:58` | `eventStream/callback@58` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:65` | `afterOf` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:72` | `json` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:76` | `answer` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:81` | `answer/callback@81` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:82` | `answer/callback@82` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:98` | `decodeWrite` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:109` | `answerHistory` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:118` | `answerHistory/callback@118` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:119` | `answerHistory/callback@119` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:126` | `handle` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:132` | `handle/callback@132` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:133` | `handle/callback@132/callback@133` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:141` | `handle/callback@141` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:142` | `handle/callback@141/callback@142` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
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
| `worker/Objects.vibe:161` | `asked/callback@161` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `worker/Reply.vibe:62` | `reasonOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:67` | `failureReason` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:93` | `dayOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:98` | `promptOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:106` | `promptOf/callback@106` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:128` | `tagOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:146` | `fold` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:170` | `agentOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:194` | `agentOf/resolve` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:214` | `respond` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:218` | `respond/emit` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:219` | `respond/callback@219` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:244` | `run` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:253` | `compose` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:262` | `compose/callback@262` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:294` | `answer` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:302` | `answer/callback@302` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:313` | `answer/callback@313` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:320` | `answer/callback@320` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:329` | `callback@329` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:331` | `callback@329/callback@331` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/replyReasons.vibe:9` | `reasonCode` | pure logic | Failure precedence and model reason codes; proved. |
| `worker/replyReasons.vibe:22` | `failureCode` | pure logic | Failure precedence and model reason codes; proved. |
| `worker/Sequencer.vibe:41` | `attemptOf` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:42` | `attemptOf/callback@42` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:45` | `entryOf` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:46` | `entryOf/callback@46` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:50` | `make` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:55` | `make/state` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:65` | `make/record` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:75` | `make/locked` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:80` | `make/ensureDispatched` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:89` | `make/accepted` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:90` | `make/accepted/callback@90` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:94` | `make/follow` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:95` | `make/follow/callback@95` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:98` | `make/follow/callback@95/callback@98` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:102` | `make/follow/callback@95/callback@102` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:108` | `make/settle` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:109` | `make/settle/callback@109` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:129` | `make/post` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:130` | `make/post/callback@130` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:139` | `make/read` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:141` | `make/read/callback@141` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:141` | `make/read/callback@141` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:144` | `make/read/callback@144` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:152` | `make/history` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:164` | `make/start` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:166` | `make/start/callback@166` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:175` | `make/append` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:176` | `make/append/callback@176` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:186` | `make/restart` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:187` | `make/restart/callback@187` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:201` | `make/finish` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:202` | `make/finish/callback@202` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:210` | `make/finish/callback@210` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:214` | `make/fail` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:215` | `make/fail/callback@215` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:219` | `make/startTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:220` | `make/startTour/callback@220` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:229` | `make/endTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:230` | `make/endTour/callback@230` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:237` | `make/running` | pure logic | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:237` | `make/running/callback@237` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:240` | `make/open` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:243` | `make/say` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:243` | `make/say/callback@243` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:250` | `make/finishTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:252` | `make/finishTour/callback@252` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:256` | `make/ended` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:256` | `make/ended/callback@256` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Tour.vibe:25` | `callback@25` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:39` | `prompt` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:45` | `guide` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:56` | `charged` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:57` | `charged/callback@57` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:58` | `charged/callback@57/callback@58` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:62` | `settle` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:68` | `spoken` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:77` | `spoken/callback@77` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:90` | `spoken/emit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:90` | `spoken/emit/callback@90` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:107` | `callback@107` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:109` | `callback@107/callback@109` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
