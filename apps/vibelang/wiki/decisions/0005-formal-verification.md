# 0005. Formal verification of the state machine

**Status:** accepted, 2026-11-07. **Rulings:** VL-9, VL-15.

**Decision.** Two layers check the machine in `src/core/conversation.ts`:

1. **Proofs.** LemmaScript (`lemmascript` 0.6.6, MIT, Midspiral) reads `//@` contracts in the TypeScript and Dafny
   4.11.0 proves them for every input. This is the comment syntax VibeLang's open VIP-43 (`theorem`, `spec`, `proof`)
   would lower to, so the contracts move into VibeLang syntax when that VIP lands.
2. **Properties.** Effect's `Arbitrary` (`effect/Arbitrary`, Effect 4.1.1) runs random intent sequences through the
   real sequencer and delivers the events to clients duplicated, reordered and with gaps (`test/conversation.test.vibe`).

**What the probe found** (nyc-01, 2026-11-07; 22 shapes proved in 25 s, all 22 broken copies rejected): write the
machine as pure transitions over readonly records, string-tagged unions, array updates by spread, indexed `forall`
contracts and bounded integer sequence numbers. Avoid `ReadonlyMap`, lambdas inside annotations, indexed `.every`
callbacks in code, and rebuilding a record from narrowed optional fields.

**Able to fail.** Each property and proof is shown failing on a broken copy of the code it guards. Removing the "one
reply at a time" guard from `decide` fails "gives every event it numbers the full effect its type names".

**Not covered yet.** The ordering between the Durable Object, its WebSocket clients and the agent's flow (roadmap 1b)
is a protocol question for a model checker (TLA+ with TLC, as in `~/Desktop/fv-report.md`), added with that brick.
