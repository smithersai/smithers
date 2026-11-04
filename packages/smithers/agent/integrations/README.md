# @smthrs/integrations

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

The package runs in a browser, a Cloudflare Worker, Node and Bun: crypto is
WebCrypto, and HTTP is the Effect `HttpClient` you provide, usually
`FetchHttpClient.layer`. A test provides its own client to inject a transport
fault. GitHub requests identify the client with `GitHub.GitHubClient.USER_AGENT`; hosts
use the same exported value for GitHub OAuth, git HTTP and other direct requests.
The client never follows a redirect. A host without a process
environment, such as a Worker, passes the token in the config or an `env`
record.

Use `GitHub.Actions.CommentOnIssue` inside a flow to journal its result.
`AddLabels`, `UpsertComment`, `CheckRun`, and `LinkPullRequest` provide keyed
write-back actions, which the flow engine retries durably, waiting a rate
limit's `Retry-After`; the clients never retry. Ambiguous writes report
`outcomeUnknown`, even when `retryUnsafeWrites` permits a retry. Sticky-comment
and check-run actions serialize reconciliation and writes for the same key
within one process, across action layers. Separate processes must route a key
to one owner; a write still in flight remotely can remain ambiguous. PR links
are confirmed from GitHub’s closing references, never inferred from Markdown. GitHub webhooks enter through
the backend at `POST /webhooks/github`.

Request spans record method, status and failure classification without caller
URLs, paths or query values; the transport's URL-bearing spans are disabled.
Pagination spans record page count and truncation, and count spans record the
total. Counts always start at page one, overriding caller pagination. Issue
write reconciliation rejects every truncated scan, including scans with a
matching marker, because the original may be older than the visible copy.

## Shared webhook ingress

`Core.Channel.make` binds verify, decode, map, and dispatch in that order.
Verification reads the exact delivered bytes. The receiver bounds body size
before `Channels.ingest`, and gives every delivery an `idempotencyKey` to
prevent duplicate work. Decoder warnings omit raw errors and schema issues. See [the receiver guide](docs/guides/webhook-ingress.md).

## Tests

```sh
pnpm --filter @smthrs/integrations test
GITHUB_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
```

The normal suite uses local HTTP fixtures and durable SQLite engines. The
live suite requires an explicit test repository and credentials.

## Documentation

[Quickstart](docs/quickstart.md) · [GitHub](docs/guides/github.md) ·
[API](docs/api.md) · [Durable actions](docs/concepts/durable-actions.md)

PKCE helpers return lazy Effects and fail validation during execution. Authorization
URLs require HTTPS, except on loopback. `Core.Source.runWithCursor` requires a flow
execution: poll, handler and commit receipts are journaled and spacing uses the
durable clock. See [the API](docs/api.md) for its turn budget and recovery contract.
