# 0144: Runners admit at half load; overflow goes to Cloudflare

Date: 2026-11-01. Status: accepted for admission and the overflow claim; the container box is proposed. Builds on
[0136](0136-external-agents-on-runners.md) (external agents on runners), [0143](0143-fleet-and-alerts.md) (the fleet)
and [0103](0103-sandbox-budgets.md) (sandbox budgets). Ruling (Will, 2026-11-01): "bare metal at half load, overflow
on Cloudflare".

## Problem

A runner claims while `running < capacity`, a fixed count. On 2026-11-01 nyc-01 had 48 cores at load 207, about 4x
over half load, and still had room by count. Machine limits block agent work two ways: an overloaded host slows every
job on it, and a full fleet leaves jobs Waiting with nowhere else to run.

## Decision

1. **The runner admits by its own machine.** It claims only while its one-minute load, smoothed over 30 s, plus 1 for
   each job it claimed in the last 120 s (fading as that job's load shows), stays under `loadPerCpu` x CPUs (0.5), and
   its disk keeps `diskFloorGb` free (40). Both live in its `runner.json`. `capacity` stays the hard cap.
2. **The host stays vendor- and machine-neutral.** A held or full runner still claims with `free: 0` and says why,
   `machine.held: "load 31/24"`. The route keeps it on `runners.held`; the fleet shows **Held · load 31/24**.
3. **Overflow is a runner that asks later.** A claim may carry `minQueuedSeconds`; the route then hands out only a job
   claimable that long. An overflow runner is plain `smthrs runner` with `minQueuedSeconds` (N, say 60) and the
   `cloudflare` label. A job waits N seconds only when no attached runner took it, so the route never asks which
   runners are held or full. Retry generations stay pinned to their first runner and never overflow.
4. **What runs in a box: API-key agents only.** The lead ruled that product coding uses a normal API key
   (`docs/work/mac-mini-subscription-routing.md`, 21:10). The egress swaps header values on exact hosts
   ([secrets.md](../features/secrets.md)), so a key reaches its vendor without entering the box. A login on a runner
   host's disk (Claude Max, ChatGPT `auth.json`) can't move into a box. Its profile runs only on attached runners, and
   its overflow is waiting.
5. **The box is `standard-4`,** 4 vCPU, 12 GiB, 20 GB. The overflow runner sets `diskFloorGb` to 5, because 40 is
   more than the box has.
6. **Budget is unchanged.** Each overflow box takes one of the 20 awake slots (`worker/branch/Budget.ts`), and the
   $100/month alert prices it. Cost per job-hour on `standard-4`
   ([pricing](https://developers.cloudflare.com/containers/pricing/)): $0.40 at full CPU, $0.26 at half. The alert
   therefore fires after about 250 to 390 overflow job-hours a month. Neither limit blocks the slice. If overflow
   becomes routine, the alert is the signal to add metal.

## Built and proven

- `smthrs runner` admission, with `packages/smithers/test/RunnerAdmission.test.ts` (injected readings, a real runner
  against a loopback host). The claim route stores `held` (migration `0085_runner_held`), with
  `worker/runners/Fleet.test.ts`. The fleet's Held row is covered by `plugins/fleet/src/model.test.ts`.
- `minQueuedSeconds`. `worker/runners/TodoRunner.test.ts` "half load and overflow" runs an attached runner held by its
  disk floor and an overflow runner labelled `cloudflare`, both real `smthrs runner` processes. The TODO's job waits
  3 s, the overflow runner claims it, and the job settles Done and merges.

## Not built: the box itself, and why

The overflow runner above is a local process. Running it in a Cloudflare container needs three things that don't
exist:

1. **A runner token in a box.** An Admin registers a token's SHA-256 in person, and the token never leaves its machine
   (0136). No path gives a box a runner bearer. The candidate is a repository secret bound to the deployment's own
   host and swapped by the egress, but that is unbuilt and untested.
2. **An API key in a box.** The egress substitutes only `claude_subscription` and `codex_subscription` connections
   (`worker/personal/Subscriptions.ts`). An `api_key` connection has no placeholder path. Today the only route is an
   Admin's repository secret bound to the vendor host with `SANDBOX_SECRETS` on.
3. **An image and a waker.** `infra/sandbox/Dockerfile` has no `smthrs`, no `jj` and no ACP adapters. Nothing wakes a
   box when a job has waited N seconds. The job's parked probe (`Jobs.status`) is the natural place.

Will's preference that model calls egress through our Macs conflicts with the 21:10 "no subscription relay" ruling.
It also needs a public Mac endpoint for the egress to reach. Will decides it.
