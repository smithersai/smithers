# 0144: Runners admit at half load; overflow goes to Cloudflare

Date: 2026-11-01. Status: accepted; the box waits on a release of `@smthrs/cli` (see "Still open"). Builds on
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

## The box (built 2026-11-01)

1. **Token.** An Admin in person turns overflow on: `PUT /api/repos/<owner>/<name>/overflow/cloudflare
   { connectionId, profile, argv, labels?, minQueuedSeconds?, capacity? }`. The route mints the runner token,
   seals it under SECRETS_KEY, and starts `admin/SetOverflow`. That flow registers the token's SHA-256 as the runner
   `cloudflare-overflow` and keeps the setting with the sealed token (`repo_overflow`, migration 0086). Each PUT
   rotates the token; `DELETE` retires it. No person, journal or log sees it.
2. **API key.** `SandboxEgress.forwardOverflow` gives the box two placeholders, derived as a subscription's are. It
   binds the token to the deployment's host and the Admin's BYOK `api_key` connection to its base URL's host. Each value
   opens per request; the same `Egress.forward` substitutes, refuses, scrubs and audits. The box gets no repository
   secret.
3. **Wake and sleep.** The job store's probe wakes `overflow-<repo>` through `Sandboxes.wake` once a queued job has
   waited `minQueuedSeconds` and the overflow runner hasn't asked in 45 s. The wake goes through the sandbox admission,
   kind `overflow`, so the 20-awake cap and the spend alert hold. The box starts on `OVERFLOW_INSTANCE` (`standard-4`),
   writes the plan (`Overflow.boxPlan`) and starts `smthrs runner serve`. The runner ends after 300 s with no job;
   `sandbox/Keep` then finds the box idle and stops it.
4. **Image.** `infra/sandbox/Dockerfile` adds jj and the Claude Agent ACP adapter. It installs `@smthrs/cli` only when
   `SMTHRS_VERSION` is set: no published version has `smthrs runner` yet.

Proof: `worker/runners/Overflow.test.ts` (the setting, egress and wake) and `worker/runners/TodoRunner.test.ts`
"overflow on Cloudflare". In the second, a held attached runner leaves the job. The box's runner, started from the
plan's files with only placeholders, claims it through the egress. Its agent asks a fake model through the egress with
the placeholder key. The job settles Done and merges. The container's network is the test's: two local intercepts
stand in for Cloudflare's.

## Still open

- **A release.** `@smthrs/cli` with `smthrs runner` and `idleExitSeconds` must be published, and `SMTHRS_VERSION`
  set in the Dockerfile. Until then a woken box logs `sandbox.overflow` `no_runner` and sleeps.
- **A real-container run.** Nothing yet runs the box under `alchemy dev` with Docker. The Mac mini has no Docker.
- Will's preference that model calls egress through our Macs conflicts with the 21:10 "no subscription relay"
  ruling, and needs a public Mac endpoint. Will decides it; API-key overflow doesn't need it.
