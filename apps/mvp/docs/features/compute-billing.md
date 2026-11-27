# Cloud Compute Billing & Prepaid Credits

Third-party contributors can either bring their own agent for free over MCP ([0173](../decisions/0173-byoa-only-mcp-attach-and-jev-config.md)) or purchase prepaid compute credits to run Cloudflare branch sandboxes, terminals, sandbox tools, TODO runs, and CI jobs on repositories and forks where they hold Member+ permission ([0175](../decisions/0175-third-party-contributors-paid-compute-and-forks.md)).

## Pricing & Metering

- **Rate:** `2×` Cloudflare Containers pricing (`COMPUTE_PRICE_MULTIPLIER`, default `2`). For `standard-1` (0.5 vCPU, 4 GiB, 8 GB disk), this is `41.12 micro-USD/sec` (~`\$0.148/hr`).
- **Free tier:** `\$0` free cloud sandbox credit. Deployment Members of `GITHUB_REPOSITORY` continue using deployment-funded machines (`billing_mode = 'deployment'`).
- **Top-up packs:** `pack_10` (`\$10`), `pack_25` (`\$25`), `pack_50` (`\$50`) via Stripe Checkout.
- **Hard cap:** Minimum balance to wake a paid sandbox is `\$0.05` (`50_000` micro-USD). `sandbox/Keep` bills incremental elapsed seconds on every 60-second `Budget.seen` tick; when balance hits `0`, the container checkpoints and sleeps immediately.

## Routes

| Route | Auth | Description |
|---|---|---|
| `GET /api/billing/account` | Signed in | Balance, lifetime totals, compute access mode, packs, hourly rates, Stripe status, recent ledger |
| `POST /api/billing/checkout` | Signed in (person-only) | Creates a Stripe Checkout session for `{ packId }` and returns `{ url, sessionId }` |
| `POST /api/billing/webhook` | Stripe `Stripe-Signature` | Verifies HMAC-SHA256 signature and starts idempotent `billing/CreditTopUp` |
| `POST /api/billing/admin/grant` | Deployment Admin (person-only) | Starts durable `billing/AdminGrant` to grant compute credits by GitHub login |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | none | Stripe secret API key; unset disables Checkout (`503 not_configured`) |
| `STRIPE_WEBHOOK_SECRET` | none | Stripe webhook signing secret (`whsec_...`) |
| `STRIPE_API_URL` | `https://api.stripe.com` | Stripe API base URL (overridable for tests) |
| `COMPUTE_PRICE_MULTIPLIER` | `2` | Multiplier over Cloudflare Containers base rate |
