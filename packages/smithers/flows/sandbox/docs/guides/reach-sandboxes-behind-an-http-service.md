---
title: "Reach sandboxes behind an HTTP service"
description: "Serve a retained provider over HTTP with HttpSandbox.serve, and reach its machines from any host with HttpSandbox.make."
---

Some providers only run where their infrastructure is: `CloudflareSandbox`
takes a Worker binding, so only a Worker can construct it. `HttpSandbox` puts
such a provider behind an HTTP service and gives every other host (a laptop, a
build server) a `Sandbox.Provider` that reaches it with a URL and a token.

- `HttpSandbox.serve` turns a retained provider into a handler on web-standard
  `Request` and `Response`.
- `HttpSandbox.make` is the provider a host constructs to speak to that
  handler through an Effect `HttpClient`.

## Serve a provider

`serve` needs a retained provider: one with `retained: true`, `attach` and
`destroy`. The handler keeps nothing between requests, so every request
attaches the machine it names in a scope of its own, and a retained provider
leaves the machine running when that scope closes. Any other provider throws a
`TypeError` when `serve` is called. In this package `DirectorySandbox` and
`MicrosandboxSandbox` with `persistence: "sticky"` are retained, and so is
`CloudflareSandbox` with `retained: true`, which is how a Worker serves
Cloudflare containers to other hosts.

```ts
import { DirectorySandbox, HttpSandbox } from "@smthrs/sandbox"
import { Effect } from "effect"

const handler = HttpSandbox.serve({
  provider: DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers", persistence: "sticky" }),
  token: serviceToken
})

export default {
  fetch: (request: Request) => Effect.runPromise(handler(request))
}
```

The handler answers an Effect, so the server's `fetch` (a Worker's, or
`Bun.serve`'s) is the program's edge, the one place it runs. To choose the machine by the session's ceilings, pass a
function instead of a provider. Every request carries the limits its session
was acquired with, so the function picks the same provider for each request of
one session:

```ts
const handler = HttpSandbox.serve({
  provider: (limits) => (limits?.memoryMib ?? 0) > 4096 ? large : small,
  token: serviceToken
})
```

A function that throws, or returns a provider that is not retained, refuses that
request with `400`.

## Reach it from a host

```ts
import { HttpSandbox } from "@smthrs/sandbox"
import { Effect } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { HttpClient } from "effect/http/HttpClient"

const program = Effect.gen(function*() {
  const provider = HttpSandbox.make({
    url: "https://sandboxes.example.com",
    token: serviceToken,
    client: yield* HttpClient,
    limits: { cpus: 2, memoryMib: 4096 }
  })
  const session = yield* provider.acquire("ci:build-42")
  yield* session.writeFile(`${session.workdir}/hello.txt`, new TextEncoder().encode("hello"))
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
```

`acquire` asks the service for the session key's machine. Closing the acquiring
scope sends `DELETE`, and the service's provider destroys the machine. A
session reached this way serves `spawn`, `readFile`, `writeFile`, `kill` and
`ping`; it has no `fork`.

## How a command runs

A request held for a command's whole run is dropped by proxies and Workers long
before a 20-minute test suite ends, so `spawn` holds none:

1. One short request starts the command detached in the machine, in a session
   of its own (`setsid`, or a process group where the guest has none). Its
   output and exit status go to files in a directory of its own under
   `processDirectory` (default `/tmp/.smthrs-http`), outside the workdir.
2. Polls, each a short request, read the bytes after those already read, at
   most `pollBytes` (1 MiB) of each stream. A poll that found no new output
   waits `pollInterval` (250 ms) before the next. Each reader pulls its own output page on demand.
3. `exitCode` resolves once the exit status is recorded. Reading stdout, stderr and the status
   can proceed independently. The status and the output are in files, so output is byte
   exact.

Closing the spawn's scope before the command ends signals it and every process
it started with `SIGTERM`, the way the container providers do. Its files are
removed either way, except after a start whose answer never came: then the
directory stays, so the start finds it and starts nothing if it lands later. A
runner killed before it recorded an exit fails the process with `unavailable`.

The service accepts up to `maxRequestBytes` (24 MiB) per request and
`maxOutputBytes` (4 MiB) across both command streams. A larger request or
command result returns HTTP 413. File responses separately enforce server
`maxFileBytes` (4 MiB): a bounded guest read checks the size before base64
encoding, which preserves binary bytes through text-only command providers.
The client limits each response, including file reads, to `maxResponseBytes`
(64 MiB). A disconnected request interrupts its provider scope.

## Lost requests

Every request is safe to send again. The provider names each command's
directory itself, so a start sent again finds the directory and starts
nothing. A chunk names its upload ID and offset, so a chunk sent again is accepted once.
A completed upload keeps its receipt, so an older delayed chunk cannot truncate
a completed file or overwrite a newer upload.
A request that fails on the way (a transport failure, a `5xx`, or no answer
within `requestTimeout`, a minute) is sent again up to `retries` (4) times,
from `retryDelay` (200 ms) doubling, and then fails `unavailable`.

A refusal keeps the service's code: a `not_found` read is `not_found` on the
host. A `401` is `unknown`, because sending it again cannot help.

## Large files

`writeFile` sends at most `chunkBytes` (16 MiB) per request, each with the same
upload ID and total byte count, starting at offset zero. Ranges stage beside the
destination and the last range atomically publishes the file. In-progress files start with mode `0600`. Publication copies the existing
destination's owner, group and mode under the lock. The server keeps receipts
outside the checkout in the provider's session state directory or under
`processDirectory/uploads`. Destroying the session reclaims them.
Locks are OS-owned and release if a writer is killed. Linux guests need
util-linux `flock` 2.23+ with `-E`; BSD guests need `lockf -k -t`. A guest lacking
both omits the upload advertisement. A Worker request body
is capped near 100 MiB, so a shipped workspace of hundreds of MiB still
crosses. `readFile` is one `GET`: the file must fit one response.

## The protocol

Every request carries `Authorization: Bearer <token>`, compared in constant
time; without it the answer is `401` with no body. Bodies are JSON unless they
are file bytes.

| Route                                                                            | Body                                           | Answer                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `POST /v1/sessions`                                                              | `{ key, limits?, uploadVersion? }`             | `{ id, remoteId, workdir, uploadVersion?, incarnation? }` |
| `POST /v1/sessions/<remoteId>/commands`                                          | `{ id, command, cwd?, env?, stdin?, limits? }` | `{ exitCode, stdout, stderr }`                            |
| `PUT /v1/sessions/<remoteId>/uploads/v2?id&path&incarnation&upload&offset&total` | the file's bytes                               | `204`                                                     |
| `GET /v1/sessions/<remoteId>/files?id&path`                                      | none                                           | the file's bytes                                          |
| `DELETE /v1/sessions/<remoteId>?id&incarnation`                                  | none                                           | `204`, also for a destroyed machine                       |

`stdin`, `stdout` and `stderr` are base64. An `env` value of `null` removes the
variable. A `commands` request runs its command to the end in one request, so
it is for short commands; `spawn` uses it only to start, poll and signal. A
client writes only after acquire advertises `uploadVersion: 2` and an incarnation.
Every range carries that incarnation. The old file PUT returns `426` before its
body is consumed, and stale ranges return `409`. Routes without
a JSON body carry the limits as `cpus`, `memoryMib` and `timeoutSecs` query
parameters.

A `ProviderError` is `404` (`not_found`) or `422` with `{ code, message }`;
its cause never crosses. A malformed request is `400` and an unknown route
`404`, in the same shape. A `5xx` is never a refusal, so the client retries
only what failed on the way.

## Prove it

The package's own suite runs `SandboxConformance` against `HttpSandbox.make`
wired to `serve` in process, over a sticky `DirectorySandbox` running real
processes; the network is an injected `HttpClient` that also loses requests,
answers `503`, and cuts bodies on purpose. Run the same suite against your
service: see [Prove a provider](./prove-a-provider.md).
