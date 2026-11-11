---
title: "Integrations"
description: "GitHub adapters and shared durable integration primitives."
---

GitHub adapters over the Smithers control plane. Shared channels, cursors,
source stores, and durable delivery receipts remain available for host integrations.

Release scope and compatibility are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

## GitHub

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"

const comment = Effect.gen(function*() {
  const client = yield* GitHub.GitHubClient.make({})
  return yield* client.request("POST", "/repos/OWNER/REPO/issues/1/comments", { body: "Triaged." })
})
await Effect.runPromise(comment.pipe(Effect.provide(FetchHttpClient.layer)))
```

The client reads `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. Explicit
configuration wins; a supplied environment replaces the ambient environment.
An explicitly blank `token` disables the environment token fallback.
`SMITHERS_GITHUB_API_BASE_URL` selects GitHub Enterprise or a fixture server.
HTTP goes through the Effect `HttpClient` you provide, usually
`FetchHttpClient.layer`, and the client never follows a redirect.

Use `GitHub.Actions.CommentOnIssue` inside a flow to journal its result.
`AddLabels`, `UpsertComment`, `CheckRun`, and `LinkPullRequest` provide keyed
write-back actions, which the flow engine retries durably, waiting a rate
limit's `Retry-After`; the clients never retry. Ambiguous writes report
`outcomeUnknown` and are not blindly repeated. GitHub webhooks enter through
the backend at `POST /webhooks/github`.

## Shared webhook ingress

`Core.Channel.make` binds verify, decode, map, and dispatch in that order.
Verification reads the exact delivered bytes. The receiver bounds body size
before `Channels.ingest`, and gives every delivery an `idempotencyKey` to
prevent duplicate work. See [the receiver guide](./guides/webhook-ingress.md). A polled
source uses the same door: see [the polling source guide](./guides/polling-source.md).

## Tests

```sh
pnpm --filter @smthrs/integrations test
GITHUB_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
```

The normal suite uses local HTTP fixtures and durable SQLite engines. The
live suite requires an explicit test repository and credentials.

## Documentation

[Quickstart](./quickstart.md) · [GitHub](./guides/github.md) ·
[API](./api.md) · [Durable actions](./concepts/durable-actions.md)

Hosted-site sign-in uses `GitHub.Auth.Broker`; see [the package guide](../README.md#hosted-site-sign-in) for the
chosen opaque-code design, signed-assertion alternative, exact-origin registry, atomic store and host requirements.
