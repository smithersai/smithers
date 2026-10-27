# Secrets

A repository's secrets are write-only values that code in a branch's sandbox uses without ever holding: the box holds a placeholder, and the egress outside the box puts the value in the request only for that secret's own hosts. This page covers the first slice of [decision 0005 §4](../decisions/0005-sandboxes-secrets-and-the-forge.md#4-secrets): storing a secret, its host allowlist, the Secrets page, the audit, and the egress. Main-only secrets and secret files come later ([What's not built](#whats-not-built)).

```
Admin ── PUT /api/repos/<owner>/<name>/secrets/<NAME> { value, hosts, methods? }
           │ admit (Admin, in person) · check name, hosts, value · seal under SECRETS_KEY
           ▼
         secret/Put { ciphertext, nonce, hosts, … } ──▶ secrets row + secret_events (set | replace)

box: STRIPE_KEY=smthrs-secret-<64 hex>      (environment, derived per branch and generation)
  curl -H "Authorization: Bearer $STRIPE_KEY" https://api.stripe.com/v1/charges
           │ the box's outbound HTTP ─▶ SandboxEgress.forward(guest)            (SANDBOX_SECRETS, off by default: see below)
           ▼
         Egress.forward (@smthrs/secrets): host bound? method? HTTPS? ── no ─▶ 403 <code>, audited
           │ yes: open the sealed value, put it in the header, record `forwarded`
           ▼
         api.stripe.com ── answer ─▶ redirects returned unfollowed · every echo of the value scrubbed ─▶ box
```

## Writing

`PUT /api/repos/<owner>/<name>/secrets/<NAME>` with `{ value, hosts, methods? }` sets or replaces a secret; `DELETE` on the same path deletes it. Both answer `202 { name }` once the flow has started, and the row arrives in the shape.

- **Who:** an Admin acting in person (0007 `repo:secret-write`). An agent, flow or sandbox acting for them is refused (`forbidden`), as is every other role. Signed out is `authentication`.
- **Which repository:** the one sign-in reads roles on (`GITHUB_REPOSITORY`), since a session carries one role; any other is `not_found`.
- **Name:** an environment variable's name: `^[A-Z_][A-Z0-9_]{0,63}$` (`invalid_name`).
- **Hosts:** 1 to 16 exact lowercase DNS names, no wildcard, IP address, port or single label such as `localhost` (`invalid_hosts`). **Methods:** optional, from `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`; every method when absent.
- **Value:** 8 bytes to 16 KiB of text with no control character and no unpaired surrogate (`too_short`, `too_long`, `control_character`, `malformed_text`). The body is at most 32 KiB (`too_large`, 413).
- **Hosts change only with a value.** There is no route that rebinds a stored value to another host, so whoever points a secret at a host already knows the value.
- **Sealing:** the route seals the value before it starts `secret/Put`, so the flow's payload and journal hold only ciphertext. AES-256-GCM (`@smthrs/control`'s `WebCryptoCipher`) under a key derived from SECRETS_KEY, with the repository, the name and the key's version as the authenticated context: a ciphertext moved to another row doesn't open.
- **Flows:** `secret/Put` (step `secret/Store`) and `secret/Delete` (step `secret/Erase`) run on the Cloudflare host (`FlowExecution`). Each step writes the row and its `secret_events` record in one transaction under its invocation key, so a step run again records nothing twice. A database failure is `StoreUnavailable`, retried for up to 30 minutes.
- **Refusals** answer `{ code }`: `authentication` 401, `forbidden` 403, `not_found` 404, `invalid_name`, `invalid_hosts`, `invalid` and the value's codes 400, `too_large` 413, `off` 503 (no SECRETS_KEY), `unavailable` 503 (the flow couldn't start).

## Reading

Nobody reads a value back. `GET /api/shapes/secrets?repo=<repo id>` syncs the repository's `repo_id`, `name`, `hosts`, `methods` and `updated_at` to a Member or above; anyone else, or a request naming another repository, gets a shape with no rows. Electric sends the array columns in Postgres' text form (`{api.stripe.com}`).

## The Secrets page

`/<owner>/<name>/settings/secrets` lists a repository's secrets by name: each one's hosts, its methods when set, and when it last changed. The list comes from `GET /api/shapes/secrets?repo=<repo id>` into `secrets:<repo id>`, which the device keeps. The repository header's Secrets link shows to a Member or above of the repository, on the deployment's own repository alone, by the role ChatApi answers for it (`GET /api/repos/<owner>/<name>/role`, decision 0079): a Member of the deployment's repository sees no Secrets on `smithersai/vibelang`.

| Who | Sees | Does |
|---|---|---|
| Admin, in person | the list | Add (Name, Value, Hosts separated by commas or line breaks), Rotate (a new value; hosts prefilled and editable; its methods kept), Delete after a confirmation |
| Maintainer, Member | the list | nothing |
| anyone else | "You can't see this repository's secrets." | nothing |

The server decides every write: the page only hides controls, and shows each refusal's `code` as a short phrase.

A `202` means the flow started, not that it landed: the form says Saving until the list shows the row new or changed (a delete: gone), and after 60 s that it hasn't shown up yet. Add refuses a name the list already has ("NAME exists. Rotate it instead."): Rotate is the only way to replace a value, and it keeps the secret's methods. No whole answer is an unknown outcome ("Couldn't confirm the save. Check the list before trying again."), shown as landed if the list later has it. That row also clears the form after a lost acknowledgment and records that the write started. Forms and their state belong to one repository.

A value is never shown again and never stays on the device. It is typed into a password field, read from the form once on submit, held `Redacted` in the action and sent in one `PUT` through `SecretsClient` (Effect `HttpClient`) in the person's own session. It never goes through the device's outbox or a browser flow, no collection has a field for it, and the form clears once the write lands. The page records `secrets.put` and `secrets.delete` spans, a `secrets.write` log line and the `smithers_web_secret_writes` counter (`started`, `refused`, `unknown`, `landed`, `late`), carrying names, a hosts count, outcomes and codes, never a value.

## The egress

`worker/secrets/SandboxEgress.ts` is what a branch box's outbound HTTP reaches. For a guest, a repository's branch at one generation of its machine:

- **Placeholders:** `environment(guest)` is the box's environment file, one `NAME=smthrs-secret-<64 hex>` line per secret. Each placeholder is HMAC-SHA-256 of the repository, branch, generation and name under a key derived from SECRETS_KEY, so the egress derives them again rather than storing them, and a new generation's box gets new ones: an earlier generation's is `unknown_placeholder`.
- **Policy:** every secret of the repository with its placeholder and binding, plus the hosts a box reaches with no secret: the package registries every box reaches (`RegistryEgress.HOSTS`, [the machine](sandbox-tools.md#the-machine)), so turning secrets on never loses them, and `EGRESS_ALLOW_HOSTS` (comma-separated; none by default). Every other host is `host_not_allowed`.
- **Substitution, refusals, redirects, scrubbing and limits** are `@smthrs/secrets`' `Egress.forward` ([its docs](../../../../packages/smithers/flows/secrets/docs/README.md)): header values only, HTTPS only, exact host and method, no redirect followed, 16 placeholders and 64 KiB of headers at most, and every echoed form of every one of the repository's values scrubbed from every answer, whichever host sends it.
- **Values** open per request, in memory, from the sealed rows; a value that doesn't open sends nothing (503 `secret`).
- **Audit:** each decision is a `secret_events` row (`action = 'use'`) with the guest's `scope` (`<branch id>:<generation>`), the host, the method, the outcome and the names, written before the request is sent; a decision that can't be recorded sends nothing (503 `audit`).

### Wiring into the box

The branch's `SandboxObject` (`worker/BranchSandboxes.ts`) routes the box's outbound requests here only when `SANDBOX_SECRETS` is `true`, and never a check job's. It is off by default; `e2e/secrets.spec.ts` proves it through a real box (below), and turning it on for a deployment is Will's call: set `SANDBOX_SECRETS=true` in ChatApi's environment when Alchemy plans it. With it on, every wake:

1. registers `interceptAllOutboundHttp` and `interceptOutboundHttps("*")` beside the forge's intercept (`@smthrs/platform-cloudflare`'s `SandboxObject.wake` with `egress`), so every request for another host reaches the object, as every wake does;
2. answers each such request with `SandboxEgress.forward({ repoId, branchId, generation })`, the guest taken from the object's own state (the branch it serves and its generation), never from the request;
3. writes `environment(guest)` to `/run/smithers/env` as root and has every login shell source the file (`/etc/profile.d/smithers-env.sh`), then trusts the container's CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) when Cloudflare provides it, as a box without secrets does (`SandboxEgress.TRUST`: `update-ca-certificates`, and `NODE_EXTRA_CA_CERTS` and `DPRINT_CERT` in `/etc/profile.d/smithers-trust.sh`), all in `SandboxEgress.SETUP`, which prints nothing whatever fails (workerd reports a command's exit only once its unread output closes); the sandbox tools' commands get the same placeholders and trust as their environment.

The terminal's sockets reach the same `fetch`, so the object attaches one only with a one-use ticket ChatApi takes from it over RPC: the box can't get one. With `SANDBOX_SECRETS` off, the box reaches only the forge and the package registries (`worker/branch/RegistryEgress.ts`), and holds no placeholder.

## Keys

SECRETS_KEY is a Worker secret Alchemy generates once (`infra/Secrets.ts`, 32 random bytes as hexadecimal) and binds to ChatApi. The sealing key and the placeholder key are SHA-256 derivations of it with labels of their own. Without SECRETS_KEY, or with one under 32 characters (logged as `secrets.off`), every secrets route answers `off` and the egress answers 503 `off`. Replacing it makes every stored value unreadable: Admins set them again.

## Postgres

`db/migrations/0021_secrets.ts`: `secrets (repo_id, name, ciphertext, nonce, key_version, hosts, methods, updated_by, updated_at)`, keyed by repository and name, and `secret_events`, the audit: `set`, `replace` and `delete` with the Admin and the step's invocation key, and `use` with the guest's scope, host, method, outcome and names. Neither holds a value.

## Observability

`secret.request`, `secret.shape`, `secret.write` and `secrets.egress` log lines and spans, and the `smithers_secret_requests`, `smithers_secret_shape_requests`, `smithers_secret_writes` and `secret_egress_requests` counters ([observability.md](../observability.md#secrets)). They carry names, hosts, methods, outcomes, codes and counts; never a value, a ciphertext, a header, a path or a body. The egress turns its HTTP client's own span off.

## Tests

- `packages/smithers/flows/secrets/test/` (100% coverage): substitution only in headers and only for bound hosts and methods; refusals unsent; redirects returned unfollowed, also against real servers and the real `fetch`, with a control that shows a followed redirect would leak; scrubbing of every form at every chunk split; header and placeholder limits; vault, audit and upstream failures; and a sentinel search of every span, log line, metric and failure.
- `worker/secrets/Setup.docker.test.ts`, in a real branch-sandbox container: another user's login shell gets the placeholders and `NODE_EXTRA_CA_CERTS`, the CA is trusted, and the setup prints nothing, also when the CA can't be trusted (exit 2).
- `worker/secrets/Secrets.test.ts`, on the compose Postgres and Electric, with the flows on the Node host's engine: an Admin's set, replace and delete, and every refusal; a sentinel search of every table, the flow journal and everything recorded; the shape's columns; the egress end to end with a scripted upstream, including another host, an earlier generation and a redirect.
- `src/features/secrets/` (100% coverage), on the app's layer against ChatApi's real handler: Add, Rotate and Delete as an Admin, read-only for a Member, nothing for anyone else, every refusal and a network failure; and a sentinel search, after Add and Rotate, of every collection row, the outbox, the device's SQLite files, ChatApi's spans and everything the tab exported.

- `e2e/secrets.spec.ts`, under `alchemy dev` with `SANDBOX_SECRETS=true` and `GITHUB_REPOSITORY=octocat/Spoon-Knife` (need `sandboxSecrets`): an Admin adds and rotates `DEMO_TOKEN` on the Secrets page, bound to httpbingo.org; in the branch's terminal, a real container, the variable is a placeholder; a Node `fetch` with it as a bearer token gets httpbingo.org's 200 with the token echoed back as the placeholder, and httpbin.org's request is refused 403 `host_not_allowed`; from outside the box, `docker export` of its filesystem, every process environment and every ChatApi log line hold neither value, and the egress logged one substitution forwarded and the refusal; deleted, the placeholder gets 403. Its trace is off, since a trace keeps what was typed.

## What's not built

- **On by default**: `SANDBOX_SECRETS` stays off until Will switches it on ([Wiring into the box](#wiring-into-the-box)).
- **Main-only secrets** (D-24) and **secret files** (M-42).
- **The forge token and model routing** in the egress (0005 §4 steps 3 and 4), which the forge proxy and the model endpoint do today on their own routes.
- **Path scoping** of a secret, beyond hosts and methods.

An empty read-only list says **No secrets · Admins add secrets**; an Admin's empty list says **No secrets** beside
the existing add form. The hint grants no new permission and exposes no values.
