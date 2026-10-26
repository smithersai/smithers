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
  role over an hour old ──▶ RoleChecks.start(session, role_checked_at) ──▶ auth/RecheckRole on its Durable Object (no wait)
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
| `GET /api/auth/session` | `200 { signedIn: false, available }` or `{ signedIn: true, personId, login, role }`, `personId` the person's stable id ([the device's owner](#the-devices-owner)); `503` when Postgres fails. `available` is true where the GitHub App is configured, and under `alchemy dev` |

The return path is a path on this site; anything else, including `//host` and `/\host`, returns to `/`. `?sign_in=failed` is dropped from it, so trying again doesn't come back saying it failed. Every answer is `Cache-Control: no-store`.

## Sessions and cookies

| Cookie | https | plain http (local development, mvp.md M-28) | Flags | Lifetime |
|---|---|---|---|---|
| session | `__Host-smithers_session` | `smithers_session` | HttpOnly, SameSite=Lax, Path=/, no Domain, Secure on https | `SESSION_MAX_AGE_DAYS` (30) |
| sign-in state | `__Host-smithers_sign_in` | `smithers_sign_in` | the same | 10 minutes; expired by the callback |
| dev signed-out | `__Host-smithers_dev_signed_out` | `smithers_dev_signed_out` | the same; value `1`, unsigned | 30 days; only where the GitHub App isn't configured and a fallback is signed in (`alchemy dev`) |

- A cookie is `<token>.<HMAC-SHA256>`. Postgres keeps only the token's SHA-256, so reading the database signs nobody in.
- A session ends at its age, at sign-out, when signing in again in the same browser, or when GitHub refuses its tokens. Ended sessions keep their row with `revoked_at` and `revoked_reason`. A session GitHub refused, or whose tokens no longer open, forgets its GitHub tokens at once; a signed-out one keeps them sealed until `auth/RevokeGitHubToken` revokes them on GitHub and forgets them ([Signing out](#signing-out)).
- `Sessions.resolve` reads the row on every request, so a revocation applies to the next request. Postgres unreachable is `SessionsUnavailable`: the model endpoint answers `503 provider_internal`, not a sign-in prompt.

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
- **The token** is `SessionKeys.sign("run", base64url(claims))`: HMAC-SHA256 under `SESSION_SECRET`, a purpose no cookie shares. Claims: the person, the session it was minted under, `act`, the run, its root, the chain, the ceiling and the end, 15 minutes on (`CREDENTIAL_TTL_MS`); the engine mints the next a minute before. Without sign-in configured, local development's people sign theirs with `SESSION_SECRET` when Alchemy bound one, so a credential outlives the dev server reloading ChatApi, and with a key the Worker draws when it starts otherwise. A request a credential went with that comes back `401` makes the engine ask for every credential again, once (`auth.run_credential` `outcome: stale`).
- **It ends with its session.** Verifying reads the session by id, so a credential replayed after sign-out, or for a person no longer signed in, reads as nobody (`401`). A forged, tampered or expired one reads as nobody too, never as the cookie beside it.
- **Bound to its run.** The runs report route and the answer write route take a credential only for the run its chain started from (`403 other_run`); a sandbox call names an answer only as that run.
- **Credential renewal.** Before renewing a queued write's credential, the tab reads its real sign-in store. Signed out, renewal returns `401` locally and sends nothing.
- **The tab's outbox.** A write the agent queues in the tab, an issue write, carries its run's credential, and the tab sends it with that and without the cookie; a run with no credential to send queues nothing (`no_credential`). The git writes route reads who acts (`via`) from the request alone: the body names nobody.
- **Signed out**, a run sends its requests with no credential and no cookie.
- **The Node host** (`src/test/agent.ts`) runs the same credentials; with no tab, every root run its tests start is the person's own press.

**Person-only acts.** `PERSON_ONLY_FLOWS` in `src/flows/personOnly.ts` holds every registry flow with a `userOnlyReason`, and the compiler refuses one missing or one too many; `refusesCredential` reads the same list. Each entry says how it stays the person's: its `route` refuses an `act`, only the person `starts` it there (`chat/Answer`: asking), or it reaches no server route (`device`, with why). `PROTECTED_ACTS` holds the server's own: a secret's write and merging a pull request; approving, pre-approving, members, roles and plugin grants join it with their routes. Each route calls `refusesPersonOnly(actor, act)`.

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
| `todo/commit`, `todo/drop` | `POST /api/repos/<owner>/<name>/stack` | `403 forbidden`, the route's own contract |
| `secret` | `PUT`, `DELETE /api/repos/<owner>/<name>/secrets/<name>` | `403 forbidden`, the route's own contract |

`POST /api/runs/<run>/credential` answers `200 { token, act, expiresAt }`; `400 invalid` for a body that isn't `{ flow, ceiling? }`; `401` signed out; `403 forbidden` for another person's answer (`chat/Answer`'s run is the answer's id); `403 person_only`, `capability_exceeded` or `too_deep`; `404` for a run id that isn't one; `413` past 16 KiB.

Not built yet: confirmation receipts and the host's confirm dialog for protected acts (decision 0017 slice 0); the runs a remote host starts mint their own credentials once a remote flow acts for a person; a plugin installation as a credential's subject (slice 2).

## Roles and role checks

The session's role is the person's permission on `GITHUB_REPOSITORY`, the deployment's own repository (`GET /repos/<owner>/<name>` with their token), mapped as decision 0007 §9 says, never with more power than GitHub gives. It decides nothing on any other repository: there the role is the person's GitHub permission on that one, read with the App and kept 5 minutes ([decision 0079](../decisions/0079-roles-per-repository.md), `worker/github/RepoRoles.ts`). Issue writes, the stack, a repository's home ([home](home.md#who-sees-what)), a branch's workspace ([branch workspace](branch-workspace.md)) and a TODO's run ([runs](runs.md)) use it today. `GET /api/repos/<owner>/<name>/role` answers it to the browser, `{ role, own }` with `own` true on the deployment's own repository, and every repository route asks (`router.tsx` `enterRepo`, kept per tab in the repository feature's `roles`): the header's Secrets and Settings links and each page's buttons show by it, none before it answers, and the features still fenced to the deployment's repository (secrets, custom domains, triage, merging) only where `own`.

| GitHub | Role |
|---|---|
| admin | Admin |
| maintain | Maintainer |
| write | Member |
| triage, read | Guest |
| none (a repository they can't see) | no role |

The role is read at sign-in, and again once it is an hour old (`ROLE_RECHECK_MINUTES`; mvp.md M-05). The request that finds it stale starts `auth/RecheckRole { sessionId }` on the remote flow host ([remote-flows.md](remote-flows.md)) and doesn't wait for it.

**One check of a session at a time.** The execution is named after the session and the check it replaces, the session's `role_checked_at` (`auth-recheck-<session>-<epoch ms>`). Every request that finds the same stale role, in this hour or a later one, starts the same execution, and the flow engine runs it once. Only a finished check moves `role_checked_at`, so the next check can't start until this one is over, and only one check ever redeems a session's refresh token.

The flow's steps:

1. `auth/RedeemRefresh`: when the 8-hour `ghu_` token expires within 5 minutes, trades the single-use `ghr_` refresh token once (`Core.OAuthToken.exchangeRefreshToken`) and seals the new pair for the session. Its result, sealed into the run's journal, holds only the encrypted pair and the presented token's digest, never a token in plaintext. It writes nothing.
2. `auth/StoreTokens`: stores the sealed pair over the token it presented, while the session is live. It retries from the journaled result until Postgres answers, so a Postgres failure, or the host dying, after GitHub issued the pair never redeems the spent token again (the regression from Codex review 4).
3. `auth/CheckRole`: reads the permission with the session's current token and records the role.

GitHub refusing the refresh token (expired after 6 months, or used) while the session still holds it, or the access token (the App revoked), ends the session. GitHub or Postgres failing fails `auth/RedeemRefresh` or `auth/CheckRole`, which retry 5 times from 1 second, doubling. When every attempt fails, `auth/KeepRole` keeps the role and records the check, so a request an hour later starts a new one; it retries until Postgres answers.

**The one window no journal closes.** GitHub redeems the refresh token and its answer never arrives (the connection drops, or the host dies before the step seals). Nothing holds the new pair, so the retry, or the next check, presents the spent token; GitHub refuses it, the session ends, and the person signs in again. Each redemption is one step, so this window is the length of one HTTP exchange.

## Signing out

`POST /api/auth/sign-out`, and signing in again in the same browser, sign the browser's session out through the durable flow `auth/RevokeGitHubToken { sessionId }`, on the remote flow host ([remote-flows.md](remote-flows.md)), one execution per session (`auth-revoke-<sessionId>`). The flow owns the whole sign-out: it ends the session (`revoked_reason` `sign_out`), revokes its GitHub token and forgets its tokens.

- **Admitted first.** The handler starts the flow through `Flows.FlowStarter` and waits only for the start to be recorded, never for the flow. A start the host refuses is a `503` (`auth.sign_out` `failed`, reason `not_started`, with the host's code): nothing changed, the session is still live and the cookie still set, so signing out again can finish. Before this, a refused start was logged and swallowed, the sign-out answered `204`, and nothing would ever revoke the token (Codex review 4).
- **Refused at once.** Once the start is recorded, the handler ends the session itself, so its next request is refused without waiting for the flow; the flow's own end changes nothing then. A handler that dies in between leaves the flow to end it.
- **Recoverable.** Sign-out looks for a live session, or one that ended and still holds GitHub tokens nothing revoked yet, such as one signed out before sign-out waited for its flow. Signing out again with that cookie starts its flow; once the flow forgot the tokens, there is nothing to do (`no_session`).
- **Signing in again** admits the sign-out of the session the browser held before it redeems GitHub's code: a start the host refuses fails the sign-in (`?sign_in=failed`, reason `sign_out_not_started`) with nothing redeemed and the session kept. Once the new session is written, the old one ends.

The flow's steps:

1. `auth/EndSession` ends the session, keeping its sealed GitHub tokens; one that ended already is left as it is (`over`). Only Postgres can fail it, and its retry never gives up;
2. `auth/RevokeToken` opens the ended session's sealed access token, and revokes it with GitHub as the App: `DELETE /applications/<client id>/token` with the client id and secret as HTTP Basic and `{ access_token }`. `204` is revoked; `404` and `422`, a token GitHub no longer has, count as revoked. Then it forgets the session's GitHub tokens.

A token that no longer opens (`SESSION_SECRET` changed) is forgotten without reaching GitHub (`unreadable`). A session with no tokens is left alone (`none`), and so is a live one (`live`), which the flow never meets since it ends the session first. GitHub or Postgres failing fails the revocation, which retries 5 times from 1 second, doubling; after the last attempt `auth/ForgetTokens` forgets the tokens anyway (`forgotten`), and its own retry never gives up. A session GitHub refused needs no revocation: its tokens are already dead and forgotten.

**The device.** Once ChatApi answers the sign-out `204`, never after a failed one, the tab forgets the session it last confirmed and wipes this device's synced data and outbox (decision 0008 §4.6) through `DeviceWipe`, the host's `wipe`. In the browser, every page takes part (`src/wipe.ts`, wired in `src/main.tsx`):

1. **Every page holds the data.** From before its program starts until it ends, a page holds the Web Lock `smithers-data`, shared.
2. **Every page leaves.** `wipe` sets the `smithers-wipe` mark in localStorage and tells every page on the `smithers-wipe` BroadcastChannel, its own included. Each page then drops its view, stops its program, which closes the device store and the outbox and ends its engine worker, and loads again.
3. **The next boot deletes once nothing has the data open.** Before `start` opens anything, a marked page takes the exclusive Web Lock `smithers-wipe`, then `smithers-data` exclusively, so it waits until every page that had the data open has ended, and none can write a row back; then the engine's own Web Lock, so no engine worker holds its OPFS files. Only then does it delete the engine's OPFS directory `smithers/<engine name>` (the engine's store and the app's shared database, the device store) and the outbox's IndexedDB database `smithers-outbox`, and clear the mark. Other pages loading at the same time wait for the wipe's lock and find it done. The theme's mirror stays.
4. **A page whose delete still fails never opens the stores.** The mark stays, and the page starts on stores that aren't the device's (`unwiped`): the device store in memory, the outbox in memory, so no ask of the ended session is sent, and no engine, so none of its runs resumes. The pill says Smithers can't run in this browser, with Reload, whose boot deletes again.

The page continues as a visitor. A visitor's page syncs only conversations whose branch a visitor may view (`worker/Chat.ts`, `branchAccess`), throttled per network ([throttling](chat.md#throttling)).

## The device's owner

A device's data belongs to one person: whoever owned it when it was made. Another person who signs in on the same browser never opens it, sends its queued writes or resumes its runs. The data stays whole and sealed until its owner signs in again, or someone signs out, which wipes the device as [signing out](#signing-out) always does. Nothing else deletes it ([decision 0023](../decisions/0023-device-ownership-and-queued-authority.md)).

**The check.** Before the engine starts, every time an engine worker is about to lead, it reads the owner record and asks ChatApi who is signed in (`authorizeDevice`, `src/device/identity.ts`, through `@smthrs/platform-browser`'s `BrowserRuntime.run({ authorize })`). The record is one row, `smithers_device_identity` (version 1: the owner's stable person id or `@visitor`, and the login they claimed it under, kept for diagnosis), in the device store beside the collections: expiry keeps it, and only the wipe deletes it.

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

**Each queued write.** A memory-only activation stamps its new writes `@none`, matching its request binding, so they can send without admitting any sealed device writes. The outbox stamps each write with the owner the tab opened the data as, and loads and sends only that owner's writes (`Outbox.Principal`). Another owner's writes stay sealed in IndexedDB (`outbox write sealed`), as an earlier owner's do when the browser evicted the device store but not the outbox, or when a visitor's device is adopted. A write an earlier build stored names no one. It is the owner's only when the receipt says the owner held the device before this activation (`continuous`: the recorded owner, or an earlier build's matching confirmed session). On a device that came to its owner only now, such a write stays sealed too, across reloads: the owner record persists eligibility for unstamped writes, and a fresh claim or visitor adoption never gains it just by reactivating.

**Signing out** wipes the device, owner record included: the next person to sign in opens a new device. Signing out from a sealed tab wipes the sealed data too, so the person at the browser decides; it is the one way to clear another person's data.

Records: `auth.device_identity` and `smithers_device_identity_checks` by `outcome`, and `via` when verified; `unavailable` with its `stage` and `reason` when the check couldn't run. None carries a login or a person ([observability](../observability.md)).

## Keys

`SESSION_SECRET` signs cookies (`Core.Signature` from `@smthrs/integrations`) and, through a key derived from it, seals GitHub's tokens and the PKCE verifier with AES-256-GCM (`WebCryptoCipher` from `@smthrs/control`), each bound to its row and column. In a deploy and under `alchemy dev`, Alchemy generates it once and binds it to ChatApi (`infra/SignIn.ts`). Replacing it signs everyone out: their cookies no longer verify, and a role check ends a session whose tokens no longer open.

## Postgres

Migration `0005_sign_in`. None of these tables is synced to browsers.

| Table | Columns | |
|---|---|---|
| `people` | `id` (uuid), `github_id` (unique), `github_login`, `created_at`, `updated_at` | a person, keyed by GitHub's numeric id; the login follows renames |
| `sign_in_attempts` | `state_digest` (key), `verifier` (sealed), `redirect_uri`, `return_to`, `expires_at` | sign-ins in progress; expired rows are deleted when the next one starts |
| `sessions` | `id`, `token_digest` (unique), `person_id`, `role`, `role_checked_at`, `github_access` and `github_refresh` (sealed), `github_access_expires_at`, `github_refresh_digest`, `created_at`, `expires_at`, `revoked_at`, `revoked_reason` (`sign_out`, `github_refused`, `unreadable`) | one per browser sign-in |

## Configuration

| Variable | Default | |
|---|---|---|
| `GITHUB_APP_CLIENT_ID` | none | the Smithers GitHub App's client id; without it sign-in is off |
| `GITHUB_APP_CLIENT_SECRET` | none | its client secret; without it sign-in is off |
| `SESSION_SECRET` | generated by Alchemy | at least 32 characters; shorter turns sign-in off and logs `auth.config` |
| `GITHUB_REPOSITORY` | `smithersai/smithers` | `owner/name`: the repository roles are read on |
| `SESSION_MAX_AGE_DAYS` | `30` | a positive integer |
| `ROLE_RECHECK_MINUTES` | `60` | a positive integer |

ChatApi and the `FlowExecution` Durable Object read them with Effect `Config`. Set the App's two in the deploying environment; Alchemy binds them to the Worker as secrets ([infrastructure.md](../infrastructure.md#credentials)).

**Callback URLs.** The GitHub App must list `<origin>/api/auth/callback` for every origin people sign in from: `http://localhost:1337/api/auth/callback` for `pnpm dev`, and the deployed site's `url` plus `/api/auth/callback`. GitHub refuses any other redirect URI (`redirect_uri_mismatch`, logged as `exchange_misconfigured`). On a loopback host GitHub ignores the port: with only `http://localhost:1337/api/auth/callback` listed, it takes `http://localhost:1338/api/auth/callback` and `http://127.0.0.1:1338/api/auth/callback`, and refuses `http://localhost:1337/other` (checked 2026-10-20). So a second `alchemy dev`, which takes the next free port, signs in for real too. The dev server's HTTPS and HTTP/2 URL, `https://localhost:1443` ([infrastructure.md](../infrastructure.md#https-and-http2)), is another scheme: list `https://localhost:1443/api/auth/callback` too to sign in for real there.

## Local development

Under `alchemy dev`, `worker/DevChatApi.ts` runs the same program. With `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` in the environment, sign-in is real; without them, a local developer is signed in as an Admin, so the browser's agent can call the model endpoint on a laptop.

The local developer can sign out, so the end-to-end suite tests a signed-out page against `alchemy dev`. Sign out (`POST /api/auth/sign-out`, same-origin check kept) sets the dev signed-out cookie, `smithers_dev_signed_out`, and every request carrying it is signed out; `GET /api/auth/session` says `{ signedIn: false, available: true }`, so "Sign in with GitHub" shows. Pressing it (`GET /api/auth/sign-in?return=<path>`) clears the cookie and answers `303` to the return path, never reaching GitHub. A deploy has no fallback, and none of this applies.

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
| `components/` | `AuthProvider`/`useAuth`, `SignInButton` (a link returning to this page; hidden where sign-in is off), `Account` (the login and Sign out, or the button with "Couldn't sign in." after `?sign_in=failed`), `ComposerGate` (what `composerAccess` says: the composer, "Members can ask Smithers.", or "Sign in to ask Smithers." and the button) |

**The composer is for Members and above** (decision 0007 §2, `repo:ask`). `composerAccess` shows the composer when ChatApi says the person is Admin, Maintainer or Member, and "Members can ask Smithers." for a signed-in Guest or a person with no role. While ChatApi hasn't answered, or can't be reached, the session it last confirmed on this device decides, so a Member who reloads offline still asks; with none, nothing shows while it hasn't answered, and the sign-in prompt shows once it can't be reached. The prompt shows only when ChatApi says signed out, or the device never had a session.

**Signed out, nothing leaves the browser.** `ComposerGate` replaces the composer, so a signed-out person has nowhere to type an ask, and the model endpoint refuses a signed-out call with `401` either way. A question already in the outbox that ChatApi refuses with `401` (signed out since) or `403` (not a Member) stays on the device as Not sent (`refused`), with Edit and Discard, and is never sent again.

`appLayer` (`src/boot.ts`) builds `Auth` over `AuthStore`, the device's `Persistence` and `DeviceWipe.layer(host.wipe)`, with `AuthClient` among the browser's services (`realServices`); `boot` renders it, and main.tsx gives it to React through `AuthProvider`. The app's header shows `Account`, and `ComposerGate` wraps the composer (`src/screens/app/AppShell.tsx`).

### When ChatApi can't say

A device that never confirmed a session shows "Sign in to ask Smithers." while ChatApi can't say who is signed in (`composerAccess`). It recovers by itself once ChatApi answers, with no click, no `online` event and no reload:

```
check (startup or online) ── unreachable ──▶ refresh: dispatch auth/refresh { } (door sync), once per run of failures
                                                │
engine worker: auth/refresh/check ── asks the tab that started it, on <name>/auth-session ──▶ tab: check("retry")
      ▲                                                                                        │
      └── SessionUnreachable: the engine tries again, 1 s doubling to 30 s, no give-up ◀── unreachable
          signed_in or signed_out: the run ends; the tab already shows what ChatApi said
```

- `auth/refresh` is a durable client flow (`src/features/auth/flows.ts`). Its one step asks the tab that started the run (`src/flows/askingTab.ts`) to check its session as it does when it opens; the tab answers how the check ended. The step fails `SessionUnreachable` while ChatApi can't say, and the engine's retry policy (`REFRESH_RETRY`) asks again. The app writes no retry loop.
- A tab starts one refresh per run of failures: a check that fails while its refresh runs starts no second one (`AuthStore.refreshing`). Checks run one at a time on a tab (`AuthStore.checking`), so a retry waits for a startup or `online` check already asking.
- A tab that closes answers nothing; after 60 s (`ASK_SESSION_WITHIN`) the step settles the run `gone`.
- A new device whose first check failed opened as a visitor's (`@visitor`): the answer that names the person adopts it in place ([adopting in place](#the-devices-owner)), so the composer shows with no click and no reload.
- Records: the tab logs `auth.refresh` (`stage: started`) and dispatch's `flow.dispatch` line; each check it runs is `auth.session_refresh` and `smithers_auth_session_refreshes` with `via: retry`; the engine worker records `auth.refresh.check` (span and log line, `outcome`, `executionId`, `durationMs`). None carries a login.

## Not built yet

- Signing out wipes the outbox without draining it or saying how many asks it discards (decision 0008 §4.6); signing in doesn't upload a signed-out person's local asks.
- An unreadable wipe marker selects the unwiped host. Directory lookup failures preserve the marker; only `NotFoundError` proves the engine directory absent. Reload still happens if stopping the program throws synchronously.
- The boot-time half of the wipe runs before the program starts, so a finished wipe isn't logged or counted. A failed one shows as the program's `persistence unavailable` and `browser.engine.unavailable` (`error.type` `WipeUnfinished`) records and the `smithers-wipe` mark staying in localStorage.
- The `github_app_authorization` revocation webhook isn't handled; a role check ends the session within the hour instead.
- Per-repository roles cover issue writes, the stack, a repository's home, branches and TODO runs, and the buttons that act on them (decision 0079, `worker/github/RepoRoles.ts`). Triage, commitments, merging, the issues' shapes, the webhook, secrets and custom domains still serve the deployment's repository only. Roles Smithers sets itself (`repository_roles`, 0007 phase 2), the device flow for the TUI and CLI, grants and the visitor cookie are later phases of 0007 and 0008.

## Tests

Run with the compose Postgres up (`pnpm db:up`). GitHub is the second scripted seam beside the model (`worker/test/github.ts`): it keeps GitHub's rules (a code bound to its challenge and redirect URI, redeemed once; refresh tokens redeemed once), and a test injects a refusal, an outage or a defect per step.

| Test | Proves |
|---|---|
| `worker/SignIn.test.ts` | a sign-out whose flow's start the host refuses (a fault-injected `FlowStarter`) is `503` and keeps the session, and signing out again starts it; a session signed out whose tokens nothing revoked is revoked by signing out again; signing in again whose sign-out can't start fails before GitHub and keeps the old session; the redirect, state and S256 challenge; cookie flags on http and https; return paths; the full sign-in; state mismatch four ways; a replayed callback reaching GitHub once; a code GitHub already redeemed; expiry, denial and a missing code; GitHub failing at each step; a verifier that no longer opens; signing in again; Postgres failing at each route; role mapping for all four roles and none; a stale role starting a check named after the one it replaces, the same one an hour later, and a new one once a check recorded; sign-out revocation, its sealed tokens kept and one revocation started, and the old cookie refused; cross-site sign-out refused; local development's developer signing out with the dev cookie (an ask refused `401`) and back in without GitHub; forged, unknown and expired cookies; sign-in off without the App or with a short secret; a signed-out ask refused (`401`) and a signed-in one answered; no token in any record |
| `worker/flows/RecheckRole.test.ts` | the flow on the Node host; a retried GitHub failure; refreshing an expiring token and using the new one; an expired refresh token ending the session; a refresh rotated, or stored, while the step waited on GitHub; requests an hour apart while a check is paused after GitHub redeemed its refresh token start that one check, one engine per execution as on Cloudflare, and the session keeps its replacement; a replacement Postgres refused to store, then the engine dying and a new one resuming the run, redeems once and leaves the session live with the replacement; a redemption whose answer was lost ends the session; a check that fails every attempt keeping the role; tokens GitHub no longer accepts; unopenable tokens; no token or login in its records |
| `worker/flows/RevokeGitHubToken.test.ts` | sign-out, and signing in again, starting the flow with the sealed tokens kept, and again only while the tokens wait; the flow ending a session still live before it revokes; the flow on the Node host revoking the token on GitHub and forgetting it; a token GitHub no longer has; GitHub down once and retried; every attempt failing and the tokens forgotten anyway; GitHub or Postgres failing each step by reason; an unopenable token forgotten without GitHub; a live session, no session and a session GitHub refused left alone; no token or login in its records |
| `worker/ExecutionHost.test.ts` | the deployed remote host runs `auth/RecheckRole` and `auth/RevokeGitHubToken` over the app's tables |
| `worker/GitHubAuth.test.ts` | the real adapter against a scripted GitHub on loopback HTTP, GitHub's `200 OK` OAuth errors included; revoking a token as the App (`204`, `404` and `422` revoked; `401` and `403` misconfigured; `429` and `502` unavailable) |
| `worker/GitHubAuth.live.test.ts` | the real GitHub: the App's credentials, a callback URL, and a real user token's person and role; each case skips naming the variables it needs |
| `src/wipe.test.ts` | reopening every page without a wipe; a sealed page's memory stores and unavailable engine; the browser's wipe on Node's Web Locks and BroadcastChannel, with stand-ins for OPFS and IndexedDB: a page still holding the data holds the wipe off, and the wipe then deletes both stores and clears the mark; it waits for the leading engine worker's lock; two pages booting at once delete once; a delete another connection holds off finishes when it closes; a failed delete keeps the mark and opens unwiped; every page, the signing-out one included, stops its program and loads again once; an unwiped page's stores are memory and its engine is unavailable with `WipeUnfinished` |
| `e2e/sign-in.spec.ts` | in a real browser: a tab sealed while its owner was signed out reopens with their draft once a reconnect's session check finds them; another person signing in on the browser sees neither the device's draft nor its queued question, which isn't sent as them and stays on the device, and both are back, the question sent once, when its owner signs in again; signing out wipes the device (the unsent question gone, the outbox empty, the shape from offset -1); with two tabs, a tab slow to unload holds the other's wipe off, then both open as visitors with nothing of the session, the mark cleared; a new device opened while every session read answers 503 (`?faults=session-503`, the engine worker's too) shows the sign-in prompt, then, once ChatApi answers, the composer on the same page within 35 s, the device its person's, and asking taken (`202`); an evicted device whose outbox kept the earlier owner's queued question, taken in place by the next person to sign in, who never sees or sends it, and whose own ask is taken |
| `worker/RunCredentials.test.ts` | who a credential says acts: an agent's chain, a flow's, nested calls growing the chain, keeping the root and staying the agent's; no credential for a person-only flow; a wider callee refused, a narrower one intersected; a chain stopped at its depth; property tests that every hop narrows and no chain acts as the person or for anyone else; forged, tampered, another purpose's, expired and ended credentials reading as nobody, never as the cookie beside them; a request from another person's or a visitor's device data reading as nobody under a cookie or a credential, counted without either person; through ChatApi: the agent's `run/answer` refused, nested and with its own credential, and the person's press taking it; a plugin's wider callee refused; another person's run, another run, forged and expired credentials refused; replayed after sign-out, refused; without sign-in configured, a credential outliving a reload under `SESSION_SECRET`, and not without it |
| `worker/PersonOnly.test.ts` | every person-only flow with a route and every protected act, keyed by the list itself: an agent's, a flow's and a frame's request refused `403` and counted |
| `src/flows/credentials.test.ts` | on the Node engine against ChatApi's routes: the agent's run sends its credential and no cookie, and its nested `run/answer` is refused before anything is sent; the person's press goes in their session, a root person-only press from a busy or reloaded tab still goes in the session and logs `door_timeout`, while a tab answering with another door is refused; one credential however many requests; a declared ceiling sent; signed out, no credential and no cookie; from a tab whose sign-in row says signed out, no credential request at all, the person's press still in the session; a mint unreachable or not a credential, and a lineage unreadable, send nothing; a run with no recorded parent nested in the run it is named after; a credential the server no longer reads asked for again once; a run's credential for the tab's outbox |
| `src/device/identity.test.ts` | the owner check on the deployed builds' device stores (7b96f878 and production's c6940ac5), built by TanStack DB from their fixtures: the confirmed person opens it with every row kept (the regression that wiped it); a confirmed stable id matched by id, any case; another login, or no confirmed login, leaves it sealed and whole; offline or signed out it waits; a new device, a visitor's device adopted at sign-in, the owner's data offline, signed out and under another person; after the wipe the next person owns a new device; an interrupted registration; a missing stable person, an unknown record version and a broken store refused and counted by stage; every outcome counted, no login or person logged; each tab's decision, its session check, receipts, bound requests and reopening once, and the activation's deadline; a person's session on the visitor's data adopted in place (not now failing as unsent, requests meanwhile waiting and then carrying the person), and a refused adoption or someone else's data reopening |
| `src/features/auth/auth.test.ts` | the tab on a Node device: signed out, signed in through GitHub, signing out, sign-in off, ChatApi unreachable, refused or silent; `composerAccess` for every status and role; a Member reloading offline or before ChatApi answers still asking; a Guest or no role seeing the line; ChatApi saying signed out retaining device ownership while the online tab gates asks; a sign-out ChatApi takes leaving no stored rows and an empty outbox, a failed one leaving both; a wipe the host couldn't do counted; no login in its log lines; a failed first check recovering through `auth/refresh` on a Node engine once ChatApi answers, with no event or click, and one refresh per run of failures |
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
