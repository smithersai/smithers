# Sign-in

People sign in with the Smithers GitHub App. Each browser holds its own session in Postgres behind a signed, HttpOnly cookie, and every request reads who is asking from it. Signed-out people browse, and can't ask Smithers. This is [decision 0008](../decisions/0008-auth.md) phase 1, with Will's answers in its §11; roles are [decision 0007](../decisions/0007-roles-and-tags.md)'s.

## How it works

```
browser                         ChatApi (worker/SignIn.ts)                     GitHub
"Sign in with GitHub" (a link)
  GET /api/auth/sign-in?return=/app ──▶ state + PKCE S256 pair
                                        sign_in_attempts row (state digest, sealed verifier, 10 min)
  ◀── 302 + state cookie ─────────────── authorization URL ─────────────────▶ the person approves
  GET /api/auth/callback?code&state ◀────────────────────────────────────────── redirect
                                        state == this browser's state cookie?   ─ no ─▶ failed
                                        take the attempt (deleted as read)      ─ none ─▶ failed (replayed)
                                        exchange code + verifier ──────────────▶ ghu_ (8 h) + ghr_
                                        GET /user, GET /repos/<repository> ─────▶ id, login, permissions
                                        people row (GitHub id), sessions row (sealed tokens, role)
  ◀── 303 to /app + session cookie
every request ── cookie ──▶ Sessions.resolve: signature, then the live session row ─▶ Actor or nobody
  role nearing its deadline ──▶ RoleChecks.start(session, role_checked_at) ──▶ auth/RecheckRole on its Durable Object (no wait)
POST /api/auth/sign-out ──▶ FlowStarter.start(auth/RevokeGitHubToken { session }) on its Durable Object
                              ─ not recorded ──▶ 503, the session and cookie as they were
                            ──▶ end the row (sealed tokens kept), expire the cookie
        the flow: end the row (again: a no-op) ──▶ DELETE /applications/<client id>/token (as the App) ──▶ revoked
                  forget the session's GitHub tokens
  ◀── 204 ──▶ the tab wipes this device's synced data and outbox, and reloads as a visitor
```

- **A button the person presses.** Sign-in is a link; the app never redirects anyone to GitHub on its own, and agents can't press it (decision 0008 §3).
- **The state is bound to the browser that started it.** A callback finished in another browser, or with a state this browser didn't get, signs nobody in and never reaches GitHub (login CSRF).
- **Single use.** The callback deletes its sign-in as it reads it, so a replayed callback signs nobody in, and GitHub redeems a code once and only with the verifier its challenge came from.
- **The callback's writes happen in its handler.** A code is single-use and bound to its request, so a durable retry could not redeem it again; this is the one exception decision 0008 names to every action being a durable flow. Checking a role again, which refreshes GitHub's token, is a flow, and so is signing a session out.

## Routes

| Route | Answers |
|---|---|
| `GET /api/auth/sign-in?return=<path>` | `302` to GitHub with the state cookie; `503 { code: "not_configured" }` without the GitHub App; `503` when Postgres fails. Under `alchemy dev` without the App: `303` to the return path, the local developer signed in again ([Local development](#local-development)) |
| `GET /api/auth/callback?code&state` | `303` to the return path with the session cookie; on any failure `303` to the return path (or `/`) with `?sign_in=failed` |
| `POST /api/auth/sign-out` | `204`, `auth/RevokeGitHubToken` started, the session ended and the cookie expired; `403` when the request doesn't say it came from this site (`Origin`, or `Sec-Fetch-Site: same-origin`); `503` when Postgres fails or the flow's start isn't recorded, with the session and cookie as they were. Under `alchemy dev` without the App: `204` with the dev signed-out cookie |
| `GET /api/auth/handoff?request=<signed>` | at `APP_DOMAIN` only ([Other hosts](#other-hosts)): `303` to `<alias>/api/auth/arrive#code=<code>`; for a custom domain `200`, the page asking to continue; `302` to GitHub first without a session here; `303` to the alias's return path with `?sign_in=failed` after GitHub failed; `400` for a request that isn't signed, has expired or names a host that isn't one; `404` elsewhere; `503` when Postgres fails |
| `POST /api/auth/handoff` (form field `request`) | at `APP_DOMAIN` only: Continue on that page, `303` to the arrive page as above; `403` from another site |
| `GET /api/auth/arrive` | at an alias only: the page that posts the code from its fragment back here (`no-referrer`, a CSP pinning its one script); `404` at `APP_DOMAIN` or without one |
| `POST /api/auth/arrive` (form field `code`) | at an alias only: `303` to the return path with the alias's session cookie; `303` with `?sign_in=failed` for a code that is unknown, spent, expired, another host's, or not this browser's nonce's; `403` from another site |
| `GET /api/auth/session` | `200 { signedIn: false, available, hostedModel }` or `{ signedIn: true, personId, login, role, hostedModel, install? }`, `personId` the person's stable id ([the device's owner](#the-devices-owner)); `503` when Postgres fails. `available` is true where the GitHub App is configured, and under `alchemy dev`. `hostedModel` says whether the deployment's own model answers: signed out, anyone (decision 0099), so a visitor's [first run](first-run.md) shows the steps they will have; signed in, this person, which is only a Member or above of `GITHUB_REPOSITORY` (ruling AUTH-8). `install` is where Install goes, `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`, when the deployment signs in with the App |

The return path is a path on this site; anything else, including `//host` and `/\host`, returns to `/`. Validation checks the origin and the normalized pathname: `/.//host`, `/a/..//host` and encoded dot-segment equivalents also return to `/`. Encoded slashes and backslashes remain path data, without a second decoding. Both callback outcomes revalidate stored paths, including attempts started before an update. `?sign_in=failed` is dropped from it, so trying again doesn't come back saying it failed. Every answer is `Cache-Control: no-store`.

## Other hosts

People sign in at every alias (`APP_ALIASES`) and verified custom domain through `APP_DOMAIN`, whose callback is the only one the GitHub App lists ([decision 0130](../decisions/0130-sign-in-on-other-hosts.md), ruling AUTH-9).

```
alias (factory.example.com)                  APP_DOMAIN (example.com)                       GitHub
"Sign in with GitHub" (Sec-Fetch-Site same-origin or none, else ?sign_in=failed)
  GET /api/auth/sign-in?return=/p ──▶ nonce cookie (signed, 10 min)
  ◀── 302 ───────────────────────────── /api/auth/handoff?request=<signed {host, returnTo, sha256(nonce), expiry}>
                                        signature, expiry, host an alias or active domain? ─ no ─▶ 400
                                        no session here ──▶ the ordinary sign-in, returning here ─────▶ callback
                                        a custom domain ──▶ a page: "Sign in to <host>?" ── Continue (same-origin POST)
                                        code: 256 bits, sha256 kept with session, host, nonce digest, 60 s
  ◀── 303 /api/auth/arrive#code=… ──────
  GET /api/auth/arrive: a page; its script drops the fragment and posts the code (no-referrer)
  POST /api/auth/arrive code=… ──▶ same origin? take the code (deleted as read) ─ none, expired, other host ─▶ failed
                                   nonce cookie's digest == the code's? ─ no ─▶ failed
                                   host_sessions row (fresh token, parent = the home session) ──▶ 303 + session cookie
```

- **A press on the alias.** A sign-in that another site's link starts signs nobody in (M-46): the alias refuses one whose `Sec-Fetch-Site` isn't `same-origin` or `none`.
- **The code never reaches a server in a URL.** It travels in the fragment, which browsers send to no server and in no `Referer`, and in a same-origin POST body. Logs, spans and metrics carry the outcome, the reason and the host only.
- **One code, one browser, one host.** Every attempt spends the code; it redeems only within 60 seconds, only at the host it was issued for, and only from the browser holding the nonce its request named.
- **A custom domain asks first.** Its owner controls where its name points, so for one `APP_DOMAIN` shows a page with the person's login, Continue and Cancel, and mints the code only on Continue, a same-origin POST. The confirmation page sends no referrer: when its POST has `Origin: null` or no `Origin`, it must have `Sec-Fetch-Site: same-origin`; other metadata is refused. `APP_ALIASES` hosts, which only the deployment serves, skip it.
- **Alias sessions nest.** An alias session holds no GitHub token: it acts as its home session (the actor's session, the role check, run credentials, GitHub writes) and ends with it. Signing in again renews an eligible alias row in place. An ineligible alias is revoked and replaced; a pre-0130 GitHub session still ends through its sign-out flow. Signing out at the alias ends only that alias's session (`auth.sign_out` `reason: alias`; no flow, nothing to revoke). Signing out at `APP_DOMAIN`, or anything else that ends the home session, ends every alias session under it at the next request.
- **Without `APP_DOMAIN`** (`workers.dev`, local development), every host signs in through GitHub itself, as before, and needs its own callback URL.

## Sessions and cookies

| Cookie | https | plain http (local development, mvp.md M-28) | Flags | Lifetime |
|---|---|---|---|---|
| session | `__Host-smithers_session` | `smithers_session` | HttpOnly, SameSite=Lax, Path=/, no Domain, Secure on https | `Expires` at the row's 400-day deadline |
| sign-in state | `__Host-smithers_sign_in` | `smithers_sign_in` | the same | 10 minutes; expired by the callback |
| dev signed-out | `__Host-smithers_dev_signed_out` | `smithers_dev_signed_out` | the same; value `1`, unsigned | 30 days; only where the GitHub App isn't configured and a fallback is signed in (`alchemy dev`) |

- A cookie is `<token>.<HMAC-SHA256>`. Postgres keeps only the token's SHA-256, so reading the database signs nobody in.
- A session ends at sliding expiry, its absolute deadline, sign-out, replacement, GitHub refusal or emergency revocation. An eligible same-person sign-in renews its row in place. Every end atomically revokes the row, transfers sealed tokens to cleanup, clears them from the row and records anonymous home and alias receipts ([Signing out](#signing-out)).
- Explicit sign-out accepts a configured old-key signature after in-place rotation, even when that cookie can no longer authenticate data requests. It still checks the request's origin and device owner; home sign-out ends its aliases, while alias sign-out ends only that alias.
- A terminal's cached session end blocks frames while one bounded authority check verifies that the session remains live. Both terminal timers share that check; confirmed expiry closes with 4401, and unavailable or timed-out verification closes with 1012.
- `Sessions.resolve` reads the row on every request, so a revocation applies to the next request. Postgres unreachable is `SessionsUnavailable`: the model endpoint answers `503 provider_internal`, not a sign-in prompt.

`GET /api/auth/session` renews a live home session at most daily, including when
requested through an alias, to 30 days (`SESSION_MAX_AGE_DAYS`) capped at 400 days
from `started_at`. Existing starts are backfilled from `created_at`. The shared
`sessionLive` predicate enforces this bound for cookie resolution, role checks,
deployment membership, alias creation and socket authority. An alias's deadline
is 400 days after the earlier of its own and its parent's start.

The signed-in answer includes optional `deadline`, effective `expiresAt` (the
earlier of sliding expiry and the deadline), and `serverNow` from the database's
`clock_timestamp()` in the lookup after renewal. Cookies change only at sign-in
and sign-out. Sign-in sets `Expires` to the row's deadline; a copied or delayed
cookie authenticates nobody past the server bound. Older cookies keep their
original `Max-Age` until the next sign-in.

The optional `session` field is the row's independent 128-bit random `session_tag`,
encoded as 32 lowercase hexadecimal characters and unique on its table. Database
defaults generate and backfill tags, including inserts from an older Worker.
An alias returns its own tag. Renewal and in-place re-authentication keep it.
The tag is never derived from a session id and never enters run credentials,
logs, traces, metrics or URLs. The response exposes neither row id.

`GET /api/auth/session` with `x-smithers-session-tag` adds `prior`, even without
a cookie or with a failed signature: `ended`, `live`, `absent` or `failed`.
The tag grants only this status lookup. A single transaction on the primary,
through the uncached ChatDatabase, reads the receipt first, locks parent then
alias, and checks raw revocation, sliding expiry and starts against
`clock_timestamp()`. It never uses `sessionLive`. A retained expired row goes
through `endSession` even when its receipt was backfilled. Renewal and
re-authentication lock first and require an unrevoked, unexpired row afterward;
confirmation therefore cannot be undone by a later renewal. An alias's own
absolute deadline ends only that alias. Failed queries answer `failed`, never
`absent`. Every answer is `no-store`.

A signed-out answer authenticates nobody; it does not prove an end. Only a
verified different person or `prior: ended` confirms destruction. A missing
cookie, failed signature, `prior: live`, `absent` or `failed` keeps data sealed.
The same verified person with a new tag adopts it when the old tag is live or
absent; a failed lookup retains the old tag. This device behavior ships in
step 3, guided by the reviewed session-end design.

A request bound to `@anonymous` reads as nobody before either cookie or bearer
resolution, including when another tab has signed in. It records an anonymous
device-principal refusal. `@none` remains unbound for session discovery. The
server adds this binding; sending it from the device belongs to step 3.

## Run credentials

The server tells the person from the agent, a flow or a plugin acting for them ([decision 0017](../decisions/0017-everything-is-a-plugin.md#run-credentials-telling-the-person-from-the-agent-slice-0), slice 0). Only the person's own press runs with their session: a root run of a person's flow (the registry's `acts` unset) that the tab started through a person door (`button`, `slash`, `composer`, `key`). The compiled `branch/operation/start` and `branch/operation/program` implementations retain a `branch/publish` or `branch/update` parent’s session so a person’s GitHub write stays theirs (GH-2). This exact compiled parent/child pair is the only exception: a credential-backed parent never gains a session, and all other nested runs send their own server-minted credential without the session cookie.

```
tab ── dispatch(flow, door)
   refusesCredential(flow) and not a person door ──▶ refused: person_only; no run
   otherwise ──▶ engine (src/flows/credentials.ts), on each request to /api/
     root run? ──▶ ask its tab: which door, signed out? (DOOR_WITHIN)
        signed out ──▶ no credential request, no cookie
        person flow and person door ──▶ the session cookie
        silent ──▶ log auth.run_credential { outcome: door_timeout }
                   refusesCredential(flow)? session cookie; otherwise: credential request
        another door ──▶ credential request, still refused for person-only acts
   anything else ──▶ POST /api/runs/<run>/credential {flow, ceiling?}
                       a root: in the person's session    a nested run: with its parent's credential
                     ◀── {token, act, expiresAt}  or 403 person_only / capability_exceeded, 401 signed out
                 ──▶ the request with Authorization: Bearer <token>, credentials: "omit"
ChatApi: Sessions.resolve ── a bearer token? ──▶ verify: signature, expiry, the session still live ──▶ Actor + act
                                                  never the cookie's person, even when it doesn't verify
         a person-only route ── act set? ──▶ 403 person_only, counted
```

- **The server sets `act`, never the request.** A chain the person's session starts is `agent` when the registry marks its flow an agent (`chat/Answer`, `flow/new`, `flow/run/prompt`: `worker/Actor.ts` `AGENT_FLOWS`), else `flow`. A nested call keeps its caller's kind, and becomes `agent` inside an agent. `app` (a frame's dispatch) and `sandbox` are the other kinds.
- **Authority narrows at every hop.** A credential holds its root run, the chain of flows from it (at most 16) and its ceiling. A nested call's ceiling is the caller's intersected with the callee's declared `Flow.make` capabilities (`Flow.intersectCeilings`); a callee whose declared ceiling the caller's doesn't cover is refused `capability_exceeded` (`Flow.ceilingWithin`). A declared ceiling only narrows.
- **A signed-out tab asks for no credential.** The tab's door answer also says whether its sign-in row says nobody is signed in (`DoorAnswer.signedOut`, `src/flows/doors.ts`). Every root run, including one marked `acts: "flow"` or `acts: "agent"`, asks its tab. Every signed-out root run, including a person's press, goes signed out at once, as a minted `401` would leave it, without sending the credential request: a visitor's page makes no `POST /api/runs/<id>/credential` (`auth.run_credential` `outcome: signed_out`, at Debug). Nested runs inherit that anonymous state instead of minting under a nonexistent session. A signed-in person's own press still goes in the session, and a tab of an earlier build that answers only the door still gets a credential asked for.
- **A person-only press survives a silent tab.** Dispatch starts a flow whose route refuses an act (`refusesCredential`) only through a person door; otherwise it returns `refused` with `person_only`. For a root run of one, if the tab does not answer within `DOOR_WITHIN`, the request goes in the session: dispatch already established the person's press, even if the tab is busy or reloaded while the engine resumed the run. A tab answering with another door is still refused. A silent door logs `auth.run_credential` with `outcome: door_timeout`.
- **No credential for a person-only act.** A flow whose route is person-only gets none, nested or not: `403 person_only`. The engine hands that refusal to the step as its request's answer, and sends nothing.
- **A run's parent** is the one the engine recorded, else the run it is named after (`requesterOf`: the agent's calls are `<answer>/…/call/…`, an answer's close `<answer>/close`) when the engine holds one; `ack/…` and `deliver/…` name no run, so theirs are roots.
- **The token** is `SessionKeys.sign("run", base64url(claims))`: HMAC-SHA256 under the durable issuer, a purpose no cookie shares. Claims: the person, the session it was minted under, `act`, the run, its root, the chain, the ceiling and the end, 15 minutes on (`CREDENTIAL_TTL_MS`); the engine mints the next a minute before. Without sign-in configured, local development's people sign theirs with `SESSION_SECRET` when Alchemy bound one, so a credential outlives the dev server reloading ChatApi, and with a key the Worker draws when it starts otherwise. A request a credential went with that comes back `401` makes the engine ask for every credential again, once (`auth.run_credential` `outcome: stale`).
- **It ends with its session.** Verifying reads the session by id, so a credential replayed after sign-out, or for a person no longer signed in, reads as nobody (`401`). A forged, tampered or expired one reads as nobody too, never as the cookie beside it.
- **Bound to its run.** The runs report route and the answer write route take a credential only for the run its chain started from (`403 other_run`); a sandbox call names an answer only as that run.
- **Credential renewal.** Before renewing a queued write's credential, the tab reads its real sign-in store. Signed out, renewal returns `401` locally and sends nothing.
- **The tab's outbox.** A write the agent queues in the tab, an issue write, carries its run's credential, and the tab sends it with that and without the cookie; a run with no credential to send queues nothing (`no_credential`). The git writes route reads who acts (`via`) from the request alone: the body names nobody.
- **Signed out**, a run sends its requests with no credential and no cookie.
- **The Node host** (`src/test/agent.ts`) runs the same credentials; with no tab, every root run its tests start is the person's own press.

**Person-only acts.** `PERSON_ONLY_FLOWS` in `src/flows/personOnly.ts` holds every registry flow with a `userOnlyReason`, and the compiler refuses one missing or one too many; `refusesCredential` reads the same list. Each entry says how it stays the person's: its `route` refuses an `act`, only the person `starts` it there (`chat/Answer`: asking), or it reaches no server route (`device`, with why). `PROTECTED_ACTS` holds the server's own: a secret's write, merging a pull request and a stack's settings (decision 0135); approving, pre-approving, members, roles and plugin grants join it with their routes. Each route calls `refusesPersonOnly(actor, act)`.

| Act | Route | Refusal |
|---|---|---|
| `chat/Answer` (asking) | `POST /api/questions` | `403 { message }` |
| `run/answer` | `POST /api/runs/<id>/answer` | `403 person_only` |
| `flow/answer` | `POST /api/flow-drafts/<id>/answers` | `403 person_only` |
| `branch/share` | `POST /api/branches/<id>/shares` | `403 person_only` |
| `terminal/open` | `POST /api/terminals` | `403 person_only` |
| `notification/ack` | `POST /api/notifications/ack` | `403 person_only` |
| `alert/channel` | `POST /api/alert-channels` | `403 person_only` |
| `domain/add` | `POST /api/repos/<owner>/<name>/domains` | `403 person_only` |
| `domain/remove` | `DELETE /api/repos/<owner>/<name>/domains/<hostname>` | `403 person_only` |
| `issue/triage`, `triage/run`, `triage/enable`, `triage/pause`, `issue/commitment`, `pr/merge` | `POST /api/repos/<owner>/<name>/writes` | `403 forbidden`, the route's own contract |
| `todo/commit`, `todo/drop`, `stack/configure` | `POST /api/repos/<owner>/<name>/stack` | `403 forbidden`, the route's own contract |
| `secret` | `PUT`, `DELETE /api/repos/<owner>/<name>/secrets/<name>` | `403 forbidden`, the route's own contract |

`POST /api/runs/<run>/credential` answers `200 { token, act, expiresAt }`; `400 invalid` for a body that isn't `{ flow, ceiling? }`; `401` signed out; `403 forbidden` for another person's answer (`chat/Answer`'s run is the answer's id); `403 person_only`, `capability_exceeded` or `too_deep`; `404` for a run id that isn't one; `413` past 16 KiB.

Not built yet: confirmation receipts and the host's confirm dialog for protected acts (decision 0017 slice 0); the runs a remote host starts mint their own credentials once a remote flow acts for a person; a plugin installation as a credential's subject (slice 2).

## Roles and role checks

The session's role is the person's permission on `GITHUB_REPOSITORY`, the deployment's own repository (`GET /repos/<owner>/<name>` with their token), mapped as decision 0007 §9 says, never with more power than GitHub gives. It also gates hosted inference and machine access on every repository (decision 0122 amendment). Repository permissions remain separate: there the role is the person's GitHub permission on that one, read with the App and kept 5 minutes ([decision 0079](../decisions/0079-roles-per-repository.md), `worker/github/RepoRoles.ts`). Issue writes, the stack, a repository's home ([home](home.md#who-sees-what)), a branch's workspace ([branch workspace](branch-workspace.md)) and a TODO's run ([runs](runs.md)) use it today. `GET /api/repos/<owner>/<name>/role` answers it to the browser, `{ role, own }` with `own` true on the deployment's own repository, and every repository route asks (`router.tsx` `enterRepo`, kept per tab in the repository feature's `roles`): the header's Secrets and Settings links and each page's buttons show by it, none before it answers, and the features still fenced to the deployment's repository (secrets, custom domains, triage, merging) only where `own`.

| GitHub | Role |
|---|---|
| admin | Admin |
| maintain | Maintainer |
| write | Member |
| triage, read | Guest |
| none (a repository they can't see) | no role |

The role is read at sign-in, and again five minutes before its hour-long receipt expires (`ROLE_RECHECK_MINUTES`; half the configured window if shorter). The request that finds it due starts `auth/RecheckRole { sessionId }` on the remote flow host ([remote-flows.md](remote-flows.md)) and uses the still-fresh receipt without waiting. If an idle session returns after expiry, cookie and bearer requests advance that same durable execution for up to ten seconds, then reread the live session. Healthy recovery serves the triggering request; failed or unfinished recovery leaves protected access retryable. An alias is checked again too, so ending it during recovery still signs that host out. All the person's live sessions use their newest role receipt, including a demotion another session learned before signing out. A database sequence orders observations before GitHub is read; a delayed older response cannot overwrite a newer demotion. The check's completion timestamp only schedules its next check. A person with no live session has no deployment exemption.

**One check of a session at a time.** The execution is named after the session and the check it replaces, the session's `role_checked_at` (`auth-recheck-<session>-<epoch ms>`). Every request that finds the same stale role, in this hour or a later one, starts the same execution, and the flow engine runs it once. Only a finished check moves `role_checked_at`, so the next check can't start until this one is over, and only one check ever redeems a session's refresh token.

The flow's steps:

1. `auth/RedeemRefresh`: when the 8-hour `ghu_` token expires within 5 minutes, trades the single-use `ghr_` refresh token once (`Core.OAuthToken.exchangeRefreshToken`) and seals the new pair for the session. Its result, sealed into the run's journal, holds the encrypted pair, the presented refresh digest, the replacement access digest and the observed token generation, never a token in plaintext. It writes nothing.
2. `auth/StoreTokens`: locks the session row and classifies the latest committed state: stores the sealed pair at its observed generation, recognizes an installed replay, or enqueues an abandoned pair for cleanup. It retries from the journaled result until Postgres answers, so a Postgres failure, or the host dying, after GitHub issued the pair never redeems the spent token again (the regression from Codex review 4).
3. `auth/CheckRole`: reads the permission with the session's current token and records the role.

GitHub refusing the refresh token (expired after 6 months, or used) while the session still holds it, or the access token (the App revoked), ends the session. GitHub or Postgres failing fails `auth/RedeemRefresh` or `auth/CheckRole`, which retry 5 times from 1 second, doubling. When every attempt fails, `auth/KeepRole` copies the person's newest role receipt and records the check, so a request an hour later starts a new one; it retries until Postgres answers. Role writes serialize on the person's row, so a failed refresh on an older Member session cannot override a verified demotion.

**The one window no journal closes.** GitHub redeems the refresh token and its answer never arrives (the connection drops, or the host dies before the step seals). Nothing holds the new pair, so the retry, or the next check, presents the spent token; GitHub refuses it, the session ends, and the person signs in again. Each redemption is one step, so this window is the length of one HTTP exchange.

## Signing out

`POST /api/auth/sign-out` starts `auth/RevokeGitHubToken { sessionId }` on the
remote durable host, with one execution per session. Admission failure answers
503 and keeps the session. Once admitted, both the handler and the flow use the
same idempotent `endSession` transaction. Alias sign-out ends only that alias while its parent is live. If the parent
has already ended, it finalizes the parent and its credentials immediately,
with receipts dated at the actual earlier end.
An ineligible callback ends its held home row transactionally; eligible
re-authentication only replaces credentials and keeps the row live.

The end transaction locks the parent before aliases, sets `revoked_at`, moves
sealed tokens into `github_token_cleanups`, clears them from the session, and
writes `session_end_receipts (session_tag PRIMARY KEY, ended_at, reason)` for the
home and its aliases. Reasons are `sign_out`, `github_refused`, `unreadable`,
`expired` and `compromised`. Receipts contain no person, login or token.

The existing durable cleanup sweep also finalizes unread expiries and applies
retention: session and alias rows are erased 30 days after their end; anonymous
receipts are erased 400 days after their end. No migration erases a session.
Before erasure the sweeper preserves the person's newest role observation in
`person_role_receipts`; `latestRole` and generation reads include it, so an old
session cannot regain authority after a confirmed demotion is erased. That
receipt cascades on person deletion; anonymous end receipts do not. Past their
400-day bound tags answer `absent`, which never proves an end.

The existing `auth/EndSession`, `auth/RevokeToken` and `auth/ForgetTokens` action
names remain readable in durable histories. Revocation now drains pending
cleanup rows, even after the session is erased. Exhausted revocation attempts
leave cleanup for the sweeper. Unreadable cleanup remains pending. `ownerOf` and
`hostOwnerOf` identify a sign-out's person without authenticating them;
`signingOut` finds pending cleanup, and `forgetTokens` transfers ended tokens
instead of discarding them. The writer inventory is
`worker/SessionEndWriters.test.ts`; it detects new writers, but cannot prove an
allowed writer fires correctly. False ends written into rows still wipe.

**The device.** Once ChatApi answers the sign-out `204`, never after a failed one, the tab forgets the session it last confirmed and wipes this device's synced data and outbox (decision 0008 §4.6) through `DeviceWipe`, the host's `wipe`. In the browser, every page takes part (`src/wipe.ts`, wired in `src/main.tsx`):

1. **Every page holds the data.** From before its program starts until it ends, a page holds the Web Lock `smithers-data`, shared.
2. **Every page leaves.** `wipe` sets the `smithers-wipe` mark in localStorage and tells every page on the `smithers-wipe` BroadcastChannel, its own included. Each page then drops its view, stops its program, which closes the device store and the outbox and ends its engine worker, and loads again.
3. **The next boot deletes once nothing has the data open.** Before `start` opens anything, a marked page takes the exclusive Web Lock `smithers-wipe`, then `smithers-data` exclusively, so it waits until every page that had the data open has ended, and none can write a row back; then the engine's own Web Lock, so no engine worker holds its OPFS files. Only then does it delete the engine's OPFS directory `smithers/<engine name>` (the engine's store and the app's shared database, the device store) and the outbox's IndexedDB database `smithers-outbox`, and clear the mark. Other pages loading at the same time wait for the wipe's lock and find it done. The theme's mirror stays.
4. **A page whose delete still fails never opens the stores.** The mark stays, and the page starts on stores that aren't the device's (`unwiped`): the device store in memory, the outbox in memory, so no ask of the ended session is sent, and no engine, so none of its runs resumes. The pill says Smithers can't run in this browser, with Reload, whose boot deletes again.

The page continues as a visitor. A visitor's page syncs only conversations whose branch a visitor may view (`worker/Chat.ts`, `branchAccess`), throttled per network ([throttling](chat.md#throttling)).

## The device's owner

A device's data belongs to one person: whoever owned it when it was made. Another person who signs in on the same browser never opens it, sends its queued writes or resumes its runs. The data stays whole and sealed until its owner signs in again, or someone signs out, which wipes the device as [signing out](#signing-out) always does. Nothing else deletes it ([decision 0023](../decisions/0023-device-ownership-and-queued-authority.md)).

**The check.** Before the engine starts, every time an engine worker is about to lead, it reads the owner record and asks ChatApi who is signed in (`authorizeDevice`, `src/device/identity.ts`, through `@smthrs/platform-browser`'s `BrowserRuntime.run({ authorize })`). A worker's first check takes the session read it started as it began to load, before its flows' modules evaluated (`src/flows/sessionStart.worker.ts`, [decision 0117](../decisions/0117-cold-start.md)); every later check asks again. The record is one row, `smithers_device_identity` (version 1: the owner's stable person id or `@visitor`, and the login they claimed it under, kept for diagnosis), in the device store beside the collections: expiry keeps it, and only the wipe deletes it.

| The device holds | Signed in as its owner | Signed in as someone else | Signed out | ChatApi unreachable |
|---|---|---|---|---|
| nothing | opens; whoever signs in owns it (`verified`, `new`) | (the same) | opens as a visitor's (`visitor`) | opens as a visitor's (`visitor`) |
| a visitor's data | opens; whoever signs in adopts it (`verified`, `visitor`) | (the same) | opens (`visitor`) | opens (`visitor`) |
| a person's data | opens (`verified`, `owner`) | sealed (`changed`) | sealed (`signed_out`) | opens as theirs (`offline`) |
| an earlier build's data (7b96f878, c6940ac5), with its confirmed session | opens when it is theirs: the confirmed stable id, or, from builds that kept none, the login, any case; they own it from then on (`verified`, `legacy`) | sealed (`changed`) | sealed (`signed_out`) | sealed (`unverified`) |
| an earlier build's data without a confirmed session | sealed (`changed`): no one can be told it is theirs | sealed (`changed`) | sealed (`signed_out`) | sealed (`unverified`) |

The login match is for the one upgrade from builds that kept a login and no stable id, production's c6940ac5 among them: once a device has an owner record, the stable id decides and the login never matters again. Matching a login proves less than an id, since GitHub can give a released login to someone else; a person who could exploit that would already need this browser profile, whose files they could read anyway.

**Each tab.** The worker sends its receipt (`smithers/device-identity`: the owner, or none when sealed, and the outcome) to its tab and every waiting tab. A tab that starts while another tab's worker leads asks on the channel; the leader reads `GET /api/auth/session` again and answers with its receipt only while that session is still the owner's (or ChatApi can't say). A tab opens the device store and the IndexedDB outbox only on a receipt that names an owner; until one comes both wait, as they wait for a leader anyway. Sealed, the tab runs on memory stores and no engine (`persistence unavailable`, `browser.engine.unavailable` with `DeviceIdentityRefused`). Another person signed in since the leader's activation, as when a second tab signed in, reopens every tab (`reopen`, `src/wipe.ts`) so a new activation checks them; a second mismatch within a minute stays on memory instead.

**Each session answer.** The page's fetch checks every `GET /api/auth/session` answer against its activation (`stale`, `src/device/identity.ts`): Auth's read at startup and on reconnect, and the one it makes after a `401`. Data opened for someone other than the person signed in now, or a tab sealed only because no one was signed in (`signed_out`) or ChatApi couldn't say (`unverified`) once someone signs in, reopens every tab, and the new activation decides. So a tab opened offline is checked as soon as an answer comes, and the owner signing in again reopens their sealed data without a reload.

**Adopting in place.** A tab bound to a visitor's data (`@visitor`) never reloads when a session answer names a person: its fetch asks its leader to adopt the data (`{ request: "adopt" }` on the identity channel) and waits for the receipt. The leader runs the owner check again with the database its activation was given (`@smthrs/platform-browser`'s `authorize` contract); a visitor's record then claims the person (`verified`, `via: visitor`), and its receipt goes to every tab. Every tab on the visitor's data takes the owner in place, with the receipt's continuity (false: the person came to the data only now, so the outbox's unstamped writes stay sealed, as do writes stamped as anyone else), logs `auth.device_identity` `adopted`, and dispatches `smithers-device-adopted`, on which chat sends waiting writes and asks waiting shapes again (`smithers_web_sync_retries{via: adopted}`). The session answer then goes on, so Auth shows the person signed in. ChatApi couldn't say by then (the visitor's receipt again): the answer fails as unsent, and `auth/refresh` asks again ([when ChatApi can't say](#when-chatapi-cant-say)). A leader that never answers (an earlier build) before the request’s Effect deadline (15 s for session checks), or any other receipt, reopens the page as before. Requests made meanwhile wait, then carry the person: what ChatApi served a visitor (`@visitor` reads as nobody) is asked again under the person, and a person-scoped shape's old handle is answered `409 must-refetch` on its next request, so the device syncs it again.

**Each request.** Every request a tab or its engine worker makes to this origin's `/api/` carries `x-smithers-device-person`: the owner whose data it opened, `@visitor`, or `@none` for a tab on memory, which holds no one's data and acts as its cookie's person. ChatApi reads a request whose cookie or run credential is anyone else as nobody, and refuses a cookie-authenticated write or sign-out that names no one, as an earlier build's tab sends (`auth.device_principal` and `smithers_device_principal_refusals`, `mismatch` or `unbound`), so a page opened as one person can't act as the next person signed in. `GET /api/auth/session` stays unbound, so a tab can see the change. A session answer naming someone else, or a `401` while someone else is signed in, reopens every tab, and the request fails as unsent rather than refused, so a queued write waits for its owner. A request with a run credential is that run's whatever the cookie, as before; a read without the header is read as before.

**A write ChatApi couldn't place.** A write the outbox holds and sends in the person's session opts in to a check of its `401` (`x-smithers-confirm-401`, which the page's fetch removes from every request): co-edit updates, issue writes and steers without a run credential, and TODO changes. The page's fetch reads the session after the refusal. Still the write's person: ChatApi couldn't tell who asked, as when a sign-in in another tab swapped the cookie, so the write is held (`src/outbox.ts` `held`), sent again with the outbox's backoff and after every reload, never refused, and the connection pill offers "Sign in to send your changes" until all held writes are delivered. Signed out: the page reopens and its activation decides the write with the device's data, unless a pending sign-out on this device owns the lifecycle guard, whose wipe deletes it; the write fails as unsent meanwhile. No session answer: the write fails as unsent and is checked again on its next send. A write sent with a run credential keeps its `401`: it is about the run. The page reopens at most once a minute; a reopen held back leaves the page's fetch working.

**Each queued write.** A memory-only activation stamps its new writes `@none`, matching its request binding, so they can send without admitting any sealed device writes. The outbox stamps each write with the owner the tab opened the data as, and loads and sends only that owner's writes (`Outbox.Principal`). Another owner's writes stay sealed in IndexedDB (`outbox write sealed`), as an earlier owner's do when the browser evicted the device store but not the outbox, or when a visitor's device is adopted. A write an earlier build stored names no one. It is the owner's only when the receipt says the owner held the device before this activation (`continuous`: the recorded owner, or an earlier build's matching confirmed session). On a device that came to its owner only now, such a write stays sealed too, across reloads: the owner record persists eligibility for unstamped writes, and a fresh claim or visitor adoption never gains it just by reactivating.

**Signing out** wipes the device, owner record included: the next person to sign in opens a new device. Signing out from a sealed tab wipes the sealed data too, so the person at the browser decides; it is the one way to clear another person's data.

Records: `auth.device_identity` and `smithers_device_identity_checks` by `outcome`, and `via` when verified; `unavailable` with its `stage` and `reason` when the check couldn't run. None carries a login or a person ([observability](../observability.md)).

## Keys

`SESSION_SECRETS` is a JSON map of signing key ids to secrets of at least 32
characters. The generated `SESSION_SECRET` is the compatibility fallback, under
the id `legacy`; migrations backfill existing rows with that id. The issuer is
read inside each session or alias insert. The same statement writes `cookie_key`
and `started_at`, and the cookie is signed after commit with that recorded key.
A Worker missing that key rolls the insert back. Issuance takes locks in order:
people, then sessions or aliases. Statement, lock and idle transaction timeouts
are 5 s, 2 s and 10 s; PostgreSQL 17 also enforces a 15 s transaction timeout.

`SESSION_SEAL_SECRET` alone seals GitHub tokens, PKCE verifiers and journaled
refresh replacements with AES-256-GCM. Unset, it falls back to `SESSION_SECRET`.
Alchemy resolves this secret once and makes both its binding and the signing map
depend on the publication gate. `session_seal_key` stores its domain-separated
HMAC-SHA-256 fingerprint (`"smithers session seal check v1"`). The first publication
pins a NULL reference from the secret this deployment holds, including when
sessions, pending sign-ins or cleanup ciphertext exist. It logs `pin_seal`
after commit, without the secret or fingerprint. Later mismatches refuse
publication. Signing rotation never changes the encryption key.

If the seal secret is lost, run
`node --import=vibelang/register ops/auth/session-keys.ts reset-seal --confirm-sign-out`
with `DATABASE_URL`. This durable operator command clears only the seal pin;
the next publication pins its configured secret. A different seal makes old
GitHub tokens and pending sign-ins unreadable and signs affected people out
when their tokens are next opened. It cannot recover old cleanup ciphertext.
The flag explicitly confirms that consequence. No cookie or old secret is required.

Delayed writes retain the verifying cookie key. A recorded payload from before
that field existed means `legacy`, so it cannot adopt a newer stamp on replay.
An alias write retains its alias key; its parent is still checked against the
configured key set. Explicit sessionless local authority remains separate.
Triage settings keep their write pending when captured authority is unavailable,
including retries before sign-in recovers. Only a confirmed permission denial
settles `not_allowed`; recovery retries the original write ID.
Repository denial requires a fresh locked role observation at least as recent
as admission. Missing, expired or older observations stay retryable.

Verification reports the configured key. Cookie resolution and socket leases
require that key to equal the presented row's stamp. Internal reads, including
membership and role checks, accept only row keys still configured. A presented cookie or socket lease further narrows that set to its
verifying or captured key. A configured-key cookie for a live row stamped with another key authenticates
nobody: the session endpoint returns `{ credential: "stale" }` plus `prior` when
a tag was supplied, and other
cookie-authenticated routes retain their empty `401` with
`x-smithers-credential: stale` and `Cache-Control: no-store` unless the request
sends exactly `x-smithers-accepts: credential-stale`.
`ACCEPTS_HEADER` and `ACCEPTS_CREDENTIAL_STALE` in `src/features/auth/contract.ts`
name that opt-in. An opted-in request gets `503` with
`x-smithers-credential: stale`, `Retry-After: 1` and `Cache-Control: no-store`,
without executing the route. The unchanged deployed pulls client keeps its
pre-503 empty `401` response, with no refusal code. The client stack must
send this opt-in only once it consumes the status and stale header as a retryable
`credential_stale` transport outcome, hold reversibly and reread the session
with `x-smithers-session-tag` set to its recorded tag. It must retain the queued
write through inconclusive rereads and resume through the durable outbox after
verified activation; it must never convert stale into `Outbox.Refused`. Only the
session-end model's confirmed end or verified person change may authorize deletion.
A missing row, expired or revoked row, or unconfigured signing key reads as signed
out, which alone is inconclusive. A tag-bearing request also returns `prior`. The stale diagnostic ignores row-key equality, including an unknown new
stamp, and returns only SQL liveness. Stale never renews the row or returns a
person, role, expiry or tag.

Signing key operations run through the durable operator flows, outside the app's
public flow host. With an explicit `DATABASE_URL` and `SESSION_SECRETS`, run
`node --import=vibelang/register ops/auth/session-keys.ts stage <id>`, deploy the key map to every Worker,
then `node --import=vibelang/register ops/auth/session-keys.ts promote <id>`. Promotion commits before the
separate cessation step records `clock_timestamp()`. Retrying the same operation
and id resumes its active or completed durable run in `smithers_auth_ops`. After a
terminal failure, reinvocation uses the SDK's `Flow.retryFrom` at the recorded
failed step, with a stable next-attempt ID; earlier completed steps replay from
history. The failed receipt remains unchanged. Each invocation admits one
attempt, and the engine owns its retries and waits. Concurrent invocations join
the same attempt. An emergency replacement must match the recorded intent before
a retry can start. Seal resets use a new run id for each confirmed invocation. Key ids are never reused.
After database time passes cessation plus 401 days, `retire <id>` labels the old
key retired and a subsequent deployment may omit it.

Each configured key needs a durable row with a fingerprint equal to
HMAC-SHA-256(secret, `"smithers session key check v1"`). Staging writes it on
insert. The first publication pins the sole legacy issuer's NULL fingerprint
from this deployment's secret, including with live or ended rows, and logs
`pin_legacy` after commit without secret material. The exact `0108` to `0116`
upgrade needs no operator bootstrap. A wrong initial secret signs people out
as before; it does not block publication. Later mismatches and other NULL key
references refuse publication.

For emergency drop, first stage replacement J and configure it on every Worker.
Then run `node --import=vibelang/register ops/auth/session-keys.ts emergency-drop K J`.
The durable command validates J, promotes it if K issues, records cessation
only after commit, and retries its final step until database time strictly
passes `ceased_at + 30 seconds`. It atomically ends all K-stamped home and alias
rows and marks K compromised. It never deploys. Deploy without K afterward;
the gate's exception requires a compromised label and zero raw live K-stamped
home or alias rows, including aliases under re-keyed parents.

Every production publication depends on a fresh Alchemy gate after migrations.
After initializing the first pins, it rejects a missing or mismatched seal fingerprint, a configured key with no row or a NULL or mismatched signing fingerprint,
a missing issuer, and an omitted key with NULL or recent `ceased_at`, including
a row already labelled retired, except the fenced compromised-key case above. Only database time decides. A missing
cessation receipt therefore blocks removal after a crash rather than permitting
it. Short-lived proofs also select the durable issuer, so a ceased key issues no
new state cookie, hand-off or run credential.

## Postgres

Migration `0005_sign_in`. None of these tables is synced to browsers.

| Table | Columns | |
|---|---|---|
| `people` | `id` (uuid), `github_id` (unique), `github_login`, `created_at`, `updated_at` | a person, keyed by GitHub's numeric id; the login follows renames |
| `sign_in_attempts` | `state_digest` (key), `verifier` (sealed), `redirect_uri`, `return_to`, `expires_at` | sign-ins in progress; expired rows are deleted when the next one starts |
| `sign_in_handoffs` | `code_digest` (key), `session_id`, `host`, `nonce_digest`, `return_to`, `expires_at` | codes `APP_DOMAIN` handed to an alias, 60 s, deleted as read (migration `0074_host_sessions`) |
| `host_sessions` | `id`, `token_digest` (unique), `parent_id` (the home session), `host`, `created_at`, `started_at`, `cookie_key`, `session_tag` (unique random), `revoked_at` | one per alias sign-in; live while it and its home session are (migration `0074_host_sessions`) |
| `sessions` | `id`, `token_digest` (unique), `person_id`, `role`, `role_checked_at`, `role_verified_at` (when GitHub last confirmed the role; a failed check never moves it, null until one confirms it, migration `0093_session_role_verified`; what a socket's lease trusts, [socket leases](../observability.md#socket-leases)), `github_access` and `github_refresh` (sealed), `github_access_expires_at`, `github_refresh_digest`, `created_at`, `started_at`, `cookie_key`, `session_tag` (unique random), `expires_at`, `revoked_at`, `revoked_reason` (`sign_out`, `github_refused`, `unreadable`, `expired`, `compromised`) | one per browser sign-in |

Additional private auth tables: `session_signing_keys` stores state, promotion,
cessation and fingerprint; `session_seal_key` pins the single encryption key;
`github_token_cleanups` owns sealed cleanup pairs;
`session_end_receipts` holds anonymous status until its 400-day retention;
`person_role_receipts` preserves the newest authority through session erasure.
None is synced to browsers.

## Configuration

| Variable | Default | |
|---|---|---|
| `GITHUB_APP_CLIENT_ID` | none | the Smithers GitHub App's client id; without it sign-in is off |
| `GITHUB_APP_CLIENT_SECRET` | none | its client secret; without it sign-in is off |
| `SESSION_SECRET` | generated by Alchemy | compatibility signing key `legacy` and sealing fallback |
| `SESSION_SECRETS` | map containing `legacy` | JSON key id to secret map; duplicate values or secrets shorter than 32 characters turn sign-in off |
| `SESSION_SEAL_SECRET` | `SESSION_SECRET` | pinned encryption secret; not rotated with signing keys |
| `GITHUB_REPOSITORY` | `smithersai/smithers` | `owner/name`: the repository roles are read on |
| `SESSION_MAX_AGE_DAYS` | `30` | a positive integer |
| `ROLE_RECHECK_MINUTES` | `60` | a positive integer |
| `APP_DOMAIN`, `APP_ALIASES` | none | where sign-in hands sessions from ([Other hosts](#other-hosts), [infrastructure.md](../infrastructure.md#domain)) |
| `GITHUB_APP_SLUG` | `smithers` | the App's name in its URL: where Install goes ([repo.md](repo.md#configuration)) |

ChatApi and the `FlowExecution` Durable Object read them with Effect `Config`. Set the App's two in the deploying environment; Alchemy binds them to the Worker as secrets ([infrastructure.md](../infrastructure.md#credentials)). ChatApi reads every one of them whether or not sign-in is configured: a plan never sees `SESSION_SECRET`, which the stack binds itself, so a setting read only once sign-in is on was never bound (`APP_DOMAIN` and `APP_ALIASES` until 2026-10-31).

**Callback URLs.** A deployment with `APP_DOMAIN` needs one: `https://<APP_DOMAIN>/api/auth/callback`, for every alias and custom domain too ([Other hosts](#other-hosts)). Otherwise the GitHub App must list `<origin>/api/auth/callback` for every origin people sign in from: `http://localhost:1337/api/auth/callback` for `pnpm dev`, and the deployed site's `url` plus `/api/auth/callback`. GitHub refuses any other redirect URI (`redirect_uri_mismatch`, logged as `exchange_misconfigured`). On a loopback host GitHub ignores the port: with only `http://localhost:1337/api/auth/callback` listed, it takes `http://localhost:1338/api/auth/callback` and `http://127.0.0.1:1338/api/auth/callback`, and refuses `http://localhost:1337/other` (checked 2026-10-20). So a second `alchemy dev`, which takes the next free port, signs in for real too. The dev server's HTTPS and HTTP/2 URL, `https://localhost:1443` ([infrastructure.md](../infrastructure.md#https-and-http2)), is another scheme: list `https://localhost:1443/api/auth/callback` too to sign in for real there.

## Local development

Under `alchemy dev`, `worker/DevChatApi.ts` runs the same program. With `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` in the environment, sign-in is real; without them, a local developer is signed in as an Admin, so the browser's agent can call the model endpoint on a laptop.

The local developer can sign out, so the end-to-end suite tests a signed-out page against `alchemy dev`. Sign out (`POST /api/auth/sign-out`, same-origin check kept) sets the dev signed-out cookie, `smithers_dev_signed_out`, and every request carrying it is signed out; `GET /api/auth/session` says `{ signedIn: false, available: true, hostedModel }`, so "Sign in with GitHub" shows. Pressing it (`GET /api/auth/sign-in?return=<path>`) clears the cookie and answers `303` to the return path, never reaching GitHub. A deploy has no fallback, and none of this applies.

Local development has more people than its developer, by the dev person cookie, `smithers_dev_person`: `teammate` (a Member), `guest` (a Guest) and `maintainer` (a Maintainer), and `newcomer-<1 to 32 lowercase letters and digits>`, a Member whose id and login are that value, nobody before, so the [first run](first-run.md)'s end-to-end test is a brand-new person on every run (`worker/DevChatApi.ts` `newcomer`). A run credential minted for one verifies as them.

## The browser

`src/features/auth/` follows [state.md](../state.md):

| File | What it is |
|---|---|
| `contract.ts` | the routes, `SessionState`, `signInHref` and the sign-in copy, shared with ChatApi; `mayAsk` and `composerAccess`, which decide what stands where the composer goes |
| `schema.ts` | `SessionState` as it arrives, the tab's `Session` row, and the device's `Confirmed` row |
| `api.ts` | `AuthClient`: `session` (`GET /api/auth/session`) and `signOut` (`POST /api/auth/sign-out`), each under one deadline, failing with `AuthUnreachable` |
| `store.ts` | `AuthStore`: one local row, `loading` until ChatApi answers, then `signed_in`, `signed_out` or `unreachable`; and `auth-confirmed`, the last session ChatApi confirmed, kept on the device (`Persistence`) |
| `actions.ts` | `load` (keeps or forgets the confirmed session, and answers how the check ended), `check` (one session check at a time, counted by what started it), `refresh` (starts `auth/refresh` after a failed check), `pressSignIn` (counted) and `signOut` (`signingOut` at once, once at a time; after a `204`, forgets the confirmed session and wipes the device, counted) |
| `flows.ts`, `steps.ts`, `tab.ts` | `auth/refresh`: the durable flow that asks again after a failed check, its step in the engine worker, and the tab's answer ([when ChatApi can't say](#when-chatapi-cant-say)) |
| `device.ts` | `DeviceWipe`: the host's `wipe` as a service, failing with `WipeFailed` |
| `auth.ts` | `Auth`: the `session` and `confirmed` queries and the plain actions; reads the device's confirmed session and asks who is signed in as the app opens |
| `components/` | `AuthProvider`/`useAuth`, `SignInButton` (a link returning to this page; hidden where sign-in is off), `Account` (the login and Sign out, or the button with "Couldn't sign in." after `?sign_in=failed`; `signIn={false}` leaves the button to a page that offers it itself, `/app`'s [first run](first-run.md)), `ComposerGate` (what `composerAccess` says: the composer, "Members can ask Smithers.", or "Sign in to ask Smithers." and the button) |

**The composer is for Members and above of the conversation's repository** (decision 0007 §2, `repo:ask`; ruling AUTH-8). On `/app`, the deployment's own repository's home conversation, `composerAccess` shows the composer when ChatApi says the person is Admin, Maintainer or Member, and "Members can ask Smithers." for a signed-in Guest or a person with no role, whom the [first run](first-run.md) sends to a repository of their own instead. On a branch's page the branch's access decides (`member`): writing the branch means a Member or above on its repository. While ChatApi hasn't answered, or can't be reached, the session it last confirmed on this device decides, so a Member who reloads offline still asks; with none, nothing shows while it hasn't answered, and the sign-in prompt shows once it can't be reached. The prompt shows only when ChatApi says signed out, or the device never had a session.

When ChatApi says `roleConfirmed: false`, the tab retains that flag: a null or Guest role keeps the composer pending instead of claiming membership was denied; an observed Member or above may still ask, subject to server authorization. A later confirmed session clears the pending flag.

**Signed out, nothing leaves the browser.** `ComposerGate` replaces the composer, so a signed-out person has nowhere to type an ask, and the model endpoint refuses a signed-out call with `401` either way. A question already in the outbox that ChatApi refuses with `401` (signed out since) or `403` (not a Member on the conversation's repository) stays on the device as Not sent (`refused`), with Edit and Discard, and is never sent again.

`appLayer` (`src/boot.ts`) builds `Auth` over `AuthStore`, the device's `Persistence` and `DeviceWipe.layer(host.wipe, host.finishSignOut)`, with `AuthClient` among the browser's services (`realServices`); `boot` renders it, and main.tsx gives it to React through `AuthProvider`. The app's header shows `Account`, and `ComposerGate` wraps the composer (`src/screens/app/AppShell.tsx`). On `/app`, until the person has had a conversation, the [first run](first-run.md)'s steps stand in the gate's place before Ask, and its Sign in step is the page's one sign-in action.

### When ChatApi can't say

A device that never confirmed a session shows "Sign in to ask Smithers." while ChatApi can't say who is signed in (`composerAccess`). It recovers by itself once ChatApi answers, with no click, no `online` event and no reload:

```
check (startup, online or manual retry) ── unreachable ──▶ refresh: dispatch auth/refresh { } (door sync), once per run of failures
                                                │
engine worker: auth/refresh/check ── asks the tab that started it, on <name>/auth-session ──▶ tab: check("retry")
      ▲                                                                                        │
      └── SessionUnreachable: the engine tries again, 1 s doubling to 30 s, no give-up ◀── unreachable
          signed_in or signed_out: the run ends; the tab already shows what ChatApi said
```

- `auth/refresh` is a durable client flow (`src/features/auth/flows.ts`). Its one step asks the tab that started the run (`src/flows/askingTab.ts`) to check its session as it does when it opens; the tab answers how the check ended. The step fails `SessionUnreachable` while ChatApi can't say, and the engine's retry policy (`REFRESH_RETRY`) asks again. The app writes no retry loop.
- A tab starts one refresh per run of failures: a check that fails while its refresh runs starts no second one (`AuthStore.refreshing`). Checks run one at a time on a tab (`AuthStore.checking`), including the person's Try again action. A manual retry waits for a startup, `online`, durable refresh or earlier manual retry already asking, so an older response cannot replace newer authorization in the live or saved session. Manual retries use `check("retry")` and the same refresh records.
- A tab that closes answers nothing; after 60 s (`ASK_SESSION_WITHIN`) the step settles the run `gone`.
- A new device whose first check failed opened as a visitor's (`@visitor`): the answer that names the person adopts it in place ([adopting in place](#the-devices-owner)), so the composer shows with no click and no reload.
- Records: the tab logs `auth.refresh` (`stage: started`) and dispatch's `flow.dispatch` line; each check it runs is `auth.session_refresh` and `smithers_auth_session_refreshes` with `via: retry`; the engine worker records `auth.refresh.check` (span and log line, `outcome`, `executionId`, `durationMs`). None carries a login.

## Not built yet

- Signing out wipes the outbox without draining it or saying how many asks it discards (decision 0008 §4.6); signing in doesn't upload a signed-out person's local asks.
- An unreadable wipe marker selects the unwiped host. Directory lookup failures preserve the marker; only `NotFoundError` proves the engine directory absent. Reload still happens if stopping the program throws synchronously.
- The boot-time half of the wipe runs before the program starts, so a finished wipe isn't logged or counted. A failed one shows as the program's `persistence unavailable` and `browser.engine.unavailable` (`error.type` `WipeUnfinished`) records and the `smithers-wipe` mark staying in localStorage.
- The `github_app_authorization` revocation webhook isn't handled; a role check ends the session within the hour instead.
- Per-repository roles cover issue writes, triage, commitments, merging, the issues' shapes and the webhook, the stack, a repository's home, branches and TODO runs, and the buttons that act on them (decision 0079, `worker/github/RepoRoles.ts`). Secrets and custom domains still serve the deployment's repository only. Roles Smithers sets itself (`repository_roles`, 0007 phase 2), the device flow for the TUI and CLI, grants and the visitor cookie are later phases of 0007 and 0008.

## Tests

Run with the compose Postgres up (`pnpm db:up`). GitHub is the second scripted seam beside the model (`worker/test/github.ts`): it keeps GitHub's rules (a code bound to its challenge and redirect URI, redeemed once; refresh tokens redeemed once), and a test injects a refusal, an outage or a defect per step.

| Test | Proves |
|---|---|
| `worker/SignIn.handoff.test.ts` | an alias signing in through `APP_DOMAIN` with no GitHub call, and signed out everywhere through the one callback; a verified custom domain; no `APP_DOMAIN`; and every attack: a forged, tampered, expired or foreign-host request, a return to another site, another site's link, a replayed, expired or other host's code, a missing, mismatched or forged nonce, a cross-site form, a code in the query string, the fragment and `no-referrer`, the page's CSP hash, no code, nonce or session in any record; a fresh token at every sign-in; signing out at the alias and at home; the role check and credentials of an alias session; Postgres failing at each step |
| `e2e/alias-sign-in.spec.ts` | against a deployment with an alias (`aliasSignIn`, `E2E_ALIAS_URL`): pressing Sign in at the alias comes back signed in through `APP_DOMAIN` without GitHub, no request URL or Referer carries the code, and signing out there leaves the home session |
| `worker/ChatApi.bindings.test.ts` | Alchemy's plan of ChatApi, offline, binds `APP_DOMAIN`, `APP_ALIASES`, `GITHUB_APP_SLUG` and every other setting [infrastructure.md](../infrastructure.md#credentials) lists for it, and the same ones whether or not the plan's Config sees `SESSION_SECRET` and `SECRETS_KEY` |
| `worker/SignIn.test.ts` | a sign-out whose flow's start the host refuses (a fault-injected `FlowStarter`) is `503` and keeps the session, and signing out again starts it; a session signed out whose tokens nothing revoked is revoked by signing out again; signing in again whose sign-out can't start fails before GitHub and keeps the old session; the redirect, state and S256 challenge; cookie flags on http and https; return paths; the full sign-in; state mismatch four ways; a replayed callback reaching GitHub once; a code GitHub already redeemed; expiry, denial and a missing code; GitHub failing at each step; a verifier that no longer opens; signing in again; Postgres failing at each route; role mapping for all four roles and none; a stale role starting a check named after the one it replaces, the same one an hour later, and a new one once a check recorded; sign-out revocation, its sealed tokens kept and one revocation started, and the old cookie refused; cross-site sign-out refused; local development's developer signing out with the dev cookie (an ask refused `401`) and back in without GitHub; forged, unknown and expired cookies; sign-in off without the App or with a short secret; a signed-out ask refused (`401`) and a signed-in one answered; no token in any record |
| `worker/flows/RecheckRole.test.ts` | the flow on the Node host; a retried GitHub failure; refreshing an expiring token and using the new one; an expired refresh token ending the session; a refresh rotated, or stored, while the step waited on GitHub; requests an hour apart while a check is paused after GitHub redeemed its refresh token start that one check, one engine per execution as on Cloudflare, and the session keeps its replacement; a replacement Postgres refused to store, then the engine dying and a new one resuming the run, redeems once and leaves the session live with the replacement; a redemption whose answer was lost ends the session; a check that fails every attempt keeping the role; tokens GitHub no longer accepts; unopenable tokens; no token or login in its records |
| `worker/flows/RevokeGitHubToken.test.ts` | sign-out, and signing in again, starting the flow with the sealed tokens kept, and again only while the tokens wait; the flow ending a session still live before it revokes; the flow on the Node host revoking the token on GitHub and forgetting it; a token GitHub no longer has; GitHub down once and retried; every attempt failing and the tokens forgotten anyway; GitHub or Postgres failing each step by reason; an unopenable token forgotten without GitHub; a live session, no session and a session GitHub refused left alone; no token or login in its records |
| `worker/ExecutionHost.test.ts` | the deployed remote host runs `auth/RecheckRole` and `auth/RevokeGitHubToken` over the app's tables |
| `worker/GitHubAuth.test.ts` | the real adapter against a scripted GitHub on loopback HTTP, GitHub's `200 OK` OAuth errors included; revoking a token as the App (`204` and `404` revoked; `401` and `403` misconfigured; `422`, `429` and `502` unavailable) |
| `worker/GitHubAuth.live.test.ts` | the real GitHub: the App's credentials, a callback URL, and a real user token's person and role; each case skips naming the variables it needs |
| `src/wipe.test.ts` | reopening every page without a wipe; a sealed page's memory stores and unavailable engine; the browser's wipe on Node's Web Locks and BroadcastChannel, with stand-ins for OPFS and IndexedDB: a page still holding the data holds the wipe off, and the wipe then deletes both stores and clears the mark; it waits for the leading engine worker's lock; two pages booting at once delete once; a delete another connection holds off finishes when it closes; a failed delete keeps the mark and opens unwiped; every page, the signing-out one included, stops its program and loads again once; an unwiped page's stores are memory and its engine is unavailable with `WipeUnfinished` |
| `e2e/sign-in.spec.ts` | in a real browser: a tab sealed while its owner was signed out reopens with their draft once a reconnect's session check finds them; another person signing in on the browser sees neither the device's draft nor its queued question, which isn't sent as them and stays on the device, and both are back, the question sent once, when its owner signs in again; signing out wipes the device (the unsent question gone, the outbox empty, the shape from offset -1); with two tabs, a tab slow to unload holds the other's wipe off, then both open as visitors with nothing of the session, the mark cleared; a new device opened while every session read answers 503 (`?faults=session-503`, the engine worker's too) shows the sign-in prompt, then, once ChatApi answers, the composer on the same page within 35 s, the device its person's, and asking taken (`202`); an evicted device whose outbox kept the earlier owner's queued question, taken in place by the next person to sign in, who never sees or sends it, and whose own ask is taken |
| `worker/RunCredentials.test.ts` | who a credential says acts: an agent's chain, a flow's, nested calls growing the chain, keeping the root and staying the agent's; no credential for a person-only flow; a wider callee refused, a narrower one intersected; a chain stopped at its depth; property tests that every hop narrows and no chain acts as the person or for anyone else; forged, tampered, another purpose's, expired and ended credentials reading as nobody, never as the cookie beside them; a request from another person's or a visitor's device data reading as nobody under a cookie or a credential, counted without either person; through ChatApi: the agent's `run/answer` refused, nested and with its own credential, and the person's press taking it; a plugin's wider callee refused; another person's run, another run, forged and expired credentials refused; replayed after sign-out, refused; without sign-in configured, a credential outliving a reload under `SESSION_SECRET`, and not without it |
| `worker/PersonOnly.test.ts` | every person-only flow with a route and every protected act, keyed by the list itself: an agent's, a flow's and a frame's request refused `403` and counted |
| `src/flows/credentials.test.ts` | on the Node engine against ChatApi's routes: the agent's run sends its credential and no cookie, and its nested `run/answer` is refused before anything is sent; the person's press goes in their session, a root person-only press from a busy or reloaded tab still goes in the session and logs `door_timeout`, while a tab answering with another door is refused; one credential however many requests; a declared ceiling sent; signed out, no credential and no cookie; from a tab whose sign-in row says signed out, no credential request at all, the person's press still in the session; a mint unreachable or not a credential, and a lineage unreadable, send nothing; a run with no recorded parent nested in the run it is named after; a credential the server no longer reads asked for again once; a run's credential for the tab's outbox |
| `src/device/identity.test.ts` | the owner check on the deployed builds' device stores (7b96f878 and production's c6940ac5), built by TanStack DB from their fixtures: the confirmed person opens it with every row kept (the regression that wiped it); a confirmed stable id matched by id, any case; another login, or no confirmed login, leaves it sealed and whole; offline or signed out it waits; a new device, a visitor's device adopted at sign-in, the owner's data offline, signed out and under another person; after the wipe the next person owns a new device; an interrupted registration; a missing stable person, an unknown record version and a broken store refused and counted by stage; every outcome counted, no login or person logged; each tab's decision, its session check, receipts, bound requests and reopening once, and the activation's deadline; a person's session on the visitor's data adopted in place (not now failing as unsent, requests meanwhile waiting and then carrying the person), and a refused adoption or someone else's data reopening |
| `src/features/auth/auth.test.ts` | the tab on a Node device: signed out, signed in through GitHub, signing out, sign-in off, ChatApi unreachable, refused or silent; `composerAccess` for every status and role; a Member reloading offline or before ChatApi answers still asking; a Guest or no role seeing the line; ChatApi saying signed out retaining device ownership while the online tab gates asks; a sign-out ChatApi takes leaving no stored rows and an empty outbox, a failed one leaving both; a wipe the host couldn't do counted; no login in its log lines; a failed first check recovering through `auth/refresh` on a Node engine once ChatApi answers, with no event or click, and one refresh per run of failures; manual retries waiting for held startup, online and manual checks, keeping the newer role live and after reopening the device |
| `src/features/auth/steps.test.ts` | `auth/refresh` on the Node host: the tab's `signed_in` or `signed_out` settling the run; `unreachable` asked again 1 s and then 2 s later; a tab that is gone settling it `gone` |

The browser half of signing in, pressing Approve on GitHub, belongs to the end-to-end suite with the `codeplanesmithers` test account (decision 0008, E2).

### Verified live (2026-10-20)

Against the Smithers GitHub App Will set up (`smitherspreviewrelease`), on a second `alchemy dev` (stage `live_williamcory`, port 1338, its own database and Electric, `GITHUB_REPOSITORY=roninjin10/smithers-github-tests`), so the shared :1337 kept its local developer:

| What | Result |
|---|---|
| `worker/GitHubAuth.live.test.ts`, every case | 3 of 3 pass on `smithersai/smithers` and on `roninjin10/smithers-github-tests`: the App's client is known, `http://localhost:1337/api/auth/callback` is a callback, and a real `ghu_` token reads its person and role |
| A real sign-in in a browser | `codeplanesmithers`, from a saved browser profile, pressed "Sign in with GitHub": GitHub returned to `/app` signed in, `GET /api/auth/session` said `{ signedIn: true, login: "codeplanesmithers", role: "guest" }` (read on a public repository), and the session cookie was `smithers_session`, HttpOnly, SameSite=Lax. GIF: `~/Desktop/smithers-mvp/gifs/sign-in-github-live.gif` |
| Signing that session out | `POST /api/auth/sign-out` answered `204`; `auth/RevokeGitHubToken` revoked the token on GitHub (`auth.revoke_token` `revoked`) and forgot both tokens; the cookie then reads signed out |

A driver outside the suite does the browser half, since GitHub's own pages are not the app's to test; it hands the session cookie to `e2e/issues.spec.ts` as `E2E_SESSION_COOKIE`.

Queued agent issue writes renew their original signed run proof at delivery through `POST /api/runs/<run>/credential {flow, renew}`. Renewal verifies the old signature and the still-live original session and requires the same current person, session and run. Only expiry changes: attribution, run, root, chain and ceiling are copied exactly. A forged/revoked proof, another session/person/run or an acting caller is refused. The write itself uses the renewed bearer without cookies. Outbox payload version 3 migrates version 2 by retaining its signed proof and write id; replay remains the same idempotent operation. A refusal never falls back to the person's cookie, and transient renewal failures use the outbox's existing retry policy.

Reconnection diagnostics record `auth.session_subscription` (`listening`/`stopped`), `auth.session_refresh` (`via: startup`/`online`/`retry`) and `smithers_auth_session_refreshes`. These distinguish browser event delivery, subscription lifetime and the next session check without recording identities or content.

The scoped auth lifecycle owns the initial session read: it subscribes to network events first, queues one startup check, and consumes startup and online checks serially; a check that fails starts `auth/refresh` ([when ChatApi can't say](#when-chatapi-cant-say)). Boot waits only for registration before rendering, never for HTTP. A network transition before subscription is covered by that initial read, without a duplicate request during layer construction.

A newly dispatched run uses anonymous reads until this tab confirms sign-in. Loading and unreachable session states do not request a session credential; signed-out visitors never POST a credential merely by opening a repository.

Personal settings, repository settings and secrets offer signed-out visitors a sign-in link returning to that page. Signed-in people without permission retain the access explanation.

A repository that is absent or unavailable also offers visitors sign-in, without claiming that a private repository exists. An upstream outage remains an outage.

The machine boundary includes attaching existing terminals, branch Publish/Update/Resync, and steering a running TODO. Each requires deployment membership in addition to the repository permission; watching a TODO run still uses that repository's role.

For POST, PUT, PATCH and DELETE, ChatApi buffers the complete body before any handler resolves authority.
The read has one 10-second deadline and an 8-MiB aggregate cap; handlers keep their smaller limits.
A timed-out body returns `408 body_timeout`, a broken body `400 invalid`, and an oversized body `413 too_large`.
`write.admission` traces the boundary; `smithers_write_bodies` counts buffering outcomes and `write.body` logs refusals
by status alone. Neither records content or credentials. Bodyless writes are already at EOF. Reads add no database query.

A session read waits at most one second for the role-check start acknowledgment. A timeout cancels that wait, records `auth.role_check` with `start_timeout` and counts it, then returns the live session. A later request can start the same idempotent execution.

`POST /api/auth/handoff` is bounded to 4 KiB during body admission, matching the handler, including requests with a query string. Oversize declared or streamed bodies return 413 before authority resolution.

Active cookie and bearer sessions admit the existing durable role recheck five minutes before the 60-minute authority deadline (half the window when configured shorter). Admission and expiry use the database clock. Cookie and bearer admission subtract monotonic elapsed time after role recovery, including a held role-check start, so a fresh role cannot admit a request past its sliding or absolute session deadline. Ended bearer proofs retain the `smithers_run_credentials{op="verify",outcome="ended"}` count and model-endpoint refusal, before budget reservation or provider dispatch. A failed read never renews the receipt; past its deadline protected reads remain retryable.

A signed-in answer with `roleConfirmed:false` keeps identity visible and starts or continues the existing durable `auth/refresh` flow. The transient check outcome is `unconfirmed`; the displayed session stays signed in. Both startup/connectivity checks and an explicit reload admit recovery. Repeated unconfirmed answers retry under the existing durable policy until authority is confirmed or the tab is gone, without another reload or online event.

The execution host serializes immediate renewal drives and scheduled alarms within an object incarnation. A concurrent caller waits for the active drive and reuses its durable result; it never takes over its healthy permission request or rotating-token redemption. The host regression holds each network step open while a second drive races it.

The deployment repository's fresh session role also authorizes its conversations
and feed when no App installation row has been recorded. A GitHub metadata hiccup
does not demote a Member. Elsewhere, the uninstalled public-copy fallback needs a
successful public metadata answer. A metadata 404 denies public readability, the same
for an absent repository and a private one, and the denial is kept for 60 seconds
([decision 0162](../decisions/0162-repository-refusal-classification.md)); a 5xx,
timeout or rate limit stays a retryable `503 unavailable`. Confirmed private
visibility, revoked sessions and confirmed role loss still deny. See
[decision 0156](../decisions/0156-deployment-authority-without-installation-row.md).


### Pending sign-out across tabs

Before sending sign-out, the page holds the exclusive `smithers-sign-out` Web Lock. Reopen senders take a compatible shared guard before broadcasting. Receivers retain the request while sign-out holds its exclusive guard, so a broadcast delivered late cannot disappear. A failed sign-out releases queued reopens; a successful one proceeds to its wipe. Cancelled or rejected reopen decisions release the transport latch, including requests already waiting for the decision. A successful response retains the hold through the whole sign-out action. Its finalizer releases the guard even when changing local session state, reading or deleting the confirmed session, or saving that deletion fails. Once the server ends the session, wipe marking or safe sealing runs regardless of those failures. A failed request waits for release before returning. Closing or crashing the owning page releases the browser-owned lock, so it cannot strand later reopens. The existing wipe still stops every page and deletes both stores on the next boot.

Held-write sign-in status comes from owned persisted outbox rows, with payload-free invalidations between tabs. Followers and an offline reload show it before another send. A different person's held rows remain sealed. Run-credential writes retain their existing exclusion from session reauthentication.

Wipe marking and broadcasting finish inside the sign-out guard's lifecycle. If either fails after a successful sign-out, the page stops its program once, seals itself against reopening the stores, and releases the guard before reporting failure. The page shows “Wipe failed” and Retry outside the stopped app runtime; successful marking broadcasts the normal wipe. The whole action releases the guard in its finalizer, after wipe marking or safe sealing, rather than relying on reaching the wipe call. Lifecycle records report `sign_out_failed` and `sign_out_released`, without session data. A sealed page ignores delayed identity reopens until a wipe can be marked.


### Browser capability failure

Without Web Locks, startup renders “This browser needs Web Locks” before opening the device store, outbox or engine. It closes the wipe channel and reports `browser.unsupported` with capability `web_locks`. It starts no memory-only substitute.

### Stale credentials on queued writes

The bound transport advertises `x-smithers-accepts: credential-stale` on every
same-origin `/api/` request, including its session rereads, so the server can
return the stale-credential answer to clients that handle it. It adds no such
header to other origins or paths.

A cookie-authenticated response of `503` with `x-smithers-credential: stale`
never reaches a feature's status handler. The bound transport fails it as
`DeviceIdentityRefused({ reason: "credential_stale" })`, so the durable outbox
retains the write and owns its retry schedule. Other statuses retain their
existing behavior.

Before another write is sent, the transport enforces `Retry-After` (seconds or
an HTTP date) and rereads `GET /api/auth/session`, with
`x-smithers-session-tag` when the device recorded one. An inconclusive reread
keeps the write queued; a reread naming the bound person releases it. A signed-out
or different-person answer follows the existing reopen paths. Session reads and
explicit sign-out remain available while writes wait. The reread shares the
write's cancellation signal. No write is replayed inside the transport.

The versioned bootstrap owner record gains a nullable `session_tag` column.
A verified activation records the server's optional 32-character hexadecimal
`session` tag, and its receipt supplies that tag to page and worker transports.
Offline activation retains it; another person's answer cannot replace it. The
existing device wipe deletes it with the owner record. It grants no authority
and never appears in logs, traces, metrics or URLs. This adds no collection or
outbox payload schema and changes no outbox library or dependency patch.

Queued chat questions use the same never-drop 401 hold and sign-in prompt as other
session writes. A follower retains a hold discovered outside the index until the
stored row actually settles. Reopen suppression records only accepted reloads
and retains the suppressed request at its eligibility boundary.

Stale-credential deadlines and verification requirements are stored by owner in
the device outbox, shared by page and worker transports and removed by sign-out's
wipe. A successor honors the deadline and verifies that owner before sending.
Memory-only pages verify the current signed-in person for transient writes without
opening retained data. No session tag grants authority. Failed publication keeps
a local hold until the transport can persist it. AuthClient reports
`credential_stale` distinctly from network failure, so the data gate hides private
rows until a session answer verifies the person again.
The refusal reaches AuthClient before publication completes, including when the
credential lock or storage stalls beyond the session request's deadline.


A wipe-marker failure seals the page immediately. Its sign-out finalizer returns
before runtime shutdown waits for that fiber; the data lock stays held until
shutdown finishes, then the sealed page offers Retry. Internal session rereads
persist stale-credential Retry-After deadlines through the same serialized path
as ordinary responses, including confirmation after 401 and expired-gate checks.

Rejected session cookies are counted by `smithers_auth_session` with
`outcome: cookie_rejected`. A present cookie that fails signature verification
or the live-row lookup increments it; an absent cookie and a database failure
do not. A stale credential is also a rejection and retains its separate stale
diagnostic. Cookies and tokens never enter these records.

The `cookie_rejected` alert is inert without a metrics exporter and counts as
neither alerting nor a safety control.

Socket hosts revalidate once at a cached session end. While the check is pending,
frames past that end are refused. A fresh live lease advances the kept admission,
even when its database expiry is unchanged: an earlier slow lookup can have
underestimated the remaining lifetime. An ended session closes. A capped lease makes no extra checks in
its last seconds. Terminal frames read the current admission after renewal.


## Re-authentication before the absolute deadline

The callback verifies any configured signing key, then authenticates the GitHub
person before locking the held session. The row qualifies only for that person,
while unrevoked and live more than 30 seconds beyond the eligibility check under
both its sliding expiry and absolute deadline. The update reads the durable
issuer in the same statement that resets `started_at`, writes the new tokens
and increments `github_token_gen`. The id, token and opaque tag stay the same.
An ineligible callback creates a new row and revokes the held one in the same
transaction. Failed exchange or eligibility transactions never end the held row.

The replaced sealed pair is committed to `github_token_cleanups` before launching
`auth/RevokeReplacedGitHubToken` as `cleanup:<id>`. Cleanup has no session-ending
step and never reads or writes sessions. A failed launch leaves the durable row
for `auth/MaintainSessions`. Before authentication work, ChatApi records its
singleton durable intent; unavailable admission returns retryable 503 before
the callback can commit. Each round runs the existing sweep, sleeps durably for
five minutes, and hands off through the same host alarm pattern as `chat/Expire`.
No subsequent request is needed, including after a failed cleanup admission.
The sweep starts unfinished rows older than five minutes. Successful cleanup
clears both sealed columns and sets `finished_at`, retaining the unique access
`pair_digest`. The sweeper deletes finished tombstones after 30 days; a replay
past retention may enqueue again, and GitHub’s 404 is success; its 422 validation/spam response retries.

Reauthentication preserves a newer role observation and its verification time.
A delayed callback cannot extend the newer receipt's authorization deadline.

`RecheckRole` journals the observed generation with a redemption. Every token,
conditional-revocation and role write requires that generation. Overlapping
stores classify after `SELECT ... FOR UPDATE` in a separate statement, so an
installed replay never queues the currently installed token. Older journal
entries decode as generation zero and recover their pair digest from the pinned
seal; an already installed legacy ciphertext counts as an installed replay.

At an alias, `reauth=1` is carried to the hand-off. A home session within seven
days of its deadline goes through GitHub first. Arrival validates the nonce,
locks the parent and held alias, and applies the same 30-second eligibility
margin, configured-key verification, host and parent binding. An eligible alias
keeps its row and token; an ineligible one is revoked and replaced.

Tests: `worker/Reauthentication.test.ts`, `worker/SignIn.handoff.test.ts`,
`worker/flows/RecheckRole.test.ts` and
`worker/flows/RevokeReplacedGitHubToken.test.ts`. The browser banner, reversible
hold, session-tag continuation and wipe behavior remain step 3.

The deployment role window is captured while the host and request services are built, and travels with their runtime authority service. Losing ambient runtime configuration cannot widen it. A credential publication that cannot persist retains its privacy fence, while another context's queued write-lock acquisition ends on cancellation or after two seconds with retryable `credential_stale`. The caller's existing durable retry policy owns the next attempt; session reads and sign-out remain available.

## Independently hosted sites

`GitHub.Auth.Broker` in `@smthrs/integrations` lets hosted sites use this deployment's existing GitHub callback.
`HostedAuthBroker` hosts `/api/auth/broker/start`, `/api/auth/broker/exchange`, and only the broker's exact callback
state format; ordinary sign-in, alias handoff and sessions keep their existing handlers. Every operation is an
`auth/Broker` step in the object's SQLite journal; only its operation name and null result are journaled.

Configure `HOSTED_AUTH_SITES` as redacted JSON entries `{origin, secret}` for the exact HTTPS origins this deployment
serves, with distinct keys of at least 32 characters, and `AUTH_BROKER_ENCRYPTION_KEY` as a base64 32-byte key.
`AUTH_BROKER_ORIGIN` defaults to HTTPS `APP_DOMAIN` and must be the already-registered callback's origin. Existing
GitHub client credentials and `SESSION_SECRET` remain. A site has only its own registry key and its own session.
No redirect URL is added. The deployment adds the `HostedAuthBroker` class/binding through Alchemy.

A site with `grants` in `HOSTED_AUTH_SITES` can also act on GitHub for a person, through `GitHubConnection`, one Durable Object per person ([decision 0165](../decisions/0165-hosted-site-github-delegation.md)). It holds that person's one sealed token and answers signed `POST /api/auth/broker/delegation?person=<id>` calls. ChatApi's route checks the site's signature, and that the call names that person, before it addresses the object, so an unsigned call creates none and answers 403. `GITHUB_CONNECTION_KEYS` (`{ id: base64 32-byte key }`) and `GITHUB_CONNECTION_KEY_ACTIVE` seal tokens; without them the broker refuses Connect. A person disconnects a site at `/api/auth/connections`. GitHub's `github_app_authorization` webhook ends every delegation.

A site with `reads` (`[{ repository, repositoryId }]`) in `HOSTED_AUTH_SITES` reads those public repositories for its signed-out visitors through the App ([decision 0165, public reads](../decisions/0165-hosted-site-github-delegation.md#addendum-public-reads-2026-11-10-lane-vl-public-reads)). ChatApi answers signed `POST /api/auth/broker/public-read` calls before any Durable Object, with an installation token minted for that repository id alone, read-only, after GitHub confirms the repository is public and still has that id (`worker/PublicReads.vibe`). An invalid `reads` entry or no App answers 503 `unavailable`.

The chosen single-use code and signed-identity alternative, origin/PKCE checks, sixty-second expiry, fragment
handoff, logging and security review are in [VibeLang decision 0029](../../../vibelang/wiki/decisions/0029-hosted-sign-in-broker.md)
and [the integrations guide](../../../../packages/smithers/agent/integrations/README.md#hosted-site-sign-in).
The new Worker modules are VibeLang; the rule scopes include `.vibe` and exempt only their host composition roots
from the rule against Cloudflare in portable flows. This lane does not deploy the app.

The shared `httpPolicy` is registered through Alchemy `Telemetry.layer` for ChatApi and HostedAuthBroker, so the HTTP tracer redacts query values before exporting spans. Proxy/native access logs must also omit OAuth query values and callback/exchange bodies.

### GitHub's page at the callback

Each successful callback, ordinary or brokered, records whether GitHub showed the person one of its own pages
before it, and whether smithers.sh had revoked one of their tokens since their previous sign-in:
`smithers_auth_github_consent` and the span and log `auth.github.consent`
([observability](../observability.md)). It answers from production whether our revocations bring GitHub's
authorization page back ([decision 0165](../decisions/0165-hosted-site-github-delegation.md#revocation-and-the-authorization)).
A failure to read the history logs `outcome: failed` and never fails sign-in.

### Tokens from a failed callback

Ordinary successful sign-in stores its encrypted GitHub pair for later API calls. If a callback fails after the
exchange and before session issuance commits, it seals the unused pair into `github_token_cleanups` and admits
`auth/RevokeReplacedGitHubToken`. Its existing flow retries revocation and its existing durable maintenance admits
an interrupted launch. No token enters a flow payload. A failure to persist cleanup logs/counts fixed
`auth.token_cleanup`, `smithers_auth_token_cleanup { outcome: failed }`, without changing the callback response.
The hosted identity broker independently revokes its temporary pair through `auth/broker/revoke`; its success and
exhaustion counters are `smithers_auth_broker_revocations` and `smithers_auth_broker_revocation_failures`.

The hosted sign-in broker writes structured JSON logs through `@smthrs/observability` in its own Durable Object. Each `auth.broker.revoke` record keeps its `outcome` (`revoked` or `failed`) and current trace and span identifiers; it never logs tokens or identity content.
