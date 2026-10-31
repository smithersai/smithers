---
"@smthrs/agent": minor
---

Adds external agents: a durable step whose work an agent program does on a runner machine, with no vendor named.

- `AgentRunner` is the contract between a host and its runners: an agent is a name, machine labels and an opaque
  profile; a job is claimed, heartbeated and settled with the files the agent changed (`Done`), a coded failure, a
  retryable end, or a cancellation that says whether the agent's process tree was gone. `AgentJobs` is the host's job
  store port.
- `ExternalAgent.make(tag, { payload, task })` declares the step: an `ExternalJob` that queues generation `<origin>#g<n>`,
  probes from 2 seconds doubling to 30, replaces a retryable generation, and answers `{ changes, summary, usage,
  generation }` or fails `AgentFailed` with a code.
- `Acp.make(transport, { onUpdate })` is an Agent Client Protocol client over an agent's stdio: `initialize`,
  `newSession`, `loadSession`, `prompt`, `cancel`, and every `session/update` as it arrived.
