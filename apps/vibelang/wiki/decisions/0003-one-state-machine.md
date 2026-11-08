# 0003. One state machine across browser and server

**Status:** accepted, 2026-11-07. **Rulings:** VL-8, VL-12.

**Decision.** A conversation is one state machine (`src/core/conversation.vibe`), VibeLang with no Effect code:

```
intent ──decide──▶ event #seq ──apply──▶ conversation        the sequencer (one per conversation)
                   event #seq ──receive──▶ client             every copy: browsers, CLI, MCP
```

- `decide` is the only writer: it numbers the next event (`seq = last + 1`) or refuses with a reason. `Post` and
  `StartReply` require a nonempty entry id that has never appeared in this conversation, including finished replies.
  `StartReply.inReplyTo` must name an existing person post with no reply, including finished or failed replies.
  `ReplyStarted` and its projected entry preserve that post id; malformed starts only advance the replay cursor.
- `RestartReply` (event `ReplyRestarted`) empties the streaming reply's text when the agent's model call retries, so
  the next attempt streams from nothing; only the reply that streams can restart (0010).
- A tour (0014) is an agent entry that answers no post: `StartTour` (event `TourStarted`) opens it while the agent
  is idle, it streams and settles as a reply does, `OpenPane` (event `PaneOpened`) sets the conversation's `pane`
  only while it streams, and `EndTour` (event `TourEnded`) ends only a tour, keeping its text.
- `apply` is shared: every copy applies the same numbered events in order. A stale event changes nothing; the next one
  always advances `seq`.
- `receive` adds a client's view: posts it sent that no event has confirmed (`pending`), and `gap` when an event
  arrives ahead of the next one, after which it replays from its last `seq`.
- Every intent reaches `decide` from a durable flow step (0011): a person's post from `vibelang/Post`'s record step,
  the agent's reply from `vibelang/Reply`'s steps (0010). The flows call this module; nothing duplicates it.
- The Foldkit Model holds a `Client`; its `update` only calls these functions plus screen state (splash, prompt).

**Why.** poteto's pstack ("Model the Domain"): a state machine or reducer instead of scattered conditionals, so
invalid states can't be represented and the rules live in one module that tests and provers read directly.

**Invariants** (0005 proves them for every input; replay convergence is property-tested): `seq` counts up by one
with no gaps; every accepted reply targets an existing unanswered person post; the agent is `working` exactly when a reply is open, and only that reply is unfinished; entries are
ordered by `seq`; entry ids are nonempty and unique; a client id appears at most once; an event preserves every
unrelated entry. The property suite checks these after every accepted intent, with a retained regression for a reply
reusing a person's or a finished reply's id.

**Gap recovery property.** Deliveries may duplicate, reorder or omit events, with the final numbered event eventually
delivered. Only `receive` setting `gap` requests replay from the client's last applied `seq`; the harness never forces
a final replay. An entirely silent missing tail needs reconnect, covered by the surface/runtime tests. A receive
mutation that never flags gaps must fail convergence for `Posted #1, ReplyStarted #2` delivered as `[1]`.

**Post recovery and names (Fable 7, 11).** A failed pending post keeps its id and text. Retry clears only its failure
via `retryPost`, then sends the same id through Factory; it cannot append another optimistic copy. Posts carry
`Guest` from the browser until sign-in exists. Only the view calls a person post `You`, when its client id has this
tab's session and numeric post suffix; other people's names remain unchanged.
