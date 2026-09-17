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

## Drivers

The routes, the store, the hub and the projection never see an engine. They
see the `Driver` service: start a turn and receive its harness events through
a sink, interrupt it, answer a permission, steer text into it, and re-drive
what was parked when the process last stopped. `ScriptedDriver` replays a
recording; the durable engine driver implements the same service over
`Agent.run`.

## Pages

- [API reference](./api.md)
