---
"@smthrs/agent": minor
"@smthrs/cli": minor
---

Steering and stopping an external agent on a runner.

- `Acp`: `initialize` reports `steering` (the agent advertises `_meta.steering.supported`), and `client.steer` hands a
  message to the turn in flight over `_session/steering`, which the published ACP adapters of two coding agents serve.
- `AgentRunner`: a heartbeat's answer carries the job's undelivered `steers` (`{ id, text }`); a heartbeat and the
  settlement list the ones the agent read (`delivered`).
- `smthrs runner` hands each steer to its agent once: into the turn in flight when the agent takes steering, else by
  cancelling the turn and prompting with the steer and "Then continue the task.", or as the next turn after one ended.
  A steer is delivered when the agent sends its next update after it. The session checkpoint keeps a ledger, so a steer
  handed over before a restart is never handed over again.
- `Transcript.KINDS` gains `steer` and `cancel`: `smthrs runner` marks each steer it hands over as `_smithers/steer`
  `{ id, mode }` and a stop the host asked for as `_smithers/cancel` in the job's transcript, and every prompt
  turn's end as `_smithers/turn`, a turn a steer cancelled included.
- `smthrs runner` fixes: the process-tree watcher walked only from processes it hadn't seen, so a command an agent
  started under one it had seen (a coding agent's shell command, three levels down) was never seen, and a stop
  reported the tree gone while the command ran on. It walks the whole tree each time, looks before cancelling a turn
  (an adapter may end its helpers on a cancel and orphan their commands), and never counts an unreadable process table
  as gone. `runner.tree` logs what each stop saw, signalled and left; `runner.quiet` how long the end of a turn waited.
- A profile's `steering: "prompt"` makes the runner cancel and prompt even for an agent that takes native steering,
  for one whose native steering moves its running command to the background and ends its turn.
