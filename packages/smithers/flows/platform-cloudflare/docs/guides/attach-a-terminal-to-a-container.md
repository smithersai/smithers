---
title: "Attach a terminal to a container"
description: "Give each viewer a browser terminal on a tmux session in a Durable Object's container: wake the container offline with its intercepts, create the session, and bridge each WebSocket."
---

This guide gives a container Durable Object browser terminals. Each terminal is
a tmux session in the object's container, named by the terminal's id, and each
viewer's WebSocket gets its own tmux client. The owner types; everyone else
watches. Bytes travel over `@smthrs/sandbox`'s `TerminalProtocol`.

```
browser ── wss ──▶ Worker ──▶ Durable Object ── accept() ── attach ── exec(["tmux","attach-session",…], { pty }) ──▶ tmux
             authorizes, decides write | read       one tmux client per socket; the session outlives it
```

## 1. The container's image

The image needs `tmux`, a shell and a non-root user who owns the working
directory. Set tmux's `window-size latest` so the owner's size wins:

```dockerfile
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git tmux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 2000 workspace \
  && useradd --create-home --shell /bin/bash --uid 1000 --gid workspace smithers \
  && install -d -o smithers -g workspace /workspace
RUN printf 'set -g window-size latest\nset -g default-shell /bin/bash\n' > /etc/tmux.conf
USER smithers
WORKDIR /workspace
ENTRYPOINT ["/bin/sh", "-c", "exec sleep infinity", "box"]
```

Every command runs as a numeric `uid:gid`, here `1000:2000`. A deployed
container's `exec` refuses a user name and runs a bare `uid` as root, so give
the user fixed ids in the image. A command inherits only `PATH` from the
image: pass `HOME`, `USER` and `LANG` yourself.

```ts
const user = "1000:2000"
const env = { HOME: "/home/smithers", USER: "smithers", LANG: "C.UTF-8" }
```

## 2. Wake the container before each use

`SandboxObject.wake` starts the container with `enableInternet: false` when it
is not running, on the `instance` type you name (Cloudflare's default is
`lite`: 1/16 vCPU and 256 MiB), arms its inactivity timeout (30 minutes unless
you pass another), and registers each outbound HTTP intercept. The intercepts are the
box's only way out. An intercept's fetcher runs outside the box, so it can add
a credential the box never holds.

With Alchemy, the object's container handle is the machine, and a Worker
entrypoint reached through `ctx.exports` is the fetcher:

```ts
import { ContainerTerminal, SandboxObject } from "@smthrs/platform-cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { Box } from "./Box.ts" // a Cloudflare.Container with schedulingPolicy: "durable_object"

const state = yield* Cloudflare.DurableObjectState
const box = yield* Box
const egress = Cloudflare.fromCloudflareFetcher(state.raw.exports.Egress({ props: { repo } }))
const wake = SandboxObject.wake(box, {
  intercepts: [{ host: "forge.example.internal", fetcher: egress }],
  instance: "standard-1"
})
```

`wake` registers the intercepts on every call, not only after a start: a
restarted object, or one that died between its start and its registration,
gets them back.

A Durable Object that restarts, after a deploy for one, starts with no
inactivity timeout, and Cloudflare then stops its container soon after the
object goes idle, even while a process runs in it. Re-arm it once per
incarnation, in the object's constructor, and on each use that doesn't wake:

```ts
yield * SandboxObject.rearm(box)
```

## 3. Create the session

Opening a terminal is a write: run it as a durable flow step after the
person's access is checked. `ensureSession` creates the tmux session unless it
already runs, as a non-root user, in the working directory:

```ts
const open = (terminalId: string) =>
  wake.pipe(
    Effect.andThen(ContainerTerminal.ensureSession(box, { name: terminalId, user, cwd: "/workspace", env }))
  )
```

The name must be a lowercase UUID, and the user a `uid:gid` that is not root. The working directory admits only letters,
digits, `.`, `_`, `-` and `/`, because tmux expands formats in it.

## 4. Bridge each socket

The Worker authorizes the request and decides the viewer's access before it
upgrades: `write` for the terminal's owner, `read` for everyone else. The
object accepts the socket with `accept()`, never `acceptWebSocket()`: a
hibernated object would drop the tmux client's process. It runs `attach` in
the background for the socket's lifetime and answers 101:

```ts
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

const connect = (terminalId: string, access: "write" | "read", cols: number, rows: number) =>
  Effect.gen(function*() {
    if (!ContainerTerminal.isSessionName(terminalId)) return HttpServerResponse.empty({ status: 400 })
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    yield* state.waitUntil(
      ContainerTerminal.attach(box, server, { name: terminalId, user, access, cols, rows, env })
    )
    return HttpServerResponse.setBody(
      HttpServerResponse.empty({ status: 101 }),
      HttpBody.raw(new Response(null, { status: 101, webSocket: client }))
    )
  })
```

`attach` sends `ready {access}`, then:

| From the viewer                        | `write`                   | `read`                               |
| -------------------------------------- | ------------------------- | ------------------------------------ |
| a binary frame                         | to the shell's stdin      | dropped and counted                  |
| `resize {cols, rows}`                  | resizes its terminal      | dropped                              |
| a malformed text frame, or a non-frame | closes with 1003          | closes with 1003                     |
| a frame over 64 KiB                    | closes with 1009          | closes with 1009                     |
| its tmux client                        | `attach-session -t =<id>` | `-f read-only,ignore-size`, no stdin |

Ingress validates each frame before buffering. Retained frames share a 1 MiB
budget across ingress, stdin and the pending write. Each costs 64 bytes plus its
binary byte length (zero for resize), so at most 16,384 frames can be retained.
If the next frame would exceed it, the
socket closes with code 1011 and reason `Terminal input buffer full`; the viewer
may reconnect. Stdin consumes one frame at a time. Interruption closes the
socket with code 1011 and reason `Terminal interrupted`. Every exit removes all
three socket listeners and discards buffered input. Custom socket adapters must
implement `removeEventListener`.

When the session ends, every viewer gets `ended {reason: "closed"}` and close
code 1000. When a viewer goes away, `attach` kills only that viewer's tmux
client: the shell keeps running, and the next socket attaches to it and sees
its screen redrawn.

## 5. Observe it

`attach` runs in a `terminal.connect` span carrying the terminal's id, the
access, the outcome, the close code and byte counts, and logs one
`cloudflare.terminal.connect` line. Metrics carry no id:
`smithers_cloudflare_terminal_connects{access,outcome}`,
`smithers_cloudflare_terminal_sessions_open{access}` and
`smithers_cloudflare_terminal_bytes{direction}`. No byte a viewer types or a
shell prints is recorded.

## Test it locally

Miniflare runs a Durable Object's container image through Docker: set
`containerEngine.localDocker.socketPath` to Docker's endpoint with its
`unix://` scheme (`docker context inspect --format '{{.Endpoints.docker.Host}}'`).
Binary frames a Node client sends arrive in the object as `Blob`s; `attach`
reads them as bytes. Miniflare leaves the object's container running after
`dispose()`: remove `workerd-<worker>-*` containers after the run. The
package's `ContainerTerminal.workerd.test.ts` does all three.
