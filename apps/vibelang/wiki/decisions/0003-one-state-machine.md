# 0003. One state machine across browser and server

**Status:** accepted, 2026-11-07. **Rulings:** VL-8, VL-12.

**Decision.** A conversation is one state machine (`src/core/conversation.ts`), plain TypeScript with no Effect:

```
intent ──decide──▶ event #seq ──apply──▶ conversation        the sequencer (one per conversation)
                   event #seq ──receive──▶ client             every copy: browsers, CLI, MCP
```

- `decide` is the only writer: it numbers the next event (`seq = last + 1`) or refuses with a reason.
- `apply` is shared: every copy applies the same numbered events in order. A stale event changes nothing; the next one
  always advances `seq`.
- `receive` adds a client's view: posts it sent that no event has confirmed (`pending`), and `gap` when an event
  arrives ahead of the next one, after which it replays from its last `seq`.
- The Foldkit Model holds a `Client`; its `update` only calls these functions plus screen state (splash, prompt).

**Why.** poteto's pstack ("Model the Domain"): a state machine or reducer instead of scattered conditionals, so
invalid states can't be represented and the rules live in one module that tests and provers read directly.

**Invariants** (0005 proves them): `seq` counts up by one with no gaps; the agent is `working` exactly when a reply is
open, and only that reply is unfinished; entries are ordered by `seq`; a client id appears at most once; a client that
sees any order of duplicates and gaps converges on the sequencer's conversation.
