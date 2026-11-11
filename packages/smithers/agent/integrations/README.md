# @smthrs/integrations

GitHub and Telegram adapters over the Smithers control plane. Shared channels, cursors,
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

## Telegram

```ts
import { Core, Telegram } from "@smthrs/integrations"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"

const door = Core.Channel.fromSource({ name: "telegram", route: Core.Channel.startFlow("triage") })

// Inside a flow action: poll getUpdates, start one flow per message, then commit the offset.
const receive = Effect.gen(function*() {
  const source = yield* Telegram.Source.make({ allowedChatIds: [123456789] })
  yield* source.run(door.handle)
}).pipe(Effect.provide(FetchHttpClient.layer))
```

`Telegram.Source` receives a bot's messages by long-polling `getUpdates`, so it
needs no public URL. It reads `SMITHERS_TELEGRAM_BOT_TOKEN`, drops every chat
outside `allowedChatIds`, and commits the offset only after the batch was
handled. Sending is `@smthrs/notifications`. See [the Telegram guide](docs/guides/telegram.md).

## Shared webhook ingress

`Core.Channel.make` binds verify, decode, map, and dispatch in that order.
Verification reads the exact delivered bytes. The receiver bounds body size
before `Channels.ingest`, and gives every delivery an `idempotencyKey` to
prevent duplicate work. Decoder warnings omit raw errors and schema issues. See [the receiver guide](docs/guides/webhook-ingress.md). A polled
source uses the same door: see [the polling source guide](docs/guides/polling-source.md).

## Tests

```sh
pnpm --filter @smthrs/integrations test
GITHUB_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
```

The normal suite uses local HTTP fixtures and durable SQLite engines. The
live suite requires an explicit test repository and credentials.

## Documentation

[Quickstart](docs/quickstart.md) · [GitHub](docs/guides/github.md) · [Telegram](docs/guides/telegram.md) ·
[API](docs/api.md) · [Durable actions](docs/concepts/durable-actions.md)

PKCE helpers return lazy Effects and fail validation during execution. Authorization
URLs require HTTPS, except on loopback. `Core.Source.runWithCursor` requires a flow
execution: poll, handler and commit receipts are journaled and spacing uses the
durable clock. See [the API](docs/api.md) for its turn budget and recovery contract.

## Hosted-site sign-in

`GitHub.Auth.Broker` lets independently hosted apps reuse one registered GitHub callback. The broker authenticates
`return_to` requests with a distinct key for each exact origin in the deployment's hosted-site registry. A request
contains origin, nonce, S256 challenge and a ten-minute deadline. `site().begin()` creates it; `make().start()`
starts GitHub PKCE using the broker's existing callback. `callback()` revokes the temporary provider access token after identity
lookup and returns an opaque sixty-second code in the site's fixed callback fragment. `site().redemption()` signs
the code, nonce and saved verifier; `site().exchange()` posts it server-to-server and returns only numeric ID/login.
The site sets its own session and owns authorization.

The alternative is an audience-bound identity assertion, verified with a distinct per-site HMAC key or the
broker's public key. Each site would consume its pending nonce to prevent replay and enforce issuer/key rotation;
a single global verification secret would let one site forge identities for others. It saves an exchange, but
issued assertions cannot be centrally revoked before expiry and front-channel delivery carries identity. The
opaque-code design has one central consumption and final allowlist check, and keeps identity out of URLs. `sqliteStore()` uses conditional `DELETE RETURNING` to enforce
origin, nonce, PKCE and TTL, including concurrent redemption. Hosts must journal operations through their flow
runtime, with credentials outside payloads and results. Audience, nonce, challenge and expiry are authenticated inside each encrypted code record and rechecked after
consumption, so corrupt database metadata cannot retarget or extend a grant. Broker records are encrypted with a separate 32-byte
base64 key and context bound to each digest. `memoryStore()` is ephemeral, for in-memory hosts and protocol tests.

`serve()` supplies `/api/auth/broker/start`, `/api/auth/broker/exchange` and the existing `/api/auth/callback`.
`handles()` admits only callback state with exactly `broker_` plus a 43-character nonce. The ordinary host sign-in remains separate.
`screen()` answers whether `serve()` would act on a request: a site's signature on start and exchange, the broker's
browser cookie on callback and consent. A host journals only screened requests and answers the rest `refusal(origin)`,
the same `400`, so an unauthenticated caller writes nothing. The store's conditional writes are the single-use points,
so a host needs no lock across requests. A Connect whose consent page nobody answers holds a live token pair, which
counts toward GitHub's ten tokens per person and App: `insert` never prunes `consent/` records, and each callback
drains up to `CONSENT_RELEASE` expired ones through `Store.drain` and revokes their access tokens. A host that reads
an identity from a token it then discards, such as a device-flow sign-in, revokes it with `discard(github, token)`
inside its durable step. The registry
must list only origins the deployment serves: subdomains and custom domains, never wildcard suffix matching.
All origins must be canonical HTTPS origins; `localDevelopment` explicitly permits loopback HTTP for local hosts.
No path, userinfo, query or fragment is accepted as an origin. Use a distinct secret per origin.

Serve `HANDOFF_PAGE` on the site's callback GET with no-store, no-referrer and a CSP that pins its inline script.
Its first action removes the fragment; it then posts to the same callback. Verify the local browser's signed nonce
cookie, check expiry and exact Origin, then redeem. A no-referrer browser may post `Origin: null`: accept that only
with `Sec-Fetch-Site: same-origin`. No token ever appears in a URL. Broker metrics/spans/logs contain only step and
outcome; exchange transport tracing is disabled. A lost response requires a fresh sign-in rather than replay.

A person who cancels on GitHub comes back to the broker's callback with `error=access_denied` and no code.
`cancel()` ends that attempt once, after the same browser-cookie check as `callback()`, and sends the browser to the
site's fixed callback with `#error=access_denied&state=<nonce>`: no code and no identity, and GitHub issued no token.
`screen()` admits only that error; the broker refuses any other GitHub error as before. `HANDOFF_PAGE` posts
`{ code, state, error }`, so the site spends its pending sign-in and tells the person they cancelled.

A site outside this monorepo implements its half from the wire format, which `site()` produces:

| Step     | Request                                                                                                          | Checked                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start    | Browser `GET {broker}/api/auth/broker/start?origin={origin}&return_to={signed claims}`                           | the broker: `origin` listed; signature; `claims.origin` is `origin`; 43-character base64url `nonce` and S256 `challenge`; `expires` within ten minutes          |
| Return   | Browser lands on `{origin}/api/auth/callback#code={code}&state={nonce}`, or `#error=access_denied&state={nonce}` | the site's own browser cookie holds `nonce`; the site spends its pending sign-in once                                                                           |
| Exchange | Site `POST {broker}/api/auth/broker/exchange` with JSON `{ origin, request: {signed redemption} }`               | the broker: signature; the code once, for this origin, nonce and `S256(verifier)`, within sixty seconds. `200 { id, login }`, else `400 { "error": "sign-in" }` |

Claims are the JSON `{ origin, nonce, challenge, expires }`, and a redemption is `{ origin, nonce, verifier, code,
expires }`, with `expires` in epoch milliseconds. Each is signed as `Core.CookieKeys` signs: the JSON text, a dot, and
the lowercase hex HMAC-SHA256 of `purpose:` plus that text, keyed by the site's secret, with purpose `broker_return`
for claims and `broker_exchange` for a redemption. The broker verifies the exact text it receives, then decodes it.

Install `Broker.httpPolicy` in the outer HTTP request context before server tracing. Alchemy hosts register it with `Telemetry.layer(Broker.httpPolicy)` during each Worker and auth Durable Object initialization; an ordinary init-only reference layer does not reach request fibers. It redacts every query value, including signed return_to, state and GitHub codes. Proxy/native access logs must independently omit OAuth query values and callback/exchange bodies.

Identity-only callbacks revoke their temporary GitHub access token immediately after the identity read, including a
failed read. The host must execute callbacks inside a flow: `auth/broker/revoke` is an independent action with three
engine-managed attempts (100 ms, then 200 ms), returning only `null`. Its token remains inside the enclosing
callback step; no token or refresh token enters a payload, result, journal, log or span. Exhaustion is swallowed so
identity handoff succeeds. Fixed counters `smithers_auth_broker_revocations` and
`smithers_auth_broker_revocation_failures` count completed revocations and exhausted cleanup respectively.
`auth.broker.revoke` logs only `outcome: revoked|failed`. A 422 from GitHub is a revocation failure, not evidence
that the token is gone; 404 remains idempotent success.

GitHub documents a [ten-token limit per user/application/scope, with unused/least-recently-used eviction](https://docs.github.com/en/apps/oauth-apps/using-oauth-apps/authorizing-oauth-apps#oauth-app-access).
Its [single-token DELETE endpoint](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token)
supports OAuth authorizations of GitHub Apps and uses the App client id/secret as HTTP Basic credentials. Never
use the grant-deletion endpoint for this cleanup: it revokes the person's other tokens too. The current endpoint
documentation does not explicitly specify the effect on the paired refresh token. GitHub explicitly documents
refresh-token invalidation for [authorization revocation](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types#github-app-refresh-tokens)
and for [refresh-token rotation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens#about-user-access-tokens-that-expire);
these are different operations. The injected ten-token service models pair deletion; it is not live evidence of
GitHub's unspecified single-token refresh cascade.

`Auth.Consent` records, at each callback, whether GitHub showed the person one of its own pages first. `pageOf`
reads the callback's `Referer`: GitHub's pages send their origin to another origin, while a redirect GitHub answers
without a page keeps the referrer of the page that started sign-in. GitHub's own sign-in page reads `shown` too.
`observe` adds one to `smithers_auth_github_consent` and writes the span and log `auth.github.consent`, all with
fixed attributes: `page` (`shown`, `skipped`), `after_revocation` (`yes` when this app revoked one of the person's
tokens since their previous sign-in), `hourly_tokens` (`under_limit`, `at_limit`: nine or more tokens issued in the
hour before; GitHub's [limit of ten new tokens an hour](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#creating-multiple-tokens-for-oauth-apps)
showed its authorization page at the tenth on production) and `path` (`sign_in`, `hosted_sign_in`, `connect`). The broker
calls it from `callback`, keeping a sealed per-person history (`person/` records, 30 days) of its own issues and
revocations; it passes the request's `Referer` as `callback`'s fourth argument.
