# Sandbox tools

A branch's machine is a tool provider: it runs typed tools on the branch's checkout and knows nothing about agents ([decision 0005](../decisions/0005-sandboxes-secrets-and-the-forge.md) Q2). The agent's loop stays in the browser ([0011](../decisions/0011-the-agent-runs-in-the-browser.md)) and calls the tools as flows, exactly as a person's slash command and the API do. This page covers features 5 and 7's first slice: the tools, the machine's sleep and wake, and who may call them.

```
browser (leader tab's engine)                 ChatApi                        FlowExecution DO           SandboxObject DO + container
 agent cell ─ ctx.call("sandbox/run") ┐
 /run in the composer ────────────────┼─▶ sandbox/run ─ start ─▶ POST /api/sandbox/calls ─▶ sandbox/Call ─▶ tool(): wake, SandboxTools.execute
 POST /api/sandbox/calls (API) ───────┘                result ─▶ GET  /api/sandbox/calls/<id>   │ settle      as the person's user
                                                                    ▲ sandbox_calls row ◀────────┘   a run: sandbox/Command
```

## The tools

Six client flows, all model-invocable (`src/features/sandbox/flows.ts`). Their inputs and outputs are `@smthrs/sandbox`'s `SandboxTools` schemas, and paths are relative to the checkout, `/workspace`.

| Flow | Slash | Input | Answers |
|---|---|---|---|
| `sandbox/run` | `/run <command>` | `command`, `cwd?`, `timeoutSeconds?` (60, at most 3600: a [long command](#long-commands)) | `exitCode`, `timedOut`, `stdout`, `stderr` (64 KiB each), their sizes, `truncated` |
| `sandbox/read` | `/read <path>` | `path` | `content` (1 MiB), `bytes`, `truncated` |
| `sandbox/write` | `/write <path> <content>` | `path`, `content` (1 MiB) | `path`, `bytes` |
| `sandbox/list` | `/ls [path]` | `path?` | `entries [{ name, kind, bytes }]` (1,000), `truncated` |
| `sandbox/status` | `/status` | none | `branch`, `entries [{ path, index, worktree, from? }]` |
| `sandbox/diff` | `/diff` | `paths?` | a unified diff from the last commit, new files included (256 KiB), `bytes`, `truncated` |

## The flows

Each tool's flow is two steps on this device's engine (`src/features/sandbox/steps.ts`):

```
sandbox/<tool>/start: POST /api/sandbox/calls { callId, call, conversationId | answerId }
  ─▶ sandbox/<tool>/result: GET /api/sandbox/calls/<id>, again every 250 ms to 2 s while it runs (20 minutes at most)
```

- **The call's id** is the version 5 UUID of the run's execution id (`CALL_ID_NAMESPACE`). A step run again, after a crash or with the tab closed and reopened, names the same call; ChatApi answers it as it stands, and the machine never runs it twice.
- **Where it runs:** the agent's call is a child of its answer's run, so it names the answer, and ChatApi uses that answer's conversation's branch, however the person's tab moved since. A person's call names the conversation their tab showed (`conversationId`, pinned by `src/features/sandbox/actions.ts`; a person never types it). A call that names neither is refused `invalid`.
- **Failures:** `SandboxCallRefused` (`sign_in`, `forbidden`, `locked`, `not_found`, `invalid`), `SandboxCommandTooLong` with `maxSeconds`, `SandboxCallFailed` with the machine's reason, `SandboxCallUnavailable` while ChatApi is unreachable, and `SandboxCallRunning` while the machine works. The agent sees a failure's kind and any command limit, never its message.

## The routes

`worker/branch/SandboxCalls.ts`:

| Request | Answer |
|---|---|
| `POST /api/sandbox/calls` (3 MiB at most) | `202 { callId, status: "running" }` new; `200` with how it stands for the same call again |
| | `401 authentication`; `400` / `413 invalid`; `400 { code: "too_long", maxSeconds }`; `404 not_found` (no such answer or conversation); `403 forbidden`; `409 locked`; `409 id_taken`; `503 unavailable` |
| `GET /api/sandbox/calls/<id>` | `200 { callId, status, result? , failure? }`; `404` for a call that isn't yours |

**Who may call a tool.** Every call checks the person who asked, now, with `worker/branch/Access.ts`'s `branchAccess`, the same check the terminals use:

- they must be able to **edit** the branch (`canEdit`: its owner, or shared with them to edit, never above their role). A person who can only **view** it can't run tools;
- the branch must not be `locked`: the default branch has no machine for people, and agents never touch `main`;
- the agent acts for the person who asked: ChatApi takes an agent's call only from the person whose question its answer is for, and runs it under their role and as their own user in the machine. No tool pushes, approves or merges: the machine's forge is read-only (`GitProxy.uploadPack`).

## The remote flow

`sandbox/Call { callId, ownerId, branch, call }` (`worker/flows/SandboxCall.ts`) runs on the `FlowExecution` Durable Object, one execution per call (`sandbox-call:<id>`):

```
sandbox/Tool (wake the machine, run the tool as the person's user) ─▶ sandbox/Settle (done, with the result)
a run: sandbox/Command (its own job, below) ───────────────────────┘
     └ refused, lost, no machine, no checkout ─▶ sandbox/ToolFailed ─▶ sandbox/Settle (failed, with why)
```

The tool's result is `sandbox/Tool`'s journaled success, so a replay reads it and never runs the tool again. Refusals, a refused checkout and a start that ran past `SANDBOX_START_TIMEOUT_SECONDS` (`start_timeout`) aren't retried; an unreachable machine is, for 2 minutes. A `run` is a [long command](#long-commands): its child `sandbox/Command` job settles the call with the command's result, or `lost`, and an unreachable machine is tried again within the job's deadline. A command settles with no `generation`.

## Long commands

A command can run for minutes (`pnpm install` of a monorepo) and a host's drive can't: Cloudflare ends a Durable Object alarm at 15 minutes of wall time, and a host can stop at any moment. On 2026-10-22 a TODO's `pnpm install` failed twice in production with `ToolLost`, because the alarm driving the run ended while the command held one of its steps. So a command holds no step: it is its own `sandbox/Command` job (`worker/flows/SandboxCommand.ts`), `@smthrs/sandbox`'s `SandboxCommand` over `@smthrs/flow`'s `ExternalJob`.

```
sandbox/Command { target: { branch, ownerId, callId }, call }
  start   wake the machine; start the command detached as the person's user, once per key ─▶ its pid
  probe   its runner alive, or its exit, waiting for the exit until the next probe is due ─▶ park: 1 s, doubling to 20 s ─▶ probe ...
  collect the RunResult; the working copy is saved, as after a tool call
     └ lost (the machine stopped, or the runner died) or past the deadline: cancel, then fail
```

- **Who runs it:** the TODO agent's `sandbox/run` tool (`worker/flows/TodoAgent.ts`) and each of a head's check scripts (`checks/Scripts`, [pulls](pulls.md#where-checks-run)) run the job from their step (`SandboxCommand.run`, `@smthrs/flow`'s `ExternalJob.run`), named for the call (`sandbox-command:<call id>`), and `sandbox/Call` runs it as a child boundary. The step starts the command, reads it with observes that wait for its exit, and collects it itself, under the job's key, for as long as the command may run (`stepWait`: its timeout and 15 s to stop, at most `SANDBOX_COMMAND_STEP_WAIT_SECONDS`) and the drive's budget allows (`FlowRuntime.DriveDeadline`, `EXECUTION_DRIVE_BUDGET_SECONDS`): no job execution, and the run never parks, so `git status` answers in about the time its three execs take, and a 5-minute install in about its own 5 minutes. A command still running when the drive's budget ends goes on as the job, a child of the run, which parks while it runs. Asked again after its host died, the step starts the same key, which starts nothing, or joins the job an earlier attempt handed off to; the command runs once (`worker/flows/SandboxCommand.test.ts` cuts a host off mid-command on both paths).
- **Once:** the job's key is `<job execution id>#g1`. The machine starts a key once (`SandboxTools.start`: its fence in `~/.smithers/calls/command-<key>`, the key's bytes outside `[A-Za-z0-9.-]` written `_` and two hex digits), and the object records the generation that started it (`run:<key>`, as for a tool's command). A key an earlier generation started is `lost`; it never starts again, and the job fails `ExternalJobLost`, which the call settles as `lost` and the agent reads as `ToolLost`. No replacement is started (`restarts` 0). A call whose command an attempt from before jobs ran as a tool call (`run:<call id>`) is `lost` too, and a key cancelled before its start reached the object never starts.
- **Never wakes for a probe:** only `start` wakes the machine. A probe, a collect and a cancel answer for the generation running now, and a machine that stopped answers its command `lost`. Every operation is use of the machine, so a machine whose command runs isn't put to sleep.
- **Bounded:** the command stops at its own `timeoutSeconds`, at most `SANDBOX_COMMAND_MAX_SECONDS` (an hour unless set; `COMMAND_LIMIT_SECONDS`, the job's own limit, in `src/features/sandbox/contract.ts`), where a tool call that holds its step stops at 600 s. `POST /api/sandbox/calls` refuses a run past the deployment's limit with `400 { code: "too_long", maxSeconds }`, which the agent reads as `SandboxCommandTooLong: at most <maxSeconds> seconds`; the TODO agent's `sandbox/run` tool refuses it `invalid_input` and its description says the limit. The job's deadline, 20 minutes past an hour from before the start's wake, cancels it after that; `@smthrs/sandbox` refuses a deadline that wouldn't cover a command at its limit. The browser waits for a call's result as long and 10 minutes more (`RESULT_RETRY`, 90 minutes), and the TODO agent's attempt runs for 40 minutes plus an hour (`IMPLEMENT_TIMEOUT`); a command started late in an attempt ends with it. Each exec of an operation (provisioning the person's user, opening their session, a command script) answers within 2 minutes (`COMMAND_EXEC_MS`) or the operation answers `Unavailable`, and the job asks again; the fence starts the command once however often the start is asked.
- **Output nobody reads isn't piped:** a command the object runs for its exit code alone (the checkout, provisioning, the idle probe) runs with its output discarded (`runOn`). Under `alchemy dev` a piped stream nobody reads holds the exec's exit, and `useradd` warns that a person's uid is outside UID_MIN..UID_MAX, so every first provision hung there until 2026-10-22.
- **Cancelled runs:** a run cancelled while its job is parked leaves the command to its own timeout: the job's rollback is the host's, and a parked job's host is gone.
- **Fast collect:** the working copy a collect saves is staged from the checkout's own git index, so `git add` reads only the files that changed (a fresh index rehashed every file: a second on 15,000 files on a fast host, more in a container).
- **Records:** a `sandbox.object.command` line and span per operation with what it answered and how long it took, and a warning with the stage it was in (`provision`, `record`, `session`, `script`, `save`) and its error code (`timeout` for an exec past `COMMAND_EXEC_MS`) when the machine couldn't answer; `sandbox.command` spans in the SDK with the operation and its outcome. Never the command or its output.

`sandbox_calls` (`db/migrations/0024_sandbox_calls.ts`) keeps one row per call: the branch, the person, the answer for the agent's calls, the tool, `running`, `done` with the result, or `failed` with why. The result is content for the person who asked; nothing logs it, and it isn't synced.

## The machine

`SandboxObject.tool` (`worker/BranchSandboxes.ts`) wakes the machine (start, checkout, restore) and hands the call to `worker/branch/Machine.ts`:

- **As the person:** the call runs as their own user (`worker/branch/Users.ts`), made on first use, through `@smthrs/platform-cloudflare`'s `ContainerSession`, the container as a `Sandbox.Session`.
- **Numeric users:** a deployed container's `exec` refuses a user name and runs a bare uid as root, so every command runs as a `uid:gid`: root `0:0`, the checkout's `smithers` `1000:2000`, and a person `100000` plus 30 bits of their user name's hash, in the `workspace` group `2000`. `exec` gives a command only `PATH`, so each also gets `HOME`, `USER`, `LOGNAME` and `LANG=C.UTF-8`. Under Cloudflare's `durable_object` policy every process keeps root's capabilities whatever its user: these users give files and shells an owner; they don't isolate one editor of a branch from another.
- **Exit codes only:** a command the machine runs for its exit code alone (making a person's user, the idle probe, `tmux has-session`) goes through `@smthrs/platform-cloudflare`'s `SandboxObject.run`, its output ignored. workerd's exec pipes hold no bytes, so unread output blocks the command and its exit code never comes: over the default pipes, the one-line warning `useradd` prints for a uid above `UID_MAX` hung a person's first terminal open on a branch.
- **Size:** the machine starts on `SANDBOX_INSTANCE`, `standard-1` by default (1/2 vCPU, 4 GiB, 8 GB of disk). Cloudflare's own default, `lite`, has 256 MiB.
- **At most once:** a command's fence, exit and output live in that user's `~/.smithers/calls/<call id>`, outside the checkout (`SandboxTools.execute`). That disk goes with the machine, so the object also records the generation it started each command on: a command an earlier generation started settles `lost` on a restarted machine and never runs again (0005's `MachineLost`). A record lasts a day (`RUN_RECORD_MS`), far past the call's 2-minute retry; each new command drops the older ones.
- **The forge route:** the container sends `forge.smithers.internal` to ChatApi's own entrypoint (`ctx.exports.default`, with `props` naming the branch's object), Cloudflare's documented intercept target; ChatApi hands each request back to that object, which answers it with the read-only git proxy. A Durable Object's stub as the target worked under `alchemy dev` and never reached the object in production.
- **No secrets inside:** the machine has no internet and no credential. Its only way out is the forge proxy, and, with `SANDBOX_SECRETS` on (off by default), the secrets egress for every other host, whose placeholders the tools' commands get as their environment ([secrets](secrets.md#wiring-into-the-box)).
- **A check job's machine** (`kind: "job"`, one per pull request head) differs in one way: its box reaches the npm registry and dprint's plugins, and nothing else, so a repository's checks can install their packages. It gets no placeholder ([where checks run](pulls.md#where-checks-run)).

The host-independent `worker/branch/Session.ts` owns terminal session startup; `BranchSandboxes.ts` injects the container and the catalog's `@smthrs/platform-cloudflare` terminal service. Startup has one Effect Clock deadline, `SANDBOX_SESSION_TIMEOUT_SECONDS` (positive integer, default 60), covering `start` (including the activity record), `provision` and `session` (tmux). Success logs `sandbox.session` at info with `outcome: started`, `startMs`, `provisionMs` and `sessionMs`. Failure logs it at warning with `stage`, `outcome: failed` or `timeout`, completed stage durations, `errorCode` and `errorName`; no branch or terminal ids, command arguments, error messages or user content. Failure and expiry answer `false`: the caller raises `SandboxUnavailable` with reason `exec`, and the durable `terminal/Open` flow owns retry and the final failed record.

## Sleep and wake

- **Create on demand:** the first call or terminal wakes the machine: it starts the container, clones the branch and puts back the last checkpoint.
- **Keep awake while used:** each wake starts that generation's `sandbox/Keep` (`worker/flows/SandboxKeep.ts`, once per generation: `sandbox-keep:<branch>:<generation>`). Every `KEEP_EVERY_SECONDS` (1 minute) it asks the machine whether anything happened within the idle time (`SANDBOX_IDLE_SECONDS`, 15 minutes): a call, a terminal opened, terminal input, or a person's process other than their shells and tmux. Busy, it asks again later, so an idle machine sleeps 15 to 16 minutes after its last activity. A machine never sleeps while a person's process runs; a shell busy only with its own builtins, such as `while :; do :; done`, doesn't count as one. PID 1 is tini, which reaps orphans; neither a zombie nor the box's own `smithers-idle` counts as work.
- **Cloudflare's backstop:** a 30-minute inactivity timeout stops a container whose sleep never ran. A Durable Object that restarts (every deploy) loses it, and Cloudflare then stops the container soon after the object goes idle, process or not. So the object re-arms it in its constructor and on every ask, socket and sharing change (`SandboxObject.rearm`), not only on a wake.
- **Sleep when idle:** the machine saves the working copy, then stops; `sandbox/Slept` ends that generation's open terminals `slept`. A machine whose checkpoint can't be saved stays awake, and so does one that a call, a terminal or terminal input reached while it saved: it probes again just before it stops.
- **Resume with the working copy:** the working copy is saved as a checkpoint (`SandboxTools.checkpoint`: its commit, a binary patch with every tracked and untracked change, and a git bundle of the commits no remote has, such as one made in the terminal; 8 MiB at most) in the object's storage after every `run` and `write`, at `sandbox/Keep`'s next ask after a terminal socket closes (within a minute; a save run from the closed socket's own request was killed), and before sleep. The next generation's first wake fetches that commit from the bundle (fetching the bundle's base from the forge when the branch moved past the shallow clone) or from the forge by its id, resets to it and applies the patch, once. Ignored files, such as `node_modules`, and running processes don't carry over.
- **Never lose a checkpoint:** a wake whose restore can't reach the machine or the forge fails and is tried again before anything saves over the checkpoint. A checkpoint that can't go on the fresh checkout (its commit is gone everywhere, or its patch won't apply) is kept aside in the object's storage as `stranded:<seq>`, and the machine starts from the branch.

## Configuration

| Setting | Default | What |
|---|---|---|
| `SANDBOX_COMMAND_MAX_SECONDS` | `3600` | the longest a person's or an agent's [command](#long-commands) runs: whole seconds from 60 to 3600 (the job's own limit); anything else fails at start. Read once by ChatApi (`POST /api/sandbox/calls`) and the `FlowExecution` Durable Object (the TODO agent's tool) |
| `SANDBOX_COMMAND_STEP_WAIT_SECONDS` | `3600` | the longest the step that asks for a [command](#long-commands) (the TODO agent's tool, a head's check scripts) waits on it itself, holding its run's drive (on Cloudflare, its Durable Object's alarm) while the command runs, before the command goes on as its job and the run parks: whole seconds from 0 (never) to 3600; anything else fails at start. The drive's budget bounds it too. `flows_external_job_step_wait_ms` counts the time by outcome (`collected`, `handed_off`, `interrupted`). Read once by the `FlowExecution` Durable Object |
| `SANDBOX_IDLE_SECONDS` | `900` | how long a machine stays awake with nothing happening in it before `sandbox/Keep` puts it to sleep. Read by the `FlowExecution` Durable Object |
| `SANDBOX_INSTANCE` | `standard-1` | the Cloudflare instance type a machine starts on: `lite`, `basic` or `standard-1` to `standard-4`. Read by `SandboxObject` |
| `SANDBOX_START_TIMEOUT_SECONDS` | `150` | the longest a stopped machine's container may take to start. Past it the wake fails: a tool call settles `failed` with `start_timeout` (not retried) instead of staying `running`, and the start counts in `smithers_cloudflare_sandbox_start_timeouts`. Read by `SandboxObject` |
| `SANDBOX_SECRETS` | `false` | whether the box's other outbound requests reach the secrets egress and it gets its placeholders ([secrets](secrets.md#wiring-into-the-box)). Read by `SandboxObject` |

## Observability

Content-free: ids, tools, outcomes, exit codes, statuses, counts and durations; never a command, a path, a file's content or output.

| Where | Records |
|---|---|
| ChatApi | `sandbox.call`, `sandbox.result` (logs, spans), `smithers_sandbox_call_requests{route,outcome}` |
| `sandbox/Call` | `sandbox.tool`, `sandbox.call` (logs), `sandbox.call.tool`, `sandbox.call.settle` (spans), `smithers_sandbox_calls{tool,outcome}` |
| `sandbox/Keep` | `sandbox.keep`, `sandbox.slept` (logs, spans), `smithers_sandbox_keeps{outcome}` |
| `SandboxObject` | `sandbox.object.tool`, `sandbox.object.sleep`, `sandbox.checkpoint.save`, `sandbox.checkpoint.restore` (spans), `smithers_sandbox_checkpoints{op,outcome}`; `sandbox.wake` warnings name the failed `stage` (`start`, `checkout`, `restore`, `placeholders`); `sandbox.session` logs `startMs`, `provisionMs`, `sessionMs` on success, or the failed/timed-out `stage` (`start`, `provision`, `session`) and safe failure fields; `@smthrs/platform-cloudflare`'s `cloudflare.sandbox.wake`, `cloudflare.sandbox.rearm` and `@smthrs/sandbox`'s `sandbox.tool` span |
| Browser (`SANDBOX_TELEMETRY`) | `sandbox.call`, `sandbox.call.start`, `sandbox.call.post`, `sandbox.call.result`, `smithers_web_sandbox_calls{tool,outcome}` |

## Tests

| Kind | Where |
|---|---|
| SDK | `@smthrs/sandbox`'s `test/SandboxTools.test.ts` and `test/SandboxCommand.test.ts` (real shell and git in a scratch directory), `test/SandboxCommand.container.test.ts` (the command scripts in a real container: Docker or Podman; with `SANDBOX_LONG_COMMAND_SECONDS=960`, a job runs a 16-minute command past 900 s to its result); `@smthrs/platform-cloudflare`'s `test/ContainerSession.test.ts` |
| Container | `worker/branch/Probe.docker.test.ts`: the idle probe in a real branch-sandbox container (skips without Docker): a zombie doesn't keep the machine awake, a running process does |
| Unit | `worker/branch/SandboxCalls.test.ts`, `worker/branch/Machine.test.ts`, `worker/branch/Machines.test.ts`, `worker/flows/SandboxCall.test.ts`, `worker/flows/SandboxCommand.test.ts` (a host killed mid-command on the Durable Object handlers), `worker/flows/Todo.test.ts` (the same for the TODO agent on the Node engine), `worker/flows/SandboxKeep.test.ts`, `src/features/sandbox/sandbox.test.ts` |
| End to end | `e2e/sandbox-tools.spec.ts` against `alchemy dev` with Docker: the agent writes a file, runs a test command and shows the diff; a command whose tab closed mid-run is recorded once; a ten-minute command runs once through its job and its result arrives (`E2E_LONG_COMMAND_SECONDS`) |

## What's not built

- Jobs (`job/Run`), previews, snapshots, and the Code Storage work-in-progress branch 0005 names for checkpoints; the checkpoint lives in the branch object's storage.
- Sandbox budgets wait until we ship ([sandbox budgets](../work/sandbox-budgets.md); the numbers are an open question in [rulings §18](../rulings.md#18-open-questions-no-ruling-yet)).
- `SANDBOX_SECRETS` on by default: it waits for an e2e through a real box ([secrets](secrets.md#wiring-into-the-box)).
