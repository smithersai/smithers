# 0130: Sign-in on other hosts: one GitHub callback, a hand-off to each alias

Date: 2026-10-30. Status: accepted. Ruling [AUTH-9](../rulings.md#16-auth-roles-and-spend): Will, Telegram
2026-10-30 20:24. Builds on [0008](0008-auth.md) (sign-in) and [0039](0039-custom-domains.md) (custom domains), and on
`APP_ALIASES` (docs/infrastructure.md#domain). Will reviews it with the feature (HOST-3).

## Problem

Signing in at an alias such as `factory.smithers.sh` sends GitHub `https://factory.smithers.sh/api/auth/callback` as
the redirect URI, and GitHub refuses any URI the App doesn't list (`redirect_uri_mismatch`). Every alias, and every
custom domain a maintainer adds (SCOPE-12), would need a person to edit the GitHub App first. End users add their own
domains, so that can't scale. Will: "We need a way to not have to add these callback url".

## What a person sees

```
factory.smithers.sh, signed out            smithers.sh                       GitHub
"Sign in with GitHub" (a link, pressed)
  GET /api/auth/sign-in?return=/acme/w ─▶ (only if not signed in here) ─────▶ approve
                                          GET /api/auth/callback ◀────────── the one callback
  ◀── 303 #code ─────────────────────── GET /api/auth/handoff?request=…
  GET /api/auth/arrive  (a page: reads #code, drops it from the URL)
  POST /api/auth/arrive  code=…  ─▶ alias session cookie, 303 to /acme/w
```

Signed in at `smithers.sh` already, the person presses Sign in at the alias and lands back signed in, without GitHub.
Signed out everywhere, they approve on GitHub once and land on the alias, signed in at both. At a custom domain,
`smithers.sh` first shows one page, "Sign in to vibelang.sh?", with Continue: the domain's owner, not the deployment,
controls where that name points.

## Decision

1. **One callback.** GitHub only ever calls `https://<APP_DOMAIN>/api/auth/callback`. ChatApi reads `APP_DOMAIN` and
   `APP_ALIASES` (the deploy's own settings) to know which host is home.
2. **An alias's sign-in starts a hand-off, never GitHub.** `GET /api/auth/sign-in` at a *hand-off host* (an
   `APP_ALIASES` host, or a custom domain whose `domains` row is `active`) answers `302` to
   `https://<APP_DOMAIN>/api/auth/handoff?request=<signed>`. The request is signed with `SESSION_SECRET` under its own
   purpose and carries the alias host, the return path, the nonce's SHA-256 and a 10-minute expiry. Beside it the
   alias sets `__Host-smithers_handoff`, the signed nonce: HttpOnly, SameSite=Lax, 10 minutes.
3. **Only a press on the alias starts one.** The alias refuses a sign-in whose `Sec-Fetch-Site` isn't `same-origin` or
   `none` (a link on another site), so no other site can sign a person in at an alias (M-46).
4. **Home mints a code for its own session.** `GET /api/auth/handoff` runs only at `APP_DOMAIN`. It verifies the
   request's signature and expiry and that the host is still a hand-off host. Without a session there, it runs the
   ordinary GitHub sign-in whose return path is this same hand-off, so GitHub's one callback finishes both. With one,
   it stores a code: 256 random bits, only its SHA-256 in Postgres, bound to the session, the alias host and the
   nonce's digest, valid 60 seconds. It answers `303` to `https://<alias>/api/auth/arrive#code=<code>`.
5. **A custom domain needs the person's Continue at home.** An `APP_ALIASES` host is the deployment's own: only its
   Worker serves it, so a code sent there reaches only the browser that asked, which spends it against its nonce. A
   custom domain's owner can point its name at their own server and read the fragment. So for a custom domain the GET
   answers a page on `APP_DOMAIN` ("Sign in to <host>?", the person's login, Continue and Cancel; no script, never
   framed), and only its same-origin `POST` mints the code. A link that lures a signed-in person to the GET hands
   nothing over (M-46).
6. **The code travels in the fragment and a POST body, never a URL a server sees.** A browser sends neither a fragment
   nor, under `Referrer-Policy: no-referrer`, a referrer. `GET /api/auth/arrive` is a page with one inline script,
   pinned by a CSP hash, that drops the fragment from history and posts the code back to the same origin.
   `POST /api/auth/arrive` reads the code from its body only.
7. **The alias redeems it once, bound to its nonce.** `POST /api/auth/arrive` requires a same-origin request. It deletes
   the code as it reads it, so any attempt spends it, then refuses when the code is unknown or spent, expired, issued
   for another host or a host no longer handed to, or when the browser's nonce cookie is missing or isn't the one the code was issued for. Then it
   creates an *alias session*, with a fresh token the server draws (session fixation), bound to the host and to the
   home session, and sets `__Host-smithers_session` on the alias. A session the browser held there ends first: an
   alias session at once, a session signed in through GitHub at that host before this decision through its sign-out
   flow, as the callback does.
8. **Sessions nest.** An alias session lives in `host_sessions`. It holds no GitHub token and no role of its own: it
   acts as its home session (the actor's session, its role check, a run credential, a GitHub write), and ends no
   later than it. Signing out at
   the alias ends that alias session only. Signing out at home, signing in again there, a role check that ends the
   session, or an expiry ends every alias session under it at the next request.
9. **Nothing logs the code.** Logs, spans and metrics carry the outcome, the reason and the host, never the code, the
   nonce, a token or the request's signature.

## Considered

| | Callback | How the session reaches the other host | Fit |
|---|---|---|---|
| A GitHub callback per host (today) | one per host | GitHub's own | can't scale to end users' domains |
| Wildcard callbacks | `*.smithers.sh` | GitHub's own | GitHub allows none; custom domains aren't subdomains anyway |
| A cookie on the parent domain | one | `Domain=.smithers.sh` | custom domains share no parent; widens every cookie to every subdomain |
| **Hand-off from the home domain (this)** | one | a one-time code, nonce-bound | works for any host; the alias holds a session of its own |
| Code in the query string (OAuth `query`) | one | `?code=` | Workers Logs and traces record the URL (OBS-5) |
| Form POST from home (OIDC `form_post`) | one | cross-site POST | needs a `SameSite=None` nonce cookie on the alias |

Prior art:

- **Clerk satellite domains** are this design: sign-in happens only on the primary domain, a satellite's Sign in link
  goes there, and the primary returns to the satellite only for origins in `allowedRedirectOrigins`. Clerk's default
  syncs only once the person starts signing in (`satelliteAutoSync: false`); sign-out is shared across domains.
  [clerk.com/docs/guides/dashboard/dns-domains/satellite-domains](https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains)
- **Vercel Authentication** sends a visitor to vercel.com, then back to the deployment with a cookie "restricted to one
  URL and … not transferable": a per-host token minted centrally. It signs a visitor already logged in to Vercel in
  "automatically", which M-46 forbids here, so a press on the alias starts ours.
  [vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- **Auth0** advises against wildcard callback URLs in production and offers custom domains per tenant, a few per
  tenant on Enterprise plans, with callbacks still listed per application.
  [auth0.com/docs/applications/wildcards-for-subdomains](https://auth0.com/docs/applications/wildcards-for-subdomains)
- **Netlify Identity** runs per site: each site's own `/.netlify/identity` endpoint signs people in on that site's
  domain, so a site's custom domain needs nothing central. Smithers has one GitHub App for every host, so it can't.

## Threats and what stops each

| Attack | Stopped by | Test |
|---|---|---|
| A return to a foreign host (open redirect) | the host is signed into the request and checked against `APP_ALIASES` and active domains at both ends; the return is a path | `a foreign return host` |
| Login CSRF: the attacker's code planted in the victim's browser | the code is bound to the nonce cookie of the browser that pressed Sign in; same-origin POST | `a missing or mismatched nonce` |
| A stolen code redeemed elsewhere | single use, 60 s, bound to one host and one nonce | `replayed`, `expired`, `another alias` |
| Session fixation | the alias session's token is drawn at redemption; `__Host-` cookies | `a fresh token` |
| The code leaking through Referer, logs or history | fragment, POST body, `no-referrer`, fragment dropped from history | `a code in the Referer` |
| A sign-in another site starts | `Sec-Fetch-Site` on the alias; a signed request at home | `another site's link` |
| A custom domain's owner luring a signed-in person to home's hand-off | home's page and same-origin Continue for a custom domain; the nonce for an alias | `another browser's request` (both) |
| An alias session outliving its home session | every read joins the home session | `revoking at home` |

## Consequences

- One GitHub callback for every alias and custom domain. A domain verified in Smithers signs people in at once.
- The alias needs JavaScript to finish signing in, as the app does.
- An alias session is a second row per host, readable only with its home session, and acts as it. A run credential
  minted at an alias names the home session; signing out at the alias wipes that device, which holds the engine.
- **Residual risk.** A person who presses Continue for a custom domain trusts its owner with a session that acts as
  them everywhere, as an OAuth consent does. Scoping a custom domain's session to its repository is a follow-up.
- `APP_DOMAIN` must be set for the hand-off. Without it (local development, `workers.dev`), sign-in works as before at
  the host it starts on.
