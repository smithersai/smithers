---
title: "Record, replay or pass through an HTTP service"
description: "Run a test against a real external service, record its answers with every credential scrubbed, and replay them with no network: HttpRecording's three modes, what it scrubs, and the scan that fails a build on a leaked credential."
sidebar:
  order: 10
---

A test that reaches an external service over HTTP, such as GitHub, a
provider's REST API or a sandbox control plane, can run it three ways.
`HttpRecording` is an `HttpClient` that does each one:

| Mode          | Reaches the service | Writes the recording | Needs a credential |
| ------------- | ------------------- | -------------------- | ------------------ |
| `passthrough` | yes                 | no                   | yes                |
| `record`      | yes                 | yes, on success      | yes                |
| `replay`      | never               | no                   | no                 |

The code under test does not change. It reads `HttpClient` from context, and
the test provides the client the mode selects.

```ts
import { HttpRecording } from "@smthrs/testing"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

const github = (mode: HttpRecording.Mode, token: string | undefined) =>
  Effect.gen(function*() {
    const live = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
    return yield* HttpRecording.make({
      mode,
      path: "test/recordings/issues.json",
      live,
      secrets: token === undefined ? [] : [token]
    })
  })
```

## Choose the mode in the suite

The module reads no environment variable, as VIP-71's rule 6 requires. The
suite decides, usually from its own configuration: replay by default, record
when a person runs the suite with a credential and asks to record. A replayed
run needs no credential and no network, so it runs in CI.

```bash
pnpm vitest run test/issues.test.ts                       # replay
GITHUB_MODE=record GITHUB_TOKEN=... pnpm vitest run ...   # record, then commit the file
GITHUB_MODE=passthrough GITHUB_TOKEN=... pnpm vitest ...  # real service, nothing written
```

## What a recording holds

A recording is JSON: each exchange's method, URL and body, and the response's
status, headers and body, in the order the answers arrived. Before it is
written:

1. Request headers are dropped. `Authorization`, cookies and API keys never
   reach the file.
2. Response headers are cut to `content-type`, `link`, `location` and
   `retry-after`. `Set-Cookie`, request ids and rate-limit counters are dropped.
3. URL user information is removed, and query parameters named like a
   credential (`access_token`, `code`, `sig`, `signature` and others)
   are replaced.
4. Each nonempty value the suite passes in `secrets` is replaced wherever it
   appears, regardless of length. Empty strings are ignored.
5. Bodies go through `@smthrs/journal/Redaction`'s `redact`: a field named like
   a credential (`token`, `access_token`, `client_secret`, `password`) is
   replaced, and every string is run through the token-shaped rules.
6. The whole file is scanned with `HttpRecording.scan` and checked for each
   named secret. A match refuses the write with `CredentialInRecordingError`,
   which names the rule and never the value.

A run that fails or is interrupted writes nothing and keeps the previous
recording, because a recording of a failed run would replay that failure.

The scrubber does not know your data. A password inside an issue body in a
shape no rule knows is recorded. Record against a test account and test data
you can publish, and read the file before you commit it.

## Keep a recording small

A REST answer carries more than any client reads: GitHub's issue objects are
two thirds hypermedia links. Pass `prune` to remove those fields before they
are recorded. While recording, the code under test receives the pruned body
too, so if it needs a field you removed, the recording run fails, not a later
replay.

## Replay is strict

Exchanges with the same method, URL and body are claimed once each, in
recorded order. A read before a write and the same read after it each get
their own answer. A request the recording does not hold, or asks more times
than it was recorded, dies with `UnrecordedRequestError`, which names the
method and URL. Record the test again when the code's requests change.

`replay(recording)` returns a client with `remaining()`, the count of
exchanges no request claimed, for a test that wants to prove it made every
recorded call.

A test that creates data on the service (an issue, a branch) needs names no
earlier real run used, and a replay needs the names that were recorded. Pass a
fresh `label` when recording; it is written into the recording, and a replaying
suite reads it back with `load` and builds the same names.

When a request carries another value that changes from run to run, such as a
timestamp or a generated name, pass `normalize`. It rewrites the request before
it is keyed and recorded, on both sides; the live service still receives the
original.

## Scan every committed recording

`HttpRecording.scan(text)` returns the ids of the credential shapes found in
`text`, and an empty array for a clean file. Run it over every committed
recording in CI, so a hand edit or a recording made before a scrubbing rule
existed fails the build:

```ts
for (const file of recordings) expect(HttpRecording.scan(readFileSync(file, "utf8"))).toEqual([])
```

## Model calls

A model call records through `CachedModel` and replays through `RecordedModel`
(see [Replay a model](./replay-a-model.md)): those key on the model request, so
a recording replays under another model id. Use `HttpRecording` for services
whose wire format is the contract.
