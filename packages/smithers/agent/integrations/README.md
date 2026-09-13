# @smthrs/integrations

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://integrations.smithers.sh

GitHub, Linear, and Telegram adapters over the Smithers control plane.

Smithers is a durable control plane for long-running agents: work runs as a
flow whose every step is journaled, so a crash resumes where it stopped
instead of starting over. This package is the outward-facing half of that.
Each provider gets a typed client, a webhook door that verifies the delivery's
signature before anything else runs, one normalized event shape, and one
durable action a flow calls to comment, file an issue, or send a message.

What an event _means_ stays yours. Which flow a pull request starts, and which
run an issue comment signals, is application logic. The adapters stop at
verification, normalization, and transport.

## Install

`@smthrs/integrations` is not on the npm registry yet. Until it is, build it
from source and link it into your project; the
[quickstart](https://integrations.smithers.sh/quickstart/) walks through that
and the rest of the setup.

Import the whole surface or one provider at a time. The aggregate entry point
and the per-provider subpaths export the same names:

```ts
import { Core, GitHub, Linear, Telegram } from "@smthrs/integrations"
// or only what you use:
import * as GitHub from "@smthrs/integrations/github"
```

The export map is the allowlist. A source module it does not name carries
no promise, and `./internal/*` stays null-mapped.

## The shortest real example

Comment on a GitHub issue. `make` is a plain constructor, so this needs no
layers, and the client reads its token from `SMITHERS_GITHUB_TOKEN` or
`GITHUB_TOKEN`:

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect } from "effect"

const client = GitHub.GitHubClient.make({})

await Effect.runPromise(
  client.request("POST", "/repos/OWNER/REPO/issues/1/comments", { body: "Triaged." })
)
```

Replace `OWNER` and `REPO` with your repository's coordinates. That call
already retries a rate limit, keeps the token out of every header but
`Authorization`, and refuses to repeat the POST if the connection drops,
because GitHub may have created the comment and lost the answer. To make the
same comment a step a crash cannot duplicate, call
`GitHub.Actions.CommentOnIssue` inside a flow instead: the engine journals the
result, and a restart replays it rather than posting again.

## Webhook ingress

A webhook door is library code, not a server setting. A provider builds a
`@smthrs/control` `Channel`, the application registers it with `Channels`, and
`Channels.ingest` runs verify, decode, map, dispatch in that fixed order.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"

const webhookSecret = process.env.SMITHERS_GITHUB_WEBHOOK_SECRET?.trim()
if (!webhookSecret) throw new Error("SMITHERS_GITHUB_WEBHOOK_SECRET is required")

const channel = GitHub.Webhook.channel({
  credential: Redacted.make({ id: "github-webhook", name: "github-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage")
})

const register = Effect.flatMap(Channels.Channels, (channels) => channels.register(channel))
```

`Channels.ingest` drops a replayed `idempotencyKey`, which is what makes a
provider redelivery safe to accept. That key is yours to put on the
`RawInbound`: `GitHub.Webhook.idempotencyKey`, `Linear.Webhook.idempotencyKey`,
and `Telegram.Source.idempotencyKey` derive it from the provider's own delivery
identity. An ingress that leaves the field unset has no redelivery protection.

The [GitHub receiver example](https://integrations.smithers.sh/guides/github/#receive-webhooks)
enforces a 1 MiB body limit while streaming, before calling `Channels.ingest`.
The Linear guide uses the same limit.

Telegram, which has no webhook signature to verify, ships a `getUpdates`
long-poll source instead.

## Actions

One durable action per provider, over the client of the same name:

| Action                          | Tag                                    | Does                                                           |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `GitHub.Actions.CommentOnIssue` | `integrations/github/comment-on-issue` | Comments on an issue or pull request.                          |
| `Linear.Actions.CreateIssue`    | `integrations/linear/create-issue`     | Files an issue, resolving team, state, and label names to ids. |
| `Telegram.Actions.SendMessage`  | `integrations/telegram/send-message`   | Sends a message, chunked, with a plain-text fallback.          |

All three are `tier: "irreversible"`, because the remote side has acted by the
time the call returns. Neither the engine nor the client underneath repeats
one: a rate limit is retried for every method, since a refused request was not
performed, but a 5xx or a dropped connection on a write reports
`outcomeUnknown` instead of acting twice.

`SendMessage` is the one that is not atomic: text over 4096 characters becomes
several `sendMessage` calls inside the step, and a failure partway through
leaves the earlier chunks in the chat and names them in the failure.

`.call(payload)` records a plan node; `Actions.layer` provides the
implementation, and needs the provider's client in context. The error type is
`Core.ActionFailure.IntegrationFailure`, the schema form of
`IntegrationError`, because a class cannot cross the journal.

Three actions is not the closed set. Writing another `Action.make` over the
same client is the intended way to reach an endpoint these three do not cover.

## Credentials

| Variable                                     | Used by                                      |
| -------------------------------------------- | -------------------------------------------- |
| `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN` | `GitHub.GitHubClient`, `ListenerRegistry`    |
| `SMITHERS_GITHUB_API_BASE_URL`               | GitHub Enterprise or a fixture server        |
| `SMITHERS_GITHUB_WEBHOOK_SECRET`             | `GitHub.Config.resolve`                      |
| `SMITHERS_LINEAR_API_KEY`                    | `Linear.LinearClient`                        |
| `SMITHERS_LINEAR_WEBHOOK_SECRET`             | `Linear.Config.resolve`                      |
| `SMITHERS_LINEAR_API_BASE_URL`               | A fixture server                             |
| `SMITHERS_TELEGRAM_BOT_TOKEN`                | `Telegram.TelegramClient`, `Telegram.Source` |

`GitHub.Config.resolve` and `Linear.Config.resolve` read the corresponding
`SMITHERS_*_WEBHOOK_SECRET` variables. Webhook channels require an explicit
secret resolver. The host must pass the resolved non-empty secret through
`Core.Channel.constantSecret`, or use `Core.Channel.credentialSecret` with
its credential store. The example above reads the GitHub variable directly.

Explicit configuration always wins. Every client, and `Telegram.Source`, takes
an `env` argument that _replaces_ the ambient environment rather than layering
over it, so a caller supplying its own credentials cannot have an ambient
`GITHUB_TOKEN` decide which account a call runs as.

## Tests

`pnpm --filter @smthrs/integrations test` runs the whole suite. The client and
webhook suites drive a real `node:http` fixture server over a real socket.

Three read-only suites talk to live APIs and skip when their credential is
absent:

```sh
GITHUB_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
LINEAR_API_KEY=… pnpm --filter @smthrs/integrations exec vitest run test/LinearLive.test.ts --coverage.enabled=false
TELEGRAM_BOT_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/TelegramLive.test.ts --coverage.enabled=false
```

Coverage is disabled for a single-file invocation because the package's
thresholds apply to the complete source tree; the full suite remains the
coverage gate.

## Documentation

https://integrations.smithers.sh carries the quickstart, a guide per adapter,
the concepts behind webhook ingress and durable actions, the full API
reference, a testing guide, and a troubleshooting page keyed by failure
reason.
