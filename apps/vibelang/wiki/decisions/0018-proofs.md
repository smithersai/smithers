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
| `src/core/conversation.vibe` | Conversation sequence, entry identity and correlation, pending posts, reply and tour guards, pane ownership | Integer sequences below MAX_SAFE_INTEGER; dense readonly arrays; UTF-16 strings |
| `worker/replyReasons.vibe` | Content policy → refused; credit and quota → credit; other model failures → unavailable. Agent precedence: unresolved seat, structured-output failure, model failure, generic failure | The observed tag and code are inputs; constant wording lookup and provider parsing are outside this decision |
| `worker/budgetDecision.vibe` | Strict budget admission; repeated charges add zero; a new charge is nonnegative and total increases by exactly that charge | Nonnegative integer values and a safe sum; storage serialization and floating-point normalization are not proved |
| `src/core/flowDecision.vibe` | Only accepted record dispatches; only matching attempt/offset appends; only the addressed terminal event ends a tour; repeated starts remain done | Durable engine journaling, scheduling, cancellation, storage and eventual completion are not proved |

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

Each new fixture also lives at `~/vl/vibelang-bugs/lemmascript-<name>/` with its command. These are not mutation
successes. Compiler/runtime execution of Effect, Schema and Foldkit remains outside LemmaScript's plain subset.

## Inventory

The compiler's original-source ESTree identifies executable functions, methods, effect blocks and nested callbacks
without counting generated wrappers or code examples inside strings. `node verify/inventory.cjs --write` refreshes this table; without `--write` it rejects drift. Pure
functions with unsupported library operations remain unproved until a documented reproduction or upstream fix exists.

<!-- inventory:start -->
662 executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.

| File and line | Function | Class | Proof or reason |
| --- | --- | --- | --- |
| `src/core/conversation.vibe:113` | `apply` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:153` | `apply/callback@153` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:160` | `apply/callback@160` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:168` | `apply/callback@168` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:177` | `apply/callback@177` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:194` | `apply/callback@194` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:210` | `tourEntry` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:219` | `isTouring` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:229` | `isTour` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:246` | `isReplying` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:255` | `hasClientId` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:273` | `hasEntryId` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:291` | `canReplyTo` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:336` | `accepted` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:342` | `refused` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:365` | `decide` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:440` | `post` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:464` | `failPost` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:467` | `failPost/callback@467` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:480` | `retryPost` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:481` | `retryPost/callback@481` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:492` | `receive` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:498` | `receive/callback@498` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/conversation.vibe:509` | `resume` | pure logic | Production state machine; contracts and executable mutations. |
| `src/core/flowDecision.vibe:6` | `dispatches` | pure logic | Dispatch admission, append ordering and tour terminal events; proved. |
| `src/core/flowDecision.vibe:13` | `appends` | pure logic | Dispatch admission, append ordering and tour terminal events; proved. |
| `src/core/flowDecision.vibe:20` | `endsTourEvent` | pure logic | Dispatch admission, append ordering and tour terminal events; proved. |
| `src/core/flowDecision.vibe:29` | `startAnswer` | pure logic | Dispatch admission, append ordering and tour terminal events; proved. |
| `src/core/flows.vibe:28` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:36` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:40` | `replyIdOf` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:45` | `unanswered` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:49` | `unanswered/callback@49` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:48` | `unanswered/callback@48` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:67` | `posted` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:83` | `callback@83` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:85` | `callback@83/callback@85` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:94` | `docsPage` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:132` | `endsTour` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:137` | `touring` | pure logic | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:146` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:154` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:162` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:171` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:180` | `body` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:190` | `counted` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:196` | `startTour` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:205` | `endTour` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:213` | `openDocs` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:222` | `say` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:233` | `toured` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:241` | `callback@241` | effectful shell | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:243` | `callback@241/callback@243` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/flows.vibe:244` | `callback@241/callback@244` | wiring | Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved. |
| `src/core/LiveFactory.vibe:15` | `unavailable` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveFactory.vibe:16` | `unavailable/callback@16` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveFactory.vibe:20` | `health` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:29` | `refusable` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:39` | `LiveFactory` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveFactory.vibe:40` | `LiveFactory/callback@40` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:45` | `LiveFactory/callback@40/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:52` | `LiveFactory/callback@40/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:57` | `LiveFactory/callback@40/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:62` | `LiveFactory/callback@40/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:69` | `LiveFactory/callback@40/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/LiveFactory.vibe:70` | `LiveFactory/callback@40/events/callback@70` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/LiveFactory.vibe:78` | `LiveFactory/callback@40/events/callback@70/callback@78` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:43` | `scriptedTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:61` | `scripted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:66` | `scripted/callback@66` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:69` | `scripted/callback@69` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:79` | `digestOf` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:86` | `callback@86` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:98` | `callback@86/nextId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:99` | `callback@86/nextId/callback@99` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:104` | `callback@86/recorder` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:105` | `callback@86/recorder/callback@105` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:105` | `callback@86/recorder/callback@105/callback@105` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:106` | `callback@86/recorder/callback@105/callback@105/callback@106` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:120` | `callback@86/answer` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:131` | `callback@86/answer/callback@131` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:139` | `callback@86/openRoom` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:140` | `callback@86/openRoom/callback@140` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:150` | `callback@86/openRoom/callback@140/record` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:155` | `callback@86/openRoom/callback@140/dispatch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:157` | `callback@86/openRoom/callback@140/accepted` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:157` | `callback@86/openRoom/callback@140/accepted/callback@157` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:159` | `callback@86/openRoom/callback@140/start` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:163` | `callback@86/openRoom/callback@140/dispatch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:164` | `callback@86/openRoom/callback@140/end` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:168` | `callback@86/openRoom/callback@140/open` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:169` | `callback@86/openRoom/callback@140/say` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:170` | `callback@86/openRoom/callback@140/finish` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:173` | `callback@86/openRoom/callback@140/ended` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:173` | `callback@86/openRoom/callback@140/ended/callback@173` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:177` | `callback@86/openRoom/callback@140/ended/callback@173/callback@177` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:184` | `callback@86/openRoom/callback@140/callback@184` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:186` | `callback@86/openRoom/callback@140/callback@184/callback@186` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:187` | `callback@86/openRoom/callback@140/callback@184/callback@187` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:207` | `callback@86/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:209` | `callback@86/post/callback@209` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:213` | `callback@86/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:215` | `callback@86/tour/callback@215` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:219` | `callback@86/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:221` | `callback@86/endTour/callback@221` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:225` | `callback@86/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:230` | `callback@86/read/callback@230` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:230` | `callback@86/read/callback@230` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:231` | `callback@86/read/callback@231` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:233` | `callback@86/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/MockFactory.vibe:234` | `callback@86/events/callback@234` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:239` | `callback@86/events/callback@234/callback@239` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:244` | `callback@86/events/callback@234/callback@244` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/MockFactory.vibe:245` | `callback@86/events/callback@234/callback@245` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/mockReplies.vibe:119` | `callback@119` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/core/mockReplies.vibe:149` | `mockReply` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/mockReplies.vibe:158` | `chunks` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/wire.vibe:43` | `conversationPath` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/wire.vibe:56` | `routeOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/core/wire.vibe:71` | `decodeSegment` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:57` | `counted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:63` | `signature` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:68` | `guarded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:88` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:96` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:104` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:112` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:120` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:128` | `body` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:132` | `planned` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:134` | `planned/callback@134` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:138` | `started` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:140` | `started/callback@140` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:144` | `noted` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:146` | `noted/callback@146` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:150` | `approved` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:152` | `approved/callback@152` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:159` | `folded` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:167` | `folded/callback@167` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:171` | `folded/callback@171` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:171` | `folded/callback@171/callback@171` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:187` | `bootstrapped` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:195` | `callback@195` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/flows.vibe:197` | `callback@195/callback@197` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:198` | `callback@195/callback@198` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:199` | `callback@195/callback@199` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:200` | `callback@195/callback@200` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:201` | `callback@195/callback@201` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/flows.vibe:202` | `callback@195/callback@202` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `src/history/seed.vibe:220` | `sanitize` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:233` | `titleOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:241` | `evidenceOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:265` | `pushOnce` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:277` | `seedOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:339` | `seedOf/callback@339` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:340` | `seedOf/callback@339/callback@340` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:348` | `seedOf/callback@348` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:362` | `clip` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:367` | `notesOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:373` | `notesOf/callback@373` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:374` | `notesOf/callback@374` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:385` | `intentsOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:413` | `replay` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:428` | `seedFrom` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:429` | `seedFrom/callback@429` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:433` | `seedFrom/callback@433` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:439` | `seedFrom/callback@433/callback@439` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:439` | `seedFrom/callback@433/callback@439/callback@439` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/history/seed.vibe:438` | `seedFrom/callback@433/callback@438` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:437` | `seedFrom/callback@433/callback@437` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/history/seed.vibe:441` | `seedFrom/callback@441` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `src/surfaces/backend.vibe:13` | `notDeployed` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/backend.vibe:17` | `unreachable` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/backend.vibe:22` | `callback@22` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/backend.vibe:24` | `callback@22/callback@24` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/backend.vibe:32` | `backend` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli-entry.vibe:9` | `callback@9` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli-entry.vibe:12` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:10` | `run` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:13` | `commandFor` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:14` | `commandFor/callback@14` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:23` | `cli` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/cli.vibe:26` | `cli/callback@26` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/cli.vibe:29` | `cli/callback@29` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:25` | `ask` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:36` | `ask/callback@36` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:55` | `read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:61` | `define` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/commands.vibe:70` | `define/invoke` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:75` | `define/run` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:76` | `define/run/callback@76` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:84` | `define/render` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:94` | `callback@94` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:99` | `callback@99` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/commands.vibe:100` | `callback@99/callback@100` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/manifest.vibe:8` | `callback@8` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/manifest.vibe:21` | `callback@21` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp-entry.vibe:7` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:6` | `callback@6` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/mcp.vibe:8` | `callback@8` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:11` | `callback@8/callback@11` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/surfaces/mcp.vibe:11` | `callback@8/callback@11/callback@11` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:18` | `serve` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:27` | `mcp` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/surfaces/mcp.vibe:29` | `mcp/callback@29` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:11` | `BrowserFactory` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/backend.vibe:12` | `BrowserFactory/callback@12` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:16` | `BrowserFactory/callback@12/callback@16` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:17` | `BrowserFactory/callback@12/callback@16/callback@17` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/backend.vibe:22` | `BrowserFactory/callback@12/callback@16/callback@22` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/backend.vibe:30` | `BrowserFactory/callback@12/mode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/backend.vibe:31` | `BrowserFactory/callback@12/post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:35` | `BrowserFactory/callback@12/read` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:39` | `BrowserFactory/callback@12/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/backend.vibe:39` | `BrowserFactory/callback@12/events/callback@39` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:43` | `BrowserFactory/callback@12/tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:47` | `BrowserFactory/callback@12/endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/backend.vibe:52` | `BrowserFactory/callback@12/callback@52` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:68` | `tourConversation` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:106` | `init` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:136` | `update` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:138` | `update/ResolvedMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:139` | `update/PressedCommandK` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:140` | `update/ClickedAsk` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:142` | `update/PressedEscape` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:150` | `update/ClickedLearnMore` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:151` | `update/ClickedEndTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:153` | `update/SucceededTour` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:155` | `update/FailedTour` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:157` | `update/FailedEndTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:158` | `update/ClickedDocs` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:159` | `update/ClickedSplash` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:160` | `update/ClickedChat` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:161` | `update/UpdatedDraft` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:162` | `update/SubmittedDraft` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:163` | `update/SucceededPost` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:164` | `update/ClickedRetry` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:165` | `update/ClickedRetry/callback@165` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:172` | `update/FailedPost` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:173` | `update/ReceivedEvent` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:181` | `update/ReceivedEvent/callback@181` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:193` | `update/FailedEvents` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:194` | `update/ClickedReconnect` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:195` | `update/FocusedPrompt` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:196` | `update/ScrolledTranscript` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:205` | `update/ClickedLatest` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:213` | `learnMore` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:240` | `touringHere` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:245` | `endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:249` | `openPalette` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:254` | `minimizeSplash` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:260` | `hasConversation` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:264` | `submit` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:288` | `message` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:301` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:302` | `execute/callback@302` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:304` | `execute/callback@304` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:312` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:315` | `execute/callback@315` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:316` | `execute/callback@316` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:324` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:326` | `execute/callback@326` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:328` | `execute/callback@328` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:329` | `execute/callback@329` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:336` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:338` | `execute/callback@338` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:341` | `execute/callback@341` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:342` | `execute/callback@342` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:350` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:352` | `execute/callback@352` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:355` | `execute/callback@355` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:356` | `execute/callback@356` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:367` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:369` | `execute/callback@369` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:372` | `execute/callback@372` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:373` | `execute/callback@373` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:380` | `keyMessage` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:387` | `subscriptions` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:389` | `subscriptions/scrolled` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:391` | `subscriptions/callback@391` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:396` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:410` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:416` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:422` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:428` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:433` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:434` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:439` | `subscriptions/callback@391/filterMapEvent` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:446` | `subscriptions/callback@391/modelToDependencies` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:453` | `subscriptions/callback@391/dependenciesToStream` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:454` | `subscriptions/callback@391/dependenciesToStream/callback@454` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:456` | `subscriptions/callback@391/dependenciesToStream/callback@454/callback@456` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:458` | `subscriptions/callback@391/dependenciesToStream/callback@458` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:465` | `subscriptions/callback@391/modelToDependencies` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:471` | `subscriptions/callback@391/dependenciesToStream` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:473` | `subscriptions/callback@391/dependenciesToStream/callback@473` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/main.vibe:475` | `subscriptions/callback@391/dependenciesToStream/callback@473/callback@475` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:477` | `subscriptions/callback@391/dependenciesToStream/callback@473/callback@477` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:479` | `subscriptions/callback@391/dependenciesToStream/callback@473/callback@479` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:482` | `subscriptions/callback@391/dependenciesToStream/callback@482` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/main.vibe:495` | `viewTransition` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:11` | `blocks` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:17` | `blocks/flushProse` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:44` | `inline` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:45` | `inline/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:49` | `render` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:50` | `render/callback@50` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/markdown.vibe:53` | `render/callback@50/callback@53` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:18` | `askedForMock` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:28` | `backendMode` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:29` | `backendMode/callback@29` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:30` | `backendMode/callback@29/callback@30` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:33` | `backendMode/callback@29/callback@30/callback@33` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/startup.vibe:39` | `main` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:45` | `main/callback@45` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/startup.vibe:55` | `main/callback@55` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/styles.vibe:8` | `stylesheet` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/styles.vibe:9` | `stylesheet/callback@9` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:16` | `failureOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:20` | `view` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:42` | `logo` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:46` | `top` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:58` | `away` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:66` | `paneIcon` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:71` | `githubMark` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:79` | `splash` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:110` | `splashPane` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:120` | `control` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:128` | `docsPane` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:148` | `chat` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:154` | `chat/callback@154` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:155` | `chat/callback@155` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:170` | `entryView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:187` | `pendingView` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:199` | `ownPost` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:204` | `postFailure` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:215` | `promptInput` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:223` | `promptInput/callback@223` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `src/web/view.vibe:224` | `promptInput/callback@224` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:230` | `composer` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:245` | `statusText` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/view.vibe:255` | `palette` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:2` | `atBottom` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:9` | `transcriptViewport` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:14` | `transcriptViewport/active` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:18` | `transcriptViewport/position` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:19` | `transcriptViewport/scrollable` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:20` | `transcriptViewport/pause` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:28` | `transcriptViewport/wheel` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:29` | `transcriptViewport/key` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:37` | `transcriptViewport/touchStart` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:41` | `transcriptViewport/touchMove` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:42` | `transcriptViewport/touchMove/callback@42` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:48` | `transcriptViewport/touchEnd` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:49` | `transcriptViewport/scrolled` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `src/web/viewport.vibe:58` | `transcriptViewport/follow` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/AgentModel.vibe:44` | `chatModel` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/AgentModel.vibe:47` | `chatModel/onFailure` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/AgentModel.vibe:48` | `chatModel/onSuccess` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:36` | `objectOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:37` | `objectOf/try` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:37` | `objectOf/catch` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:41` | `reached` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:42` | `reached/callback@42` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:45` | `callback@45` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:48` | `callback@45/callback@48` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:50` | `callback@45/callback@48/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:54` | `callback@54` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:59` | `callback@54/callback@59` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:61` | `callback@54/callback@59/callback@61` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:64` | `callback@54/callback@59/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:67` | `callback@54/callback@59/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:68` | `callback@54/callback@59/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:70` | `callback@54/callback@59/callback@70` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:75` | `callback@54/callback@59/alarm` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:75` | `callback@54/callback@59/alarm/callback@75` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:78` | `callback@54/callback@59/alarm/callback@75/admit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:78` | `callback@54/callback@59/alarm/callback@75/admit/callback@78` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:82` | `callback@54/callback@59/alarm/callback@75/spend` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:82` | `callback@54/callback@59/alarm/callback@75/spend/callback@82` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:106` | `callback@106` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:112` | `callback@106/callback@112` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:115` | `callback@106/callback@112/post` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:115` | `callback@106/callback@112/post/callback@115` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:119` | `callback@106/callback@112/read` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:119` | `callback@106/callback@112/read/callback@119` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:123` | `callback@106/callback@112/tour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:123` | `callback@106/callback@112/tour/callback@123` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:127` | `callback@106/callback@112/endTour` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:127` | `callback@106/callback@112/endTour/callback@127` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Api.vibe:131` | `callback@106/callback@112/events` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Api.vibe:131` | `callback@106/callback@112/events/callback@131` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Budget.vibe:15` | `replyKey` | wiring | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:24` | `make` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:28` | `make/admit` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:35` | `make/spend` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/Budget.vibe:36` | `make/spend/callback@36` | effectful shell | Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts). |
| `worker/budgetDecision.vibe:7` | `admits` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/budgetDecision.vibe:19` | `charge` | pure logic | Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition. |
| `worker/Http.vibe:35` | `eventStream` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:36` | `eventStream/callback@36` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:39` | `eventStream/callback@39` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Http.vibe:40` | `eventStream/callback@40` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Http.vibe:47` | `afterOf` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:54` | `json` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Http.vibe:58` | `answer` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:63` | `answer/callback@63` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Http.vibe:64` | `answer/callback@64` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Http.vibe:80` | `handle` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:86` | `handle/callback@86` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Http.vibe:87` | `handle/callback@86/callback@87` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/index.vibe:14` | `notFound` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/index.vibe:19` | `fetch` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
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
| `worker/Objects.vibe:115` | `postExecutionId` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:125` | `tour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:130` | `endTour` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:134` | `asked` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:140` | `asked/callback@140` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:153` | `post` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:163` | `execute` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:175` | `repliesOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:188` | `start` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:189` | `wake` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Objects.vibe:199` | `alarm` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Objects.vibe:214` | `alarm/runtime` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
| `worker/Reply.vibe:93` | `dayOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:98` | `promptOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:106` | `promptOf/callback@106` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:125` | `tagOf` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:143` | `fold` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:167` | `agentOf` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:191` | `agentOf/resolve` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:211` | `respond` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:215` | `respond/emit` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:216` | `respond/callback@216` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:241` | `run` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:249` | `compose` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:258` | `compose/callback@258` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:290` | `answer` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:298` | `answer/callback@298` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:309` | `answer/callback@309` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:316` | `answer/callback@316` | pure logic | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:325` | `callback@325` | effectful shell | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
| `worker/Reply.vibe:327` | `callback@325/callback@327` | wiring | Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved. |
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
| `worker/Sequencer.vibe:238` | `make/open` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:241` | `make/say` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:244` | `make/finishTour` | effectful shell | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:246` | `make/finishTour/callback@246` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:250` | `make/ended` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Sequencer.vibe:250` | `make/ended/callback@250` | wiring | Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved. |
| `worker/Tour.vibe:33` | `callback@33` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:44` | `prompt` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:50` | `declared` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:66` | `toolsOf` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:70` | `toolsOf/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:74` | `toolsOf/handler` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:75` | `toolsOf/handler/callback@75` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:75` | `toolsOf/handler/callback@75/callback@75` | pure logic | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:81` | `guide` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:92` | `charged` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:93` | `charged/callback@93` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:94` | `charged/callback@93/callback@94` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:98` | `settle` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:104` | `spoken` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:113` | `spoken/callback@113` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:127` | `spoken/emit` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:127` | `spoken/emit/callback@127` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
| `worker/Tour.vibe:149` | `callback@149` | effectful shell | Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof. |
| `worker/Tour.vibe:151` | `callback@149/callback@151` | wiring | Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision. |
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
