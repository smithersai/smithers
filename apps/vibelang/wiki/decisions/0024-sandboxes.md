# 0024. Sandboxes with monthly minutes

Status: implemented in mock mode and as an opt-in Container host; live compute fails closed pending the 0019
session/policy adapter and the deployment's binding. A test stage with a real Container binding (`vl-test`) and its
on-demand suite are written and await their first deploy; no real-container success is claimed until that run.
Rulings: VL-4, VL-5, VL-7 to VL-14, VL-17, VL-21, VL-23, VL-25, VL-29, VL-35; ARCH-14, ARCH-16.

## One capability, shared flows

Factory exposes sandbox read, start, stop and command. The chat pane, `/sandbox`, the scripted mock agent and the
CLI/MCP registry use those methods. Start, Stop, Command and Meter are typed `@smthrs/flow` declarations. Mock mode
runs them on the real memory engine; the live allowance object runs them on the engine in its SQLite. A read first
runs Meter; projection reads do not mutate usage. An alarm retries metering and failed Stop operations.

One Durable Object per person owns the ledger, generations and operation receipts. State and a completed receipt
commit in one SQLite transaction, in separate tables: receipts cannot overflow a single KV value. Durable pending
operations precede host I/O. Start reserves its generation before provisioning; failure compensates with an actual
Stop before sealing a failed receipt. A/B/A replay cannot stop a restarted generation. The host never calls a
container stopped until its actual stop receipt. Uncertain commands are not rerun. Long commands hold no writer
lock: Stop stays available, and a late result cannot overwrite a stopped or restarted generation.

A separate Durable Object owns each Cloudflare Container, using `SandboxObject.wake`, `ContainerSession` and
`SandboxTools` from the existing Smithers packages, as apps/mvp/worker/BranchSandboxes.ts does. Internet is off;
there are no egress intercepts, credentials or inherited host environment. Commands run as numeric uid/gid 1000:1000
in /workspace, with only the image's PATH and the literal HOME=/workspace. The deployment must supply an image with
sh, GNU timeout and the tools it wants available. Nothing here imports a private repository or injects a model key.

Command receipts also live outside the guest, in the machine object's SQLite. Deleting the guest's tool fence
cannot cause a replay to execute twice. Completed command output is bounded by SandboxTools; the visible transcript
keeps its last 32,768 characters. A command is bounded by the current allowance lease and the SDK's ten-minute
maximum. Stop can terminate it before that deadline.

## Minutes, conservation and clocks

ALLOWANCES in sandboxDecision.vibe is the one configuration: Viewer 0, New 60, Community 240, Contributor 600,
Maintainer 2,000 minutes per UTC month. These are the designer's proposals, not immutable rulings; Will may change them.
Only running generations consume time. Whole elapsed milliseconds are summed across simultaneous sandboxes. Displayed
remaining minutes are ceil(remaining milliseconds / 60,000); stopping does not round or discard partial usage. This replaces
the first run's unimplemented per-interval rounding proposal. Nine 100 ms Start/Stop cycles consume 900 ms; rapid restarts cannot avoid metering. Used time remains exact, including delayed-alarm
overage; remaining time clamps at zero. At zero the writer stops every running generation.

Each interval is split at every UTC month boundary and both buckets are retained. Clock rollback preserves the
metering high-water mark, including rollback across a month boundary. Invalid Date/IEEE-754 inputs fail rather than
resetting allowance. The integer kernel requires the exact safe-sum domain, checked by the host. On an impossible
sum, actual Stop receipts end compute and the prior exact total plus the rejected raw interval remain durable;
there is no saturation or invented usage cap. A six-hour bound applies only to Cloudflare's inactivity lease, never
to usage. Leases are renewed from remaining allowance divided across running generations.

## Roles and trust

0019 requires Contributor to start compute. That ruling wins over the design's New and Community allowances:
these roles have configured minutes but no start control. Live SandboxIdentity takes a trusted request identity
and current grant lookup. identityFromPolicy uses 0019's Policy.authorize(actor, "sandbox") interface for both
admission and lease renewal. Missing or failing policy denies compute. Payload roles and x-role headers cannot
establish authority. The default deployment adapter is Viewer until the roles lane's account host is connected;
VIBELANG_SANDBOX_IMAGE alone grants no authority. gatewayWithIdentity is the single integration point.

Mock identity is selected only in forced mock mode; it never becomes a live authorization header. The product mock
has a small in-memory filesystem and honest echo/redirection/cat/pwd/ls commands. It never invents successful
installs, tests, repository clones or network results. The scripted agent starts the same metered flow from chat.
The live chat agent has the same Start/Stop/Command catalog, bound to a server-owned conversation and replay-stable cell identity. Its default SandboxAgent is closed; a model cannot choose its owner or conversation. It remains unable to spend a person's allowance until its post has a trusted originating identity;
CLI/MCP and web operations already share the Factory boundary.

## Design and departures

The complete supplied design, notes, media and state screenshots are copied verbatim to wiki/designs/sandboxes.
The Foldkit UI uses its frame, tokens and Smithers classes: collapsed allowance, inline/maximized pane, KPI, role
table, Starting, terminal, Stop/Start, low/zero notices and retry. Escape minimizes. Stop remains enabled during
an unresolved command. A failed Stop retries Stop; uncertain commands never offer an automatic rerun. Stale responses cannot replace a newer operation or another conversation's projection.

- Contributor authorization takes precedence over the design's lower-role implication (0019).
- Names identify real conversation sandboxes; no example repository state or pnpm success is fabricated.
- `/sandbox` invokes the shared start flow directly; an ordinary request to the mock agent records its real
  “Started …” reply. The slash shortcut does not manufacture a chat reply or person event.
- The terminal is a bounded command console, with actual completed output, rather than a PTY emulator dependency.
- Native filesystem snapshots retain files across Stop/Start. A successful command is acknowledged only after its
  checkpoint. Stop persists its snapshot handle before destroy. If snapshotting fails at exhaustion, compute still
  stops, the failure is counted, and the last acknowledged checkpoint remains; unacknowledged background writes
  cannot be promised. Native snapshot handles expire after 30 days without restore. No stronger retention promise
  or exact month-reset deletion is claimed; storage policy belongs in the deployment review.
- Live auth/agent activation and a real Container receipt remain deployment/integration work, explicitly gated off.

## Evidence, packages and observability

Scene, browser, Factory/flow, workerd SQLite, clock/month, recovery, role, stale-generation and prototype-identity
regressions run locally. Real Containers run in the `vl-test` stage's suite, below. No transport interception or
model is required.
Feedback fuzz uses @smthrs/fuzz over Effect Arbitrary, fixed seeds, a millisecond-by-millisecond UTC oracle and Factory
lifecycles. The benchmark checks real mock file/Stop/Start cycles; it is not a Cloudflare performance claim.

The pure kernel's //@ contracts prove nonnegative remaining time, concurrent counts, exact accumulation, lifecycle
meter conservation, monotone clocks, identity validation, ownership and sequence frames. Date/IEEE-754 normalization,
Effect, HTTP, SQL transactions, scheduling, snapshots and containers remain runtime boundaries, not proved by Dafny.
The report gives actual receipts and limitations; no whole-app 100% or all-functionality proof claim is made.
The exact-integer division LemmaScript reproduction is recorded in vl/vibelang-bugs/lemmascript-exact-integer-division.
The production millisecond kernel does not divide; display rounding is a tested host boundary already listed in 0018.

The apps/mvp QuickJS variant duplicate is removed: AgentSandbox.ts composes the agent with harness/QuickJSWorkerd.
A discovered SandboxTools call-id collision is fixed in its package with real-shell regressions and docs. Lossy
legacy fences without identity metadata return ToolLost, preserving files and never executing ambiguously again.
@smthrs/sandbox is declared directly from the app's existing transitive SDK closure; no new external runtime library
is introduced. @smthrs/fuzz is the monorepo test tool, listed in 0008 pending Will's VL-5 review.

Every lifecycle, meter, lease, checkpoint and command step has a span, outcome-only log and counter. The engine adds
its real run/action records. Commands, terminal bytes, prompts, identities and keys never enter telemetry. Only
private state/flow payloads carry user content; no credential is put in a sandbox environment or flow payload.

## Real Containers in tests (VL-35, lane vl-containers-live, 2026-11-10)

Will ruled that sandbox tests run real Cloudflare Containers (VL-35). The `vl-test` Alchemy stage (`PROBE_STAGE`)
declares only the probe Worker (`worker/SandboxProbe.vibe`), the product's account and machine objects behind it and
the offline image: no site, API, domain or model. The probe serves the product's `/api/sandboxes/*` protocol through the
same `gatewayOf`, `accountObject` and `machineObject`; only the identity differs (`worker/sandboxProbeFetch.vibe`).

```
suite (LiveFactory) ── Bearer token, x-vibelang-probe-owner: probe-<deadline> ──▶ probe Worker
                                                  ├─ gatewayOf ─▶ SandboxAccount: flows, ledger, meter alarm
                                                  │                 └─ leaseClamped ─▶ SandboxMachine ─▶ Container (lite)
                                                  └─ POST /api/probe/sweep ─▶ stop, then the Container's own state
```

- **Identity.** A request is a Contributor only with `VIBELANG_SANDBOX_PROBE_TOKEN` and an owner `probe-<deadline>`
  whose deadline is in the future and at most `PROBE_WINDOW_MS` (10 minutes) away; anything else is signed out. Each
  run is a new owner, so a new ledger. Production never declares the probe.
- **Spend.** One conversation (`live`) per run, one run at a time (`--mode sandboxes-live`: one file, one worker), the
  `lite` instance (now explicit in `machineObject`; it was Cloudflare's default), and compute ends by the deadline,
  three ways:
  1. The suite's scope finalizer sweeps its owner, on success or failure.
  2. Past the deadline the owner is a Viewer, so the account's alarm runs the SandboxMeter flow, which stops every
     running generation with actual Stop receipts (the existing path for a role that may not start). This durable flow
     is the leftover sweeper; it needs no client, so a killed suite leaves nothing running past the deadline.
  3. Every lease is clamped to the deadline, so Cloudflare's inactivity timeout stops the Container even if no alarm
     runs.
- **Sweep.** `POST /api/probe/sweep` stops the owner's running generation before the deadline, or runs its alarm after
  it, then answers the Container's own state through the machine's `status` operation, which reads `running` whatever
  the generation. A sweep it cannot finish answers 503, which the suite counts as still running.
- **Suite.** `test/support/sandboxesLive.vibe` starts, writes `keep.txt`, stops (checkpoint), starts (restore), reads
  the file back, stops, checks the metered minutes (used above zero, never above the run's wall time, remaining the
  allowance left rounded up) and sweeps. `pnpm test:sandboxes-live` runs it against the stage; it fails, never skips,
  without `VIBELANG_SANDBOX_PROBE_URL` and `VIBELANG_SANDBOX_PROBE_TOKEN`. `test/sandboxProbe.test.vibe` runs the same
  body in every `pnpm test`, over loopback HTTP and local processes, with refusals, deadline teardown, the lease clamp
  and sweep failures. That run proves the probe's logic, not Cloudflare's behavior.
- **Record and replay (VL-36).** The suite's client is `@smthrs/testing`'s `HttpRecording`.
  `VIBELANG_SANDBOX_MODE=record pnpm test:sandboxes-live` writes `test/recordings/sandboxes-live.json`; request headers,
  so the token and the owner, never reach it, and the URL is keyed under `https://probe.invalid`. Once that file is
  committed, `test/sandboxesReplay.test.vibe` replays the real run in every `pnpm test`, claims every exchange and scans
  the file for credentials; until then it skips with that reason. `test/sandboxProbe.test.vibe` records the loopback run
  and replays it, so the wiring is checked before the first real recording exists.
- **Not yet proved.** Snapshot restore, start latency within `startTimeoutMs`, metering against real time and the
  deploy itself wait on the first live run. Durable Object storage and native snapshots outlive a run (snapshots expire
  after 30 days without restore); `pnpm destroy:sandboxes-test` removes the stage.

The lead deploys and runs it from the Mac, with Cloudflare credentials:

```sh
cd apps/vibelang
export VIBELANG_SANDBOX_IMAGE=docker.io/library/debian:bookworm-slim   # any image with sh and GNU timeout
export VIBELANG_SANDBOX_PROBE_TOKEN="$(openssl rand -hex 32)"
pnpm deploy:sandboxes-test                                             # prints the probe's workers.dev URL
VIBELANG_SANDBOX_PROBE_URL=https://<probe>.workers.dev pnpm test:sandboxes-live
VIBELANG_SANDBOX_MODE=record VIBELANG_SANDBOX_PROBE_URL=https://<probe>.workers.dev pnpm test:sandboxes-live   # then read and commit test/recordings/sandboxes-live.json
pnpm destroy:sandboxes-test                                            # removes the stage
```
