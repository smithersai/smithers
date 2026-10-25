# Sandbox budgets

Limits on how many branch machines are awake and what a month of them costs (ruling AUTH-5, [decision 0103](../decisions/0103-sandbox-budgets.md)). Will, 2026-10-19 22:45: "Add this as a TODO but we won't worry about this until we ship." The numbers are the ones he was shown at 22:43; an Admin changes them in Settings with no deploy.

| Limit | Default | At the limit |
|---|---|---|
| Machines awake in the deployment | 20 | a machine that would start waits for a free one |
| A person's own branch machines awake | 2 | the same |
| Monthly sandbox spend alert | $100 | every Admin is told in their notifications, and by email and Telegram where an Admin set them |

## The ledger

`sandbox_generations` (`db/migrations/0062_sandbox_budgets.ts`, `worker/branch/Budget.ts`) holds one row per awake machine: its branch, the person it was woken for, its kind, its instance type and generation, when it started, when `sandbox/Keep` last found it awake (`seen_at`) and when it ended. A branch has at most one open row, as it has one machine.

```
a call, a command's start or a terminal  ─▶ SandboxObject.wake ─▶ running? ── yes ──▶ the tool runs
                                                                     │ no
                                                                     ▼
                                         Budget.admit (one transaction, advisory lock)
                                            │ the branch's slot live ─▶ admitted
                                            │ awake < 20 and, for a branch's own machine, the person's < 2 ─▶ admitted, slot opens
                                            └ else ─▶ Waiting: the step tries again (SandboxUnavailable `waiting`)
                                         admitted ─▶ the container starts ─▶ Budget.started: generation, instance type
sandbox/Keep, every minute ─▶ busy ─▶ Budget.seen (renews the slot) · slept or gone ─▶ Budget.ended
```

- **Awake** means open and renewed within `LEASE_SECONDS` (5 minutes). A machine whose keep-awake died stops counting once its lease lapses; its branch's next admission closes the row at its last renewal.
- **Per person** counts only a branch's own machines (terminals and tool calls) woken for that person. A TODO's machine, a pull request's check job and a CI job count toward the deployment's limit only, so a person's background work never locks them out of their own terminal. CI's own owner is no person.
- **The hard cap.** Cloudflare's `durable_object` scheduling policy has no `max_instances`: "The `durable_object` policy does not support `max_instances`" ([scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)), and Alchemy refuses the prop for it. So the admission is the cap, and it fails closed: a wake that can't ask Postgres starts no machine and is tried again. Cloudflare's account limits stay the last stop.
- **Fails safe the other way too.** A wake that fails before its container starts gives its slot back (`Budget.release`); one that started keeps it until `sandbox/Keep` ends it.

## Waiting for a sandbox

`terminal/Open` holds its machine before it wakes it (`sandbox/Admit`). With none free, the terminal's row says `waiting` and the step asks again from 5 s, doubling to 30 s, for 30 minutes (`ADMIT_WAIT_SECONDS`). The branch page keeps Open terminal disabled and says **Waiting for a sandbox**. Once a machine is free the row records `admitted_at`, and the open's 180 s deadline counts from then. A tool call or a command that finds no machine free is tried again within its own step's retries and settles `unavailable` after them.

## The spend alert

`ops/SandboxSpend` (`worker/flows/SandboxSpend.ts`) runs once an hour: every `FlowExecution` alarm starts its window's run once it is done, as the database sample does.

```
ops/SampleSandboxSpend ─ the month's machine time priced, machines awake, the Admins' alert ─▶ under: done
                         └ at or over ─▶ ops/BellSandboxSpend (a `spend` notification for each Admin)
                                         ops/DeliverSandboxSpend × { email, telegram } (worker/flows/AlertDelivery.ts)
```

- **Price.** Each row's awake time within the UTC calendar month, times its instance type's vCPUs, memory and disk at Cloudflare's prices ($0.000020 a vCPU-second, $0.0000025 a GiB-second, $0.00000007 a GB-second, [pricing](https://developers.cloudflare.com/containers/pricing/)), with the CPU priced as if always busy: an upper bound, so the alert never comes late. A `standard-1` machine is about $0.074 an awake hour. A live row counts to now; a lapsed one to its last renewal.
- **Once a month per limit.** The alert's id is `sandbox-spend-<month>-<limit>`: a later hour finds every bell row and receipt already there. Raising the limit mid-month alerts again once the spend reaches the new one.
- **Where it shows.** In each Admin's bell (Admins with a live session), opening Settings, never as a toast. By email and Telegram through the channels an Admin set ([spend alerts' channels](spend-alerts.md#channels)), with receipts in Settings. The message: `Sandbox spend · $104.20 this month · alert at $100` and the link to Settings.

## The limits

An Admin sets the three numbers at **Settings → Sandboxes** and presses Save (`sandbox/limits`, person-only; an agent never changes them). `POST /api/sandbox-limits` writes the one `sandbox_limits` row; `GET /api/shapes/sandbox-limits` syncs it to Admins only. The next admission and the next hourly sample read it. Bounds: 1 to 1,000 awake, 1 to 100 per person, $0 to $1,000,000 a month ($0 turns the alert off).

## Records

`sandbox.budget`, `smithers_sandbox_admissions`, `smithers_sandbox_awake`, `sandbox.spend`, `smithers_sandbox_spend_usd` and the rest are listed in [observability.md](../observability.md#sandbox-budgets). None carries a person's id.

## Tests

| Test | Proves |
|---|---|
| `worker/branch/Budget.test.ts` | the defaults and an Admin's limits; admission to the deployment's limit and the person's, kinds that don't count per person, a live slot kept at the limit, a lapsed one closed; eight concurrent admissions never pass a limit of three; a machine's slot from admission to start, renewal, end and release; the month's spend priced by instance type, within the month only; its records; Postgres down fails the admission |
| `worker/branch/BudgetApi.test.ts` | an Admin sets the limits; every refusal; the shape to Admins only |
| `worker/flows/TerminalOpen.test.ts` | the terminal's wait: `waiting`, asked again, admitted, its deadline from then; Postgres down; the admission before the wake |
| `worker/branch/Terminals.test.ts` | a waiting terminal keeps the person's place for the wait; an admitted one has its deadline from the admission |
| `worker/flows/SandboxKeep.test.ts` | a busy machine renews its slot; a refused renewal is logged and the keep goes on; sleep closes only its generation's slot |
| `worker/flows/SandboxSpend.test.ts` | under, at and off; every Admin's bell and never a Member's or an ended session's; one email and one Telegram message, once a month; a provider down then up; the start once an hour |
| `src/features/terminal/*.test.ts` | Waiting for a sandbox in the panel; a waiting row stays opening past the open's deadline; a row that starts waiting while watched |
| `src/features/spend/spend.test.ts` | Save sets the limits and they sync back; a save that can't land stays Not saved; a Member's is refused |
| `src/features/attention/entries.test.ts` | a spend alert is listed in the bell and never a toast |

## Not built

- Snapshot retention for branches untouched in 30 days: snapshots aren't built ([sandbox tools](sandbox-tools.md#whats-not-built)).
- A waiting sandbox call or command says nothing in the conversation; only the terminal says Waiting for a sandbox.
