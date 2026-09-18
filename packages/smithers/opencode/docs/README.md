---
title: "@smthrs/opencode"
description: "An OpenCode protocol server over the Smithers agent loop: the hosted OpenCode app renders Smithers turns as sessions, tool cards, permission cards and history, with no UI of its own."
---

`@smthrs/opencode` puts the Smithers cell loop behind the OpenCode app. You
start `smithers opencode` in a repository, open `https://app.opencode.ai`, and
the app connects to `http://127.0.0.1:4096` the way it connects to OpenCode's
own server. Every prompt runs a Smithers turn; every cell, call, print and
demand the loop produces becomes a card in the timeline; a permission park
becomes the app's approval card; a reload reads the history back from disk.

## What the app speaks

The hosted app probes `GET /global/health` and, when it answers
`{healthy: true}`, runs OpenCode protocol v1: `/session`, `/provider`,
`/agent`, `/config`, `/path`, `/project`, `POST /session/:id/prompt_async`,
`POST /session/:id/permissions/:id`, and the `/global/event` stream whose
envelope is `{directory, project, payload: {id, type, properties}}`. Three v2
routes are called as well: `/api/health`, `/api/session` and `/api/reference`.
The contract, as traced from the app against OpenCode 1.18.31, is in the
repository at `docs/jev-harness/trace/summary.md`.

## How a turn is rendered

Each frame of the loop opens a `step-start` part. The model's prose streams
into a `reasoning` part. The cell it wrote is a `cell` tool part whose output
is what the cell printed and whose title counts its calls and edits. Every
`ctx.call` is a tool part named after the flow, with `ls` renamed to `list`,
so the app's cards for `read`, `edit`, `write`, `bash`, `grep`, `glob` and
`apply_patch` apply. A discipline demand is a `demand` part. The final answer
streams as a text part, then the assistant header gets its finish, the session
its tokens, and the status goes idle.

Part ids are derived from the assistant message and a sort key, so a frame
replayed after a permission park names the same parts and the app updates the
cards it already shows instead of drawing them twice.

## Classify and the health dot

The cell has a door to Jev: the `classify` flow and the curated
`classify/triage/relevance`, `classify/check/verdict`, and
`classify/edit/risk` flows of `@smthrs/std`, bound over the evaluator the
host installs. A classify call renders as a `classify` card titled with the
count of states and questions and the time Jev took, one line per state with
the leading answer and its probability, and the full answers as the card's
structured metadata.

After every frame the server asks Jev three questions about the run and
folds the answer into a dot in front of the session title: 🟢 progressing,
🟡 repeating itself or exploring without an edit, 🔴 parked or in need of a
person, ⚪ health unavailable. A `health` card appears on every color change
with the reason as its title. The rule is a pure function in `Health.decide`;
the evaluation runs on its own fiber with a deadline and never touches the
turn. Each decision is recorded in the store as a `flows.opencode.health.v1`
row.

## The gateway key is required

`AI_GATEWAY_API_KEY` is not optional for a server that runs a model. The
harness asks Jev whether the sentence a turn wrote describes what the turn
did, and a completion nothing judged ends the run as `completion_unjudged`
rather than standing. So `smithers opencode` runs a startup preflight
(`EngineDriver.evaluatorRefusal`) and refuses to start when the host can bind
no evaluator, with `EngineDriver.noEvaluator` and exit 2. The question is what
the host can provide: a host that injects its own evaluator, which is what the
tests and any scripted judge do, starts whatever the environment holds.

A turn that only converses still completes without a judge, because a
completion with no evidence claim forms no question, which is why the gap
showed up as a working demo and a failing first real task. `--scripted`
replays the recorded turn, runs no model, and needs no key at all.

When Jev is reachable but one evaluation fails, the transport answers
`unreachable` for that call: the classify call resolves as `{ ok: false }` in
the cell, the dot is gray, the gray card is titled `health unavailable: ...`,
and the run goes on.

## Frames and the read-only cap

A turn runs on the harness's cell loop with the host's teaching in its
system context (`EngineDriver.hostTeaching`): answer a conversational
request, or one the printed output already answers, with `ctx.done` in that
same cell; call flows only when the request needs them; never run a command
the person did not ask for. The read-only cap is armed at six frames
(`EngineDriver.readOnlyCap`): a turn that only reads or only prints is
demanded an action at six read-only frames and stopped at twelve, which
closes as a red `stopped` health decision. `smithers opencode` passes a
frame budget of forty (`--max-frames`); raise it for a long task.

## Cost

Every model settlement updates the session's tokens and cost, and the
assistant header carries the turn's. The seat's price is the host's to
name (`Serve.Options.pricing`); without it the cost is zero. The turn ends
with a synthetic text part summarizing frames, calls, classify calls, and
the Jev calls with their latency and spend.

## Drivers

The routes, the store, the hub and the projection never see an engine. They
see the `Driver` service: start a turn and receive its harness events through
a sink, interrupt it, answer a permission, steer text into it, and re-drive
what was parked when the process last stopped. `ScriptedDriver` replays a
recording; the durable engine driver implements the same service over
`Agent.run`.

## Pages

- [Quickstart](./quickstart.md)
- [API reference](./api.md)
