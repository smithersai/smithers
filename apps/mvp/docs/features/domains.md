# Custom domains

A Maintainer points their own domain at the repository's app, the way Vercel does it: add the domain in Settings, add the DNS record shown, and Smithers verifies it and, on Cloudflare, issues its certificate. Will, 2026-10-21 (SCOPE-12, SCOPE-13): "add support to smithers for configuring your own domain in same way you can on vercel", hidden from everyone but maintainers. The design is [decision 0039](../decisions/0039-custom-domains.md). The first domain is vibelang.sh.

```
Maintainer ── Settings: Add docs.example.com
  domain/add (the tab's engine) ── POST /api/repos/<owner>/<name>/domains { hostname }
                                     │ Maintainer or Admin, in person · hostname valid, not reserved, not another repository's
                                     ▼
FlowExecution ── domain/Verify (a poll, ~7 days) ───────────────────────────────────────────┐
  attempt 1: domain/Claim ─▶ domains row: pending, this poll's id ─▶ domain_events: add      │
  each attempt: domain/Check ─▶ DomainProvider.ensure / status ─▶ the row: records,          │
                verification, certificate, problem ─▶ active or failed ends the poll         │
                                    wait 1 min, 2 min, 3 min … ◀──────────────────────────────┘
GET /api/shapes/domains ◀── Electric ◀── domains ──▶ Settings: "Pending verification", the CNAME to copy
```

## The Settings section

A Maintainer or Admin manages a repository's domains at **Settings** (`/<owner>/<name>/settings`), linked from the repository's header only for them. Anyone else who opens the page sees its header alone, and ChatApi's shape sends them no rows.

```
Settings ── Add ──▶ domain/add { owner, name, hostname }        (the tab's engine; retried an hour while offline)
                      └─▶ POST /api/repos/<owner>/<name>/domains ──▶ 202 ── domain/Verify on the FlowExecution host
         ── Refresh ─▶ domain/add (the same hostname: a new verification)
         ── Remove ──▶ domain/remove ──▶ DELETE /api/repos/<owner>/<name>/domains/<hostname>
GET /api/shapes/domains?repo=<repo id> ──▶ the cards (synced while the page shows; never kept on the device)
```

- **The field:** one hostname. The tab trims it, lowercases it and drops a trailing dot, and refuses a name that can't be a domain (`Not a valid domain`) without sending it: a scheme, a path, a port, a wildcard, one label, or an all-digit top-level label (`normalizeHostname`, `contract.ts`).
- **A write in flight** shows beside it: `Adding…` under the field until the domain's card arrives, `Checking…` or `Removing…` on its card. A refusal shows in its place until the next write of that hostname: `Not a valid domain`, `This domain is reserved`, `Another repository uses this domain`, `Only Maintainers can change domains`, `Sign in again`, `Repository not found`, `Custom domains are off`, or `Couldn't save. Try again` when ChatApi couldn't be reached within the hour or the engine couldn't run the flow.
- **A card** per domain, by hostname: its state (`Pending verification`, `Valid configuration`, `Invalid configuration`, `Removing`), its certificate (`Pending`, `Active`, `Failed`, `Unmanaged` when the host terminates TLS), why it isn't active (`Another account uses this domain`, `The provider blocked this domain`, `DNS records not found. Refresh after adding them`, `Couldn't check. Retrying`, or the provider's own reason), and, until it is active, the DNS records to add: Type, Name and Value, each Value with Copy. Refresh and Remove are disabled while a write of it is in flight.
- **Who:** `domain/add` and `domain/remove` are person-only in the registry: the agent never adds, checks or removes a domain, and ChatApi refuses a run acting for a person `403 person_only`.

## Routes

- **`POST /api/repos/<owner>/<name>/domains { hostname }`** adds a domain and answers `202 { hostname }` once `domain/Verify` has started. Posting a hostname the repository already holds refreshes it: a new poll takes the row over and the old one stops at its next check. That is the Settings section's Refresh.
- **`DELETE /api/repos/<owner>/<name>/domains/<hostname>`** removes one through `domain/Remove`, `202 { hostname }`. A hostname the repository doesn't hold changes nothing.
- **Who:** a Maintainer or Admin acting in person (0007 `repo:domain-write`). An agent, flow or sandbox acting for them is `403 person_only` (`domain/add` and `domain/remove` are person-only in the registry); any other role `403 forbidden`; signed out `401 authentication`.
- **Which repository:** the one sign-in reads roles on (`GITHUB_REPOSITORY`); any other is `404 not_found`.
- **Hostname:** trimmed, lowercased, without a trailing dot; two or more labels of letters, digits and inner hyphens, at most 253 characters, and a top-level label that isn't all digits. No scheme, port, path or wildcard; a name outside ASCII comes in its `xn--` form (`400 invalid_hostname`). The deployment's zone (`DOMAINS_ZONE`), any name under it, and the host the request came to are `400 reserved`. A hostname another repository holds is `409 taken`.
- **Refusals** answer `{ code }`: also `400 invalid` (not `{ hostname }` JSON), `413 too_large` (a body over 1 KiB), `503 off` (no provider) and `503 unavailable` (the flow couldn't start).

## Reading

`GET /api/shapes/domains?repo=<repo id>` syncs the repository's `hostname`, `repo_id`, `state`, `verification`, `certificate`, `records`, `problem`, `checked_at` and `updated_at` to a Maintainer or Admin in person. A visitor, a Member, a Guest, an agent acting for a Maintainer and a request naming another repository get a shape with no rows, so nobody else learns a domain is being set up.

| Column | Values |
|---|---|
| `state` | `pending` (waiting for DNS), `active` (verified, with a certificate or one the host manages), `failed`, `removing` |
| `verification` | `pending`, `active`, `failed` |
| `certificate` | `pending`, `active`, `failed`, `unmanaged` (the `dns` provider: the host terminates TLS) |
| `records` | `[{ type, name, value }]`: the routing record first (`CNAME`, or `ALIAS` at an apex such as `vibelang.sh`), then Cloudflare's ownership and certificate `TXT` records while they are needed |
| `problem` | `taken` (Cloudflare refused the hostname as already in use; a hostname active on another account is usually accepted and stays pending until its ownership TXT record is added), `blocked`, `timed_out`, `unreachable` (the last check couldn't reach the provider; the poll goes on), or the provider's own short reason, such as `custom hostname does not CNAME to this zone.` |

## Flows

`worker/domains/DomainFlows.ts`, registered on the Cloudflare host by `ExecutionHost.withDomains`:

- **`domain/Verify`** is a `Poll.make` lineage of up to 140 attempts, a minute apart at first and a minute longer each time: about 6.8 days, inside Cloudflare's own 7-day validation window ([backoff schedule](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/backoff-schedule/)). The first attempt runs `domain/Claim`, which inserts or takes over the row and records `add` or `refresh` once under its invocation key. A refresh keeps the row's state and provider id until its first check, so an active domain keeps serving and a removal right after still forgets the registration. A refresh never brings back a domain removed meanwhile, and leaves one being removed alone; a removal and a refresh pressed together can run in either order. Every attempt runs `domain/Check`: it registers the hostname at the provider if the row has no provider id yet (`ensure` finds one an earlier attempt made, so a retried step registers once), otherwise reads its status, and writes the verdict. A registration a check made for a row removed meanwhile is forgotten at once, so none is orphaned at the provider. `active` and `failed` end the poll; so does a row that is gone, being removed, or owned by a newer poll (`superseded`). A check that can't reach the provider records `unreachable`, keeps the last verdict and waits for the next attempt; at the last attempt a domain still pending is `failed` with `timed_out`, and a registration the provider deleted (Cloudflare deletes one that didn't validate in its window) is made anew.
- **`domain/Remove`** runs `domain/Release`: it marks the row `removing` and records `remove` once, has the provider forget the hostname (retried for a day while the provider is unreachable or off, so a registration is never left behind), and deletes the row.
- Postgres failing is `StoreUnavailable`, retried for 30 minutes. A step that still fails is one more unsatisfied attempt of the poll.

## Providers

`DomainProvider` (`worker/domains/Provider.ts`) is the only way the app reaches a domain provider (ARCH-7): `ensure(hostname)`, `status(id, hostname)` and `remove(id)`, failing `ProviderUnavailable` (retried), `HostnameTaken` or `HostnameRejected` (final).

- **`cloudflare`** (`worker/domains/Cloudflare.ts`): a [custom hostname](https://developers.cloudflare.com/api/resources/custom_hostnames/) on the deployment's zone with HTTP certificate validation. A hostname is `active` once its `status` and `ssl.status` are both `active`. One request per call, 10 s each, the token as a bearer header only.
- **`dns`** (`worker/domains/Dns.ts`): for a host that terminates its own TLS: development, the end-to-end tests, and a self-hosted or native deployment. It registers nothing; a domain is verified once public DNS, asked over DNS-over-HTTPS, gives it the target as its CNAME. A shared address proves nothing (a CDN serves many owners), so an apex its DNS provider flattens stays pending with this provider. Its certificate is `unmanaged`.

### Configuration

| Variable | Meaning |
|---|---|
| `DOMAINS_PROVIDER` | `cloudflare` or `dns`. Unset is off: every route answers `503 off`. Under `alchemy dev` unset is `dns`. |
| `DOMAINS_ZONE` | The deployment's own zone, such as `smithers.sh`: reserved, and the SaaS zone on Cloudflare. `localhost` under `alchemy dev`. |
| `DOMAINS_CNAME_TARGET` | What every domain's record points at; `domains.<zone>` unless set. |
| `DOMAINS_ZONE_ID`, `DOMAINS_API_TOKEN` | `cloudflare` only: the zone's id, and a Worker secret with "SSL and Certificates: Edit" on it. |
| `DOMAINS_DOH_URL` | `dns` only: the DNS-over-HTTPS resolver; `https://cloudflare-dns.com/dns-query` unless set. |

A provider missing what it needs is off and logs `domains.off` with the reason.

### Cloudflare setup (once, from the MacBook)

1. On the deployment's zone, add a proxied placeholder record for the fallback origin (`AAAA fallback 100::`) and set it as the Custom Hostnames fallback origin.
2. Add the CNAME target as a proxied record (`CNAME domains → fallback.<zone>`).
3. Route custom-hostname traffic to the site Worker ([Worker as origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).
4. Set `DOMAINS_PROVIDER=cloudflare`, `DOMAINS_ZONE`, `DOMAINS_ZONE_ID` and the secret `DOMAINS_API_TOKEN`; run `pnpm exec vitest run worker/domains/Cloudflare.live.test.ts` with the same variables.

Steps 1 to 3 belong in `alchemy.run.ts` beside the app's own domain ([infrastructure.md](../infrastructure.md#domain)): `DOMAINS_ZONE` is `APP_DOMAIN`'s zone, and the Worker route that takes custom-hostname traffic must leave the docs site's zone routes and the app's own custom domain alone.

## Postgres

`db/migrations/0046_domains.ts`: `domains (hostname PRIMARY KEY, repo_id, provider_id, poll_id, state, verification, certificate, records, problem, checked_at, updated_by, updated_at)`, so a hostname belongs to at most one repository; and `domain_events`, the audit: `add`, `refresh` and `remove` with the person and the step's invocation key, and `check` whenever a domain's state or problem changes.

## Observability

`domain.request`, `domain.shape` and `domain.step` log lines and spans, the `smithers_domain_requests`, `smithers_domain_shape_requests` and `smithers_domain_steps` counters, and `domains.off` ([observability.md](../observability.md#custom-domains)). They carry the repository, codes and outcomes, never a hostname or the token. A check that couldn't forget a registration it made for a domain removed meanwhile logs `orphaned` at error level and counts it: an operator removes that custom hostname by hand.

## Tests

- `worker/domains/Domains.test.ts`, on the compose Postgres and Electric with the flows on the Node host's engine and the real `dns` provider over a resolver scripted at the network: a Maintainer's and an Admin's adds (a subdomain's CNAME, a flattened apex), pending, refresh, removal, every refusal, faulty providers (taken, blocked, unreachable, forgotten), the last attempt, a superseded poll, the steps' database failures, and the shape for each role.
- `worker/domains/Cloudflare.test.ts`, `Dns.test.ts`, `Config.test.ts` and `src/features/domains/contract.test.ts`: each adapter against a scripted API, every status mapping and failure, the configuration's choices, and the hostname rules.
- `worker/PersonOnly.test.ts`: both routes refuse an agent, a flow and a frame acting for the person.
- `worker/domains/Cloudflare.live.test.ts`: the real Cloudflare API, skipped without its variables.
- `src/features/domains/api.test.ts`: the client against every answer the routes give, the steps' outcomes and counts, and every state's, problem's and refusal's words.
- `src/features/domains/domains.test.ts`, on the compose Postgres and Electric with ChatApi's real handler: a Maintainer's add (normalized, `Adding…`, then the pending row with its CNAME), Refresh and Remove; a name refused on the tab, unsent; the page's list per repository; Copy, and a clipboard that refuses; an engine that can't run the write (`unavailable`); a Member's add refused `forbidden`, with no rows.
- `e2e/domains.spec.ts` (local development's people): a Maintainer adds a domain under `.example`, sees the CNAME record and `Pending verification` with the certificate `Unmanaged`, refreshes and removes it; a Member sees no Settings link, no Domains section and no rows.

## What's not built

- **Known gaps.** A `domain/Claim` that fails for 30 minutes (Postgres down) ends its poll with no row, after the route answered `202`. A lost `202` that the browser retries starts a second poll, or a second removal; a delayed second removal could remove a domain added again in between. A registration a check couldn't forget is logged `orphaned`.

- **Serving a custom domain.** The site Worker doesn't yet map a request's `Host` to the repository's app; that and the Cloudflare setup above land with the smithers.sh cut-over.
- **Live Cloudflare calls** have not run: they need the zone's token on the MacBook.

A repository's Settings page says `No settings available` when the viewer cannot manage its domains.
