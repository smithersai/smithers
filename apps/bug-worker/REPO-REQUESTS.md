# Community repository requests

The home page no longer embeds the nomination form: registration is GitHub
sign-in plus installing the Smithers GitHub App on the repository. This Worker
still serves the nomination, claim, and notification contract below.
No account is required to submit, follow, or browse repositories.

## Lifecycle and app handoff

`POST /api/repo-requests` accepts `{ "repo": "owner/repo", "email": "optional@example.com" }`.
It checks GitHub for a public, enabled repository with a recognized license,
then stores it as `smithering`. GitHub URLs and `.git` suffixes normalize to
one case-insensitive repository identity. This records a request for the team
to support the repository; it does not launch an agent or provision the app.
Every accepted request is one nomination. The response is
`{ repo, subscribed }`, and `repo.nominations` is the repository's current
nomination count, including this one. `subscribed` means a confirmation email
was sent; the address receives the completion email only after the recipient
confirms (see Notifications). When a confirmation could not be sent, the
response adds `confirmation` with `rate_limited`, `send_failed`, or
`email_not_configured`.

Each public record has `name`, `url`, `status` (`smithering` or `ready`),
`appUrl` (null until ready), and `nominations`.

`GET /api/repo-requests` returns `{ repos }`: the 20 most nominated
repositories, most nominated first, ties by name, exact at any catalog size.
The response carries `cache-control: public, max-age=60`, so a browser reuses
it for a minute; the page bypasses that cache after a submission.
`GET /api/repo-requests?repo=owner/repo` returns `{ repo }` for one
repository, 404 when nobody has requested it, and 400 for an invalid name.
The upcoming app can consume this same public catalog and use ready entries
as its supported repositories.

## Nomination counts

Each repository has one counter key, `repo-nominations:<owner/repo>`, holding
the count as a decimal string. An accepted `POST` reads it, adds one, and
writes it back; rejected requests (invalid input, private or unlicensed
repository, rate limit) never touch it. KV has no atomic increment, so two
nominations that arrive at the same moment can record as one. The tally is
public and informational, so that undercount is accepted rather than adding a
Durable Object.

The same `POST` then rewrites one leaderboard key, `repo-nominations-top`: a
JSON array of `{ "name", "count" }` sorted by count, then name, capped at 20.
It replaces the repository's own entry with the new count and drops anything
past 20. The list endpoint reads that one key plus each listed repository's
readiness, 21 KV reads at most, and never scans the catalog. The leaderboard
shares the counter's read-modify-write, so the same concurrent-write
undercount applies to it and nothing else.

Once the app supports a repository **and its repository view works for an
anonymous visitor**, call `POST /api/repo-requests/complete` with the existing
`x-bug-admin` secret header and this JSON body:

```json
{
  "repo": "owner/repo",
  "appUrl": "https://app.smithers.sh/repos/owner/repo"
}
```

The URL is supplied by the app integration, not inferred by the landing page.
Only HTTPS URLs on `smithers.sh`, `app.smithers.sh`, and `canary.smithers.sh`
are accepted. The completion endpoint does not test the destination's access
policy: anonymous access must be verified before publishing. Do not publish
an app URL until that repo view exists. Publishing is monotonic: new requests
cannot reset readiness, and changing a published URL returns 409.

All visitors then see **Smithered / Open in Smithers**. The current app is still
being built; this change supplies the intake, public catalog, and completion
contract, not the repository view inside that app.

## Community forks

The first accepted nomination of a repository forks it into the
[smithers-community](https://github.com/smithers-community) GitHub
organization with `POST https://api.github.com/repos/{owner}/{repo}/forks` and
the body `{ "organization": "smithers-community" }`. Set `GITHUB_FORK_TOKEN`
when deploying the Worker to a token that can create forks in that
organization. The outcome is stored under `repo-fork:<owner/repo>` as
`{ "status": "forked", "forkedAt": "..." }`, `{ "status": "failed", "error": "..." }`,
or `{ "status": "skipped" }` when the token is unset. A fork failure is logged
and recorded but never fails the nomination; the repository is still stored as
`smithering`. Fork status is not part of the public listing.

## Maintainer claims

A maintainer can claim a nominated repository. Claiming only records who
claimed it; it does not grant access or start any work yet.

`POST /api/repo-claims` accepts `{ "repo": "owner/repo", "login": "github-login", "email": "optional@example.com" }`.
It returns `200` with `{ repo, login, claimedAt }` for the first claim, `409`
if the repository is already claimed, `404` if the repository has never been
nominated, and `400` for an invalid repository, login, or email. Claims share
the per-IP throttle used by nominations.

`GET /api/repo-claims?repo=owner/repo` returns `{ repo, login, claimedAt }` or
`404`. Claims live under `repo-claim:<owner/repo>`. The claimant's email is
stored with the claim and never appears in responses.

## Notifications

Configure `RESEND_API_KEY` and `NOTIFICATION_FROM` (a verified sender) when
deploying the Worker. No emails are sent during development tests. Delivery
uses the [Resend send endpoint](https://resend.com/docs/api-reference/emails/send-email)
and [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

Subscription requires recipient consent. A submission with an email stores no
subscriber: it sends one confirmation email and keeps a pending record under
`repo-confirm:<token>` for 24 hours. The token is 128 random bits, hex encoded,
and single-use. `GET /api/repo-requests/confirm?token=<token>` deletes the
pending record and creates the deliverable subscriber; expired or used tokens
return 410, malformed tokens 400. The confirmation response includes a `cancel`
URL, and every notification email ends with an unsubscribe link. Both point at
`GET /api/repo-requests/cancel?token=<token>`, which removes a pending
confirmation or a confirmed subscription (`repo-cancel:<token>` maps the
cancellation token to the subscriber key) and returns 404 for unknown tokens.
Confirmed subscribers are stored as `{ "email", "cancel" }` JSON; plain-address
records written before this flow remain deliverable but carry no unsubscribe
link. Without provider configuration no consent email can be sent, so the
submission stores nothing and reports `confirmation: "email_not_configured"`;
a send failure reports `"send_failed"`. Confirmation sends are throttled to
three per recipient per hour across all repositories (excess submissions report
`confirmation: "rate_limited"`), on top of the per-IP submission throttle.

Confirmed subscribers receive one transactional email upon completion.
Receipts skip already-sent messages; a cron runs every ten minutes to retry
failed sends and catch signups concurrent with completion. Each invocation
visits at most two repositories and one page of 50 subscribers per repository.
Subscriber cursors advance after every page regardless of delivery failures.
Full scans repeat, retrying unreceipted recipients on their next visit until
three failed delivery attempts have been recorded. The third failure records
a terminal state under `repo-notification-failure:<subscriber-key>` with
`attempts`, `terminal`, `failedAt`, and `error`; subsequent delivery calls skip
that recipient. This budget applies to provider errors, network failures, and
failed receipt writes. It is shared by scheduled and manual delivery. An
operator can remove the failure record to permit retries after resolving the
cause. KV consistency or failed failure-record writes can allow extra attempts.
Corrupt readiness records and repository-specific storage errors are skipped
and logged with the affected key, so healthy repositories continue and the
global cursor advances. Future full scans revisit those records.

Completion reports `email_not_configured` while the provider is unconfigured.
Always supply both email variables on redeploy so Alchemy does not remove the
bindings.

Maintainers can also call `POST /api/repo-requests/notify` with `x-bug-admin`
and `{ "repo": "owner/repo" }`. A batch handles up to 50 subscriptions and
returns `sent`, `failed`, `pending`, and a next `cursor`. Pass that cursor in
the next call even when some sends fail. Restart from the first page after
the cursor is null to revisit retryable failures. Completion remains visible
if sending fails. The cron keeps separate sweep and subscriber cursors.

KV is eventually consistent. New requests, readiness, and counts may take up
to a minute to reach other locations; the page loads the most nominated list
once per visit and again, bypassing the browser cache, after each submission.
Records and per-email subscriptions use separate keys so concurrent
submissions cannot overwrite a subscriber list or reset completed work. Provider keys
protect concurrent delivery retries for 24 hours; if a send succeeds but its
KV receipt cannot be saved for longer than that, a retry may send a duplicate.
The existing KV per-IP throttle is advisory, not an atomic rate limiter.

Email addresses never appear in public responses. Confirmed subscribers live
under `repo-subscriber:<owner/repo>:<sha256(email)>`, pending confirmations
under `repo-confirm:`, cancellation tokens under `repo-cancel:`, and the
per-recipient confirmation throttle under `repo-confirm-throttle:`, separate
from public metadata
under `repo-request:`, counts under `repo-nominations:`, the leaderboard under
`repo-nominations-top`, and completion under
`repo-ready:`. Notification receipts use `repo-notified:`, failure records use
`repo-notification-failure:`, forks use `repo-fork:`, and claims use `repo-claim:`.

Completion uses the `REPO_COMPLETIONS` Durable Object binding, keyed by the
normalized repository name. A storage transaction commits the first URL;
conflicting completions return 409 even when KV reads are stale. Existing KV
publications are adopted on first use. Alchemy provisions the `RepoCompletion`
class and its storage migration with the Worker. Missing binding returns 503.
The committed record is mirrored to `repo-ready:` before returning success or
sending notifications. If that KV write fails, retry completion with the same
URL to repair the mirror; another URL cannot replace the committed record.

## Validation and deployment

Run `pnpm -C apps/bug-worker test` and `pnpm -C apps/site build`. Deploy the
Worker before the site; otherwise the new form gets a visible API error and
the most nominated list stays hidden. `alchemy.run.ts` is an Alchemy 2 stack
(`import * as Alchemy from "alchemy"` and `alchemy/Cloudflare`), matching the
`alchemy` version the workspace installs; deploy with
`BUG_ADMIN_TOKEN=... pnpm -C apps/bug-worker deploy`. Deployment needs the
email bindings above, `GITHUB_FORK_TOKEN` for community forks, and the
ten-minute cron.
