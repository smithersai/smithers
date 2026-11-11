---
title: "Webhook ingress"
description: "Bound request bodies before shared channel ingestion."
---

Register a verified `Core.Channel.make` channel named `signed`. The host
provides `channelsLayer`. GitHub webhooks use the backend receiver; this is the
generic host channel boundary.

The idempotency key is `Core.Channel.signedBodyKey(body)`, the SHA-256 of the
signed bytes. Never key on a delivery id header: it is not signed, so a captured
delivery resent under a new id would start a second run. A provider retry
resends the same bytes and is dropped; distinct events carry their own ids and
timestamps in the body.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core } from "@smthrs/integrations"
import { Effect } from "effect"
import { createServer } from "node:http"

const maxBodyBytes = 1024 * 1024
const server = createServer((request, response) => {
  const chunks: Array<Uint8Array> = []
  let receivedBytes = 0
  let stopped = false
  const discard = () => {
    stopped = true
    chunks.length = 0
  }
  request.on("aborted", discard)
  request.on("error", () => {
    discard()
    response.destroy()
  })
  request.on("data", (chunk: Uint8Array) => {
    if (stopped) return
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBodyBytes) {
      discard()
      request.pause()
      response.writeHead(413, { Connection: "close" }).end(() => request.destroy())
      return
    }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (stopped) return
    const body = Buffer.concat(chunks)
    discard()
    const program = Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const idempotencyKey = yield* Core.Channel.signedBodyKey(body)
      return yield* channels.ingest({
        channel: "signed",
        raw: {
          body,
          headers: request.headers as Record<string, string | undefined>,
          idempotencyKey
        }
      })
    })
    Effect.runPromise(Effect.provide(program, channelsLayer)).then(
      () => response.writeHead(200).end(),
      () => response.writeHead(401).end()
    )
  })
})
```
