# 0175: 3rd-Party Contributors — Paid Cloudflare Compute Credits, One-Click Forks, and Onboarding

Date: 2026-11-27. Status: accepted (approved by Will 2026-11-27). Amends [0122](0122-who-may-ask.md) §5 (machines no longer deployment-Member only when the caller holds paid compute credits) and builds on [0103](0103-sandbox-budgets.md) (sandbox budgets), [0079](0079-roles-per-repository.md) (per-repository roles), and [0173](0173-byoa-only-mcp-attach-and-jev-config.md) (BYOA over MCP).

## Context

Third-party contributors who do not hold Member+ permissions on `GITHUB_REPOSITORY` hit three walls today:

1. **Unclear getting-started flow.** Landing (`/`), first-run (`/app`), and non-maintainer repository pages end in bare `"Members can clone"` / `"Members can ask Smithers"` / `"Open your repository"` prompts without explaining how a contributor participates: either **Bring Your Own Agent (free over MCP)** or **Fork & run on Cloud Sandboxes (paid credits)**.
2. **No one-click Fork experience.** Contributors must manually fork on GitHub, install the Smithers GitHub App, and navigate back; forks have no upstream sync or upstream PR shortcut.
3. **Cloudflare sandboxes & remote jobs are deployment-Member only** (0122 §5). Even after forking a repo and becoming `admin` on their fork, attempting to open a terminal, call sandbox tools, or commit a TODO returns `403 members_only ("Members can run machines.")`.

## Decision

### 1. Prepaid Compute Credits via DI `BillingProvider` (Stripe Checkout)

- **Exact integer ledger in micro-USD (`1 USD = 1_000_000` micro-USD)** in Postgres (`db/migrations/0136_compute_billing.ts`):
  - `compute_accounts`: per-person `balance_micro_usd` (`CHECK (balance_micro_usd >= 0)`), `lifetime_purchased_micro_usd`, `lifetime_spent_micro_usd`, `stripe_customer_id`, `updated_at`.
  - `compute_ledger`: immutable append-only audit log (`topup`, `sandbox_usage`, `admin_grant`, `refund`), unique `idempotency_key` preventing double-credit or double-debit on webhook/step replay.
  - `compute_checkout_sessions`: tracks pending/completed/expired Stripe Checkout sessions.
  - `sandbox_generations` gains `billing_mode` (`deployment` | `paid`), `billed_seconds`, and `billed_micro_usd`.
- **Pricing & free tier (Will, 2026-11-27):**
  - **\$0 free cloud sandbox credit** — BYOA local agent (`smthrs node serve` / MCP) is always free.
  - **2× Cloudflare Container cost** (`COMPUTE_PRICE_MULTIPLIER`, default `2`), e.g. `standard-1` ≈ `\$0.148/hr` (~\$0.15/hr).
  - **Prepaid top-up packs:** `pack_10` (\$10), `pack_25` (\$25), `pack_50` (\$50).
  - **Hard cap at \$0:** Minimum admission balance `MIN_ADMIT_MICRO_USD = 50_000` (\$0.05). Every `Budget.seen` renewal (60 s) atomically debits incremental usage for `billing_mode = 'paid'` generations; when balance reaches `0`, `Budget.seen` signals `{ exhausted: true }` and `sandbox/Keep` gracefully checkpoints and sleeps the container. `Budget.ended` settles final seconds idempotently.
- **Deployment Members unchanged:** Members+ of `GITHUB_REPOSITORY` continue using `billing_mode = 'deployment'` at zero personal cost under `sandbox_limits`.
- **Dependency-injected `BillingProvider` service** (`worker/billing/BillingProvider.vibe` + `StripeProvider.vibe`):
  - Effect-native `HttpClient` to Stripe Checkout API and constant-time WebCrypto HMAC-SHA256 webhook verification (`Stripe-Signature`, 5-minute replay window).
  - Gated cleanly on `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` via Effect `Config`. Without keys, checkout returns `503 not_configured` while balance, rates, ledger, and Admin credit grants (`POST /api/billing/admin/grant`) still work.
- **Durable flows:** `billing/CreditTopUp` (webhook-triggered, idempotent on event id) and `billing/AdminGrant` (Deployment Admin person-only).

### 2. Unified Machine Admission (`ComputeAccess`)

All five machine gates (`Terminals`, `SandboxCalls`, `SocketChecks`, `stack/Api`, `RemoteRuns`) check `ComputeAccess.check(actor)`:
- Deployment Member+ → `allowed (mode: "deployment")`.
- Non-member with `balance_micro_usd >= MIN_ADMIT_MICRO_USD` (and Member+ role on the target repository/fork) → `allowed (mode: "paid")`.
- Non-member without sufficient credits → `402` / `403 { code: "credits_required", balanceMicroUsd, message: "Add cloud credits in Settings or attach your own agent via MCP." }`.

`GET /api/auth/session` includes `computeAccess` (`"deployment" | "paid" | "none"`) and `computeBalanceMicroUsd` so the UI immediately renders accurate CTAs without extra round trips.

### 3. One-Click Fork & Upstream Workflow

- Extend `@smthrs/integrations` (`GitHub.Forks`) with `create(owner, repo)` and `syncUpstream(owner, repo, branch)` validated through `repositoryPath`.
- Persist contributor forks in `repo_forks` (`db/migrations/0137_repo_forks.ts`).
- `POST /api/repos/<owner>/<name>/fork` (signed-in person-only, uses their session GitHub token) records the fork attempt and starts durable flow `repo/Fork` (`fork/CreateOnGitHub` → `fork/CheckAppInstall` → `fork/Settle`), returning `202` immediately.
- `GET /api/repos/<owner>/<name>/fork` returns the person's fork state (including `forkOwner`, `forkName`, `appInstalled`, `installUrl`).
- `POST /api/repos/<owner>/<name>/sync-upstream` (fork Member+, person-only) syncs the fork's default branch with upstream via `GitHub.Forks.syncUpstream`.
- On a fork, the repo header displays `Forked from upstream/repo`, a one-click **Sync upstream** button, and an **Open upstream PR** link.

### 4. Contributor Onboarding & Minimal-Text UX

- **Landing (`/`):** Keep the stylized wordmark and primary CTA; add a concise 3-card overview (**Bring your own agent · Free**, **Fork & maintain · Your repo**, **Cloud sandboxes · Pay as you go**).
- **First-Run (`/app`):** Non-members see guided steps: Sign in → Pick or fork a repository (with quick links for featured repos) → Choose how to run (BYOA Free via MCP or Add Cloud Credits).
- **Repo header & gates:** Signed-in non-maintainers see a one-click **Fork** button (transitioning to **Open your fork →** once forked), plus actionable `credits_required` prompts linking straight to `/app/settings#billing` or Connect Agent.
- **Settings (`/app/settings`):** Every signed-in user sees **Cloud compute & credits** (balance, rate table, \$10/\$25/\$50 Stripe top-up buttons, usage ledger, and free BYOA alternative). Deployment Admins additionally see a **Grant credits** control.

## Observability

- Counters: `smithers_compute_billing_requests`, `smithers_compute_credits_micro_usd`, `smithers_compute_debits_micro_usd`, `smithers_compute_exhausted_sleeps`, `smithers_repo_forks`.
- Structured logs & spans (`billing.checkout`, `billing.webhook`, `billing.charge`, `billing.grant`, `repo.fork`, `repo.sync_upstream`) carry only outcomes, pack ids, micro-USD amounts, and durations — never Stripe secrets, GitHub tokens, or user payloads.
