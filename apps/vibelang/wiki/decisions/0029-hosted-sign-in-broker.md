# 0029. Hosted sign-in through smithers.sh

Status: implemented locally, 2026-11-09; the lead coordinates deployment. Ruling VL-33; supersedes 0019's per-site sign-in callback.

## Design twice

Chosen: an opaque, 256-bit, single-use code with server-to-server redemption. The hosted site signs a request
containing its exact origin, a fresh nonce, an S256 PKCE challenge and a ten-minute deadline. The broker authenticates
that request using the declared origin's own key, starts GitHub with separate state and PKCE, and uses only its
existing `/api/auth/callback`. After reading GitHub's numeric ID and login it discards the GitHub tokens, writes an
encrypted identity behind a sixty-second code, and redirects to the declared site's fixed callback with that code
in the fragment. The callback erases the fragment, posts locally, and the site's server signs a redemption request
with its saved verifier. Atomic conditional deletion checks origin, nonce, PKCE and expiry before returning identity.
The site issues its own session and resolves project roles through 0019's existing policy.

Alternative: an audience-bound signed identity assertion verified by the site with a distinct per-site HMAC key
or the broker's public key. It removes the exchange request and central code table. Each site would atomically
consume its pending nonce to prevent replay, and consistently enforce audience, issuer and key rotation. A single
global shared verification secret would additionally let a compromised site forge identities for others. An issued
assertion also survives a central registry revocation until it expires, and front-channel delivery must protect the
identity-bearing assertion. We choose the opaque code: one central consumption and final allowlist check, identity
only over server-to-server HTTP, and independent keys for every origin. No new VibeLang dependency is required.

## Host boundaries

The library catalog's `@smthrs/integrations` entry supplies `GitHub.Auth`, `Core.CookieKeys` and
`GitHub.Auth.Broker`. The shared broker owns signatures, allowlist checks, encryption, PKCE, TTLs, HTTP responses,
and the conditional SQLite store. Apps provide durable execution and configuration.

smithers.sh hosts `HostedAuthBroker`, a new SQLite Durable Object. Its `auth/Broker` steps persist operation names
and null results only; credentials stay in encrypted records. Its ordinary sign-in and ordinary GitHub callback
remain the existing implementation. Only `/api/auth/broker/start`, `/api/auth/broker/exchange`, and callbacks whose
state has exactly `broker_` plus a 43-character nonce enter the broker. No GitHub redirect URL is added.

VibeLang's existing Accounts object keeps its nonce and encrypted verifier and performs local session issuance
inside `vibelang/Account` steps. Mock identity selection and CLI/MCP device authentication stay independent.

The registry contains exact HTTPS origins served by the deployment, including declared smithers.sh subdomains and
custom domains. It accepts no wildcard or suffix-only grant. Origins with userinfo, noncanonical spelling, a path,
query or fragment are refused; HTTP is permitted only by an explicitly injected loopback development host.
Unknown origins never receive a redirect. Every stage reads the deployed registry; removing an entry in the next deployment prevents starts and exchanges.

## Security review

- Replay: the signed start request is admitted once. GitHub attempts and handoff codes are atomically consumed;
  a wrong origin, nonce or verifier cannot consume a valid code. A lost response requires a fresh sign-in.
- Open redirect: both start and callback recheck the deployment registry. The only destination is the exact origin
  plus the fixed callback path. No caller chooses a path or an upstream broker URL.
- CSRF: separate HttpOnly, host-only, SameSite=Lax cookies bind the browser at broker and site. GitHub state binds
  the broker attempt; site nonce and PKCE bind the return. Local POST requires the exact Origin, with the browser's
  no-referrer `Origin: null` accepted only alongside `Sec-Fetch-Site: same-origin`. Agents never gain a person session.
- Code leakage: the handoff code uses a fragment, erased before a same-origin POST, and a no-referrer response with
  a strict CSP and no outside assets. Neither code nor identity enters access-log URLs. The exchange is a POST with
  HTTP transport tracing disabled. GitHub's own authorization code still uses its standard PKCE-bound callback.
  A real HTTP adapter regression found default server spans exposing OAuth queries. Shared `httpPolicy` now redacts query values in the request context, registered through Alchemy `Telemetry.layer` for both Workers and auth objects. Proxy/native access logs must independently omit OAuth queries and callback/exchange bodies. Application auth logs, spans, counters and durable receipts contain fixed operation/outcome names only.
- Storage: origin, nonce, challenge and the code deadline are authenticated inside the encrypted handoff as well as checked by SQLite. Even a faulty store bypassing metadata checks cannot return another origin's identity or extend expiry. Pending GitHub verifiers and handoff identities are encrypted with authenticated context bound to their
  digest key. Store keys and redemption bindings are digests; raw codes, tokens and shared keys are never stored in
  the flow journal. Expired broker records are pruned by the next journaled insertion, without a timer or worker.

## Deployment handoff

The lead deploys both apps; this lane deploys neither. smithers.sh must carry the shared integrations code, broker
Durable Object binding and migration, route wiring, its existing GitHub App client credentials and session secret,
`AUTH_BROKER_ENCRYPTION_KEY` (base64 32-byte key), and redacted `HOSTED_AUTH_SITES` JSON containing a distinct
`{origin, secret}` per hosted site. `AUTH_BROKER_ORIGIN` is the registered-callback origin; it defaults to HTTPS
`APP_DOMAIN`. Each site's secret is at least 32 characters and is supplied only to that site and the broker.

VibeLang receives `AUTH_BROKER_ORIGIN` and `AUTH_BROKER_SITE_SECRET`, in addition to its existing origin, signing
key, encryption key, initial-maintainer ID and GitHub device-flow configuration. Deploy smithers.sh first, then
VibeLang. A plan is not a deployment receipt; production sign-in remains unverified until the lead smoke-tests it.

MVP declares the monorepo's existing `vibelang-runtime@0.0.12` because its new Worker module is VibeLang; 0008 records it as awaiting Will's VL-5 approval. No runtime
or test dependency is added to VibeLang. The library's cryptography, HTTP, SQLite and flow-engine boundaries are
behaviorally tested; this record does not claim a formal proof of cryptography or those runtimes.

## Verification and compatibility

The broker's protocol/policy unit suite measures all four coverage metrics at 100%, including concurrent use,
exact expiry, origin tricks, faulty provider/store services, redirect leakage and ciphertext audience/expiry.
The TTL and record-binding predicates are proved by Dafny against exact source copies, with expired-code and
wrong-binding mutations rejected. The local cookie-name decision is proved separately. Cryptography, URL parsing,
HTTP and SQL atomicity remain tested host/library boundaries, not claims of formal proofs of those runtimes.

Both production auth handlers run in workerd; Chromium tests use distinct loopback origins and an injected GitHub
service that checks PKCE, with no request interception. The browser fixture starts once per suite and owns cleanup;
it does not enter either deployed app. Plain HTTP loopback uses local cookie names; the CLI/MCP validators and action
identity adapter share that contract, and existing signed local CLI cookies remain accepted. HTTPS still requires
host-prefixed cookies. Missing browser-broker configuration does not disable device flow.

A VibeLang 0.0.12 gap encountered while registering a native Vitest test is retained at
`~/vl/vibelang-bugs/authbroker-nested-effect-test/` on nyc-01: a nested `effect {}` inside the async callback of a
throwing registration wrapped in `Effect.try` is wrongly typed as a function. The minimal case reproduces TS2345.
No compiler behavior was changed. The actual broker classifier regression lives with the shared API in its
existing Effect-native test suite; no TypeScript product path or diagnostic suppression was added.
