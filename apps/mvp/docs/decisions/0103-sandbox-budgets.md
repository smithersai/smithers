# 0103: Sandbox budgets

Status: accepted (2026-10-25). Implements ruling AUTH-5, decided at ship: Will, 2026-10-19 22:45, "Add this as a TODO but we won't worry about this until we ship." Answers [0005](0005-sandboxes-secrets-and-the-forge.md) question 3 with the numbers Will was shown at 22:43; he may change them, and an Admin changes them in Settings without a deploy. Feature page: [sandbox budgets](../features/sandbox-budgets.md).

## Decision

1. **Limits.** At most 20 machines awake in the deployment and 2 of a person's own branch machines. A machine that would pass a limit waits. A monthly sandbox spend alert at $100. All three live in one `sandbox_limits` row an Admin sets in Settings (`sandbox/limits`, person-only); no row means these defaults.
2. **A ledger, renewed by the keep-awake.** `sandbox_generations` has one open row per awake machine. `sandbox/Keep`, which already asks every awake machine each minute, renews it while busy and closes it on sleep. A row nobody renewed for 5 minutes stops counting, so a lost keep-awake never holds a slot.
3. **One admission, in the machine's own object.** Every path that starts a machine (a terminal, a tool call, a command, a TODO's tools, check and CI jobs) goes through `SandboxObject.wake`, so the admission lives there, before a stopped container starts, in one Postgres transaction under an advisory lock. A running machine needs none.
4. **The admission is the hard cap.** Cloudflare's `durable_object` scheduling policy has no `max_instances` ("The `durable_object` policy does not support `max_instances`", developers.cloudflare.com/containers/configuration/scheduling-policy/), and Alchemy refuses the prop for that policy. So `infra/BranchSandbox.ts` carries no `maxInstances`, and the admission fails closed: a wake that can't ask Postgres starts nothing and is retried. The callers' steps already need Postgres for their own journals.
5. **Per person counts a branch's own machines only.** TODO, check and CI machines count toward the deployment's limit only, so a person's background work never locks them out of their terminal.
6. **A terminal waits; other callers retry.** `terminal/Open` holds its machine first (`sandbox/Admit`, up to 30 minutes) and its row says `waiting`, shown as "Waiting for a sandbox". A tool call or command retries within its own step's policy and settles `unavailable` after it. Waiting is a retryable `SandboxUnavailable` (`waiting`), so no new failure reaches the flows that don't wait.
7. **Spend is priced from the ledger, as an upper bound.** Awake time by instance type at Cloudflare's per-second prices, CPU as if always busy. Cloudflare reports no per-application usage to a Worker, and an upper bound never alerts late.
8. **The alert goes where alerts go, never as a toast.** `ops/SandboxSpend`, hourly like `ops/DatabaseLoad`, puts a `spend` notification in each Admin's bell and delivers through `AlertDelivery` to the email and Telegram channels, once per month and limit.

## Why

- Nothing capped sandbox cost at ship: a runaway agent or a forgotten terminal could keep containers awake without bound.
- The keep-awake already visits every awake machine each minute; reusing it as the lease's renewal adds one update, not a new loop (DUR-2).
- Putting the admission in the object, not in each flow, covers every path, including paths added later.

## Consequences

- A deployment that sets 1,000 awake still stops at Cloudflare's account limits.
- A lost keep-awake undercounts its machine until Cloudflare's 30-minute inactivity timeout stops it.
- The spend is an estimate; the Cloudflare bill is the truth.
- Library catalog entries used: `@smthrs/flow` (the steps and retries), `@smthrs/notifications` (`Channels`, through `AlertDelivery`), `@smthrs/effect-electric` and `@smthrs/effect-tanstack-db` (the limits' shape and Settings), `@smthrs/ui`.
