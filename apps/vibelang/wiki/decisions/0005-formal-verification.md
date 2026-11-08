# 0005. Formal verification of the state machine

**Status:** accepted, 2026-11-07. **Rulings:** VL-9, VL-15.

**Decision.** Two independent layers check the actual `src/core/conversation.vibe`:

1. [LemmaScript](https://github.com/midspiral/lemmascript), by **Midspiral** (MIT), reads its normal `//@` contracts;
   Dafny proves them. LemmaScript reads TypeScript, and the module stays in its verifiable subset, which is plain
   TypeScript syntax: `pnpm verify` proves an exact `.ts` copy of the file's text, staged under the ignored
   `verify/.checks/`. (`vibelang --ts-projection` keeps the text and all 83 `//@` comments but appends an import of
   `vibelang-ts-mapper/prelude`, which the proof's strict typecheck can't resolve, TS2307.) This is verification
   tooling, not a runtime dependency. VibeLang's VIP-43 has not landed; move these contracts into its syntax when it
   does.
2. Effect 4.1.1's `Arbitrary` runs random intent sequences through the real sequencer, then delivers events to clients
   duplicated, reordered and with gaps (`test/conversation.test.vibe`, 400 runs per property).

## One command

From `apps/vibelang`, run `pnpm verify`. On the first run it installs the lockfile-pinned LemmaScript **0.6.6** npm
closure and **Dafny 4.11.0** into ignored `verify/.tools`. The installer verifies the official Dafny release archive's
SHA-256 before extraction. It supports Linux x86_64 and macOS arm64/x86_64; only Linux was exercised on this lane.
Node >=18, npm, Python >=3.9, curl and unzip are prerequisites; there is no global tool installation.

Every check strictly typechecks the selected source, creates a unique ignored `verify/.checks/run-*` directory,
generates fresh Dafny, and invokes Dafny with one solver core and a 60-second limit per positive assertion batch (30 seconds for a negative case). It never
accepts a saved `.dfy` proof. All eleven exported transitions/queries and both typed decision constructors opt in with
`//@ verify`. Missing emitted marked functions and source edits during a check fail the harness. Dafny locations are
mapped back to TypeScript function names and declaration lines; raw generated locations remain in the diagnostic.
Summaries, SHA-256 source identities, raw logs and Dafny CSV timings are retained under that run directory.

A measured Linux run on nyc-01 took **17.240 s** including extraction and strict checking (**21 verified, 0 errors** at the time; **23** after the fix below;
16.367 s for extraction plus Dafny). Preceding runs on the identical source took 46.308 s and 56.577 s under contention. These exclude first-time installation and vary
with contention on the shared server. `nice` is used by the scripts; `CHECK_JOBS` defaults to one for multiple files.

## Proven contracts and their domain

| Function | Proven |
| --- | --- |
| `apply` | `seq` is unchanged or exactly previous + 1; every event other than the next leaves the record unchanged; the next always advances, including content that does not fit |
| `apply` | Strict entry order is preserved when input entries are ordered and bounded by the input sequence; entry sequence bounds are preserved |
| `apply` | Distinct nonempty person client ids remain distinct for every event; full person-id uniqueness and nonempty person ids are preserved for nonempty-id posts |
| `apply` | `working` iff `replying` is nonempty is preserved for nonempty-id reply starts; every unfinished entry belongs to the current agent reply, at most one is unfinished, and a working agent has an unfinished entry, each as an invariant-preservation implication |
| `apply` | An admitted reply start appends one entry carrying `AGENT_NAME` and the exact `inReplyTo` post id |
| `decide` | Every accepted event is next; accepted starts have nonempty ids and require a nonworking agent; accepted posts have nonempty text/client ids, fit `MAX_TEXT`, and have no existing matching client id |
| `canReplyTo` | Exact equivalence: a nonempty id names a person post and no agent entry already targets it, including finished/failed replies |
| `decide` | Accepted starts preserve `intent.inReplyTo`, which names an existing person post with no prior reply |
| `isReplying`, `hasClientId` | Exact equivalence with their reply and indexed existential lookup predicates; the empty client id never matches |
| `post` | Existing pending ids cause an unchanged client; uniqueness is preserved; old pending entries remain an exact prefix; at most one is appended; conversation/gap are unchanged |
| `failPost` | Preserves conversation/gap, pending count, ids and text; changes only matching entries and uses the exact reason, defaulting to `failed` |
| `retryPost` | Preserves conversation/gap, pending length, ids/text and unmatched entries; clears only the matching failure |
| `receive` | An event at or below the sequence leaves the entire client unchanged (hence repeated delivery is idempotent); an event beyond the next marks a gap |
| `resume` | Clears gap and preserves conversation/pending |
| Typed decision constructors | Preserve the exact accepted event or refusal, together with its success tag |

Counters use LemmaScript's **integer** model. The numeric precondition on `apply`, `decide` and `receive` is
`0 <= seq < 9007199254740991` (`Number.MAX_SAFE_INTEGER`); advancing may reach that maximum. Another increment
requires a new in-range input. Fractional, NaN, infinite or unsafe sequence values are outside the proof domain.
There is no artificial bound on entry/pending counts or string lengths; arrays are dense readonly records, and
strings use the JavaScript UTF-16 configuration. These are mathematical proofs under the stated preconditions,
not enumeration of bounded event histories. Invariant antecedents are explicit: no function claims to repair an
already-invalid conversation.

## Findings, fixed: `apply` accepted two malformed events

The proof run found two inputs for which the unrestricted invariants failed, though `decide` never numbers either:

- `apply(empty, { type: "ReplyStarted", seq: 1, id: "" })` left `agent = "working"` with `replying = ""`.
- Two next `Posted` events with `clientId = ""` appended two person entries carrying that id.

`apply` now ignores any creation the sequencer would refuse (an empty client id, or an empty or reused entry id),
advancing `seq` as it does for every other misfit. The contracts hold for every event without qualification, and two
more are proved: entry ids stay nonempty and unique. `test/conversation.test.vibe` keeps a regression for each case.

## Able to fail

The preceding Linux selftest rejected **40/40** executable mutations in **400.308 s** with two workers; every copy
strictly typechecked and reached a failed Dafny obligation in its intended function.

`pnpm verify:broken` generates its executable mutations from the production module at run time, under
`verify/.checks/`; `verify/mutations.py` holds the cases. The generator checks that each change matches exactly once
in its function and that all `//@` contracts and assertions stay byte-identical to production. Every copy
must strictly typecheck, reach Dafny, and fail an obligation in its intended function; parser errors, backend type
errors, timeouts and tool failures do not count. The selftest selects the intended function in each unchanged-contract
copy; a direct `pnpm verify` on that copy checks every function. The selftest defaults to two workers. Individual failures are reproducible with
`pnpm verify:broken <name>`; each run writes the mutations it checked to its `manifest.json`.

The verification subset keeps readonly records, string-tagged unions, spread appends and indexed `forall`
contracts. Lookup loops use an explicit index with loop invariants **inside the loop body**. Decision construction
uses typed `accepted`/`refused` helpers because 0.6.6 mis-lowers nested unions. Existing `.map`/`.filter` operations
remain where Dafny can verify them; local arrays and checked assertions provide element-preservation guidance.
`ReadonlyMap`, annotation lambdas, indexed `.every` and optional-field reconstruction are avoided, per the probe.
Tool defects and minimal reproductions live in `verify/bugs/`; they are not counted as successful negative proofs.

## Outside the proof

No proof yet covers eventual network delivery/replay convergence, liveness, the Durable Object/WebSocket/agent-flow
protocol, rendering, Effect execution, authentication, or deployment. Protocol modeling belongs with roadmap 1b
(TLA+/TLC). The existing `Arbitrary` suite checks replay convergence empirically. The app's `PACKAGE.ts` runs proof and mutation gates in normal CI (0018). The proof trusts TypeScript erasure, LemmaScript's lowering and local library, Dafny/Z3 and the stated
JS number/UTF-16 model; it is not a proof of those toolchains. macOS installers have not been executed here.

**Fable finding 3.** `canReplyTo` and the start correlation contracts pass a fresh Linux run: **25 verified, 0 errors**. Six additional executable mutations cover missing/non-person/already-answered targets, omitted admission guard, mismatched event target and projected target. Final mutation receipts are in the lane report.

**Retry (Fable 7).** The pending recovery transition adds a frame and an exact clearing contract, plus two executable mutations. The current production proof has **28 verified, 0 errors** across thirteen marked functions; the mutation suite contains **48** unchanged-contract copies.

**Fable final receipt.** Fresh production verification: **28 verified, 0 errors** in **17.321 s**. `pnpm verify:broken` rejected **48/48** executable mutations in **303.372 s** with two workers, each strictly typechecked and failed a Dafny obligation in its intended function. The eight new mutations cover reply targeting/correlation and pending retry; all forty prior copies were regenerated and rejected again.

**Restart (live agent, 2026-11-07).** `RestartReply` and its event `ReplyRestarted` (decision 0010) add two contracts:
an applied restart of the streaming reply keeps every entry and empties that reply's text, and `decide` accepts a
restart only for the reply that streams. Every existing invariant covers the new case. Two executable mutations prove
both can fail (`apply-restart-text`, `decide-restart-guard`). Linux receipts on nyc-01: `pnpm verify` **28 verified, 0
errors** in 27.9 s; `pnpm verify:broken` rejected **50/50** mutations in 480.1 s with two workers.

**Total, said in the source (2026-11-07).** Each exported function's JSDoc now carries `@throws {never}`, so VibeLang
lets Effect code (the live sequencer, 0010) call the machine directly; LemmaScript reads only `//@` lines, and the
mutation copies were regenerated with byte-identical contracts. Receipts: `pnpm verify` **28 verified, 0 errors** in
20.8 s; `pnpm verify:broken` rejected **50/50** in 375.2 s.

**All app decisions (VL-29).** [0018](0018-proofs.md) extends the harness beyond this conversation module and records
the function inventory, production extractions, executable mutations and every remaining proof boundary. The gate
automatically discovers marked production modules; every module is freshly generated and strictly typechecked.

**Whole-app second batch (0018).** The conversation's contracts now include at most one answer per post, ignored
text after a terminal reply/tour, exact delta/failure payloads, and admissible intent completeness. The shared gate
also proves browser, mock and protocol policies. Five expensive negative cases select a named production
postcondition with fail-closed matching; positive proofs still check every obligation. Parser errors and solver
timeouts remain failures of the mutation gate, never successful rejections. Current receipts are in 0018.

**History and numeric boundaries (0018).** Exact mythical transitions, refusal precedence and rank-bound induction
are proved. Runtime decoding now enforces the safe-integer domain before replay, follow and bootstrap; sequence
exhaustion is refused before incrementing. The unsafe-integer fixture records why a mathematical integer proof
alone does not establish IEEE-754 behavior. Receiver proofs additionally cover gap frames and pending membership.

The current shared gate passes 161 obligations in ten modules and rejects 302 executable mutations; 0018 records
the exact receipt composition and the remaining proof boundaries.

**Shared surfaces and model context (0018).** The twelve-module gate now proves 182 obligations and rejects 346
mutations. Ordered index witnesses establish exact model-context selection; shared CLI/MCP accumulation and safe
budget admission/addition are proved and integrated into their Effect shells.

**Exact conversation and ordered selection (0018).** Every apply entry field and state frame is specified and
lifted to receive, including role-ledger prepend order. Pending removal and unanswered posts carry source-position
witnesses; replay carries a retained-log bound. The fresh Dafny proof adds only a checked recursive lemma call for
the pending-count measure. Every positive assertion is checked, with conversation assertions split for tractability;
its batch count is recorded separately from ordinary obligations. Stored conversation rows are decoded before replay.

History replay (0018) now carries every apply contract through a maximum-cursor wrapper. Its production fold proves
safe cursor and rank preservation and exact numbering for contiguous events; this is not a proof of journal ordering
or full replay-state equivalence. Every decide clause is retained through the writer's capacity wrapper.

Web decisions (0018) now include exact six-field screen projections and presentation/media guards. Finite coordinate
comparisons use the backend's real type; native subtraction remains outside the proof, with a retained rounding
counterexample. Host Model composition and account/People transitions are not inferred from the projection proof.

Sandbox guard/frame proofs (0018) use quantified first-match source positions while retaining iterative runtime
traversals. The newly exact running-count measure has an additions-only, checked induction call in its fresh empty
Dafny lemma. No original contract, emitted statement or generated condition is removed.

Startup choices (0018) now share an import-free proved kernel. Browser startup, history role selection and mode
navigation call it; native storage/URL operations and their failure fallbacks remain explicit host boundaries.

Theatre presentation (0018) now calls a proved kernel for speech decisions, selectors and keyboard focus wrapping.
Actual speech, DOM layout and persisted-state decoding remain host/library boundaries.

The live dispatcher (0018) threads a proved scan/attempt/done model through actual storage observations and engine
attempts. It stops on the first unmarked post even when busy; engine execution and journal/lock correctness remain
library/host assumptions.
