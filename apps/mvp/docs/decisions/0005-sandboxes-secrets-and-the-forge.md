# 0005: Sandboxes, secrets and the forge

Status: accepted (Will, 2026-10-19: Q1 Cloudflare, Q2 the sandbox is a tool provider; Q3, budgets, decided at ship in [0103](0103-sandbox-budgets.md)). Built: branch machines, keep-awake, sleep and wake with a checkpoint in the object's storage, agent tools, long commands as jobs, the secrets egress (off by default), sandbox budgets. Not built: `job/Run`, snapshots, the Code Storage WIP branch, `branch/Follow` for main, previews. Design panel: Opus as lead, and Sol; 2026-10-19. Features 5, 6 and 7 of Will's 2026-10-19 list. It builds on [0002](0002-local-first.md) (Yjs over Electric), [0003](0003-flows-and-the-agent.md) (flow placement, the agent on Cloudflare), [0006](0006-repo-clone-and-view.md) (Code Storage, `@smthrs/effect-code-storage`), [0007](0007-roles-and-tags.md) (branch modes, `@smthrs/access`) and [0008](0008-auth.md) (actors and grants). The prototype starts in its own jj workspace after features 1 to 3 land. Opus and Sol designed independently; the [appendix](#appendix-opus-sol-and-final-compared) compares them point by point. Will's three questions are at the end.

## Decision

1. **Branch sandboxes run on Cloudflare Containers** under the `durable_object` scheduling policy (Sandbox SDK 1.0), one Durable Object per branch. Freestyle is the fallback behind the existing `Sandbox.Provider` seam, and the S0 spike can switch to it (§6).
2. **The branch, never the sandbox, holds the truth.**
   - Commits and work-in-progress checkpoints live in Code Storage.
   - Open files' Yjs updates and the flow journal live in Postgres.
   - A container snapshot is a warm cache.
   - When Cloudflare stops a container it sends SIGTERM and waits up to 15 minutes; the sandbox checkpoints in that window.
3. **Every sandbox operation is a durable flow on the Cloudflare host.** A `SandboxObject` Durable Object owns the container and serializes calls to it. It runs no loops, timers or retries.
4. **Branch modes are 0007's: `locked`, `open` and `restricted`.**
   - Running a shell counts as writing.
   - The sandbox's forge access is read-only. Every write to Code Storage is a flow step through `@smthrs/effect-code-storage`, fenced by `expected_target_sha`.
5. **Multiplayer works online only.** A branch with exactly one possible writer also works offline, local-first, through `y-indexeddb`.
6. **No secret value enters a sandbox.**
   - The sandbox holds placeholders.
   - One `Egress` WorkerEntrypoint intercepts all of its HTTP and HTTPS traffic. It checks each request against the sandbox's grant, injects credentials into headers only, and scrubs echoes from responses.
   - Values are sealed in Postgres under a key that only the Worker holds.
7. **The coding agent's loop runs on the host, and its tools run in the sandbox.** Every model call is a `ModelStep` through `HostModel`: today the fast Qwen model on Cerebras.
8. **SDK work:**
   - rewrite `CloudflareSandbox` for SDK 1.0;
   - add `SandboxObject` and `Egress` to `@smthrs/platform-cloudflare`;
   - add a new platform-neutral `@smthrs/secrets`;
   - add `YDoc` to `@smthrs/effect-electric`;
   - add branch, commit, token and webhook operations to `@smthrs/effect-code-storage`.
   - There is no `@smthrs/platform-sandbox`.

## Why

- **Will's rule decides a tied score.** "If Cloudflare supports this natively, use Cloudflare." Cloudflare and Freestyle each score 405 of 500 (§1).
  - Cloudflare natively meets every listed need except two: a persistent disk, and Docker with bridge networking.
  - Decision 2 removes the disk need: what a sleeping or crashed sandbox must not lose is never stored only on its disk.
  - S0 measures the Docker gap.
- **The secrets proxy is native and programmable.** Outbound handlers "run in the Workers runtime, outside the container sandbox", see HTTPS through a per-instance CA, and seal DNS when Internet is off [1].
  - The Egress code can mint a forge token per request, decode Basic credentials, route model calls to our host and scrub responses.
  - Freestyle's injection is declarative. Doing the same there needs a SOCKS5 proxy that we would run ourselves: the iron-proxy and CA-rotation operations the old backend carried [9].
- **One platform:** the sandbox is a Durable Object beside HOST-PLAN's execution objects, reached by RPC with no vendor key, and Alchemy 2.0.0-beta.83 already provisions it.
- **Half the price:** about $0.06 an awake hour, against $0.13 on Freestyle.
- **Less vendor risk.** Freestyle deprecated its Git and Dev Server APIs and removed `fork` from its SDK in 2026 [5].
- **Prior art agrees on the boundary.** The guest holds a placeholder and a trusted proxy substitutes it for exact hosts: Fly's tokenizer, iron-proxy, Anthropic's sandbox runtime, Claude Code cloud, Vercel, Deno and Daytona [7].
  - Substitution in headers only, never bodies, is Daytona's rule.
  - Scoping by method and path is Cloudflare's and Anthropic's.

## Consequences

- **Docker:**
  - Containers can't change iptables, so `dockerd` runs as root with `--iptables=false --ip6tables=false --ip-forward=false`.
  - Inner containers need `--network=host`; rootless Docker does not start [2].
  - Compose files that rely on bridge networks need `network_mode: host`.
  - Repos that need KVM, more than 20 GB of disk or bridge networking are out of v1 unless S0 says otherwise.
- **Beta:**
  - The `durable_object` policy and snapshots have been public beta since 2026-09-30 [1].
  - Snapshot time and storage price are undocumented, and a snapshot expires 30 days after its last restore. S0 measures both.
- **Non-HTTP egress is closed:** no SSH git, and no external TCP databases. Tools that pin certificates or need mutual TLS fail under interception.
- **Local signing is unsupported.** A secret a tool must read to sign or decrypt locally can't satisfy never-in-guest; that operation is unavailable until an outside signing service exists. Secret files (M-42) hold placeholders.
- **Other decisions change:**
  - 0007's premise, "a repository-scoped Pierre token may not limit branches", is wrong. JWT ref policies limit writes per token [6]. Its read-only rule stands for a different reason: every forge write becomes an attributed, fenced flow step.
  - 0008's in-box `smithers_sbx_` token is unnecessary on Cloudflare. `Egress` learns the sandbox and generation from props our Durable Object sets, which the guest can't forge, and stamps `act: sandbox` itself.
  - 0006's clone URL form, with a JWT inside it, never reaches a sandbox: its remote is credential-free.
- **Sign-in:** creating branches or sandboxes and using secrets need a signed-in person (0008 §1). Until 0008 ships, the prototype runs only against an operator-owned fixture repository named in host configuration. No sign-in gate is added.
- **Library catalog entries used:** `@smthrs/sandbox`, `@smthrs/capability`, `@smthrs/effect-electric`, `@smthrs/crypto`, `@smthrs/agent` with `@smthrs/std`, `@smthrs/model-host`, `@smthrs/ui`.

## 1. The provider, scored

Scores run from 1 to 5, multiplied by the weight. Every number has a source in [Sources](#sources); costs are for an awake hour.

| Criterion (weight) | Cloudflare Containers | Freestyle | Daytona |
|---|---|---|---|
| Egress that injects credentials (20) | **5**: Worker handlers with per-request code, a per-instance CA, DNS sealed | **4**: default-deny firewall; edge header injection by method and exact path; per-request logic needs our own SOCKS5 proxy | **3**: header-only placeholders with scrubbing, but routing is cooperative (`HTTP_PROXY`) below Tier 3 |
| Runs most repos (20) | **3**: any linux/amd64 image; Docker only with host networking; no KVM; 4 vCPU, 12 GiB, 20 GB defaults | **5**: full microVM, Docker and Compose preinstalled, KVM, 64 GB disk on Hobby | **4**: containers with Docker and Compose documented; a VM class with KVM; 10 GB disk default |
| Durability (15) | **3**: ephemeral disk; filesystem snapshots (beta, 20 GB, 30-day TTL); SIGTERM grace up to 15 min | **5**: pause keeps memory and processes; stop keeps disk; snapshots kept until deleted | **4**: stop keeps disk, archived after 7 days; the VM class pauses and forks with memory |
| Fit with our durable host (15) | **5**: a Durable Object beside our flow host; RPC; Alchemy | **3**: SDK runs in Workers over `fetch`; lifecycle, rules and secret values live in a second control plane | **3**: SDK runs in Workers with `nodejs_compat`; same split |
| Wake time (10) | **4**: blog median 648 ms; docs "1-3 second" | **4**: about 500 ms (vendor claims) | **3**: "under 90ms" with no method |
| Cost (10) | **5**: $0.059 (custom 1 vCPU, 4 GiB, 20 GB, 25% busy) | **3**: $0.132 (2 vCPU, 4 GiB, wall clock) plus a $50 plan | **3**: $0.115 (1 vCPU, 4 GiB) to $0.166 |
| Ports and previews (5) | **4**: the Worker forwards to `getTcpPort`; a hostname per preview on a wildcard zone | **5**: free `*.style.dev` names, wildcard domains, forward auth | **4**: a URL per port, WebSockets; custom domains need our own proxy |
| Maturity (5) | **3**: GA 2026-04-13; key APIs beta | **2**: five people; Git, Dev Servers and `fork` removed in 2026 | **4**: SOC 2 Type II, $24M Series A; closed source since June 2026 |
| **Weighted, of 500** | **405** | **405** | **345** |

**Cloudflare's monthly cost:** one branch sandbox awake 8 hours a day for 30 days costs about $14, plus the account's $5 Workers plan.
- **Shape:** the custom instance `{ vcpu: 1, memoryMib: 4096, diskMb: 20000 }`: the largest disk, with 1 GiB more than the 3 GiB-per-vCPU minimum for package installs.
- **Rates:** memory $0.009 a GiB-hour, CPU $0.072 a vCPU-hour of active use, disk $0.000252 a GB-hour [2].
- **Not counted:** Code Storage bills $0.15 a GB for every clone; restoring from a snapshot avoids most of them [6].

## 2. Branches and sandboxes

**One sandbox per branch.**
- **Identity:** at creation each branch gets an immutable id, and the Durable Object's name is the SHA-256 of `(repository id, branch id)`. A deleted and re-created branch never reaches the old branch's files ("Reusing a name or a snapshot for someone else gives them the earlier user's files" [1]).
- **Sharing:** everyone on a branch reaches the same object, and therefore the same container, files, jobs and logs.
- **State:** a `sandboxes` row in Postgres holds state, generation, head, snapshot id and image digest. Electric syncs it, and only flows write it.

```
           Create             Wake (work arrives)               Keep: idle 15 min
  none ───────────▶ asleep ─────────────────────▶ awake ─────────────────────────▶ asleep
                      ▲   restore snapshot (same image)      │ Sleep: fence jobs, checkpoint,
                      │   else main's snapshot + fetch       │ snapshot, store id, destroy
                      │   else image + clone; flush docs     │
                      └──── SIGTERM: Sleep in the grace window; OOM: next step finds it stopped → Wake (generation + 1)
  Delete: revoke previews and egress first, destroy, forget the snapshot, delete the branch if asked
```

- **Create** is lazy: `branch/Create` calls Code Storage `createBranch` and inserts the row, and no machine starts.
- **Wake:**
  - **Start:** it restores the branch's snapshot when the image matches. Otherwise it restores main's latest snapshot, which is plain data and restorable "including from another Durable Object" [1], then fetches and switches. Otherwise it starts from the image and clones.
  - **Files:** it applies the WIP checkpoint, then writes accepted Yjs documents to disk, so a restore never rolls back newer edits.
  - **Generation:** it advances only after the sandbox is ready.
  - **Unknown outcomes:** an unknown provider outcome runs an inspection step before any retry, because a timeout doesn't prove a machine is gone.
- **Sleep:**
  - **Trigger:** it comes from `sandbox/Keep`, which waits on a durable timer until `last_active_at` plus 15 minutes. A sandbox with a running job is never idle.
  - **Backstop:** Cloudflare's inactivity timeout, at most 6 hours, is set to 30 minutes, and set again in the object's constructor because a restarted Durable Object loses it [1].
  - **No sweeps:** no alarm loop decides anything.
- **SIGTERM:** the image's entrypoint traps it and calls `http://sandbox.smithers.internal/stopping`. `Egress` passes the call to `SandboxObject`, which starts `sandbox/Sleep` for that generation within the 15-minute grace.
- **Reading never wakes a sandbox.** The tree and files of a sleeping branch come from Code Storage, at the head or the WIP checkpoint.
- **main follows main.** Code Storage's `push` and `repo.sync.succeeded` webhooks, HMAC-signed, start `branch/Follow` [6]. It wakes main's sandbox, checks out the SHA, runs the repository's setup command, snapshots and sleeps. That snapshot is the base for new branches.
  - Only Follow runs in main's own sandbox.
  - Jobs on main run in job sandboxes started from main's snapshot and destroyed at `collect`, so no job can poison the base every branch starts from. The old backend ran trusted main jobs the same way [9].

**Modes** come from 0007 §5, and `@smthrs/access` decides them.

| Mode | Writes (edits, shells, jobs, the agent) | Offline edits | Code Storage access |
|---|---|---|---|
| `locked` (main; protected branches) | nobody; changes arrive by merge | none | read |
| `open` (new branches) | every Member | no: multiplayer | read; writes by flow |
| `restricted` | the creator plus named writers | only while the creator is the sole writer | read; writes by flow |

- **Enforcement points:**
  - the admission step of every write flow;
  - the Yjs write endpoint, which refuses an update before it enters the document;
  - `Egress`, whose forge token is `git:read` with the ref policy `*` set to `no-push` [6].
- **Read-only views** never receive a terminal or a sandbox-control capability.
- **On a mode or role change,** the next step of the changing flow re-registers the intercept with a new generation, which revokes the old placeholders, and closes the affected sockets (0007).

**Multiplayer works online; single-player works offline.** Both use one mechanism: a Yjs document per text file through `@electric-sql/y-electric` 0.1.54 [8], keyed by repository, branch and file id. Cursors are awareness rows, upserted with a 30-second expiry. `@smthrs/ui`'s `CodeEditorView` already binds `yCollab`.
- **Multiplayer:** offline, the editor turns read-only and the pill says `Offline`. There are no multiplayer drafts.
- **Sole writer:** edits persist in IndexedDB and merge on reconnect. A branch that became `restricted` or `locked` meanwhile keeps the edits on the device, with `Move to new branch` and `Discard` (0007). Before a branch gains a second writer, its owner's offline edits are reconciled online.
- **Offline scope:** the device keeps the tree and the files it opened. Running anything needs the sandbox, so it is online-only.
- **Edits never wait for a machine.**
  - Postgres holds them, and a durable materializer, `doc/Flush`, writes accepted revisions to disk atomically within 1 s (M-02).
  - Agent edits enter through the same revisioned path.
  - A fenced reconcile step imports disk changes made by jobs or shells as attributed edits, and detects divergence instead of overwriting.
- **Non-text files:** binary files, files over 1 MiB, renames and deletes use revisioned writes with compare-and-swap, not `Y.Text`.
- **Compaction:** a write step merges updates every N updates. y-electric documents none [8].
- **Commits:** a commit records the document revision it flushed.

## 3. Durability

| State | Lives in | Survives | Written by |
|---|---|---|---|
| Commits, branches | Code Storage | everything | `branch/Commit` (`createCommitFromDiff`, `expected_target_sha`), merges |
| Uncommitted working tree | Code Storage `+ephemeral` branch `wip/<branch id>` | everything | `sandbox/Checkpoint`, fenced, so a stale incarnation's write is refused [6] |
| Open files' edits | Postgres `ydoc_updates` | everything | the Yjs write endpoint |
| Sandbox row, snapshot id, generation | Postgres + Durable Object storage | everything | sandbox flows |
| Dependencies, build caches | container snapshot | 30 days after the last restore | Sleep, Follow |
| Job output | Postgres `job_output (job_id, offset, bytes)` | everything | `job/Follow` |
| Processes, dev servers | container memory | nothing | |

Checkpoints run after each mutating agent turn or job and before Sleep. Only a stop without SIGTERM, such as running out of memory, loses work: the edits made inside the box since the last checkpoint. A step that reaches the machine after its generation changed fails with a typed `MachineLost`. A job then settles `lost`, and the agent starts a new turn told which checkpoint the machine restarted from.

**Flows,** on the Cloudflare host. Each reaches the container through the `SandboxObject` stub.

| Flow | Steps |
|---|---|
| `branch/Create` | admit, `createBranch`, insert the row |
| `sandbox/Wake` | admit, start or restore, apply checkpoint and documents, mark awake, start `Keep` |
| `sandbox/Keep` | durable idle timer, then `sandbox/Sleep` |
| `sandbox/Sleep` | fence new jobs, checkpoint, `snapshotContainer`, store the id, destroy, mark asleep |
| `sandbox/Exec` | admit, wake, `exec` (60 s at most; idempotent commands only), record |
| `job/Run` | admit, wake, `start` (fenced by job id), `follow` × n, `collect`, settle |
| `branch/Follow` | wake main, check out the SHA, set up, snapshot, sleep |
| `branch/Commit` | flush, capture `Sandbox.Work`, `createCommitFromDiff` |

**Jobs run in containers.** A job runs in its branch's sandbox and sees its tree, dependencies and services. A job that must be isolated runs in a job sandbox started from the branch's snapshot.
- **Start:** `Sandbox.job` launches the command detached under `setsid`, records its pid and exit file, and fences duplicates with an atomic `mkdir`.
- **Follow:**
  - Each `job/Follow` step streams `tail -c +<offset>` until the exit file appears, or for 10 minutes at most, because a Durable Object alarm runs at most 15 minutes [3].
  - It appends output at most once a second, fenced on `offset`, so a resumed step neither duplicates nor skips.
  - The open stream keeps the container alive. Cloudflare doesn't count work inside the box as activity [1].
- **Retries:** a retried `exec` runs a second copy ("If the client retries, a second copy of the command runs" [2]). Anything not idempotent goes through `job/Run`.

## 4. Secrets

```
sandbox VM: enableInternet false; the entrypoint trusts /etc/cloudflare/certs/cloudflare-containers-ca.crt
  /run/smithers/env and declared files hold placeholders: STRIPE_KEY=smthrs-secret-<64 hex>
  every request on :80 and :443 ─ interceptAllOutboundHttp + interceptOutboundHttps("*") ─▶ Egress {sandbox, generation}
     1. resolve the grant for (repository, branch, generation); a host outside the policy ─▶ 403, audited
     2. registries: GET, HEAD and git-upload-pack only
     3. <org>.code.storage ─▶ add Basic t:<ES256 JWT>, git:read, ref policy * no-push, 5-minute expiry
     4. model.smithers.internal ─▶ the HostModel route; key and budget stay on the host
     5. a placeholder in a header (Basic decoded first) ─▶ its secret's hosts and methods ? swap : 403
        a bound host without its placeholder ─▶ 403 (require); redirects return to the guest unfollowed
     6. fetch over HTTPS; scrub the value, its base64 and URL-encoded forms, across chunks; audit by name
```

- **Where values live:**
  - The table is `secrets (repo_id, name, ciphertext, iv, key_version, hosts, methods, main_only)`.
  - Values are AES-256-GCM sealed with WebCrypto under a key-encryption key bound to the Worker as a secret. The additional authenticated data is `repo_id|name|key_version`, so ciphertexts can't move between rows.
  - Writing a secret is Admin-only and never an agent's (0007 `repo:secret-write`). Reads return names only. The shape the UI reads has no ciphertext column.
  - `Egress` decrypts per request, in memory.
- **How they're injected:**
  - **Minting:** each wake mints one placeholder per secret per generation, keeps them in the object's storage, and writes `/run/smithers/env` and the declared files (M-42).
  - **Reaching processes:** `exec` doesn't inherit `start()`'s environment, so the job launcher sources the file [2].
  - **On disk:** snapshots and checkpoints hold placeholders only.
- **Binding:**
  - **Scope:** a secret binds to a branch sandbox's grant: repository, branch, generation, destination host and method.
  - **No per-process binding:** "The sandbox is therefore the smallest unit of trust" [1], and `Egress` can't tell which process sent a request. A job whose secrets the branch's agent must not use runs in its own job sandbox with its own grant.
  - **Main-only secrets** reach only job sandboxes of `locked` main that a Maintainer started, never agent runs or branches (D-24).
- **One wildcard intercept:** a container has 128 intercept entries and none can be removed while it runs [2], so the policy lives in `Egress` and changes by re-registering with new props.

| Threat | Defense | What remains |
|---|---|---|
| Code reads a secret | values never enter the VM | none |
| A placeholder sent elsewhere | audience and method check; placeholders bound to a generation | none |
| A secret abused against its own host | per-secret hosts and methods; main-only scoping; audit; human approvals for risky acts | real: anything in the box can use a bound secret. Bind narrowly. |
| Data leaves through an allowed host | default deny; registries read-only | allowed write APIs stay channels |
| An upstream echoes the value | exact, base64 and URL-encoded scrubbing, across chunks, of responses up to 16 MiB | transformed echoes; allow only hosts whose responses we reviewed |
| DNS or other ports | Internet off: "DNS cannot carry data out of the container" [2] | none documented |
| Nested Docker | inner containers share the sandbox's network, so the same intercepts apply | they fail TLS until the CA is mounted |
| Telemetry carries a value | values exist only inside one `Egress` request; a sentinel test over exported logs, spans and metrics | none |
| An agent widens its own egress | policy and secrets are person-only flows | none |

## 5. Connecting it all (feature 7)

- **The app agent** (feature 1's design) calls the flows the buttons call: `branch.create`, `branch.mode`, `sandbox.run`, `job.run`, `job.cancel`, `file.read`, `file.write` and `branch.commit`. Secrets, egress and modes have no agent path. An agent acts as its person, never above them (0007 §4).
- **The coding agent runs on the host, and its hands are in the box.**
  - `agent/Code { branch, task }` runs `@smthrs/agent` on the Cloudflare host.
  - Its `@smthrs/std` tools (read, write, edit, grep, bash, test) act on the branch's machine through `Sandbox.layerHost(CloudflareSandbox.make(stub), { session })`, which already provides `ChildProcessSpawner`, `FileSystem` and `Path`.
  - Its model is `HostModel`: Cerebras `qwen-3.8-27b`, the default in `worker/ChatApi.ts`. It is called through `ModelStep`, so every call is a durable step, keys stay on the host, the VM can die without losing the agent, and an injected agent can't edit its own journal.
  - Long commands become `job/Run`. The agent appears in presence as a participant (M-34).
- **0003's `sandbox` placement has two forms:**
  - **App flows** (`file.write`, `sandbox.run`) are trusted. Their body runs on the host, and their effects land on the branch's machine through `Sandbox.layerHost`.
  - **Repository and authored flows** are untrusted code. They run entirely in the guest through `SandboxedFlow`, in a job sandbox, and return one durable step. `SandboxedFlow` imports `node:fs`, `node:os` and `node:crypto` and bundles with esbuild on the host, so for the Cloudflare host it must bundle inside the guest. That change goes with 0003's repository flows.
- **Agents inside the box** later run as `job/Run`: Claude Code, Codex, or `smthrs`. Their model traffic goes to `model.smithers.internal`, where the host meters it. The job is their durable unit (question 2).
- **The UI joins feature 2's repository view.** Each piece is a feature-3 template, so it also renders inside chat.
  - a branch picker with the sandbox's state and a lock for the mode;
  - a job panel that renders `job_output` with `@smthrs/ui`'s `Terminal`;
  - preview links on a separate wildcard zone, because preview pages run in the visitor's browser [1];
  - `CodeEditorView` with cursors.
  - Requests are acknowledged at once. Status and logs arrive as Electric rows (root `AGENTS.md`, instant chat).

| Package | Change |
|---|---|
| `@smthrs/sandbox` | Rewrite `CloudflareSandbox` for 1.0 over a structural `SandboxObject` stub: argv `exec` with byte-exact streams, `retained`/`attach`/`destroy`, `NetworkPolicy` and `ResourceLimits` honored instead of refused. Delete the 0.x `Sdk` slice. In `Sandbox.job`, add `follow(handle, offset)` and borrowed machines that `collect` never destroys. |
| `@smthrs/platform-cloudflare` | `SandboxObject`: functions a container Durable Object delegates to (start or restore, snapshot, destroy, re-arming the timeout, the intercepts, the generation). `Egress`: the WorkerEntrypoint body. No loops. |
| `@smthrs/secrets` (new) | Platform-neutral placeholders, grants, header rewriting, Basic decoding, streaming scrub over Fetch `Request`/`Response`, and the WebCrypto seal. `@smthrs/targets`' `SecretProxy` moves onto it and its copy is deleted, giving two consumers. |
| `@smthrs/effect-electric` | `YDoc` over `y-electric`, as 0002 §5 planned. |
| `@smthrs/effect-code-storage` | `createBranch`, `createCommitFromDiff` (ephemeral targets, `expected_target_sha`), `gitToken` (read, `no-push` ref policy, ≤ 3,600 s), webhook verification. |
| no `@smthrs/platform-sandbox` | `Sandbox.layerHost` already gives the host remote files and processes, and `SandboxedFlow` runs a flow inside a guest. |

## 6. Prototype plan

**The slice:** a person, or the agent, presses **Run tests** on a repository cloned by 0006's `repo/Clone`, and the log streams into the app.
1. `job/Run { repo, ref: head, argv: ["sh", "-c", "npm ci && npm test"] }` starts on the Cloudflare host.
2. It starts a job sandbox from the image: Node 24 on Debian Trixie with git and ca-certificates, `enableInternet: false`, both intercepts, and `smithers-init` as the entrypoint.
3. `git clone` runs through `Egress`, which adds a read token. npm runs through `Egress` to the registry.
4. `start`, `follow` × n into `job_output`, then `collect` and settle into `jobs`, then destroy.
5. Electric shapes `jobs` and `job_output` drive the job panel. A second tab shows the same log live.

**Acceptance:** each check is a real test.
- **Fixtures:** Node, then Python, then a Compose fixture; the Compose result is recorded either way.
- **Durability:**
  - Kill the execution object during provisioning and again mid-follow: no gap, no duplicate, no false success.
  - Kill the container mid-job: the job settles `lost`, and a retry runs again.
  - A duplicate launch makes one job. Cancel's tombstone fences a late launch.
- **Failure paths:** a nonzero exit, a full disk, an output flood (at most one write a second) and a refused instance size.
- **Egress:**
  - a push, an unlisted host and a nested container's direct dial are refused;
  - a placeholder sent Basic-encoded to the wrong host is refused.
- **Sentinel:** a secret and the forge token never appear raw, base64 or URL-encoded in exported logs, spans, metrics or `job_output`.
- **Receipts:** p50 and p95 of cold ready and first log line. No vendor speed claim becomes ours without a receipt.

**Workstreams, by file ownership.** Every package keeps 100% coverage, uses real Postgres, Electric and containers, and scripts only the model.

| Stream | Owns | Needs |
|---|---|---|
| S0 spike, day 1, disposable | one command on a real account (below) | nothing |
| S1 | `packages/smithers/flows/sandbox` | S0 |
| S2 | `packages/smithers/flows/platform-cloudflare` (`SandboxObject`, `Egress`) | HOST-PLAN W4, S3 |
| S3 | `packages/smithers/flows/secrets` (new); `packages/smithers/build/targets/src/SecretProxy.ts` | nothing |
| S4 | `packages/effect-code-storage`, with 0006's owner | 0006 |
| S5 | `apps/mvp`: flows, migrations (`sandboxes`, `jobs`, `job_output`, `secrets`), shapes, the job panel, the container in `alchemy.run.ts`, e2e, bench | S1, S2, S4 |
| Later | co-editing (`YDoc`, `doc/Flush`, reconcile, compaction), `branch/Follow` and snapshots, previews, `agent/Code`, the Secrets card | S5, 0007 phase 4, 0008 |

**S0 checks:**
- the `durable_object` policy, and the `*` HTTPS intercept with injection;
- clone and `npm ci`;
- snapshot and restore time and size;
- a SIGTERM checkpoint;
- a Docker pull through the intercept, and a Compose bridge check;
- a corpus of 20 repositories.

**S0 switches to Freestyle** if restoring a 2 GB workspace takes over 30 s, if the corpus fails on more than 10% of repositories, or if the SIGTERM checkpoint can't finish in the grace window.

## 7. Risks and costs

| Risk | Answer |
|---|---|
| Beta APIs change | pin `@cloudflare/sandbox` 1.0.x and the compatibility date; run `SandboxConformance` against a real container in CI |
| 20 GB disk, 12 GiB memory | raisable defaults; ask before launch; Freestyle for repos beyond them |
| Snapshot cost and time unknown | S0 measures them; expiry is harmless because snapshots are a cache |
| OOM kills lose in-box edits since the last checkpoint | checkpoints after every mutating turn; `MachineLost` gives an honest restart |
| Cost: about $14 per branch-month, plus $0.15 a GB of Code Storage reads | snapshots avoid re-clones; budgets in question 3 |
| Agents abuse a bound secret's power | narrow hosts and methods; main-only secrets; audit; people approve risky acts |
| The engine's writer lock under many streaming jobs | HOST-PLAN's benchmark covers it |

**Questions for Will:**
1. **Is a recovery window acceptable instead of a persistent disk?** On Cloudflare, a sandbox loses running processes when it sleeps or restarts. It loses in-box edits made since the last checkpoint only when it is killed without SIGTERM. Recommended: yes. If no, Freestyle wins: its pause keeps memory and disk, at about twice the price.
   - **Will, 2026-10-19: Cloudflare.** "So it's durable so sleeping shouldn't cause issues also couldn't we manually kick the container on the backend to stop it from sleeping or something?" Yes. Sleep is our own decision (`sandbox/Keep`), taken only after 15 minutes with no activity and no running job. Cloudflare's inactivity timeout is only a 30-minute backstop that we keep re-arming. Interrupted jobs are durable flows and resume.
2. **Does "Smithers agents run in sandboxes" allow the agent's loop to run on the host, with its tools in the sandbox?** Recommended: yes. It is the only way every model call stays a durable step and keys stay out of the box. CLI agents run inside the box later, as jobs.
   - **Will, 2026-10-19: yes.** "So we want the sandbox to only expose the sandbox and it's tool and the agent to be independent of that. We want as modular/durable an architecture as possible." A sandbox is a tool provider: it exposes only the machine and its tools (exec, files, jobs, previews) as durable flow steps. It knows nothing about agents. The agent loop runs on its own host, the browser per [0011](0011-the-agent-runs-in-the-browser.md), and binds a branch's sandbox tools like any other tools, so either side can change without the other.
3. **What are the sandbox budgets?** Recommended:
   - at most 20 awake sandboxes per deployment and 2 per person;
   - a spend alert at $100 a month for sandboxes, beside the token alert;
   - snapshots kept only for branches touched in the last 30 days.
   - **Will, 2026-10-19: deferred until we ship.** "Add this as a TODO but we won't worry about this until we ship." Built at ship with these numbers: [0103](0103-sandbox-budgets.md).

## Sources

[1] Cloudflare Sandbox: [lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/), [security](https://developers.cloudflare.com/sandbox/concepts/security/), [SDK 1.0 changes](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/), [snapshots](https://developers.cloudflare.com/containers/guides/snapshots/), [outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/), [previews on their own hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/), [snapshots beta](https://developers.cloudflare.com/changelog/post/2026-09-30-snapshots/), [faster sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/)

[2] Cloudflare Containers: [limits](https://developers.cloudflare.com/containers/platform/limits/), [pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/) (`exec`, intercept limit, DNS), [FAQ](https://developers.cloudflare.com/containers/faq/) (Docker, ephemeral disk, SIGTERM)

[3] [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/): alarm handlers run at most 15 minutes

[4] Daytona: [pricing](https://www.daytona.io/pricing), [secrets](https://www.daytona.io/docs/en/secrets), [sandboxes](https://www.daytona.io/docs/en/sandboxes.md), [network limits](https://www.daytona.io/docs/en/network-limits.md), [repository archived](https://github.com/daytonaio/daytona)

[5] Freestyle: [pricing](https://www.freestyle.sh/pricing), [limits](https://www.freestyle.sh/docs/vms/pricing-and-limits), [lifecycle](https://www.freestyle.sh/docs/vms/lifecycle), [outbound TLS](https://www.freestyle.sh/docs/vms/network/tls-outbound), [Docker](https://www.freestyle.sh/docs/guides/run-docker-in-a-sandbox), [deprecations](https://www.freestyle.sh/changelog/changelog-september-9)

[6] Code Storage: [authentication](https://code.storage/docs/platform/authentication), [ref policies](https://code.storage/docs/repos/ref-policies), [ephemeral namespace](https://code.storage/docs/repos/ephemeral-branches), [restore agent state](https://code.storage/docs/guides/restore-agent-state), [webhooks](https://code.storage/docs/repos/webhooks), [OpenAPI](https://code.storage/docs/openapi.json) (`ReposCommitsCreateFromDiffRequest`: `target_is_ephemeral`, `expected_target_sha`), [pricing](https://code.storage/pricing)

[7] Prior art: [Fly tokenizer](https://github.com/superfly/tokenizer), [iron-proxy](https://github.com/paradigmxyz/iron-proxy), [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime), [Claude Code cloud environments](https://code.claude.com/docs/en/cloud-environments), [Vercel Sandbox firewall](https://vercel.com/docs/sandbox/concepts/firewall), [Deno Sandbox](https://docs.deno.com/sandbox/security/)

[8] [y-electric](https://github.com/electric-sql/electric/tree/main/packages/y-electric) 0.1.54 and its Yjs skill (debounce 100 ms or more; awareness rows expire); [y-codemirror.next](https://github.com/yjs/y-codemirror.next) 0.3.6

[9] This repository:
- `packages/smithers/flows/sandbox/src/{CloudflareSandbox,Sandbox}`
- `packages/smithers/build/targets/src/SecretProxy.ts`
- `packages/backend/ironproxy/config.go` and `packages/backend/docs/secrets.md` (main-only runs in an ephemeral machine; the legacy unbound mode this record drops)
- `packages/smithers/flows/platform-cloudflare/src/ExecutionObject.ts`
- `apps/mvp/node_modules/alchemy/src/Cloudflare/Containers/Container.ts` (2.0.0-beta.83)
- `.specs/product/mvp.md` (M-02, M-34, M-42, M-47, D-24, "Sleep")
- memory `reference_cloudflare_backend_evaluation_20261017`

## Appendix: Opus, Sol and final compared

Opus and Sol wrote their designs independently on 2026-10-19, before 0006 to 0008 were readable; Opus merged them. Each of Sol's claims the final design adopts was checked against the primary source cited above.

**Agreed:** both designs said the same thing, and the final design keeps it.

| Point | Final |
|---|---|
| `CloudflareSandbox` | targets 0.x, buffers output, destroys on scope close and refuses policy; rewrite it for 1.0 |
| `Sandbox.job` | must not destroy a borrowed branch machine; add log offsets |
| `SecretProxy` | move its portable policy out; transports go in host packages |
| Secrets | never in argv, env, images, disk, snapshots, journals or telemetry; the guest holds placeholders; values resolve only in the trusted egress |
| Forge remote | credential-free in the box; a broker adds a short-lived repository-scoped token |
| Files | Yjs through `y-electric` with an Effect wrapper; multiplayer online, single-player offline through IndexedDB |
| main | locked; follows the forge's main; agents never merge |
| Journals and keys | outside the guest; the model is `HostModel`'s Qwen on Cerebras |
| UI and agent | call the same flows; Electric carries status and logs; previews on their own origin |
| Prototype | later, in its own jj workspace, after features 1 to 3 |
| Opaque credentials | prevent extraction, not abuse of allowed API actions |

**Differed:**

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| Provider | Cloudflare, 405 of 500 | Freestyle, 84 of 100, with persistence a hard gate | Cloudflare; question 1 | Will's rule prefers Cloudflare where it is native. Decision 2 removes the persistent-disk need. Egress is programmable in our own code; the cost is half and the vendor risk lower. S0 can switch to Freestyle. |
| Scores | persistence weighted 15; Freestyle "fit" 2 | persistence 25; Freestyle "fit" 3 | Opus's weights, Freestyle "fit" 3; a 405 tie | Freestyle's SDK runs in Workers (verified). Under Sol's weights Freestyle leads, which is why question 1 decides. |
| Persistence | the sandbox is a cache; WIP ref plus snapshot | durable disk; snapshots an optimization | Opus, plus Sol's generation fencing, plus a SIGTERM checkpoint | SIGTERM with a 15-minute grace is documented [2]. Only kills without warning lose in-box edits. |
| Sandbox key | `(repository, branch name)` | immutable branch id | Sol's | the old files never reach a re-created branch [1] |
| Lifecycle | create, wake, sleep, destroy | adds revoke-first destroy, inspect-before-retry, generation advance on ready | Sol's additions | a timeout doesn't prove deletion |
| Jobs on main | in main's sandbox, changes discarded | main compute has no write authority | job sandboxes from main's snapshot | a job in main's own sandbox could poison every new branch's base |
| Dirty main | discard | quarantine | discard | main's sandbox runs only Follow; there is nothing to recover |
| Modes | `protected`, `owner`, `open`; new branches `owner` | viewer, creator-only, contributor, multiplayer | 0007's `locked`, `restricted`, `open`, with Sol's "a shell is write authority" | one vocabulary across decisions |
| Forge writes | in-box `git push` under ref-policy JWTs | read-only box; a commit flow writes | Sol's, also 0007's | every write is an attributed, fenced step. Sol's doubt about branch-scoped JWTs was wrong; ref policies exist [6]. |
| WIP | ephemeral refs | ordinary branches only | Opus's | Code Storage's capture and restore pattern with `expected_target_sha` [6] |
| Agent placement | loop on the host, tools in the box | `@smthrs/agent` in the box, journal on Cloudflare | Opus's; question 2 | no remote-journal executor to build; no model capability in the box |
| `platform-sandbox` | none | add for remote files and processes | none | `Sandbox.layerHost` already provides them (verified) |
| Freestyle adapter | only if S0 fails | build it now | only if S0 fails | follows the provider decision |
| Egress rules | header-only, Basic decoding, one `*` intercept, sealed values | strips guest auth, manual redirects, encoded and cross-chunk scrubbing, management endpoints blocked | both | they cover different gaps |
| Job-scoped secrets | per sandbox | only approved jobs (question 3) | per sandbox; isolated jobs get their own sandbox | one box can't tell processes apart [1] |
| File editing details | edits never wait; flush on wake | file-id keys; refused updates never enter; CAS for binaries; commit records revision; restore never rolls back; fenced reconcile | both | complementary |
| Offline multiplayer | read-only | keeps drafts, disables writes | read-only | no draft to reconcile after a revocation |
| Before auth | signed-out, with caps | operator-owned fixture only | Sol's; 0008 then requires sign-in | 0008 §1 |
| Prices | Code Storage hot $0.005/GB-hour; Daytona $0.0504/vCPU-hour | Code Storage $1/GB-month per replica; Daytona "no trustworthy rate card" | Opus's | the live pages on 2026-10-19 [4][6] |
| Freestyle `exec` | 5 min at most, buffered | 5 min at most | 30 s default; 5 min, or 24 h on updated guest agents | Freestyle's 2026-10-14 changelog |
| Acceptance tests | kill tests, sentinel | adds provisioning kill, guest restart, backpressure, disk full, quota, nested-container bypass, Python and Compose fixtures, latency receipts | both | broader failure coverage |
| Questions | signed-out compute; agent placement; repo scope | persistence; budgets; job-scoped secrets | persistence; agent placement; budgets | 0008 answered signed-out use; S0 decides repo scope; job scoping is decided above |


## Sleep diagnosis (2026-10-25, OBS-4)

An idle lifecycle test timed out while its durable keep flow continued. A bare `busy` result cannot distinguish a user process, terminal activity, recent use, a probe error or an unsaved checkpoint. Record those bounded reasons on every decision, with idle age where available, generation, probe phase and attached socket count; never record process names, arguments, paths or content. Preserve the existing safeguard against stopping live work or losing an unsaved checkpoint until production records identify which condition is wrong. The diagnostic change alone is not proof that sleep works.
