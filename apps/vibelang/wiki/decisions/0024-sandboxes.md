# 0024. Sandboxes with monthly minutes

Status: implemented in mock mode and as an opt-in Container host; live compute fails closed pending the 0019
session/policy adapter and the deployment's binding. No deployment or real-container success is claimed.
Rulings: VL-4, VL-5, VL-7 to VL-14, VL-17, VL-21, VL-23, VL-25, VL-29; ARCH-14, ARCH-16.

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
regressions run locally. The real Container test is opt-in with VIBELANG_SANDBOX_TEST_URL and an authenticated
VIBELANG_SANDBOX_TEST_COOKIE; otherwise it skips with that reason. No transport interception or model is required.
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
