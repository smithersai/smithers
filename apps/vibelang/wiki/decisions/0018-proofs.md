# 0018. Proofs of all app decisions

**Status:** in progress, 2026-11-07. **Rulings:** VL-9, VL-29. Lane `vl-proveall`.

The proof consumes production VibeLang modules in LemmaScript's plain TypeScript subset, with unchanged `//@`
contracts. Effect shells call those same decisions. The harness discovers every marked module under `src/`,
`worker/` and `scripts/`; omission of an emitted marked function fails. Mutations change executable text only,
strictly typecheck, and must fail a Dafny obligation in their named function. Tool errors never count as rejection.

## Proofs and boundaries

| Production module | What is proved | Boundary |
| --- | --- | --- |
| `src/history/mythical.vibe` | Inherited contracts for numbered history events, identity/rank uniqueness, epic membership and preservation of real-commit prefixes (0020) | Mutation coverage and complete transition outcomes are being extended |
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
952 executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.

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
| `src/core/MockFactory.vibe:46` | `scripted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:53` | `scripted/callback@53` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:68` | `scripted/callback@68` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:78` | `cryptoOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:85` | `callback@85` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:97` | `callback@85/nextId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:98` | `callback@85/nextId/callback@98` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:103` | `callback@85/recorder` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:104` | `callback@85/recorder/callback@104` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:104` | `callback@85/recorder/callback@104/callback@104` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:105` | `callback@85/recorder/callback@104/callback@104/callback@105` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:119` | `callback@85/answer` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:131` | `callback@85/answer/callback@131` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:139` | `callback@85/openRoom` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:140` | `callback@85/openRoom/callback@140` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:150` | `callback@85/openRoom/callback@140/record` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:155` | `callback@85/openRoom/callback@140/dispatch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:160` | `callback@85/openRoom/callback@140/accepted` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:160` | `callback@85/openRoom/callback@140/accepted/callback@160` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:162` | `callback@85/openRoom/callback@140/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:166` | `callback@85/openRoom/callback@140/dispatch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:167` | `callback@85/openRoom/callback@140/end` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:171` | `callback@85/openRoom/callback@140/wake` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:175` | `callback@85/openRoom/callback@140/running` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:175` | `callback@85/openRoom/callback@140/running/callback@175` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:176` | `callback@85/openRoom/callback@140/open` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:177` | `callback@85/openRoom/callback@140/say` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:178` | `callback@85/openRoom/callback@140/say/callback@178` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:181` | `callback@85/openRoom/callback@140/finish` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:184` | `callback@85/openRoom/callback@140/ended` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:184` | `callback@85/openRoom/callback@140/ended/callback@184` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:188` | `callback@85/openRoom/callback@140/ended/callback@184/callback@188` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:195` | `callback@85/openRoom/callback@140/callback@195` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:197` | `callback@85/openRoom/callback@140/callback@195/callback@197` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:198` | `callback@85/openRoom/callback@140/callback@195/callback@198` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:198` | `callback@85/openRoom/callback@140/callback@195/callback@198/callback@198` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:218` | `callback@85/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:220` | `callback@85/post/callback@220` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:224` | `callback@85/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:226` | `callback@85/tour/callback@226` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:230` | `callback@85/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:232` | `callback@85/endTour/callback@232` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:236` | `callback@85/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:241` | `callback@85/read/callback@241` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:241` | `callback@85/read/callback@241` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:242` | `callback@85/read/callback@242` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:244` | `callback@85/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:245` | `callback@85/events/callback@245` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:250` | `callback@85/events/callback@245/callback@250` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:255` | `callback@85/events/callback@245/callback@255` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:256` | `callback@85/events/callback@245/callback@256` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/mockReplies.vibe:121` | `callback@121` | wiring | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:151` | `mockReply` | pure logic | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
| `src/core/mockReplies.vibe:157` | `chunks` | pure logic | First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction). |
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
| `src/history/flows.vibe:57` | `counted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:63` | `signature` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:68` | `authorized` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:75` | `guarded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:95` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:103` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:111` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:119` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:127` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:135` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:139` | `planned` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:141` | `planned/callback@141` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:145` | `started` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:147` | `started/callback@147` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:151` | `noted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:153` | `noted/callback@153` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:157` | `approved` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:159` | `approved/callback@159` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:166` | `folded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:174` | `folded/callback@174` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:178` | `folded/callback@178` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:178` | `folded/callback@178/callback@178` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:194` | `bootstrapped` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:202` | `callback@202` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:204` | `callback@202/callback@204` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:205` | `callback@202/callback@205` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:206` | `callback@202/callback@206` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:207` | `callback@202/callback@207` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:208` | `callback@202/callback@208` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:209` | `callback@202/callback@209` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:17` | `unavailable` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:18` | `unavailable/callback@18` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:22` | `LiveMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:23` | `LiveMythical/callback@23` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:27` | `LiveMythical/callback@23/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:42` | `LiveMythical/callback@23/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:48` | `LiveMythical/callback@23/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:49` | `LiveMythical/callback@23/events/callback@49` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:58` | `LiveMythical/callback@23/events/callback@49/callback@58` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/LiveMythical.vibe:62` | `LiveMythical/callback@23/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:63` | `LiveMythical/callback@23/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:66` | `LiveMythical/callback@23/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:69` | `LiveMythical/callback@23/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/LiveMythical.vibe:72` | `LiveMythical/callback@23/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:18` | `seeded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:19` | `seeded/callback@19` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:24` | `landedSha` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:29` | `mockMain` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:31` | `mockMain/since` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:31` | `mockMain/since/callback@31` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:34` | `mockMain/since/callback@31/callback@34` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:33` | `mockMain/since/callback@31/callback@33` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:44` | `digestOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:51` | `MockMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:52` | `MockMythical/callback@52` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:67` | `MockMythical/callback@52/executionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:68` | `MockMythical/callback@52/executionId/callback@68` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:77` | `MockMythical/callback@52/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:77` | `MockMythical/callback@52/read/callback@77` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:78` | `MockMythical/callback@52/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/MockMythical.vibe:79` | `MockMythical/callback@52/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:82` | `MockMythical/callback@52/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:85` | `MockMythical/callback@52/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:88` | `MockMythical/callback@52/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/MockMythical.vibe:91` | `MockMythical/callback@52/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/mythical.vibe:132` | `apply` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:145` | `apply/callback@145` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:164` | `apply/callback@164` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:168` | `apply/callback@168` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:175` | `apply/callback@175` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:182` | `apply/callback@182` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:189` | `apply/callback@189` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:196` | `amended` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:202` | `started` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:208` | `approved` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:214` | `landed` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:223` | `hasEpic` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:241` | `hasCommit` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:259` | `hasSha` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:274` | `isIn` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:288` | `taskOf` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:301` | `epicOf` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:314` | `rankOf` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:329` | `endOf` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:369` | `accepted` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:374` | `refused` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/mythical.vibe:390` | `decide` | pure logic | Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane. |
| `src/history/MythicalHistory.vibe:29` | `settled` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/roles.vibe:35` | `atLeast` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/roles.vibe:47` | `may` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/history/Sequencer.vibe:54` | `trailerOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:59` | `answered` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:64` | `make` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:69` | `make/current` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:79` | `make/record` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:89` | `make/locked` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:94` | `make/openEpic` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:100` | `make/planned` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:107` | `make/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:110` | `make/follow` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:111` | `make/follow/callback@111` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:113` | `make/follow/callback@111/callback@113` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:117` | `make/follow/callback@111/callback@117` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:121` | `make/follow/callback@111/callback@121` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:126` | `make/record` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:129` | `make/plan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:130` | `make/plan/callback@130` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:160` | `make/fold` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:161` | `make/fold/callback@161` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:171` | `make/fold/callback@161/callback@171` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:169` | `make/fold/callback@161/callback@169` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:185` | `make/bootstrap` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:186` | `make/bootstrap/callback@186` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:199` | `stackOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:200` | `stackOf/recorded` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:200` | `stackOf/recorded/callback@200` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:204` | `stackOf/start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:205` | `stackOf/note` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:206` | `stackOf/approve` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:208` | `stackOf/bootstrap` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:216` | `memoryStore` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/Sequencer.vibe:219` | `memoryStore/load` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:220` | `memoryStore/append` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:220` | `memoryStore/append/callback@220` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/Sequencer.vibe:221` | `memoryStore/seed` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/wire.vibe:23` | `historyRouteOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:26` | `historyRouteOf/callback@26` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/wire.vibe:54` | `statusOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/surfaces/commands.vibe:147` | `summaryOf` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:150` | `summaryOf/callback@150` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:151` | `summaryOf/brief` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:155` | `summaryOf/callback@155` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:156` | `summaryOf/callback@156` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:161` | `summaryOf/callback@161` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:162` | `summaryOf/callback@162` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:162` | `summaryOf/callback@162` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:167` | `showHistory` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:169` | `showHistory/callback@169` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:175` | `plan` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:189` | `start` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:194` | `note` | effectful shell | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:201` | `callback@201` | pure logic | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:203` | `callback@201/callback@203` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:204` | `callback@201/callback@204` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:208` | `callback@201/callback@208` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:219` | `callback@219` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:224` | `callback@224` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
| `src/surfaces/commands.vibe:230` | `callback@230` | wiring | Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved. |
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
| `src/web/historyApp.vibe:108` | `init` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:134` | `allowed` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:139` | `commitsOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:140` | `commitsOf/callback@140` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:140` | `commitsOf/callback@140` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:144` | `realOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:145` | `realOf/callback@145` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:149` | `openWork` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:150` | `openWork/callback@150` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:150` | `openWork/callback@150/callback@150` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:154` | `matching` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:169` | `write` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:173` | `update` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:176` | `update/ResolvedMode` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:177` | `update/Loaded` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:178` | `update/FailedLoad` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:179` | `update/ClickedRetry` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:180` | `update/Navigated` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:181` | `update/ToggledEpic` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:182` | `update/ToggledEpic/callback@182` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:184` | `update/ClickedShowAll` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:185` | `update/UpdatedFilter` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:186` | `update/OpenedPlan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:193` | `update/ClosedPlan` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:194` | `update/UpdatedForm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:195` | `update/SubmittedPlan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:206` | `update/UpdatedLane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:207` | `update/ClickedStart` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:208` | `update/ClickedApprove` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:209` | `update/ClickedFold` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:210` | `update/UpdatedNoteSection` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:211` | `update/UpdatedNote` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:212` | `update/SubmittedNote` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:214` | `update/Wrote` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:218` | `update/FailedWrite` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:219` | `update/ReceivedEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:225` | `update/FailedEvents` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:226` | `update/PressedEscape` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:227` | `update/Settled` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:234` | `message` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:239` | `reasonOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:248` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:249` | `execute/callback@249` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:250` | `execute/callback@250` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:257` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:258` | `execute/callback@258` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:259` | `execute/callback@259` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:267` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:269` | `execute/callback@269` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:270` | `execute/callback@270` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:277` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:279` | `execute/callback@279` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:281` | `execute/callback@281` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:282` | `execute/callback@282` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:287` | `settledMessage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:294` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:296` | `execute/callback@296` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:299` | `execute/callback@299` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:300` | `execute/callback@300` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:307` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:309` | `execute/callback@309` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:312` | `execute/callback@312` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:313` | `execute/callback@313` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:320` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:322` | `execute/callback@322` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:325` | `execute/callback@325` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:326` | `execute/callback@326` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:333` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:335` | `execute/callback@335` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:338` | `execute/callback@338` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:339` | `execute/callback@339` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:346` | `subscriptions` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:347` | `subscriptions/callback@347` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:352` | `subscriptions/callback@347/filterMapEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:360` | `subscriptions/callback@347/filterMapEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:366` | `subscriptions/callback@347/modelToDependencies` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:367` | `subscriptions/callback@347/dependenciesToStream` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:368` | `subscriptions/callback@347/dependenciesToStream/callback@368` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyApp.vibe:370` | `subscriptions/callback@347/dependenciesToStream/callback@368/callback@370` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:372` | `subscriptions/callback@347/dependenciesToStream/callback@368/callback@372` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:375` | `subscriptions/callback@347/dependenciesToStream/callback@368/callback@375` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:379` | `subscriptions/callback@347/dependenciesToStream/callback@368/callback@379` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyApp.vibe:380` | `subscriptions/callback@347/dependenciesToStream/callback@368/callback@380` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:17` | `BrowserMythical` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:18` | `BrowserMythical/callback@18` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:22` | `BrowserMythical/callback@18/callback@22` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:23` | `BrowserMythical/callback@18/callback@22/callback@23` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:27` | `BrowserMythical/callback@18/callback@22/callback@27` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:34` | `BrowserMythical/callback@18/mode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:35` | `BrowserMythical/callback@18/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:36` | `BrowserMythical/callback@18/events` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:36` | `BrowserMythical/callback@18/events/callback@36` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyBackend.vibe:37` | `BrowserMythical/callback@18/plan` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:38` | `BrowserMythical/callback@18/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:39` | `BrowserMythical/callback@18/note` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:40` | `BrowserMythical/callback@18/approve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:41` | `BrowserMythical/callback@18/fold` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyBackend.vibe:43` | `BrowserMythical/callback@18/callback@43` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/web/historyView.vibe:18` | `view/callback@18` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:19` | `view/callback@19` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:39` | `body` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:55` | `top` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:66` | `away` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:70` | `loading` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:73` | `loading/callback@73` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:79` | `crumbs` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:82` | `crumbs/callback@82` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:95` | `list` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:108` | `list/callback@108` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:126` | `list/callback@126` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:130` | `list/callback@130` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:120` | `list/callback@120` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:135` | `epicCard` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:138` | `epicCard/callback@138` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:145` | `epicCard/callback@145` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:157` | `epicCard/callback@157` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:168` | `row` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:169` | `row/callback@169` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:170` | `row/callback@170` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:185` | `badgeOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:189` | `failure` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:194` | `refusalText` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:209` | `epicPage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:211` | `epicPage/callback@211` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:211` | `epicPage/callback@211/callback@211` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:222` | `epicPage/callback@222` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:231` | `commitPage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:232` | `commitPage/callback@232` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:234` | `commitPage/section` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:239` | `commitPage/notes` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:240` | `commitPage/notes/callback@240` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:240` | `commitPage/notes/callback@240` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:272` | `commitPage/callback@272` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:286` | `timeline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:289` | `timeline/step` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:296` | `timeline/callback@296` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:311` | `noteForm` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:313` | `noteForm/callback@313` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:318` | `noteForm/callback@318` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:325` | `plan` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:328` | `plan/callback@328` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:336` | `plan/callback@336` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:343` | `plan/callback@343` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:344` | `plan/callback@344` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/historyView.vibe:351` | `plan/callback@351` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/historyView.vibe:361` | `plan/callback@361` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `worker/Api.vibe:50` | `objectOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:51` | `objectOf/try` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:51` | `objectOf/catch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:55` | `reached` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:56` | `reached/callback@56` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:59` | `callback@59` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:62` | `callback@59/callback@62` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:64` | `callback@59/callback@62/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:68` | `callback@68` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:72` | `callback@68/callback@72` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:73` | `callback@68/callback@72/callback@73` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:79` | `callback@68/callback@72/read` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:79` | `callback@68/callback@72/read/callback@79` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:80` | `callback@68/callback@72/write` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:82` | `callback@68/callback@72/callback@82` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:90` | `callback@90` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:95` | `callback@90/callback@95` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:97` | `callback@90/callback@95/callback@97` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:100` | `callback@90/callback@95/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:103` | `callback@90/callback@95/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:104` | `callback@90/callback@95/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:106` | `callback@90/callback@95/callback@106` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:111` | `callback@90/callback@95/alarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:111` | `callback@90/callback@95/alarm/callback@111` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:114` | `callback@90/callback@95/alarm/callback@111/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:114` | `callback@90/callback@95/alarm/callback@111/admit/callback@114` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:118` | `callback@90/callback@95/alarm/callback@111/spend` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:118` | `callback@90/callback@95/alarm/callback@111/spend/callback@118` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:142` | `callback@142` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:149` | `callback@142/callback@149` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:152` | `callback@142/callback@149/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:152` | `callback@142/callback@149/post/callback@152` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:156` | `callback@142/callback@149/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:156` | `callback@142/callback@149/read/callback@156` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:160` | `callback@142/callback@149/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:160` | `callback@142/callback@149/tour/callback@160` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:164` | `callback@142/callback@149/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:164` | `callback@142/callback@149/endTour/callback@164` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:168` | `callback@142/callback@149/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:168` | `callback@142/callback@149/events/callback@168` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:175` | `callback@142/callback@149/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:179` | `callback@142/callback@149/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:183` | `callback@142/callback@149/events` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Budget.vibe:15` | `replyKey` | wiring | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:24` | `make` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:28` | `make/admit` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:35` | `make/spend` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:36` | `make/spend/callback@36` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/budgetDecision.vibe:7` | `admits` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/budgetDecision.vibe:19` | `charge` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/HistoryObject.vibe:27` | `seeded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:32` | `storeOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:34` | `storeOver/load` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:35` | `storeOver/load/callback@35` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:38` | `storeOver/load/callback@38` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:41` | `storeOver/load/callback@41` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:44` | `storeOver/append` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:45` | `storeOver/append/callback@45` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:47` | `storeOver/seed` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:48` | `storeOver/seed/callback@48` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:57` | `storeOver/seed/callback@57` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:57` | `storeOver/seed/callback@57/callback@57` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:59` | `storeOver/seed/callback@59` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:65` | `principalOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:73` | `history` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:78` | `runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/HistoryObject.vibe:90` | `bootstrap` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:92` | `bootstrap/callback@92` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:108` | `write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/HistoryObject.vibe:119` | `write/callback@119` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:52` | `eventStream` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:53` | `eventStream/callback@53` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:56` | `eventStream/callback@56` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:57` | `eventStream/callback@57` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:64` | `afterOf` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:71` | `json` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:75` | `answer` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:80` | `answer/callback@80` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:81` | `answer/callback@81` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:97` | `decodeWrite` | pure logic | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:108` | `answerHistory` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:117` | `answerHistory/callback@117` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:118` | `answerHistory/callback@118` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:125` | `handle` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:131` | `handle/callback@131` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:132` | `handle/callback@131/callback@132` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:140` | `handle/callback@140` | effectful shell | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
| `worker/Http.vibe:141` | `handle/callback@140/callback@141` | wiring | Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries. |
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
| `worker/Objects.vibe:29` | `executionIdOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:34` | `tourExecutionIdOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:38` | `dispatchedKey` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:41` | `executionStorage` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:43` | `executionStorage/get` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:43` | `executionStorage/get/callback@43` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:44` | `executionStorage/put` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:44` | `executionStorage/put/callback@44` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:45` | `executionStorage/delete` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:45` | `executionStorage/delete/callback@45` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:46` | `executionStorage/setAlarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:46` | `executionStorage/setAlarm/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:47` | `executionStorage/deleteAlarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:47` | `executionStorage/deleteAlarm/callback@47` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:56` | `dispatcher` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:59` | `dispatcher/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:61` | `dispatcher/tour/callback@61` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:64` | `dispatcher/tour/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:65` | `dispatcher/tour/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:68` | `dispatcher/tour/callback@68` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:70` | `dispatcher/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:72` | `dispatcher/start/callback@72` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:75` | `dispatcher/start/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:76` | `dispatcher/start/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:79` | `dispatcher/start/callback@79` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:87` | `conversation` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:92` | `budget` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:97` | `postsOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:102` | `toursOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:102` | `toursOf/callback@102` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:117` | `postExecutionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:124` | `wakeTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:126` | `wakeTour/callback@126` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:134` | `wakeTour/callback@134` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:146` | `tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:151` | `endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:155` | `asked` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:159` | `asked/callback@159` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:161` | `asked/callback@161` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:174` | `post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:184` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:196` | `repliesOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:209` | `start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:210` | `wake` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:220` | `alarm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:235` | `alarm/runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:21` | `eventKey` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:26` | `logOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:28` | `logOver/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:29` | `logOver/read/callback@29` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:32` | `logOver/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:33` | `logOver/write/callback@33` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:39` | `ledgerOver` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:41` | `ledgerOver/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:42` | `ledgerOver/read/callback@42` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/ObjectStorage.vibe:45` | `ledgerOver/write` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/ObjectStorage.vibe:46` | `ledgerOver/write/callback@46` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Reply.vibe:61` | `reasonOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:66` | `failureReason` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:92` | `dayOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:97` | `promptOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:105` | `promptOf/callback@105` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:124` | `tagOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:142` | `fold` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:166` | `agentOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:190` | `agentOf/resolve` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:210` | `respond` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:214` | `respond/emit` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:215` | `respond/callback@215` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:240` | `run` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:248` | `compose` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:257` | `compose/callback@257` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:289` | `answer` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:297` | `answer/callback@297` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:308` | `answer/callback@308` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:315` | `answer/callback@315` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:324` | `callback@324` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:326` | `callback@324/callback@326` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
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
