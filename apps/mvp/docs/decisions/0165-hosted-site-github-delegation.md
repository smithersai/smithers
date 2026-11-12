# 0165 — Hosted sites act on GitHub through a delegation from smithers.sh

Date: 2026-11-09. Ruling VL-33 (Will). Merges two independent designs (PROC-6, lane vl-connect). Build follows this record.

Hosted sites never hold a GitHub token. smithers.sh keeps one sealed user token per person. A site acts through a per-person, per-site delegation, limited by its registry entry, by calling typed operations signed with its own key. A write must pass the site's role policy, the delegation, and GitHub's own permission. The broker's only GitHub callback stays `https://smithers.sh/api/auth/callback`. Device sign-in (0028) is unchanged.

## Design twice

Chosen: typed operations executed by smithers.sh.

Rejected: an authenticated GitHub API proxy filtered by repository, method, path and JSON fields. It would leave the sites' `GitHubClient` calls in place and reuse `Egress.forward`. It fails on three counts. "Commit only under this path" lives inside a GraphQL body, so a correct filter must parse each request into typed operations anyway. `PATCH /repos/R/issues/N` admits title, body, state, labels and assignees under one path, so a path allowlist fails open. Find-then-perform stays on the site, with no fence across the two.

## Merge

Opus is `vl-connectdesign-opus.DESIGN.md`; Sol is `vl-connectdesign-sol.DESIGN.md`. Where they disagreed on security, the smaller blast radius won.

| # | Question | Taken from | Why |
| --- | --- | --- | --- |
| 1a | Starting Connect | Sol | POST with exact Origin and a human session. A GET cannot start a credential flow. |
| 1b | Intent | Opus | A signed `connect.person` claim on the existing start. A server-side registration adds a table and no security: the claim carries only a public numeric id. |
| 1c | Consent | Both | smithers.sh page naming site and login. Only its same-origin POST installs the credential, because GitHub skips its own prompt for an authorized person. |
| 1d | Storage | Opus | `GitHubConnection` Durable Object per person. One object is the single writer that single-use refresh tokens need, and a fault reaches one person. |
| 1e | Keys | Sol's separation, Opus's shape | `GITHUB_CONNECTION_KEYS` and `GITHUB_CONNECTION_KEY_ACTIVE`, separate from cookie and site keys. Each row records `key_id`; refresh re-seals under the active key. |
| 2a | Expiry | Sol | 30 days absolute, against 90. Renewal is a Connect press. |
| 2b | Signed call | Sol | Binds audience, route, origin, person, delegation, operation key, body digest, fresh nonce, and 60 seconds. Opus's claim omitted audience and route. |
| 2c | Revocation | Both | Site Disconnect, smithers.sh Disconnect, registry removal, 401, expiry, `github_app_authorization`. The last delegation revokes the single token, never the grant. |
| 3 | Scope language | Opus | Closed union of typed operations with a pure `permits` predicate, plus Sol's immutable repository id and fork-parent check. |
| 4 | Gates | Opus | The site re-reads role at each step. Sol's callback permit adds a round trip and stops nothing: a compromised site can answer its own callback. |
| 5 | Durability | Opus, with Sol's `unknown` | Execution per `(origin, person, key)`; no text is stored: the site resends the operation on retry, bound by digest. Missing evidence answers `unknown` and never resends a create. |
| 6 | States | Opus | Fewest words, and one action per state. |
| 7 | Trust limit | Both | Stated below. |
| 8 | Migration | Opus | Old rows deleted, not revoked: they lack refresh tokens and die within 8 hours. Existing write keys are kept, so in-flight writes adopt their GitHub object. |
| 9 | Tests | Both | Sol's restart-between-steps workerd cases; Opus's privacy sentinels. |
| 10 | Placement | Opus | One shared module. Sol's plugin and Postgres redemption table have no second caller. |

## Connect

```
browser        site worker         smithers.sh                 GitHub
 POST start ─▶ signed claim ─────▶ broker attempt ───────────▶ authorize
                                   /api/auth/callback ◀─ code
                                   person id must match claim
                                   consent page ◀ press
 ◀───────────── #code ──────────── seal in GitHubConnection(person)
 POST code ──▶ exchange ─────────▶ {person, delegation}
```

A claim without `connect` is a sign-in, and the broker revokes its token at once. A mismatched person, or Cancel, revokes the token and stores nothing. Lost redemption restarts Connect.

**One token survives.** GitHub keeps ten tokens per person, App and scope, and evicts past that. Every token a sign-in path does not keep is revoked: the broker's sign-in tokens at the callback, a cancelled or refused consent's at once, an unanswered consent's when the next callback drains it, and a vibelang device sign-in's once its identity is read. Connecting again replaces the pair and revokes the old one. smithers.sh's own sign-in keeps one pair per live session, by design, so ten live smithers.sh sessions opened after a Connect still evict it; the connection then answers `connect`.

**Refresh** runs within 5 minutes of expiry, inside the person's object, and stages the sealed result before use. A refused refresh sets the connection revoked and answers `connect`.

## The delegation

| Field | Value |
| --- | --- |
| Key | `(person, origin)` |
| `id` | 256-bit handle, useless without the site's key |
| Scopes | Copied from the registry at consent, intersected with the registry at every call |
| Expiry | 30 days absolute |
| Rate | 60 writes per hour |

Registry entry per site: `origin`, `secret`, and `grants` of `{ repository, repositoryId, scopes, paths, branchPrefix, labelPrefix }`.

| Scope | Operations |
| --- | --- |
| any grant | issue, timeline, comment, assignee, file, branch, review and fork reads |
| `issues` | create, comment, assign, close, link, create label, add label, remove label |
| `proposals` | branch, commit, pull |

`permits` refuses a repository outside the grants, a path outside a grant's segments, `..`, `.`, backslashes, `.github/`, any deletion, a head owned by another login, a label outside `labelPrefix`, and any field beyond an operation's own. `login` comes from the credential row, never the site. Approve, merge, delete and repository settings have no operation.

Three gates, all required: the site's role policy, `registry ∩ delegation ∩ permits`, and GitHub's own check of `App permission ∩ installation ∩ the person's access`. Agent sessions hold no delegation path, and smithers.sh refuses any `actor` but `person`.

## Forks

GitHub's create-fork needs the App installed on the destination account with all repositories and on the source account ([forks](https://docs.github.com/en/rest/repos/forks#create-a-fork)). Its permission table lists the endpoint under Administration write, Contents read and Repository creation write ([permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)). A user token reaches only accounts where the App is installed ([user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).

**smithers.sh does not create forks.** Creating one would add Administration write to the App and require an all-repositories install on every proposer. The person forks on GitHub and installs the App on that one repository. smithers.sh verifies the fork's parent id and commits there.

Proposals cannot avoid forks: a branch on the upstream repository needs write access that Community and Contributor people do not have. A person who already owns the repository skips the fork, as today.

| State | `reason` | Text | Action |
| --- | --- | --- | --- |
| No connection, revoked, expired | `connect` | Connect GitHub. | Connect GitHub |
| No fork | `fork` | Fork on GitHub. | Fork |
| App missing on the fork | `install` | Install Smithers on your fork. | Install |
| Role, scope, or GitHub 403 | `forbidden` | Not allowed. | none |
| smithers.sh unreachable | `unavailable` | Couldn't save. Retry. | Retry, same key |
| Answer lost | `unknown` | Unchanged | Retry joins |

## As built

Reads are one GET-only path allowlist (`DelegationPolicy.readTarget`), not typed reads: the rejected proxy's arguments concern writes. A read GitHub answers with 404 refuses as `missing`, which the site sees as GitHub's own 404, so "no such page" or "no such branch" stays an answer. Before this, it was `unavailable`, and the wiki flow retried a connected read of a missing page for two minutes. A read's repository is proven once per object before GitHub answers it: the grant's repository by its immutable id, the person's same-named repository as a fork whose parent is that id. `DelegationPolicy` has unit coverage, no Dafny proofs.

A registry entry loads only when `DelegationPolicy.validGrant` holds: `owner/name` with a positive id, at least one path, `paths` and `branchPrefix` as relative folders ending in `/`, and a non-empty `labelPrefix`. `Delegation.make` refuses any other registry, smithers.sh disables connections for one, and `permits` compares prefixes by whole segments. A write GitHub refuses with 404 or 422 answers `forbidden`, and a write spends the hour's budget only once GitHub accepts it. A revoke or a Disconnect page counts only live delegations and deletes expired ones, so a lapsed delegation never keeps the token. Each person's object binds to the first person who reaches it and refuses any other.

smithers.sh's route (`GitHub.Delegation.route`) verifies the site's origin, signature, audience and expiry, and that the envelope names the URL's `?person=`, before it addresses a `GitHubConnection`. Addressing a Durable Object creates it, so an unsigned or wrongly signed call creates nothing. The person's object then claims the nonce and checks the delegation. A site with no `grants` in `HOSTED_AUTH_SITES` signs in and holds no scope. A person disconnects a site at `/api/auth/connections`. The site's Install action redirects through `GITHUB_APP_SLUG`.

Vibelang's direct sign-in (the GitHub redirect from `/api/auth/sign-in` and the GET callback) remains, and production never reaches it: `readSetup` always sets `broker`, defaulting to `https://smithers.sh`. Only unit tests that build `Setup` without `broker` use it. The code exchange is its only use of `GITHUB_CLIENT_SECRET`; the device flow needs the client id alone. So the site keeps `GITHUB_CLIENT_SECRET` while that path exists. Removing it, and moving those tests to the broker path the workerd round trip already proves, lets production run with no secret.

## Security review, 2026-11-10

A Fable review of `main` `5540b9b2` found nine defects; lane vl-connect-hardening fixed each with a test that failed first.

| # | Finding | Fix |
| --- | --- | --- |
| 1 | An expired delegation kept the token after the last Disconnect | Count live rows; delete expired ones |
| 2 | Unauthenticated broker requests grew the one `HostedAuthBroker` object and queued every sign-in behind one lock | `Broker.screen` refuses before any execution; executions kept a day; no lock; `BROKER_LIMIT` per network before the object |
| 2b | The site kept abandoned `broker/` and `sign-in/` rows and every account execution | Pruned at the next start; executions kept a day |
| 3 | Other tokens evicted the connection | Revoke what no one keeps (above); smithers.sh sessions remain a source |
| 4 | An empty or slash-less prefix opened every branch, path or label | `validGrant` at load; segment comparison |
| 5 | Reads reached any same-named repository of the person, and the grant's by name | Proven by id and fork parent |
| 6 | An unanswered consent's token stayed live | Drained and revoked by the next callback |
| 7 | 404 and 422 on a write retried forever and spent the budget | `forbidden`; budget spent on success |
| 8 | Issue creation searched from 1970 and failed past 1,000 issues | `since` is the request's stored admission time |
| 9 | The connection object chose its person from the URL | Bound to its first person |

**Deployment contract.** ChatApi gains the Rate Limiting binding `BROKER_LIMIT` (namespace 71003, 300 requests a minute per network) on the broker's four routes; Alchemy creates it. No secret, variable or GitHub App setting changes. Existing `HostedAuthBroker` executions are forgotten a day after they settle, starting with the first request after deploy. An existing connection object binds to its person on its next request. A registry entry that fails `validGrant` now disables connections (`github.connection.config`, `invalid_grant`); today's entries pass.

## Revocation and the authorization

2026-11-10, lane vl-github-authz. A production smoke test (05:10 PST) connected the test account, then signed in to
smithers.sh and out again seven times; each sign-out revokes that session's token. The eighth sign-in showed
GitHub's "Authorize SmithersPreviewRelease" page, and the connected issues read then answered 403. The hypothesis was
that revoking a person's last token ends the App's authorization. It is false: the page is GitHub's limit of ten new
tokens an hour, and the 403 is not the connection's.

What GitHub documents:

| Question | GitHub says | Source |
| --- | --- | --- |
| Does deleting one token end the authorization? | Not stated. `DELETE .../token` revokes a single token; `DELETE .../grant` deletes the grant and all its tokens | [OAuth authorizations](https://docs.github.com/en/rest/apps/oauth-applications) |
| How many live tokens? | "a limit of ten tokens that are issued per user/application/scope combination"; past it GitHub revokes the oldest | [Creating multiple tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#creating-multiple-tokens-for-oauth-apps) |
| How many new tokens an hour? | "a rate limit of ten tokens created per hour. … Hitting the hourly rate limit will not revoke your oldest token. Instead, it will trigger a re-authorization prompt within the browser" | same section |
| Does a refresh count toward either limit? | Not stated. A refresh returns a new pair and the old pair stops working | [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) |

GitHub documents both limits for OAuth apps; its GitHub App pages are silent. Production shows they apply to the App.

**Experiments** with the test account through the persistent browser profile (scripts and logs:
`~/vl/scratch-github-authz/mac/` on nyc-01). Each smithers.sh sign-in creates one token and each sign-out revokes it.

| Run (UTC) | Sequence | GitHub page |
| --- | --- | --- |
| 14:28 | 3 sign-ins, within the hour after other test sign-ins | every one: "This application has made an unusually high number of requests to access your account. Please reauthorize the application to continue." |
| 15:41 | 2 sign-in and sign-out cycles, vibelang sign-in, Connect, 5 cycles | none for tokens 1 to 9; the prompt at the tenth |
| 16:47 | 3 cycles, each revoking the person's only smithers.sh token, vibelang sign-in, Connect, 4 cycles | none for tokens 1 to 9; the prompt at the tenth |

Revocation never brought a page: none at the 12 sign-ins that followed one below the tenth token, 5 of them after the person's only smithers.sh token was revoked. The prompt came at exactly the tenth token
created in an hour, twice. With the prompt unanswered, the connected wiki read still answered 200. The issues read
answered 503 `unavailable` right after Connect, before any cycle, and answers 503 signed out too: it is a separate
fault of `/api/issues`, not the connection's. Headless Chromium keeps the prompt's Authorize button disabled even
with focus and hover, so whether answering it creates a token is unmeasured. Whether a refresh counts is unmeasured: a
refresh needs an 8-hour-old token.

**Decision.** Sign-out keeps revoking, and nothing else changes. Revocation costs the authorization nothing, and it is
what keeps a person under ten live tokens, so the connection's token is never the one GitHub evicts
(`test/authBroker.workerd.test.vibe`, "eight sign-in and sign-out cycles keep a person's connection": an injected
GitHub with both limits, the connection answering 401 for any token GitHub dropped; with the broker's revocation
removed, the person holds 10 live tokens instead of 2). Not revoking on sign-out would trade a page nobody sees under
ten sign-ins an hour for the eviction of the connection after ten sign-ins in total. The remaining eviction path is
the one under "One token survives": ten live smithers.sh sessions after a Connect.

**Smoke-test contract.** One account creates at most nine tokens per rolling hour: each smithers.sh or vibelang
sign-in, each Connect, each device sign-in is one. A run that needs more waits an hour or uses a second account.

**Observed in production.** Every successful callback, smithers.sh's own and the broker's, records whether GitHub
showed a page before it (the callback's `Referer` is GitHub's origin), whether we had revoked one of the person's
tokens since their previous sign-in, and whether nine or more tokens were created for them in the hour before:
`smithers_auth_github_consent` (`page`, `after_revocation`, `hourly_tokens`, `path`) and the span and log
`auth.github.consent` ([observability](../observability.md)). If revocation ended the authorization, `page: shown`
would follow `after_revocation: yes` under `hourly_tokens: under_limit`; the experiments predict it follows
`at_limit` instead.

## Trust limit

A compromised site holds its key, so it can act as any person connected to that site, within its grants and that person's GitHub power, bypassing its own role checks. It cannot use another site's delegations, widen a scope, merge, approve, read a token, or reach another repository. Registry removal stops it at the next deploy; each person's smithers.sh Disconnect stops it for that person.

## Verified and open

Verified from GitHub's documentation: the install requirement, the fork permission table, the user-token limits, ten tokens per person, App and scope ([authorizing](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)), 8-hour and 6-month lifetimes with single-use refresh ([refreshing](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)), and that `github_app_authorization` is delivered to every App ([event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#github_app_authorization)).

Verified by the fleet lead from GitHub's API on 2026-11-09 (`GET /app` and `GET /app/installations`, with the App's JWT): the production App `smitherspreviewrelease` holds Contents, Issues and Pull requests write. It is installed on `smithersai` and on `codeplanesmithers`, each with all repositories. Its slug, `smitherspreviewrelease`, is `GITHUB_APP_SLUG` in the deploy environment. Vibelang's callback URL was never registered on the App, so no App setting changes.

Open, for the production smoke test:

1. GitHub documents no event-specific field naming who revoked. The handler reads `sender.id`, ignores the `ghost` placeholder, and relies on a 401 otherwise. Confirm a real delivery.
2. That a person's fork with a selected-repository install accepts `createCommitOnBranch` and the upstream pull.
3. Whether a refresh counts as a new token toward either limit, and whether answering GitHub's hourly prompt creates one. Ten further sign-ins leave the stored token usable (see "Revocation and the authorization").

## Addendum: public reads (2026-11-10, lane vl-public-reads)

**Why.** vibelang read GitHub with no credential and shared the 60-per-hour anonymous limit with every Cloudflare tenant on its egress address. On 2026-11-10 at 04:12 PST a signed-out `GET /api/wiki?page=index` logged `rate-limited` and answered 503; `/api/issues` the same. A hosted site still holds no GitHub credential, so a signed-out visitor's reads go through smithers.sh too.

```
browser ─▶ site object ── cache hit, fresh ─────────────────────────▶ answer
                 │ miss or older than 30 s: If-None-Match
                 ▼
            POST /api/auth/broker/public-read ─▶ ChatApi: signature, scope
                                                   │ installation token for the repository
                                                   ▼
                                                 GitHub GET ── 304 ─▶ cached copy, revalidated
                                                            ── 200 ─▶ store, answer
                                                            ── 403/429 limit, 5xx, unreachable ─▶ cached copy, stale
```

**The request.** `POST https://smithers.sh/api/auth/broker/public-read` with `{ origin, request, payload }`. `request` is the site key's signature, under the purpose `broker_public_read`, of `{ audience, route, origin, digest, expires }`; `payload` is `{ path, etag? }`. A delegation signature (`broker_delegation`) never verifies here, nor this one there. No person, delegation or Durable Object takes part. smithers.sh checks, in order: POST, body at most 8 KiB read within 3 seconds, a registry origin, the signature, audience, route, origin, an expiry within 60 seconds, and the digest. An unsigned request costs one HMAC and touches no storage and no GitHub. A replay within 60 seconds repeats a public GET; no nonce is kept.

**The scope.** A registry entry gains `reads: [{ repository, repositoryId }]`, separate from a person's write `grants`. `DelegationPolicy.publicRead` admits a GET of `/repos/<owner>/<name>`, or `/repositories/<id>` for a listed `repositoryId` (GitHub's `rel="next"` links name a repository this way), or one of its read collections (`issues`, `pulls`, `contents`, `git/ref`, `git/matching-refs`, `branches`, `commits`, `assignees`) for a listed repository, with safe path segments and a plain query. An entry that fails validation (not `owner/name`, no positive id) disables public reads with `github.public_read.config` `invalid_read`; it never widens them. The token is an installation token minted for that repository id alone with read permissions (contents, issues, pull requests, metadata). Before first use, and again before any read once its last check is a minute old (`RECHECK_AFTER`), smithers.sh reads `/repos/<owner>/<name>` with it: a different id refuses `forbidden` (finding 5's transfer case), and a private repository refuses `forbidden` and drops the token, so a registry mistake cannot publish private code and a repository made private is refused within a minute. A check GitHub does not answer refuses `unavailable`; no content is read without a check younger than a minute. A token is held per isolate until 5 minutes before expiry.

**The answer.** GitHub's status and body pass through with `etag`, `link`, `content-type`, `retry-after` and `x-ratelimit-*`, marked `x-smithers-public-read: github`. smithers.sh's own refusals carry `x-smithers-refusal: forbidden | unavailable` and a JSON `{ reason }`. The site trusts a status only when marked: a smithers.sh that does not serve the route yet answers its own 404, which must not read as GitHub's and drop a copy.

**The cache.** The site keeps each read in its object's storage, keyed by a digest of the URL: status 200, body (at most 1 MiB), `etag`, `link`, `content-type`, and when GitHub last confirmed it. A copy confirmed within 30 seconds answers without a request. An older one is revalidated with `If-None-Match`; a 304 costs no rate limit and refreshes the confirmation time. A 404 drops the copy. Every unmarked answer and every refusal counts as a failure. A request to GitHub runs detached from the reader that started it and is shared by every reader of its URL. A reader with patience (vibelang's wiki and issue reads: 3 seconds, inside their respective 5- and 12-second deadlines) stops waiting for revalidations once it is spent and answers those copies stale; the revalidations finish and store for the next reader. A 304 costs GitHub as long as a full page (0.74 to 0.86 s for 100 issues, measured 2026-11-10), so a read of many pages cannot revalidate them all inside a deadline.

| GitHub or smithers.sh answers | With a copy | Without one |
| --- | --- | --- |
| 200 | store, answer | store, answer |
| 304 | answer, confirmed now | not possible: no `If-None-Match` was sent |
| 404 | drop, answer 404 (`missing`) | 404 (`missing`) |
| smithers.sh's `forbidden` refusal (private or delisted) | drop, answer 403 | 403 |
| 403 or 429 with `x-ratelimit-remaining: 0` or `retry-after` | copy, stale | `rate-limited` |
| 401, 5xx, `unavailable` refusal, unmarked answer, unreachable | copy, stale | `unavailable` |

A stale answer carries `stale: <ms since epoch when GitHub last confirmed it>` on `/api/wiki` and `/api/issues`. vibelang's issues pane and wiki editor mark such a copy `Stale`, with when GitHub last confirmed it. Reads by a connected person still go through their delegation and their own limit (0165 "As built"). The History object's commit reads use the same client; `GITHUB_TOKEN` is gone from vibelang.

**Observability.** smithers.sh counts `smithers_github_public_reads{outcome}` (`ok`, `not_modified`, `missing`, `rate_limited`, `forbidden`, `unavailable`) and logs `github.public_read` with the outcome only. The site counts `smithers_github_read_cache{outcome}` (`fresh`, `revalidated`, `stored`, `stale`, `slow`, `dropped`, `too_large`, `miss_failed`). No path, body, token or person is logged.

**Trust limit.** A compromised site can read the public repositories its entry lists, at the installation's rate limit, which smithers.sh's own reads of those repositories share. It reaches no other repository and no write. A listed repository made private stays readable for at most a minute (`RECHECK_AFTER`); then smithers.sh refuses it `forbidden` and the site drops its copies. Registry removal stops it at the next deploy.

**Deploy contract.** ChatApi: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (already bound), and `reads` on vibelang's `HOSTED_AUTH_SITES` entry: `smithersai/vibelang` and `smithersai/smithers` with their ids. Without the App or with an invalid `reads` entry, the route answers 503 `unavailable` and the site serves its copies, stale. vibelang: `AUTH_BROKER_SITE_SECRET` (already bound); without it the site reads anonymously, still cached. Deploy smithers.sh first: a site that deploys first serves only copies it already holds, and a fresh object answers `unavailable` until smithers.sh serves the route.
