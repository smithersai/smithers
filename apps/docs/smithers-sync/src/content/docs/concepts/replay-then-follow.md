---
title: "Replay then follow"
description: "The two phases of a sync subscription: bounded catch-up pages until the durable tail, then credit windows of live frames, and the bounds and validation that hold at each step."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/concepts/replay-then-follow.md"
---

A subscription has two phases and one cursor set. First it replays durable
history through `Sync.Read`, page by page, until the server reports it reached
the tail. Then it follows through `Sync.Subscribe`. `SyncClient.subscribe`
performs both and presents them as a single stream of entries, so a consumer
never sees the switch.

## Phase one: pages until `done`

`Sync.Read` takes a scope, a cursor set, and a `limit`, and returns entries
plus the cursor set the page served through. A page stops at the first of three
bounds:

- the request's `limit`, capped at `SyncProtocol.maxReadLimit`;
- the frame ceiling, `SyncServer.Options.maxFrameBytes`, which defaults to
  2 MiB of summed encoded entries;
- the durable tail of every covered run.

Only the third reports `done: true`, and that is the signal to switch to the
follow.

The frame ceiling is a budget on the page, not a verdict on the read. The
server serves entries until the next one would cross it, then returns
`done: false` so the client asks for the rest. The single case that fails is
one entry whose own encoded size exceeds the ceiling, refused with
`frame_too_large`, because no page can ever carry it.

### Why a page is shared, not filled in order

A workspace read offers each covered run a share of the page before offering
unused budget back to runs that still have entries. Both passes prioritize the
least advanced supplied cursor, with run ID breaking ties. Runs without a
cursor come first. Cursor values set scheduling priority only; sequences still
order entries within their own run.

A count or byte budget can end a page before every run gets a share. Reusing the
returned cursors changes the next page's priority: served runs advance, while
unserved runs keep their priority. A continuously readable run cannot indefinitely
hold a slot ahead of another pending run. Empty runs spend no entry budget.
This requires no server-side session and does not depend on cursor array order.

Fair service does not guarantee `done`: a producer that continuously outpaces
catch-up can keep the follower in this phase. Every pending run still receives
service; a single page need not contain every run.

## Phase two: credit windows

`Sync.Subscribe` takes the same scope and cursors plus a `credit` count.
`credit` is a hard limit on frames that subscription may emit, enforced by the
server. It is not a sliding acknowledgement window, and there is no `Ack`
procedure.

A follower that wants more frames resubscribes from its current subscription
progress. `SyncClient` does exactly that, once per window, defaulting to
`SyncClient.defaultCredit` of 256 frames.

The number is a real trade. At `credit: 1` the window closes after every single
entry, so following a run that emits a hundred entries costs a hundred
subscribe round trips, each one a fresh cursor snapshot and a fresh server-side
fan-out. Replenishing a window at a time makes the round-trip cost proportional
to the window rather than to the traffic, and keeps it bounded: an unbounded
window would hand the server one never-closing subscription per follower.

## What a frame says

An `Entries` frame carries one run's entries plus the interval the server
covered: `runId`, `fromSeq`, `toSeq`. The interval describes what the server
looked at, not what it carried, because dropped admissions leave legitimate
holes inside it.

`fromSeq` is what gap detection compares against the cursor. A frame whose
`fromSeq` starts more than one past the client's cursor is a real gap and fails
the subscription with `SyncGapError`. A frame that merely omits sequences
inside its own interval is ordinary traffic.

No frame carries a cursor. The client tracks its own.

A `Closed` frame is terminal and ends the subscription with the `closed` code.
The `Heartbeat` variant is reserved: no server in this package emits one, so a
client must not wait for one. It stays in the union so adding it later is not a
wire break, and so a third-party client written against the schema already
ignores it. Keepalive is a transport concern here, because a heartbeat would
spend the subscription's credit.

## Server responses are admitted, never trusted

Both phases validate before any cursor moves. A schema-valid page or frame can
still contradict itself, and applying one would corrupt the client's
bookkeeping. The client refuses:

- a page or frame whose summed encoded entries exceed `maxFrameBytes`, with
  `frame_too_large`;
- an entry for a run the request's scope excludes;
- entries that repeat or reorder a sequence within one run;
- an entry at or below the cursor the request carried;
- an entry outside a frame's own declared interval;
- a response that echoes one run's cursor twice.

Each of the last five is a `protocol_violation`. The strictly-above-the-cursor
rule is also what makes catch-up converge: a page that carries entries but
moves no cursor would be re-read forever. An incomplete page with no entries at
all is refused for the same reason rather than retried.

## Reconnecting

A live follow that loses its transport reconnects under exponential backoff
capped at five seconds, resuming from the subscription's progress, and the
schedule resets once entries flow again. Only `transport_failed` retries. Gaps,
authorization refusals, and server closes propagate to the consumer, because
none of them is fixed by trying again. Delivery-only subscriptions resume from
delivered bookmarks; applying subscriptions resume from applied progress.
An unrelated defect or interruption accompanying a disconnect stays terminal,
with its complete cause preserved.

Transport, authentication, and reconnect all live in this package rather than
in the application. A follower that had to implement them would have to
re-derive the cursor rules above to do it safely.

## Related pages

- [Scopes and cursors](/concepts/scopes-and-cursors/): what the cursor a phase
  resumes from means.
- [Compaction and resync](/concepts/compaction/): the one refusal that is recoverable
  rather than terminal.
- [Wire protocol](/protocol/): the exact message shapes both phases use.
