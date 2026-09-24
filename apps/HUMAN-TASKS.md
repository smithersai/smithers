# HUMAN-TASKS.md — Smithers UI alpha launch

Six tasks remain before the closed alpha opens. Every one of them needs a
credential, a live target, or a product decision that no agent in this track
was allowed to make. Everything else in the UI track is landed on `main`.

Source brief: `ui.PROMPT.md` and source audit: `ui-readiness.md`. Both are
untracked operator notes and are not in this repository.

## Status

### Production-readiness panel

Two independent verifiers audited `origin/main` against the U1–U8 definitions
of done and the alpha bar, with no shared context.

| Round | Panelist            | Verdict          | Note                                                                                                                                                      |
| ----- | ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | codex `gpt-5.6-sol` | NOT-READY        | One failure: U7's runner deferred the browser-backed checklist rows as `not-testable-yet`, and `pnpm run checklist` did not exist at the repository root. |
| 1     | claude `fable`      | PRODUCTION-READY | —                                                                                                                                                         |
| 2     | codex `gpt-5.6-sol` | PRODUCTION-READY | Re-audited at `d9655726`.                                                                                                                                 |
| 2     | claude `fable`      | PRODUCTION-READY | Re-audited at `955dcee7`.                                                                                                                                 |

Round 1's failure spawned a fix lane, which rewrote the checklist runner so all
32 rows carry a real probe (headless Chrome over the DevTools protocol for the
§A/§B/§C/§F rows plus D-3 and D-4's pause half, HTTP for D-1/D-2 and §E), moved
the row catalog and CLI contract under `apps/app/scripts/launch-checklist/` so
`bun test src` covers them, and added the root `checklist` script. The panel
loop was configured for up to three rounds; it converged on round 2 and did not
exhaust its rounds. No panel node failed or ran out of retries. Both panelists
report all nine apps gates green, no `packages/**` edits from this track, and no
weakened tests.

### Landed

U1–U8 plus the evals lane, each implemented in an isolated worktree, reviewed
once by a claude agent, and landed on `main` individually.

- **U1/U2** — recommendation card renders proposes / why-now / what-happens
  (`apps/app/src/mainview/RecoCard.test.tsx`); Escape dismisses it in one
  keypress and the app-shell fallback respects `defaultPrevented`
  (`apps/app/src/mainview/RecoEscapeDismiss.test.tsx`).
- **U3** — `apps/app/src/mainview/state/RunClaims.ts` substitutes a deterministic
  line whenever a launch turn's prose claims run state; `Wave12.test.ts` replays
  the wave-11 overclaim and asserts it is gone.
- **U4** — `apps/server/scripts/deploy.ts`, `.github/workflows/apps-deploy.yml`,
  runbook at `apps/server/DEPLOY.md`. See H2.
- **U5** — `apps/server/src/invite-mechanics.test.ts`,
  `apps/server/scripts/seed-allowlist.mjs`, runbook at
  `apps/server/INVITES.md`. See H3.
- **U6** — zero-balance guard short-circuits `flow.run` / `flow.create` before
  any seam call and posts an embedded transcript notice naming
  `/billing.upgrade`; chat stays complimentary at $0
  (`apps/app/src/mainview/ZeroBalanceLaunch.test.ts`).
- **U7** — `pnpm run checklist -- --target <origin>`, runbook at
  `apps/app/scripts/README.md`. See H4.
- **U8** — `apps/app/.gitignore` reconciled, `@smthrs/chain` added to
  `scripts/browser-check.mjs`.
- **Evals** — `.smithers/evals` suite (17 cases) with a committed baseline
  report at 17/17.

### Not landed

**U9 and U10 have no lane in this run and are not on `main`.** They were added
to the brief after the workflow was authored. Neither is an alpha blocker;
both are cheap follow-ups.

- **U9 — local dev-run robustness.** `apps/app/vite.config.ts:41` still sets
  `root: "src/mainview"` as a CWD-relative literal, so `vite` launched from the
  repository root serves 404s. There is no root `pnpm dev` script encoding
  `--configLoader runner`. `@playwright/test` is not a devDependency.
  `SMITHERS_DEV_UPSTREAM` is referenced only in `apps/app/vite.config.ts` and is
  not documented in `apps/README.md`. Workarounds today: run `pnpm --filter
  smithers-app run web` from `apps/app`, and `pnpm --filter smithers-app run
  serve:local` for the UI-plus-Worker pairing.
- **U10 — exact slash-command dispatch.** `apps/app/src/mainview/flows/registry.ts:202-209`
  still matches a needle against both `command.name` and `command.summary` with
  no exact-name precedence, so typing `/flows` and pressing Enter can highlight
  and run `/flow.list`. Affects the catalog affordance, not sign-in, billing, or
  workflow launch.

### Out of scope for this track (backend / plue side)

Neither is fixable from `apps/**`. Both are recorded in `ui-readiness.md` §8.

1. **Gateway VMs have no AI-provider credential.** Every agent node fails with
   `OPENROUTER_API_KEY is not set`. This blocks the headline "make me a
   workflow" flow end to end and is the single hard
   blocker for the core demo (§8 blocker 1, effort S — one secret on the VM
   image).
2. **Wedged gateway VMs do not resume.** An idle-suspended VM keeps a `running`
   row while its relay 502s; re-provisioning returns the same dead gateway.
   Plue must discard the dead row so a re-POST provisions fresh (§8 blocker 4,
   effort M).

Also unchanged and deliberately so: billing is subsidy-only (no Stripe; alpha
users run on `admin.grant`), and identity/reco are reachable only on
`workers.dev` because their `smithers.sh` CNAMEs still point at dead Vercel
records.

---

## H1 — Decide the alpha entry point

**Decision, not work.** Two options:

**Option A: keep `canary.smithers.sh`.** Zero extra work. The Worker is already
bound to it (`apps/server/wrangler.jsonc:9`, `custom_domain: true`), the
GitHub OAuth callbacks are registered, and the Smithers Cloud connection already
exists through the gateway seam. H2 then deploys as-is.

**Option B: stand the Worker up on a Smithers Cloud hostname.** Repoint the route and
repeat the wave-7 secret inventory. This is a deliberate identity change, not a
routine deploy:

```sh
# 1. Edit the route (and ONLY the route — never the `name`).
#    apps/server/wrangler.jsonc:9
#      "routes": [{ "pattern": "<Smithers Cloud-hostname>", "custom_domain": true }]
```

Read `apps/server/DEPLOY.md` § "Frozen identity" first. The Worker `name`
(`smithers-mvp-web`) must not change: two Durable Objects (`TURN_CANCELS`,
`GATEWAY_SESSIONS`) hold state keyed to that identity, and a rename creates a
fresh Worker with empty DO storage — the existing state is orphaned, not
migrated. Removing or changing the `routes` entry detaches `canary.smithers.sh`
from this Worker; the rollback path is in the `wrangler.jsonc:5-8` comment.

Then repeat the wave-7 secret inventory against the new hostname:

```sh
# Per-worker secret inventory, from apps/server
CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 bun x wrangler secret list
# Confirm the zone/route binding moved
CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 bun x wrangler deployments list
```

Re-register the GitHub OAuth callback for the new host on GitHub App
`Iv23liwHER62HVHMWcGS` at `/api/auth/github/login/callback` — sign-in breaks
without it.

**Either way, align the marketing links.** `jjhub.tech` currently points at
`code.smithers.sh` (the `../multi` worker), which is not this app. Repoint those
links at whichever entry point you choose, or invited users land on the wrong
product.

**Blocks:** H2, H3 (the identity upstream is unchanged either way, but the
allowlist should be seeded against the origin users will actually visit), H4.

---

## H2 — Run the credentialed deploy

U4 landed the pipeline; it has never been run with credentials. Runbook:
**`apps/server/DEPLOY.md`**.

Prove the pipeline first — no credentials needed, nothing published:

```sh
cd "$(git rev-parse --show-toplevel)"
pnpm run deploy:dry
```

That runs the real `vite build` and `wrangler deploy --dry-run`, and writes a
receipt to `apps/server/deploy-receipts/dry-run/`.

Then the real run. Both variables are required: `wrangler.jsonc` declares no
`account_id`, so a multi-account token cannot pick one non-interactively.

```sh
export CLOUDFLARE_API_TOKEN=<token>          # Workers Scripts + Workers Routes edit
export CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827
cd "$(git rev-parse --show-toplevel)"
pnpm --filter smithers-server run deploy
```

**Do not edit `apps/server/wrangler.jsonc`'s `name` as part of this.** The
Worker identity is frozen to protect the two Durable Objects. If H1 chose
Option B, the `routes` edit is a separate, already-reviewed commit — not a
side effect of the deploy.

**Verify:** the command prints the new Version ID and the receipt path
(`apps/server/deploy-receipts/latest.json`). Confirm the chosen origin serves
the new build by matching its `Current Version ID` against the receipt.

**Rollback:** `bun x wrangler rollback --message "rollback to <git sha from
receipt>"` from `apps/server`, same token. Durable Object state is unaffected
either way.

**CI path:** `.github/workflows/apps-deploy.yml` runs the same script on every
push to `main`, after the apps gates. It attempts a real deploy only when the
`production` environment holds `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; otherwise it runs the dry path. See
`apps/server/DEPLOY.md` "CI (every push to main)".

---

## H3 — Seed the invitee allowlist and grant balances

U5 landed the batch door and its tests; the real invitee list has never been
seeded. Runbook: **`apps/server/INVITES.md`**. Script:
**`apps/server/scripts/seed-allowlist.mjs`**.

Put one GitHub login per line in a file (blank lines and `#` comments are
skipped), then preview with no credentials and no network call:

```sh
cd "$(git rev-parse --show-toplevel)"
pnpm --filter smithers-server run seed:allowlist -- --file invitees.txt --dry-run
```

Then seed for real:

```sh
IDENTITY_UPSTREAM_URL=https://smithers-cloud-identity.willcory10.workers.dev \
IDENTITY_ADMIN_TOKEN=<identity's ADMIN_SERVICE_TOKEN> \
pnpm --filter smithers-server run seed:allowlist -- --file invitees.txt
```

`IDENTITY_ADMIN_TOKEN` is the identity Worker's `ADMIN_SERVICE_TOKEN`, a
write-only Cloudflare secret on that deployment — it is not in this repo and
not in `wrangler.jsonc`. Get it from wherever that secret is held.
`--logins alice,bob,carol` works instead of `--file`. `--action remove`
revokes. `--requester <login>` sets audit attribution. Full flags:
`node apps/server/scripts/seed-allowlist.mjs --help`.

**Then grant balances.** Billing is subsidy-only for the alpha, so every
invitee needs a grant or they hit U6's zero-balance pause on their first
workflow launch. From an admin session in the deployed app:

```
/admin.grant 25 <login>
```

then confirm the card it renders (`/admin.grant.confirm <cardId>`, or click
through). Repeat per invitee.

**Stragglers** who were missed go through door 1 rather than a re-seed: the
user runs `/auth.request-access`, you read the queue with `/admin.requests` and
approve with `/admin.queue.approve <login>`. That path is covered end to end by
`apps/server/src/invite-mechanics.test.ts`.

---

## H4 — Re-run the launch checklist against the deployed target, then go/no-go

U7 landed the headless runner; it has never been run against a live origin
(this track was forbidden from touching live canary). Runbook:
**`apps/app/scripts/README.md`**. Needs a real GitHub session.

Mint the session cookies from a real browser sign-in — `apps/app/scripts/launch-mint-session.ts`
writes a storage-state file you can format as `name=value; name2=value2`. You
need **two** sessions: a normal one, and one parked at $0 for D-4.

```sh
cd "$(git rev-parse --show-toplevel)"
CHECKLIST_SESSION_COOKIE='smithers_session=<normal session>' \
CHECKLIST_ZERO_BALANCE_BEARER='smithers_session=<zero-balance account session>' \
CHECKLIST_BILLING_UPSTREAM_URL=<billing origin> \
CHECKLIST_BILLING_ADMIN_TOKEN=<billing admin token> \
pnpm run checklist -- --target <the H1 origin>
```

All 32 rows have a probe. The §A/§B/§C/§F rows plus D-3 and D-4's pause half
drive a real headless Chrome page on the target over the DevTools protocol; no
browser is downloaded, so a system Chrome/Chromium must be installed (or pass
`--browser <path>` / set `$CHECKLIST_BROWSER`). D-1/D-2 and the §E rows are
HTTP.

**D-4 is the row that has never been tested.** It asserts both halves: the turn
seam still answers at $0 (chat is complimentary), and a workflow launch on the
$0 session is refused into the transcript with the zero-balance pause statement
instead of starting a run. It reports `not-testable-yet` if
`CHECKLIST_ZERO_BALANCE_BEARER` is missing — that is not a pass. Make sure the
zero-balance account is genuinely at $0 before the run.

The run writes `launch-checklist-report.json` and `.md` under
`apps/reports/launch-checklist/<timestamp>Z-run/`. Exit code is `1` if any row
is `fail`. A `not-testable-yet` row always carries a named reason; read them
rather than treating them as passes.

**A-8 and A-9 are gone.** The recommendation card (the first-run digest and
the one ranked recommendation) was deleted with the recommendations feature
on 2026-08-24, and those rows went with it. The watched-repos chooser is the
whole first-run surface now.

**Final go/no-go.** Ship when:

- every checklist row is `pass`, or its `not-testable-yet` reason is one you
  accept in writing;
- D-4 passed with a real zero-balance bearer;
- an invited login can sign in, reach the app, and see its granted balance;
- you have decided whether to launch with the two plue-side blockers open. The
  missing AI-provider credential on the gateway VMs means agent workflows do
  not complete — if the alpha demo is "make me a workflow", that is a no-go
  until plue lands it, independent of everything in this track.

Raise the result on the run's `smithers ask-human` gate.

---

## H5 — Configure the signed-in canary

The `Canary` workflow runs on schedule without this, but its browser check and
metered turn report `skip` until these exist. Runbook:
**`apps/app/docs/BROWSER-CANARY.md`**; account rules:
**`apps/server/DEPLOY.md`** (the canary and e2e suites sign in as a
scoped-down user).

1. A scoped-down account: remove `codeplanesmithers` from the identity Worker's
   `ADMIN_LOGINS`, or create a second GitHub account for the canary. It must
   not be on `CANARY_ALLOWLIST_LOGINS` or hold a maintainer claim.
2. A private fixture repository owned by that account, a workspace UUID in it,
   and a safe, input-free flow that runs at least 20 seconds and completes
   without approval or repository mutation.
3. Repository secret `CANARY_SESSION_COOKIE`: that account's session cookie
   header.
4. Repository variables `CANARY_SESSION_LOGIN`, `CANARY_ALLOWLIST_LOGINS`,
   `CANARY_BROWSER_REPO`, `CANARY_BROWSER_WORKSPACE`, `CANARY_BROWSER_FLOW`.
5. Rotate the cookie before the session expires; an expired cookie fails the
   canary and opens the alert issue.

Done when a `Canary` run's browser and `turn-seam first-frame latency` rows
read `ok`, not `skip`.

---

## H6 — Adopt the Alchemy 1 Workers and add the docs deploy secrets

`apps/bug-worker`, `apps/review` and every `apps/docs/<slug>` site pin their
live Alchemy 1 names, keep state in the account's shared `alchemy-state-store`
and run stage `prod`. Until the first adoption, each live Worker lacks the
Alchemy 2 ownership tags and a plan without `--adopt` fails with
`OwnedBySomeoneElse`. From a shell holding `CLOUDFLARE_API_TOKEN`,
`ALCHEMY_PASSWORD` and each stack's secrets (listed in its `alchemy.run.ts`):

```sh
pnpm -C apps/bug-worker run plan --adopt     # read it, then:
pnpm -C apps/bug-worker run deploy --adopt
pnpm -C apps/review run plan --adopt         # read it, then:
pnpm -C apps/review run deploy --adopt
pnpm docs:deploy --adopt                     # 48 adoptions; plan-store is created
```

Pass flags straight after the script name: `-- --adopt` hands Alchemy a file
named `--adopt`.

Then add repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit,
Workers KV:Edit, Zone:Read on smithers.sh) and `ALCHEMY_PASSWORD` (the value
used above). The Release workflow's `docs-deploy` job fails on a tag push
without them.

Done when the bug Worker's bindings in the Cloudflare dashboard list
`REPO_COMPLETIONS`, `curl -sI https://plan-store.smithers.sh/` answers 200,
and a second checkout's `pnpm -C apps/bug-worker run plan` shows no changes.
