# Chat run monitor

The screenshot supplied on 2026-09-22 came from
`~/Desktop/smithers-agent-monitor/index.html`, created in Claude session
`25817c50-6d41-4677-a17c-4cbb3c5bb4a2`. Its exact completion-warning text and
phase labels remain in that standalone prototype.

The implementation was not confined to a lost branch. The trace journal arms
landed on main in `3b2b9f518c`; the app's fold, narrative, evidence notes, and
phase strip landed in `a98f757e71c0`. Subsequent changes connected native
engine evidence and fixed scoped ownership, inspection, and status handling.
The production monitor lived inside embedded run cards. Ordinary chat uses a
separate HTTP-turn transcript, and the terminal previously discarded most of
the discipline events. Neither surface had the prototype's persistent bottom
monitor.

## Shared evidence, two presentations

`@smthrs/gateway/RunTrace` and `EngineTrace` own the existing pure journal
projection. The app keeps re-export modules for its existing callers. The TUI
uses `AgentSession.trace` to project its saved harness events into exactly the
same records; older sessions without model requests or call identities retain
the evidence they actually saved.

The app's `ChatRunTimeline` follows the newest running job in the current
conversation, falling back to its latest recorded job. The dock and embedded
card use the same persisted cursor and source-card command identity. Selecting
a moment reveals the card; Latest resumes following. Bands retain whole-run
geometry while the card reads only the selected journal prefix. Chat remains
available during both execution and inspection.

The TUI follows chat or a running worker. Ctrl+T focuses inspection; arrows
visit every journal record, Home/End jump, and Esc returns to live. Clicking a
band or milestone selects it. Frame summaries and discipline evidence are
folded only through that cursor. Dense labels use two rows and overflow ticks;
all records remain reachable with the keyboard. Session restore rebuilds the
projection from persisted events.

A plain HTTP conversation without a run journal has no coding phase strip.
Missing records never become invented research, testing, or verification.

## Coordinator latency

A recent local session recorded a 428 ms model response followed by a
131,074 ms cell, including 67,937 ms between printed output and settlement.
The native host installed workspace observation for every role. Each cell
measured the checkout before and after evaluation, including coordinators
that cannot use filesystem or shell flows.

The TUI now provides the observer only to coding workers. A real harness
replay of `ctx.done("ok")` on the full checkout completed warm turns in
176–203 ms, with the cell settling in the same millisecond as the model
response. This isolates cell overhead; it is not a live provider latency
claim. Workers retain workspace observations for sealed-read invalidation.
The concurrent native scanner optimization landed in `685734ede1`, together
with the coordinator observer change. Its host port keeps a single digest fold
and measures directory entries together; the TUI adds no duplicate scanner.

## Verification

- Shared projection and existing app status, card, engine, and command tests.
- Browser probes for narrow/wide labels, keyboard and pointer scrubbing,
  continued typing, live journal growth, source identity, reload, and Latest.
- TUI projection over a recorded real model run, including failures, restored
  history, early inspection, cancelled turns, and bounded column allocation.
- Real PTY replay with cell execution, Ctrl+T, Home/End, Esc, and composer input.
- Real harness test proving the coordinator does not observe the checkout
  while a coding worker still does.
