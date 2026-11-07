# 0005. Formal verification of the state machine

**Status:** accepted, 2026-11-07. **Rulings:** VL-9, VL-15.

**Decision.** Two independent layers check the actual `src/core/conversation.ts`:

1. [LemmaScript](https://github.com/midspiral/lemmascript), by **Midspiral** (MIT), reads its normal `//@` contracts;
   Dafny proves them. This is verification tooling, not a runtime dependency. VibeLang's VIP-43 has not landed; move
   these contracts into its syntax when it does.
2. Effect 4.1.1's `Arbitrary` runs random intent sequences through the real sequencer, then delivers events to clients
   duplicated, reordered and with gaps (`test/conversation.test.vibe`, 400 runs per property).

## One command

From `apps/vibelang`, run `pnpm verify`. On the first run it installs the lockfile-pinned LemmaScript **0.6.6** npm
closure and **Dafny 4.11.0** into ignored `verify/.tools`. The installer verifies the official Dafny release archive's
SHA-256 before extraction. It supports Linux x86_64 and macOS arm64/x86_64; only Linux was exercised on this lane.
Node >=18, npm, Python >=3.9, curl and unzip are prerequisites; there is no global tool installation.

Every check strictly typechecks the selected source, creates a unique ignored `verify/.checks/run-*` directory,
generates fresh Dafny, and invokes Dafny with one solver core and a 30-second limit per assertion batch. It never
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

`pnpm verify:broken` checks the committed executable mutations in `verify/broken/`. Its generator checks that all
`//@` contracts and assertions are byte-identical to production and that the copies have not drifted. Every copy
must strictly typecheck, reach Dafny, and fail an obligation in its intended function; parser errors, backend type
errors, timeouts and tool failures do not count. The selftest selects the intended function in each unchanged-contract
copy; a direct `pnpm verify` on that copy checks every function. The selftest defaults to two workers. Individual failures are reproducible with
`pnpm verify verify/broken/<name>.ts`. `verify/broken/manifest.json` describes the mutations.

The verification subset keeps readonly records, string-tagged unions, spread appends and indexed `forall`
contracts. Lookup loops use an explicit index with loop invariants **inside the loop body**. Decision construction
uses typed `accepted`/`refused` helpers because 0.6.6 mis-lowers nested unions. Existing `.map`/`.filter` operations
remain where Dafny can verify them; local arrays and checked assertions provide element-preservation guidance.
`ReadonlyMap`, annotation lambdas, indexed `.every` and optional-field reconstruction are avoided, per the probe.
Tool defects and minimal reproductions live in `verify/bugs/`; they are not counted as successful negative proofs.

## Outside the proof

No proof yet covers eventual network delivery/replay convergence, liveness, the Durable Object/WebSocket/agent-flow
protocol, rendering, Effect execution, authentication, or deployment. Protocol modeling belongs with roadmap 1b
(TLA+/TLC). The existing `Arbitrary` suite checks replay convergence empirically. CI wiring for this local command is
still pending. The proof trusts TypeScript erasure, LemmaScript's lowering and local library, Dafny/Z3 and the stated
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
