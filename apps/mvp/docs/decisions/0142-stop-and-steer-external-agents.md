# 0142: Stop and steer an external agent

Date: 2026-10-31. Status: accepted. Builds on [0136](0136-external-agents-on-runners.md) (external agents on runners),
[0141](0141-agent-transcripts.md) (transcripts) and [0026](0026-watching-a-todo-run.md) §6 (steering a TODO's run). Design: slice S3 of the G1/G2 design
(`~/Desktop/smithers-sh-parity/design-g1g2/FINAL.md` §2.7), probe S0 (`../s0-probe/REPORT.md`, findings 1 to 3).
Will reviews it with the feature (HOST-3).

## Problem

A TODO coded by an external agent on a runner could be neither steered nor stopped from its run's page: the steer
route admitted messages only while `todo/Implement` ran, and only a dropped TODO stopped its run. A run cancelled while
`agent/Session` was parked between probes left the agent running until its hours ran out, because `ExternalJob`'s
cancellation was a rollback held by the process that parked it, and a parked step's host is gone
(`sandbox-tools.md`, "Cancelled runs").

## Decision

1. **Stop ends the agent, not the run.** `POST /api/remote-runs/<run>/stop` on a TODO's run whose `agent/Session` works
   stops every open generation of the attempt's job in one statement (`Jobs.stop`): queued and retryable ones end
   `cancelled`, a claimed one gets `cancel` at its runner's next heartbeat, and a later generation's start finds its
   predecessor cancelled. The runner cancels the turn, ends the agent's whole process tree and settles
   `Cancelled { processTreeGone }`. `agent/Session` fails `cancelled`, and the run fails the TODO with the new code
   `stopped`, so the TODO keeps its place for Retry and nothing reaches GitHub.
2. **Cancelling a parked `ExternalJob` is durable, in the SDK.** `@smthrs/flow` gains `Flow.OnCancel`: a store-backed
   engine that cancels an execution of a flow that declares one admits the declared flow as a root run, with the
   execution's payload, before it commits the cancellation, and records it in the cancelled state, where a Durable
   Object host's routing starts it. `ExternalJob`'s observation declares `<tag>/stop`, run as `cancel:<key>`, whose one
   step is the generation's `cancel`. So dropping a TODO, or any cancellation of a run, stops its agent though no process
   held the step.
3. **Steers ride the heartbeat.** The steer route admits a message to the run's queue as before, and `steerable` widens
   to "the run's agent step runs": `todo/Implement` or `agent/Session`. A working job's heartbeat answer carries the
   run's pending steers, rendered as Smithers' agent reads them. The runner hands each over once: into the turn in
   flight over ACP's `_session/steering` when the agent advertises it (S0: both Claude Code's and Codex's adapters do),
   else by cancelling the turn and prompting with the steer and "Then continue the task.", or as the next turn after
   one ended.
4. **Delivered means the agent read it.** The runner reports a steer only after the agent's next update following it,
   and the heartbeat route promotes exactly those ids (`DrainInput.ids`, new in `@smthrs/notifications`) under
   `runner:<job key>:<digest>`, which the run page reads as Delivered. The runner's checkpoint keeps a ledger, so a
   steer is never handed over twice; one handed over before a restart and never confirmed stays Sent.

## Rejected

- **Stop as the engine tombstone plus `cancel_requested` in one transaction** (FINAL.md §2.7): a cancelled `todo` run
  never reaches `todo/Fail`, so its TODO would stay Working, holding a lane, with no Retry (Retry takes a failed TODO).
  The tombstone also lives in the run's Durable Object, not Postgres, so no one transaction holds both.
- **Cancel-then-prompt as the only delivery** (FINAL.md §2.7): S0 found native mid-turn steering in both adapters,
  which keeps the tool call in flight. Cancel-then-prompt stays the fallback for any ACP agent without it.
- **Draining up to a sequence cutoff**: a steer handed over before a restart and never confirmed would be promoted
  with a later confirmed one, and read Delivered though nothing proves the agent read it.

## Consequences

- The agent's processes are gone within a heartbeat and the tree's 5 s grace (real Claude Code and Codex commands
  ignore `SIGINT` and die at `SIGKILL`); the page reads Stopped only once `agent/Session`'s next probe, at most 30 s
  later, fails the step.
- A native steer can make an agent move its running command to the background and end its turn (Claude Code did in S0
  and in this slice's eval), and the runner can't tell that from a finished turn. A profile sets `steering: "prompt"`
  for such an agent. Waiting for an agent's own processes instead was tried and rejected: Codex keeps helper processes
  alive between commands, so a job would wait until its deadline. Stopping is the tab's own: another tab
  reads Working until then.
- Each heartbeat of a working job reads its run's pending steers from the engine's journal, one read per job every
  10 s.
- An `ExternalJob` provider's `cancel` may be asked twice for one key (the in-process rollback and `cancel:<key>`); the
  documented contract already asks it to be idempotent, and the job store's is.
- The run's transcript ([0141](0141-agent-transcripts.md)) marks each steer the runner hands over as `_smithers/steer
  { id, mode }` and a stop as `_smithers/cancel`, through the runner's spool and before the agent hears either;
  every turn a steer cancels still ends with `_smithers/turn`. The Transcript panel shows both in words. The marker
  never carries the steer's words, which the run's steer list shows.
- A TODO's run that dies (`crashed`) stops its agent the same way, because a settled run offers no Stop and no step waits
  on the job any more. `_smithers/cancel` therefore says the host stopped the agent, not who asked: a person, the
  agent's hours running out, or the run dying. The `todos.failure` constraint keeps `crashed` beside `stopped`.
