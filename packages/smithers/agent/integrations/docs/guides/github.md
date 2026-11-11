---
title: "GitHub"
description: "Configure the GitHub adapter: credentials, App authentication, REST calls, idempotent issue writes, and the comment action."
sidebar:
  order: 1
---

How to wire the GitHub adapter into a host application. Each section is a
recipe; the [API reference](../api.md) has the full signatures.

## Configure credentials

The client reads its token from explicit configuration first, then
`SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. The REST endpoint reads
`SMITHERS_GITHUB_API_BASE_URL` for GitHub Enterprise. An explicitly blank
`token` suppresses the environment token fallback.

```bash
export SMITHERS_GITHUB_TOKEN=TOKEN
```

Replace `TOKEN` with a personal access or installation token.

Passing an `env` record as the second argument to `make`, `layer`, or
`resolve` replaces the ambient environment rather than layering over it, so
code that carries its own credentials cannot have an ambient `GITHUB_TOKEN`
decide which account a call runs as.

GitHub authenticates its `/applications/{client_id}/...` endpoints as the App's
OAuth client, not with a token. Pass `clientCredentials` and the client sends
the client id and secret as HTTP Basic in place of any token; error text never
carries either.

```ts
const app = yield * GitHub.GitHubClient.make({ clientCredentials: { clientId, clientSecret } }, {})
// Revokes a user's token: 204, or 404 or 422 when GitHub no longer has it.
yield * app.request("DELETE", `/applications/${clientId}/token`, { access_token })
```

## Authenticate as the App

`GitHub.AppAuth` signs a GitHub App's JWT and mints installation tokens.
Pass the App's ID (or client ID) and its private key as GitHub downloads it,
PKCS#1 PEM; a PKCS#8 PEM works too, and so does a key whose newlines an
environment variable carries escaped as `\n`. A key that does not parse or
import fails `invalid-config` without quoting it.

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"

const token = Effect.gen(function*() {
  const app = yield* GitHub.AppAuth.make({ appId: APP_ID, privateKey: Redacted.make(PRIVATE_KEY) })
  const { id } = yield* app.installation("OWNER", "REPO")
  return yield* app.installationToken({
    installationId: id,
    repositories: ["REPO"],
    permissions: { issues: "write" }
  })
}).pipe(Effect.provide(FetchHttpClient.layer))
```

Replace `APP_ID` and `PRIVATE_KEY` with the App's ID and key, and `OWNER` and
`REPO` with the repository coordinates.

- `jwt` is RS256 with `iat` 60 seconds back and `exp` 9 minutes ahead, inside
  GitHub's 10-minute ceiling, on the `Clock` service's time.
- `installation` fails `delivery-failed` with `details.status` 404 when the
  App is not installed on the repository.
- `installationToken` returns the token as `Redacted` and `expiresAt` in
  epoch milliseconds. A lost answer is `retryable`, because minting again is
  harmless.

The App's calls never read the ambient environment, so `GITHUB_TOKEN` and
`SMITHERS_GITHUB_API_BASE_URL` never decide who calls or where the JWT goes.
Neither the key, the JWT, nor a minted token appears in an error or a span.

## Call the REST API

Build the client with `GitHub.GitHubClient.make` for direct use, or
`GitHub.GitHubClient.layer` when a flow composition needs it in context. Both
send HTTP through Effect's `HttpClient`: provide `FetchHttpClient.layer` from
`effect/http`, or, in a test, a client of your own that injects a transport
fault.

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

const Viewer = Schema.Struct({ login: Schema.String })

const program = Effect.gen(function*() {
  const client = yield* GitHub.GitHubClient.make({})
  const viewer = yield* client.request("GET", "/user", undefined, { schema: Viewer })
  return viewer.login
}).pipe(Effect.provide(FetchHttpClient.layer))
```

The client never follows a redirect. It sets the fetch transport's `redirect`
to `"manual"`, so a 3xx fails `delivery-failed` with its status and the token
never reaches the `Location` host.

The response type comes from the schema. Without one, `request` returns the
parsed JSON as `unknown`, because the client checked nothing and so promises
nothing.

`request` makes one request and never repeats it. Call it from a durable flow
step, and that step's retry policy is the retry: it survives a crash and waits
what GitHub asked. A rate limit fails `retryable` for every method, with the
server's `Retry-After` or `x-ratelimit-reset`, capped at one minute, as
`details.retryAfterMillis`. To keep a whole machine inside GitHub's limits,
send it through the [GitHub proxy](#stay-inside-githubs-rate-limits). A 5xx or
a dropped connection is `retryable` only for a read. On a write it reports
`outcomeUnknown: true` in the failure's `details`, because GitHub may have
applied the write and lost the answer. If you know your endpoint is
idempotent, mark its lost writes retryable per call. `outcomeUnknown` remains
true because permission to retry does not establish whether the write happened:

```ts
yield * client.request("POST", path, body, { retryUnsafeWrites: true })
```

To walk a list endpoint, use `paginate`, which follows `Link: rel="next"`
inside a page budget and tells you when the budget ran out:

```ts
const page = yield * client.paginate("/repos/OWNER/REPO/issues", { perPage: 100, maxPages: 10 })
if (page.truncated) {
  // `page.items` is a prefix, not the whole resource. Narrow the query or
  // raise maxPages (at most 1000) before reconciling against it.
}
```

To count a list without walking it, use `count`, which asks for one item per
page and reads the `rel="last"` link:

```ts
const branches = yield * client.count("/repos/OWNER/REPO/branches")
// branches.total: how many; branches.first: the first one, as parsed JSON
```

Replace `OWNER` and `REPO` with the repository coordinates.

## Stay inside GitHub's rate limits

GitHub's limits belong to the token's principal, not to a process, so many
agents on one machine trip them together. Run one GitHub proxy per machine and
send every GitHub call through it: its limiter sees every request, and it is
the only process that holds the credential.

The limits it enforces are GitHub's own, from
[Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api):

| GitHub limit                                                                                                | What the proxy does                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 5,000 requests per hour per user or App installation (15,000 on Enterprise Cloud)                           | Models each resource's budget from `x-ratelimit-*` and waits for `x-ratelimit-reset`. |
| No more than 100 concurrent requests                                                                        | Runs at most 50 at once, leaving headroom for `gh` and `git` outside the proxy.       |
| Wait at least one second between `POST`, `PATCH`, `PUT`, and `DELETE` requests                              | Starts writes at least 1 s apart, in arrival order.                                   |
| No more than 80 content-generating requests per minute and 500 per hour                                     | Counts every write against both windows.                                              |
| On a limit: wait `retry-after`, or until `x-ratelimit-reset`, else at least a minute, growing exponentially | Pauses every caller of the principal, doubling the pause while limits persist.        |

The repository runs it as `.smithers/flows/issue-claim/github-proxy.mjs`:

```bash
node .smithers/flows/issue-claim/github-proxy.mjs --ensure
```

`--ensure` starts the proxy in the background unless one already answers at
`SMITHERS_GITHUB_PROXY` (default `http://127.0.0.1:47821`), and a second
proxy cannot bind the same port, so a machine has one. Start it from your own
shell or a flow host: it reads your credentials, which a sandboxed child
cannot. It runs a repository's requests as the configured GitHub App's
installation on the owner and everything else as `SMITHERS_GITHUB_TOKEN`,
`GITHUB_TOKEN`, or `gh auth token`.

Point the client at it and pass no token:

```bash
export SMITHERS_GITHUB_API_BASE_URL=http://127.0.0.1:47821
```

A request the proxy will not wait for (more than a minute) fails
`rate-limited` with `details.retryAt`, and nothing reached GitHub. It is not
`retryable`: in a flow, sleep durably until that instant with
`DurableClock.sleep` rather than retrying at once.

`gh api` reaches the proxy when you give it an absolute URL. `gh` sends no
token to a host it has no login for, and `GH_ENTERPRISE_TOKEN` satisfies its
login check in a sandbox with no `gh` configuration:

```bash
GH_ENTERPRISE_TOKEN=unused gh api --paginate --slurp \
  "http://127.0.0.1:47821/repos/OWNER/REPO/issues?state=open&per_page=100"
```

`GH_HOST` does not work: `gh` speaks HTTPS to an Enterprise host at
`/api/v3`. Porcelain commands such as `gh issue list` use GraphQL against
`GH_HOST`, so call the REST endpoint with `gh api` instead.

To serve sandboxes or microVMs beyond loopback, bind the proxy to the address
they reach and require a capability, the first line of
`SMITHERS_GITHUB_PROXY_CAPABILITY_FILE`. Callers send it as
`Authorization: Bearer CAPABILITY`, or as `GH_ENTERPRISE_TOKEN` for `gh`:

```bash
SMITHERS_GITHUB_PROXY=http://192.168.64.1:47821 \
SMITHERS_GITHUB_PROXY_CAPABILITY_FILE=~/.config/smithers/github-proxy-capability \
  node .smithers/flows/issue-claim/github-proxy.mjs
```

The `SMITHERS_GITHUB_*` variables listed under `RateLimit.resolveLimits` in
the [API reference](../api.md#githubratelimit) tune the limits.

## Build repository paths safely

Never interpolate an owner or repository string into a request path yourself.
`encodeURIComponent("..")` is `".."`, and the URL parser removes dot segments
afterwards, so an unvalidated string walks the token-bearing request to a
different GitHub endpoint on the same origin. `repositoryPath` validates each
segment against GitHub's naming rules and only then encodes it:

```ts
const repository = yield * GitHub.Repository.requireRepositoryPath(owner, repo)
yield * client.request("GET", `/repos/${repository}`)
```

The throwing form, `GitHub.Repository.repositoryPath`, raises an
`IntegrationError` with reason `invalid-config`; the `require*` forms put the
same failure in the Effect channel.

## Webhooks

GitHub webhooks enter through the Smithers backend (`POST /webhooks/github`),
which decides whether an event may start work. This package has no GitHub
webhook channel.

## Comment on an issue from a flow

`GitHub.Actions.CommentOnIssue` posts a comment as a durable step. The
payload's `owner`, `repo`, and `issueNumber` are validated by the payload
schema itself, so a payload built from a webhook body or a model's output
fails to decode rather than reaching the API with a hostile path.

```ts
import { GitHub } from "@smthrs/integrations"

const body = (input: typeof GitHub.Actions.CommentOnIssuePayload.Type) =>
  GitHub.Actions.CommentOnIssue.call({ ...input, body: "Triaged." })
```

The [quickstart](../quickstart.md) shows the complete wiring: the flow, the
implementation layer, and the client layer. The action fails with
`Core.ActionFailure.IntegrationFailure`; when `outcomeUnknown` is set, the
comment may already exist, so check the issue before posting again.

## Write issues and comments idempotently

`GitHub.Issues` reads and writes issues and issue comments over the
`GitHubClient` in context, so the calling flow step chooses the token by
providing the client: a person's user token, or an installation token.

A POST whose answer is lost fails with `details.outcomeUnknown: true`, because
GitHub may have created the issue anyway. Mark every body with a write id the
step keeps, such as a UUID, and on a retry look before writing again:

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Option } from "effect"

const { Issues } = GitHub

// `writeId` and `since` are the step's own: a UUID, and when it first ran.
const openIssue = (writeId: string, since: string, retry: boolean) =>
  Effect.gen(function*() {
    if (retry) {
      const found = yield* Issues.findIssueByWrite("OWNER", "REPO", { writeId, since })
      if (Option.isSome(found)) return found.value
    }
    return yield* Issues.createIssue("OWNER", "REPO", {
      title: "Crash on start",
      body: Issues.withWriteMarker("Steps to reproduce", writeId)
    })
  })
```

- `withWriteMarker` appends a blank line and `<!-- smithers:write=ID -->`,
  which GitHub renders as nothing. `writeIdOf` reads it back and
  `withoutWriteMarker` removes it for display.
- `findIssueByWrite` searches the repository's issues, skipping pull
  requests; `findCommentByWrite` searches one issue's comments. Each returns
  the earliest-created match, so a copy posted after the original never wins.
- Each finder reads at most `Actions.RECONCILE_PAGES` pages of items updated
  since `since`. Keep `since` close to the first attempt.

## Add another endpoint

The three actions are declarations over the client, not a closed set. Write
your own `Action.make` over `GitHubClient` for any other endpoint; the client
carries the rate-limit, pagination, and credential behavior, and the action
makes it journaled. [Durable actions](../concepts/durable-actions.md) shows
the shape.

## Issue trees and a person's proposal

`GitHub.Calls.withToken` supplies an explicit redacted user credential and never reads an ambient token.
Smithers' app reuses this wrapper. `GitHub.IssueChanges.get` reads assignments, `update` changes supplied labels,
assignees or state, and `link` writes GitHub's sub-issue relationship by the child's database ID. A child that already has a parent
moves only with `{ replaceParent: true }`; otherwise GitHub refuses the link. Coordinates are
validated before a credential-bearing request. An ambiguous link is reported as an unknown outcome; the client
does not repeat it. Use a durable step and reconcile from GitHub before another write.

`GitHub.Proposals.ensureFork` uses the source repository when that person owns it. Otherwise it reuses an existing
fork only when GitHub confirms its parent, creates a missing fork, and refuses a same-named unrelated repository.
Its `sourceDefaultBranch` always names the upstream default, even when the personal fork renamed its default. Compose it with `GitHub.Once.branch`, `commitOnBranch` and `pull` inside
`Action.once` to open the person's review change. People merge. These operations never merge a proposal.

Endpoint contracts: [sub-issues](https://docs.github.com/en/rest/issues/sub-issues) and
[issue updates](https://docs.github.com/en/rest/issues/issues#update-an-issue).

`GitHub.IssueChanges.timeline` reads native issue events with their actual actors.
It bounds pagination and refuses incomplete history. The caller chooses which event kinds to display;
comments have their existing dedicated reader. [Timeline endpoint](https://docs.github.com/en/rest/issues/timeline).

Native timeline records retain an optional `created_at` timestamp when GitHub supplies it. Consumers may show the actual calendar date; missing timestamps remain missing rather than becoming invented relative ages.

`Proposals.documentReview` reads a PR’s numeric author and complete native changed-file set, with a head recheck. A 404 or deleted author yields None; truncation, GitHub’s file cap, concurrent head changes and provider failures remain errors. Callers validate their exact document path and compare immutable author IDs. This is read-only; span/log/counter outcomes contain no document path or content.
