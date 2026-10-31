---
title: "External agents on runners"
description: "Hand one durable step to an agent program on a machine you run: the runner contract, the ExternalAgent step, and the ACP client the runner speaks."
---

An external agent is an agent program that runs on a machine you control, a
runner, rather than inside your flow. `@smthrs/agent` gives you three pieces:

- `AgentRunner`, the contract between your host and its runners. It names no
  agent vendor: an agent is a name, the machine labels a runner must carry, and
  an opaque profile that only the runner's own configuration reads.
- `ExternalAgent`, a durable step that queues a job, waits on it with parked
  probes, and ends with the files the agent changed.
- `Acp`, a client of the [Agent Client Protocol](https://agentclientprotocol.com),
  which a runner uses to drive whatever command a profile names.
- `Transcript`, what a runner sends its host of the agent's session as it
  happens, and how it makes each event safe and small first.

`smthrs runner` is a runner built on these pieces (see its
[CLI reference](../../../docs/reference/cli/runner.md)).

## Declare the step

```ts
import { ExternalAgent } from "@smthrs/agent"
import * as Schema from "effect/Schema"

export const Session = ExternalAgent.make("app/Session", {
  payload: { prompt: Schema.String, base: Schema.String },
  task: ({ prompt, base }) => ({
    agent: { name: "coder", labels: ["linux"], profile: "my-agent", maxHours: 4, restarts: 1 },
    repository: "github/acme/app",
    base,
    system: ["Leave the change uncommitted in the working copy."],
    prompt,
    limits: { files: 50, bytes: 1024 * 1024 }
  })
})
```

Call it from a flow body with `Session.call(payload)`. Register it with
`Session.toLayer()` over your host's `AgentRunner.AgentJobs`, and, on a host
that resolves executions by tag, list `Session.flows`.

## Implement the job store

The store is the external system the step waits on. Your runner routes claim,
heartbeat and settle its rows; the step only starts, reads and cancels:

- `start(task, key)` queues generation `key` once; the same key again does
  nothing.
- `status(key)` answers `Running` (queued, claimed, or on a runner that stopped
  answering), `Again` (a retryable end with restarts left), or `Ended` with the
  outcome. Answer `Ended` with `timeout` once the agent's hours are up, and
  `exhausted` for a retryable end past its restarts.
- `cancel(key)` ends a queued job, asks a claimed job's runner to stop it, and
  for a key not started yet records a cancellation that wins over a later start.

Fail `AgentJobsUnavailable` when the store can't record an operation; the engine
retries it.

`cancel` may be asked twice for one key: a run cancelled while its step is
parked between probes stops the generation through its own run, `cancel:<key>`,
and a host that held the step in process also stops it from its rollback. Keep
it idempotent.

## Steer the agent

A heartbeat's answer may carry `steers`, the messages people sent the agent that
it hasn't read, and the next heartbeat lists in `delivered` the ones the agent
answered after. Your heartbeat route reads them from wherever your host keeps a
run's messages and records each delivery; the runner hands every steer over
once, into the turn in flight when the agent takes `_session/steering`, else by
cancelling the turn and prompting again.

The runner marks each steer it hands over in the transcript as
`Transcript.KINDS.steer` (`{ id, mode }`, never the words), and a stop your host asked
for as `Transcript.KINDS.cancel`, so a person watching sees where the agent
was interrupted.

## Durability

The step is the session's durable unit. Its journal holds the start, each probe,
each generation and the result, never the agent's transcript. A runner keeps the
agent's own session id beside its checkout and resumes with ACP's `session/load`
after a crash, so the agent continues from the last turn its own session
recorded. A generation after a retryable end goes to the same runner, whose
checkout holds the work so far.

## Send the transcript

A runner forwards the agent's `session/update` stream as numbered events, so
its host can show the session live. `Transcript.prepare` makes one update ready
to leave the runner: it drops the agent's slash commands and configuration
options, scrubs every string, and bounds the result to
`Transcript.MAX_EVENT_BYTES`, splitting a long message and cutting any other
long string.

```ts
import { Transcript } from "@smthrs/agent"

const scrub = Transcript.scrubber(["value-of-a-secret"])
const events = Transcript.prepare(update.kind, update.update, scrub)
```

Number each event from 0 within the job's generation and post them as
`Transcript.EventsRequest` to `AgentRunner.ROUTES.events`. The host keeps each
`seq` once and answers `{ next }`, the lowest it lacks; send again from there.

## Drive an ACP agent

```ts
import { Acp } from "@smthrs/agent"
import * as Effect from "effect/Effect"

const once = (transport: Acp.Transport, cwd: string, text: string) =>
  Effect.gen(function*() {
    const client = yield* Acp.make(transport, { onUpdate: (update) => Effect.log(update.kind) })
    const { loadSession } = yield* client.initialize
    const session = yield* client.newSession(cwd)
    return { loadSession, stopReason: yield* client.prompt(session, text) }
  }).pipe(Effect.scoped)
```

`transport.incoming` is the agent's stdout split into lines and
`transport.send` writes one line to its stdin. Errors carry codes, never the
agent's message.
