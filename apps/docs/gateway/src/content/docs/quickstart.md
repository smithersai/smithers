---
title: "Quickstart"
description: "Serve a workspace gateway on loopback, prove which workspace it belongs to, read a projection snapshot off the wire, and follow one run live."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/gateway/docs/quickstart.md"
---

This quickstart brings a real gateway up over a real project and reads it the
way a client outside the process reads it: over HTTP, off the wire, with no
library on the other end.

By the end you will have probed `/health`, read a `workspace-runs` snapshot as
newline-delimited JSON, and followed one run's summary until it settled.

## Before you start

- The `smthrs` executable, installed as described in
  [Installation](/installation/).
- A project with at least one run. If you have none,
  [the CLI quickstart](https://cli.smithers.sh/quickstart/) takes an empty directory to a
  settled run in six commands.
- `curl` and `jq`, and Node 22.19.0 or later for the last step.

## Serve the workspace

From the project root:

```bash
smthrs serve
```

```text
smthrs serve listening on http://127.0.0.1:3000
  /rpc              http://127.0.0.1:3000/rpc              control rpc
  /rpc/ws           ws://127.0.0.1:3000/rpc/ws             control rpc, including watch
  /projections      http://127.0.0.1:3000/projections      projection snapshots
  /projections/ws   ws://127.0.0.1:3000/projections/ws     projection subscriptions
  /sync             http://127.0.0.1:3000/sync             journal sync
  /sync/ws          ws://127.0.0.1:3000/sync/ws            journal sync stream
  /health           http://127.0.0.1:3000/health           workspace identity
  auth  no bearer (loopback Host; loopback browser Origin)
```

That is `@smthrs/gateway`'s assembly, bound by `NodeGateway.layer`. The bind is
loopback, so it needs no credential. It accepts only loopback `Host` values,
and a browser request that carries `Origin` must name `http` or `https` on
`localhost`, `127.0.0.1`, or `[::1]`; an Origin-less CLI request remains
accepted. The server lives exactly as long as the command, so leave it running
and open a second terminal for everything below.

## Ask which workspace it is

```bash
curl -s http://127.0.0.1:3000/health | jq
```

```json
{
  "workspaceHash": "8f4b2c1d90a37e56",
  "gatewayId": "cli-4821",
  "protocolVersion": "1",
  "version": "1.0.0-rc.0"
}
```

`/health` is the one unauthenticated route, and identity is all it carries: no
token, no run, no path. A supervisor that finds a process already on this port
asks it this before deciding to keep or replace it.

## Read the workspace's runs

The read path speaks RPC over newline-delimited JSON. One request is one line:
a `Request` envelope naming the procedure and carrying its payload.

```bash
curl -s http://127.0.0.1:3000/projections \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
'
```

The answer is one `Exit` line. Pull the snapshot out of it:

```bash
curl -s http://127.0.0.1:3000/projections \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
' | head -1 | jq '.exit.value.rows[0]'
```

```json
{
  "runId": "run-1",
  "flowId": "hello",
  "status": "completed",
  "createdAt": 1000,
  "updatedAt": 2000,
  "seat": "anthropic:claude-sonnet-4-5",
  "turns": 1,
  "calls": 1,
  "callsFailed": 0,
  "editsAttempted": 1,
  "editsSucceeded": 1,
  "inputTokens": 0,
  "outputTokens": 0,
  "verdict": "completed \u2014 shipped",
  "diagnosis": "Verdict   completed \u2014 shipped\nRun       run-1 · hello · anthropic:claude-sonnet-4-5 · 5s\nActivity  1 turns · 1 calls (0 refused) · edits 1/1\nTokens    0 in / 0 out\nOutput    shipped",
  "finalOutput": "shipped"
}
```

Nothing in that row is a database column. Every field is either a
`@smthrs/control` run-summary value or something folded out of that run's
ordered control events, which is why the same row reaches a browser through a
relay unchanged. See [Projections](/concepts/projections/).

The snapshot also carries the cursor its rows were read at. Keep it: it is what
makes a follower resume without rewinding.

## Follow one run

Copy a `runId` from the listing, then follow that run's summary over the
subscription socket. Save this as `follow.mjs`:

```js
const runId = process.argv[2]
const socket = new WebSocket("ws://127.0.0.1:3000/projections/ws")

socket.addEventListener("open", () => {
  socket.send(
    JSON.stringify({
      _tag: "Request",
      id: 1,
      tag: "Projection.Subscribe",
      payload: { selector: { _tag: "run-summary", runId } },
      headers: []
    }) + "\n"
  )
})

// The server answers NDJSON. A stream arrives as Chunk messages whose values
// are the subscription's own frames.
socket.addEventListener("message", (event) => {
  for (const line of String(event.data).split("\n").filter((text) => text !== "")) {
    const message = JSON.parse(line)
    if (message._tag !== "Chunk") continue
    for (const frame of message.values) console.log(frame._tag, frame.cursor?.value ?? "")
  }
})
```

```bash
node follow.mjs run-1
```

```text
snapshot-start 6
row 6
snapshot-end 6
heartbeat
```

Three snapshot frames, then a keepalive because nothing has changed yet.
Launch or steer that run from another terminal and `delta` frames arrive, each
one carrying the selector's rows recomputed at a new cursor. The keepalive is
not decoration: an idle subscription that sent nothing for 600 seconds would
be cut by a relay, so the server emits one every 30 seconds.

## What just happened

One process served four mounts on one socket. `/health` answered an identity
question with no credential. `/projections` answered a fold over the control
plane's own events, framed exactly the way a relay forwards them to a browser.
The socket turned that same fold into a snapshot plus a live tail, at a cursor
a client can resume from.

The control plane was there the whole time, on `/rpc`, under the same
credential rule. That mount is [`@smthrs/control`](https://control.smithers.sh/reference/api/)'s contract
unchanged: this package mounts it and adds a keepalive, and re-declares none of
its procedures.

## Next steps

- [Read a projection over HTTP](/guides/read-a-projection/): every selector,
  the row each answers with, and how to decode instead of cast.
- [Follow a run over a WebSocket](/guides/follow-a-run/): the frame
  vocabulary, and resuming from a cursor without a second snapshot.
- [Host the gateway in your own process](/guides/host-the-gateway/): the
  composition behind `smthrs serve`.
- [Serve beyond loopback](/guides/serve-beyond-loopback/): the two rules
  that gate a network bind, and the ingress policy behind them.
