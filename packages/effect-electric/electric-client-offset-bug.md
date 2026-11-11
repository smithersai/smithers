# Bug report draft: `@electric-sql/client` takes a response's offset before it reads the body

Not filed. Will's rule (2026-10-19): agents never send bug reports. This is the
draft, kept with the package that works around it
(`src/ElectricCollection.ts`, `attempt`).

## Versions

- `@electric-sql/client` 1.5.28 (the latest on 2026-10-20)
- Electric server 1.8.1 (`electricsql/electric:1.8.1`)

## Summary

A long-poll response whose headers arrive but whose body is not a whole JSON
array makes the `ShapeStream` skip that batch. The stream commits the
response's `electric-offset` and `electric-handle` to its state before it
parses the body. When the parse then fails and `onError` asks for a retry, the
stream resumes from the new offset, so the rows in that batch are never
delivered. An empty 200 body is worse: the client reads it as `[]`, takes the
offset and goes on with no error at all.

## Reproduction

A `fetchClient` that cuts the first live response's body short, as a proxy
that closes a response early does:

```ts
import { ShapeStream } from "@electric-sql/client"

let cut = false
const stream = new ShapeStream({
  url: "http://localhost:3000/v1/shape",
  params: { table: "items" },
  fetchClient: async (input, init) => {
    const response = await fetch(input, init)
    if (cut || !String(input).includes("live=true")) return response
    cut = true
    return new Response("[{", response) // or "" for the silent case
  },
  onError: () => ({}) // restart where it stopped
})
stream.subscribe((messages) => console.log(messages))
// Once the stream is live: INSERT INTO items VALUES ('b'); then INSERT ('c').
```

Expected: `b` and `c` are both delivered; the retry asks from the offset the
cut request asked from.

Actual: only `c` arrives. The retry asks from the cut response's
`electric-offset`. With `""` as the body there is no error and `b` is still
lost.

## Cause

`#requestShapeLongPoll` (`src/client.ts:1709-1715`):

1. `#onInitialResponse(response)` runs `handleResponseMetadata`, which sets the
   state's offset from the response header (`src/shape-stream-state.ts:283`).
2. Only then is the body parsed: `res || "[]"`, then
   `this.#messageParser.parse(...)`.
3. A parse that throws reaches `#start`, and an `onError` retry "restarts from
   current offset" (`src/client.ts:908`): the offset of the batch that was
   never applied.

A `transformer` or `parser` that throws on a row skips its batch the same way.

## Suggested fix

Parse the body before committing the response's metadata, or keep the previous
offset until `#onMessages` has published the batch. Treat an empty body on a
200 as an error rather than `[]`: Electric 1.8.1 never sends one (its long
poll times out with `[{"headers":{"control":"up-to-date",...}}]`).

## Our workaround

`ElectricCollection.make` reads every 2xx body in full inside its
`fetchClient`. A body that breaks off is a network failure for the sync policy.
A body that ends but is not a JSON array fails the `fetchClient` call, so
Electric stops the shape before `#onInitialResponse` runs, and `reconnect`
sends the same request again. A row that fails the collection's schema, or a
`parser` that throws, stops the shape after `#onInitialResponse` ran. For that
stop `reconnect` does not answer `onError` with a retry in place: it ends the
`ShapeStream` and starts a new one from the last handle and offset the
collection committed, so the batch is asked for again.
