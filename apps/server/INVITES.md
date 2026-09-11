# Invite mechanics

The closed-alpha allowlist gates `/api/agent/turn` and every other seam
`requireTurnSession` protects (`src/index.ts`). There are two doors onto it:

1. **Self-serve request, admin approval** — a signed-in user runs
   `auth.request-access` (`POST /api/identity/request-access`, proxied to the
   identity worker); an admin reads the queue with `admin.requests`
   (`GET /api/admin/requests`) and approves with `admin.queue.approve <login>`,
   which is exactly `POST /api/admin/allowlist { login, action: "add" }`
   issued through the product Worker with an admin session cookie.
2. **Batch seed** — `scripts/seed-allowlist.mjs`, below. For inviting a list of
   people at alpha launch, or backfilling design partners, this is the
   one-command door: it skips the UI and the per-login admin session entirely
   and talks straight to the identity worker's admin endpoint with the
   identity admin credential.

Both doors land on the same call: `POST <IDENTITY_UPSTREAM_URL>/api/identity/admin/allowlist`
with `{ login, action, requester, timestamp }` and the `x-smithers-admin-token`
header. `src/invite-mechanics.test.ts` covers door 1 end to end (request ->
approve -> the same session then passes the gate) against a stateful fake of
the identity worker; `src/seed-allowlist.test.ts` covers door 2 the same way.

## One-command seed procedure

```sh
IDENTITY_UPSTREAM_URL=https://smithers-cloud-identity.willcory10.workers.dev \
IDENTITY_ADMIN_TOKEN=<identity's ADMIN_SERVICE_TOKEN> \
pnpm --filter smithers-server run seed:allowlist -- --logins alice,bob,carol
```

or from a file (one GitHub login per line; blank lines and `#` comments are
skipped):

```sh
pnpm --filter smithers-server run seed:allowlist -- --file invitees.txt
```

Preview first with `--dry-run` — it needs no credentials and makes no network
call:

```sh
pnpm --filter smithers-server run seed:allowlist -- --file invitees.txt --dry-run
```

`IDENTITY_UPSTREAM_URL` is the same value as the `vars` entry in
`wrangler.jsonc`; `IDENTITY_ADMIN_TOKEN` is identity's `ADMIN_SERVICE_TOKEN`, a
Cloudflare secret on that deployment, not a var here — get it from wherever
that secret is held, never from this repo. `--action remove` revokes instead
of adds. `--requester <login>` sets the audit attribution (defaults to
`seed-allowlist-script`). Full flag list: `node scripts/seed-allowlist.mjs --help`.

## Verifying the seed against a real deployment (CN-23)

The unit tests prove both doors work against fakes. They cannot prove the
alpha's allowlist is actually seeded, or that an invite issued to the live
identity worker admits anybody. `scripts/canary/invite-probe.ts` is the live
half:

```sh
# Read-only. Safe to schedule: it writes nothing.
IDENTITY_SERVICE_TOKEN=<identity's SERVICE_TOKEN> \
CANARY_ALLOWLIST_LOGINS=alice,bob,carol \
bun scripts/canary/invite-probe.ts
```

It reads each roster login back from the identity worker and asserts it is
admitted. A missing credential or an empty roster skips that check, and a run
that verified nothing prints `CN-23 ASSERTED NOTHING` and exits 1 — never
`PASS`, and never a green exit code. A probe that asserted nothing must not
read as a probe that passed, which is the whole point of scheduling it.

Pass `--allow-inconclusive` to exit 0 on a run that verified nothing. It is
there so a contributor without production credentials is not blocked by a
failure they cannot act on. CI refuses the flag: with `CI=true` the probe exits
1 regardless, so an unconfigured pipeline step can never report green.
`IDENTITY_UPSTREAM_URL` defaults to the canary value in `wrangler.jsonc`. Keep
the roster in a repository **variable**, not a secret — GitHub logins are
public and a variable is diffable.

`IDENTITY_SERVICE_TOKEN` is identity's service token. It is the credential the
read side needs, and the sections above name only the admin token, so set both
when running the full probe. The probe sends `IDENTITY_ADMIN_TOKEN` on the
read as well when it is set, so it works whichever of the two the read-back
door gates on.

### The read-back door

The probe reads `GET <identity>/api/identity/allowlist/<login>`, expecting
`{ login, allowlisted }`. That route is not implemented in this repository, so
what the canary identity worker answers, unauthenticated, was checked directly
on 2026-08-18:

| Request                               | Answer                                 |
| ------------------------------------- | -------------------------------------- |
| `GET /api/identity/allowlist/octocat` | `401 {"error":"Unauthorized service"}` |
| `GET /api/identity/admin/audit`       | `404 {"error":"Not found"}`            |

The worker answers 401 for a route it implements but gates, and 404 for one it
does not. So the per-login read-back exists and gates on a **service** token —
`IDENTITY_SERVICE_TOKEN` — and this deployment exposes no admin audit
read-back. The probe treats that 404 as a skip, not a failure: the invite is
still attributed where it is written (the upstream refuses an unattributed
call), it simply cannot be read back here.

If the door ever moves, pass `--read-path '/some/other/{login}'`. A 404 on the
read-back is reported as **unreadable**, never as "not allowlisted" — a missing
door and an absent login are different facts, and conflating them would let the
probe pass a completely unseeded allowlist.

### The admission half writes, so it is opt-in

Admitting a new user mutates production. The default run therefore does not do
it; it prints a `skip:` line saying the admission went unverified. Pass
`--admit-probe-login` to run the round trip:

```sh
IDENTITY_SERVICE_TOKEN=<service token> IDENTITY_ADMIN_TOKEN=<admin token> \
bun scripts/canary/invite-probe.ts --admit-probe-login
```

It reads `canary-invite-probe` (absent), invites it, reads it back (**this is
the CN-23 assertion**), checks the audit log, then withdraws it and reads it
back absent. The withdrawal is in a `finally`, so it runs even after a failed
check.

The audit check requires **one entry** recording all four facts together: the
login, the requester `canary-invite-probe`, the action `add`, and a timestamp
at or after the write this run made (5s of clock slack). The probe's login is
also its requester, so a check that looked for the two names anywhere in the
response passed on any row mentioning `canary-invite-probe` — including a
removal by another admin, and including a row left by an earlier run. A door
that answers 404 or 405 is still reported as a skip, never as a pass.

Two properties make this safe to run after a deploy:

- The probe identity is a **fixed** login, not a timestamped one. A run that
  dies between the invite and the withdrawal leaves that one known row behind,
  and the next run reports it (`an earlier run did not reach its cleanup`) and
  removes it. Timestamped logins would accumulate silently.
- `canary-invite-probe` is not a real GitHub account, so admitting it grants
  nobody a session: the OAuth callback can only ever mint a session for a login
  GitHub issues.

Run it after a deploy, not on a schedule.

### What stays manual

Proving that a real human, invited today, can sign in and reach a working chat
needs a real GitHub account and a browser. That is the sign-in journey
`apps/app/scripts/live-signed-in-check.ts` drives (CN-9), and it is a human
drill, not an automated probe: seed the invitee with the one-command seed
above, have them sign in, and confirm they reach the chat rather than the
waiting-state reply.
