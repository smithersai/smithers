---
title: "Troubleshooting"
description: "A missing package at startup, every typed refusal Runtime, NodeRuntime and SandboxedFlow raise, and the capability denials and replay surprises a host meets first: the symptom, what caused it, and what to change."
---

Every failure `Runtime` and the native compositions in `@smthrs/platform-node`,
`NodeRuntime` and `SandboxedFlow`, report is typed, and most of them are a
decision the host made, stated back plainly. Find the tag or the code and read
the matching section. A program that stops before any of them, on a missing
package, is the first section. The full schemas are in the
[API reference](./api.md) and the
[`@smthrs/platform-node` API reference](../platform-node/docs/api.md#noderuntime).

## ERR_MODULE_NOT_FOUND: Cannot find package

**Symptom.** `node` exits before your program runs:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '<name>'`.

**Cause and fix.** The package named decides it:

| Package named                                                                          | Cause                                                                                                                       | Fix                                                                                                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `effect`                                                                               | Your program imports `effect/...` and the project does not declare it. pnpm links only declared packages.                   | `npm install effect`. [Installation](./installation.md) names the range.                                             |
| `@smthrs/platform-node`, `@effect/sql-sqlite-node`                                     | A program imports `NodeRuntime` and the project does not declare `@smthrs/platform-node`, which installs the SQLite driver. | `npm install @smthrs/platform-node@next`                                                                             |
| `@smthrs/platform-bun`                                                                 | A program imports `BunRuntime` and the project does not declare its platform package.                                       | Install the [Bun](./installation.md#bun-durable-execution) line.                                                     |
| `@smthrs/flows/NodeRuntime`, `@smthrs/flows/BunRuntime`, `@smthrs/flows/SandboxedFlow` | Code written for an earlier candidate. These subpaths moved to the platform packages.                                       | Import `NodeRuntime` and `SandboxedFlow` from `@smthrs/platform-node`, and `BunRuntime` from `@smthrs/platform-bun`. |

## ERR_MODULE_NOT_FOUND: Cannot find module effect/dist/unstable/http/FetchHttpClient.js

**Symptom.** `node` exits before your program runs:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../node_modules/effect/dist/unstable/http/FetchHttpClient.js'`,
imported from an `@smthrs/*` package such as `@smthrs/artifacts`.

**Cause.** The project has `@smthrs/flows` 1.0.0-rc.5 or earlier beside
`effect` 4.1.1, and those releases import a module that `effect` 4.1.1 does not
ship. pnpm 11 can install such a release when you ask for `@smthrs/flows@next`:
its `minimumReleaseAge` skips every version younger than 24 hours, so `next`
resolves to the newest candidate older than a day, which can be more than one
release back.

**Fix.** Install 1.0.0-rc.6 or later. With npm, `npm install @smthrs/flows@next`.
With pnpm 11, run the exact-version `pnpm add` line from
[Installation](./installation.md#install-the-package), which pnpm installs the
day it is published.

## JjError: No jj on PATH

**Symptom.** A step fails, and the host and its other steps keep running. A
program that lets the failure die, as the quickstart's does, stops with this
first line:

```console
Error [@smthrs/jj/JjError]: jj: No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH.
```

Below the stack, Node prints `[cause]: Error: No executable jj found on host PATH`.
The engine reads a step's failure back from the journal as a plain `Error`
named by its tag, the same way the quickstart prints `Error [PlatformError]`.
A time-travel fork reports the same `JjError` as the cause of
`TimeTravelError [@smthrs/time-travel/TimeTravelError]: could not add fork workspace`.

**Cause.** The step needs jj and the host has none. A compensable step needs
it because the engine snapshots the workspace before each attempt. A
time-travel fork needs it to add the child run's jj workspace. A rewind needs
it only to restore files: when it crosses a compensable step, or when it sets
`wholeRepo`. A rewind over sealed steps alone runs without jj. An action that
calls `Jj` needs it directly. The first such step runs `jj --version`. A jj
older than 0.39.0 is refused the same way, with the version it found.

**Fix.** Install [jj](https://jj-vcs.github.io/jj/latest/install-and-setup/)
0.39.0 or later and put it on `PATH`, then restart the host: it reads `PATH`
when it starts. On macOS, `brew install jj`; the linked page covers Linux and
Windows. To use a binary that is not on `PATH`, set `SMITHERS_JJ_PATH` to its
path.

## JjError: The machine was too busy to start the process

**Symptom.** The first step that needs jj fails, and a program that lets the
failure die prints this first line and the error's `[cause]`:
`Error [@smthrs/jj/JjError]: jj version: TimedOut: ChildProcess.spawn (<jj path>): The machine was too busy to start the process within 5 s`.
An action that calls `Jj` itself receives the typed `JjError`, with
`code: "unknown"`, `method: "version"`, and `cause.code: "ETIMEDOUT"`; a step
failure read back from the journal keeps only the tag and the messages.

**Cause.** That step runs `jj --version` through the host's process
supervisor, which starts a fresh Node or Bun process and gives each startup
step 5 s. On a heavily loaded machine, with a load average far above its core
count, that process can start later than the bound. The probe is retried once;
this error means both attempts were too slow. jj itself is not at fault.

**Fix.** Run the step again once the load drops; the next step that needs jj
probes again and usually succeeds. On a machine that stays this busy, run
fewer processes beside the host.

## RuntimeConfigurationError

**Symptom.** `layer`, `make`, `layerHost`, or `storage` throws before opening
anything. The error carries `code: "invalid_runtime_configuration"`, a `field`
naming the option that was wrong, and a message.

**Cause.** Validation is eager: the composition is built when the function is
called, so a bad option fails at wiring time rather than at some arbitrary later
scope. `field` exists so an embedder can tell an empty `filename` from an empty
`owner.hostId` without reading prose.

| `field`             | What it refuses                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `filename`          | An empty or non-string SQLite filename.                                                                                               |
| `workspaceRoot`     | An empty or non-string workspace root, including `storage`'s second argument.                                                         |
| `owner.hostId`      | An empty or non-string host id, or an `options.owner` that is omitted or `null`.                                                      |
| `isAlive`           | An `isAlive` that is not a function.                                                                                                  |
| `canExecute`        | A supplied value that is not a function.                                                                                              |
| `canActivate`       | A supplied value that is not a function.                                                                                              |
| `requestResume`     | A supplied value that is not a function.                                                                                              |
| `cacheEnvironment`  | A supplied value that does not declare valid runtime layers and capability groups.                                                    |
| `sourceRevision`    | A supplied value that is neither a function nor a non-empty string.                                                                   |
| `privilegedJj`      | A supplied value that is not an Effect `Layer`.                                                                                       |
| `sweep`             | A value other than `undefined`, `"process"`, or an object with a non-empty `host` execution id and an optional non-empty `flow` name. |
| `resumeConcurrency` | A supplied value that is not a positive integer.                                                                                      |
| `placement`         | A supplied value that is not a non-empty string.                                                                                      |
| `signals`           | A `signals` value that is not an array, or a name that cannot be installed.                                                           |
| `shutdownTimeoutMs` | Anything that is not a safe integer from 0 through 2,147,483,647.                                                                     |
| `rules`             | A `rules` value that is not an array, a policy list whose members are not arrays, or a member that is not a capability rule.          |

**Fix.** Correct the named field. Note that nothing was created: a refused
configuration never opens a database, and a refused signal list never installs a
listener.

## NodeRuntime cannot install signal SIGKILL

**Symptom.** A `RuntimeConfigurationError` on `signals` naming the signal.

**Cause.** `SIGKILL` and `SIGSTOP` cannot be caught, and an unknown name is not
a signal at all. Both are refused before the first listener is installed, so you
never get a half-installed handler set.

**Fix.** Name catchable signals, or pass `signals: []` and wire your own. See
[Shut a host down](./guides/shut-a-host-down.md).

## permission_required: an action was refused with no rule to point at

**Symptom.** An action that reads a file or spawns a process fails with code
`permission_required`, carrying the exact capability it asked for. An action
that lets the failure die, as the quickstart's does, stops the program with
this first line:

```console
Error [PlatformError]: PermissionDenied: FileSystem.read (<path>): permission_required: fs:read:<path> (tier sealed, request permission-1)
```

`PermissionDenied` there is Effect's name for every refused platform call; the
code after the path tells this case from the next one. The cause is
`@smthrs/capability/PermissionRequired`.

**Cause.** `layerHost` builds its grant store unattended: there is no operator
to prompt, so a capability that no rule allows or denies cannot be escalated,
and the store refuses it immediately. The default decision is neither allow nor
deny; it is "ask", and there is nobody to ask.

**Fix.** Add a rule to `HostOptions.rules` that allows the capability the error
names, scoped as narrowly as the work needs:

```ts
import { Capability } from "@smthrs/flows"

const rules = [
  new Capability.Permission.Rule({
    effect: "allow",
    pattern: new Capability.Capability.CapabilityPattern({
      action: "fs:read",
      resource: `${workspaceRoot}/**`
    })
  })
]
```

The refused execution is recorded as failed, and its `executionId` replays that
failure even after you add the rule. Once the rule is in place, run under a new
`executionId`, or delete the directory that holds the engine database
(`workspace/.flows` in the [Quickstart](./quickstart.md)).

## permission_denied: a rule refused it on purpose

**Symptom.** `@smthrs/capability/PermissionDenied`, code `permission_denied`,
with a reason of `denied by permission policy`.

**Cause.** A rule matched and its effect was `deny`. This is different from the
previous case: policy answered, and the answer was no.

**Fix.** If the denial is wrong, change the rule. Note the asymmetry when
`rules` is a list of rulesets rather than a flat list: `rulesets[0]` is the
configured policy and its effective denial is a hard veto, while every later
ruleset is applied last-match-wins. An allow in a later ruleset cannot lift a
deny in the first one.

## An action reached a file or a URL that no rule allows

**Symptom.** With `rules: []`, an action still reads a file outside the
workspace, fetches a URL, or starts a process, and nothing is refused.

**Cause.** Rules govern what a step reaches through the host's Effect services:
`FileSystem`, `ChildProcessSpawner`, `HttpClient`, and `Jj`. Code that imports
`node:fs` or `node:child_process`, or calls the global `fetch`, goes around
those services, and the grant store never sees it. The grant store is not a
process sandbox.

**Fix.** Reach the outside world through the Effect services, so the rules
apply. To isolate code you do not trust, run it as a child flow with
`SandboxedFlow` on a container provider; see
[Run a child flow in a sandbox](./guides/run-a-child-flow-in-a-sandbox.md).

## undeclared_read, undeclared_write, missing_declared_output: a step broke its file boundary

**Symptom.** A step with a `hard` `fileBoundary` fails, and the run's cause is
one defect that names the refusal, its code and the paths:

```text
Error: {"_tag":"@smthrs/engine-store/UndeclaredRead","code":"undeclared_read","paths":["note.txt"],"diffIdentity":"key1_c429630f…"}
```

On 1.0.0-rc.8 and earlier the same refusal printed
`SchemaError: Expected never at ["cause"]["failures"][0]["error"]` without the
paths, after a log line that starts `A recorded action outcome does not match
the action's declared schemas`.

**Cause.** The engine compares what the step did with what it declared:

| `code`                       | What the step did                                     | `paths` names          |
| ---------------------------- | ----------------------------------------------------- | ---------------------- |
| `undeclared_read`            | Read a file its `readSet` does not declare.           | The files it read.     |
| `undeclared_write`           | Wrote a file its `writeSet` does not declare.         | The files it wrote.    |
| `missing_declared_output`    | Finished without writing a file its `writeSet` names. | The declared files.    |
| `surviving_declared_removal` | Finished with a file its `removes` names still there. | The declared removals. |

An undeclared read or write is refused before copy-back, so the workspace
keeps none of the step's writes. The refusal is the engine's verdict on the
step, not an error the action declared, so it arrives as a defect and never
through the action's `error` schema. A retry policy does not retry it, and a
replay of the execution answers the same defect.

Before 1.0.0-rc.7, `missing_declared_output` could also name a file the step did
write, when the process working directory was not `workspaceRoot`. Upgrade.

**Fix.** Declare the path in `readSet` or `writeSet`, or write the file the step
declares. To act on a refusal in code, decode the defect with its class, for
example `Schema.decodeUnknownOption(EngineStore.StepSandbox.UndeclaredRead)(defect)`.
Each refusal has its own section in the
[engine-store troubleshooting page](../engine-store/docs/troubleshooting.md).

## The engine takes snapshots even though I denied jj

**Symptom.** A compensable action still records a Jujutsu pre-image after
`jj:*` was denied to actions.

**Cause.** This is intended. Engine snapshot bookkeeping uses a private `Jj`
service, and `HostOptions.rules` governs only action-facing authority. An action
that asks for `Jj` directly is still refused; the engine's own bookkeeping is
not routed through the action's grants.

**Fix.** Nothing to change. If you need the engine to stop snapshotting, that is
a tier decision on the action, not a capability rule.

## The run returned a stale value

**Symptom.** A second run over the same database returns the previous answer,
and the action's implementation never ran.

**Cause.** `executionId` names one execution. A completed execution is answered
from the journal, which is the whole point of durability: a restart resumes
instead of repeating.

**Fix.** Use a new `executionId` for a new execution. Reuse it when you mean a
resume.

## A resumed run waits before it continues

**Symptom.** Rerunning an `executionId` whose process died prints a line such
as `INFO ...: engine-store: run quickstart-1 is held by worker-1:4242 on another host; waiting up to 28 s for its lease to expire`
and resumes later, or not at all.

**Cause.** The run is still `running` under the owner that died, and this
process takes it only once it can prove that owner gone. Under `layerHost`, an
owner on this host whose process no longer exists is taken at once, with no
line printed. Anything else waits, and the line says why:

| Line ends with                                                              | Cause                                                                                    | Fix                                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `on another host; waiting up to N s for its lease to expire`                | The run was started under a different `owner.hostId`.                                    | Use the same `hostId` on the same machine. The run resumes when the lease expires.     |
| `a live process on this host; waiting for it to finish or exit`             | A process holds the recorded pid: the owner itself, or a program that reused its pid.    | Let the owner finish, or stop the process that holds the pid.                          |
| `which the liveness check reports alive; waiting for it to release the run` | `layerHost`'s probe treats an owner on another host as alive, so it never takes the run. | Rerun on the host that started the run, or pass an `isAlive` that can judge that host. |

## queue_overflow: the journal admission queue is full

**Symptom.** A journal write fails with `queue_overflow`.

**Cause.** The runtime's journal queue has capacity 1,024 and rejects overflow
rather than dropping events. Dropping would make a later replay wrong, so the
write fails loudly instead.

**Fix.** Reduce the write rate, or compose the journal yourself through
[`@smthrs/journal`](../journal/docs/api.md) with different capacity and overflow settings,
using `Runtime.storage`, or `NodeRuntime.storage` or `layer` from `@smthrs/platform-node`, as the seam.

## SandboxedFlowError

Every sandboxed refusal is one error class with a `code` that names it, and a
message that quotes the guest's stdout and stderr where they help. The tail of
each stream is quoted, cut at 4 KiB and marked when it was cut.

| `code`              | What happened                                                                                                         | What to change                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle_failed`     | esbuild could not bundle the `entry` module.                                                                          | Check that `entry` is a `file:` URL or an absolute path to a real module, and that its imports resolve. A remote URL is not a valid entry.                                                    |
| `session_failed`    | The provider could not acquire the machine, or a file or process operation on it failed.                              | Read the message: it names which operation, whether it was writing the bundle, writing the request, spawning the runtime, reading the result back, resolving the base, or capturing the work. |
| `guest_failed`      | The guest runtime exited non-zero. Exit 126 or 127 means the image has no runnable runtime, and the message names it. | Put `node` 22 or later, or `bun`, on the guest's `PATH`. Nothing is installed for you. For any other non-zero exit, read the quoted stderr.                                                   |
| `flow_failed`       | The child flow ran and reported a failure, or the entry exports no flow with the requested tag.                       | The message carries the child's error as its tag and fields, not a stack trace. An "exports no flow tagged" message means the entry module does not export the flow you passed.               |
| `result_unreadable` | The guest exited 0 but wrote no result, or wrote something that is not the protocol's JSON.                           | Usually the runtime ran something other than the bundle. Check the `runtime` command line and the quoted stdout.                                                                              |
| `result_invalid`    | The guest's `output` does not decode through the flow's success schema.                                               | The host's declaration has drifted from the one the guest bundled: same tag, different success schema. Rebuild against one declaration.                                                       |
| `result_overflow`   | The result JSON is larger than `limits.resultBytes` (5 MiB by default).                                               | Return less, or raise the bound. The message quotes both numbers.                                                                                                                             |
| `diff_overflow`     | The captured patch exceeds `limits.diffBytes`.                                                                        | Narrow what the child writes, or raise the bound. The message quotes the patch size and the limit.                                                                                            |
| `capture_failed`    | `captureWork` was on and git refused the capture; the message starts with the reason.                                 | `not_a_repository`: make the workdir the top of a git work tree and put `git` on the guest's `PATH`. `base_unresolved`: give the repository a commit. Otherwise read git's quoted stderr.     |
| `deadline_exceeded` | The whole session outlived `options.timeout`, ten minutes by default.                                                 | Raise the timeout or shorten the child. The machine is released either way.                                                                                                                   |

## A file the child wrote is missing from the work

**Symptom.** `captureWork` was on, the child wrote a file, and the patch in
`result.work` does not touch it.

**Cause.** The workdir's `.gitignore` excludes the path. Ignored files are not
work.

**Fix.** Write the file to a path the repository tracks, or return its content
in `output`. See
[Capture the work a sandboxed child did](./guides/collect-a-workspace-diff.md).

## Two executions fought over one machine

**Symptom.** A sandboxed execution's machine disappears under it, or two
executions appear to share a workspace.

**Cause.** A session key is an exclusive claim. Two live executions with one key
share a machine, and the first to finish tears it down under the other.

**Fix.** Derive the key from both the parent `executionId` and the action's
`callId`. The engine preserves `callId` across retries and resume and assigns
distinct identities to parallel calls, even with identical payloads. The parent
id alone gives every call in one execution the same machine:

```ts
SandboxedFlow.toLayer(RunChild, Child, ({ executionId, callId }) => ({
  provider,
  session: `child:${executionId}:${callId}`,
  entry
}))
```

## A type error names a registry service the layer does not provide

**Symptom.** `NodeRuntime.layerHost<..., MyCatalog, never, never>(options, registerFlows)`
does not compile.

**Cause.** That is the point. The registry-taking form is a separate overload,
not a defaulted parameter, so a call that names a registry type must also pass
the registry layer. A default would compile and hand back a layer that claims to
provide `MyCatalog` while providing nothing.

**Fix.** Pass the registry layer as the third argument, or drop the registry
type parameters. See
[Discover flows from a registry](./guides/discover-flows-from-a-registry.md).

## `node:sqlite` ended up in a browser bundle

**Symptom.** A browser or edge build pulls in `node:sqlite` or
`node:child_process`.

**Cause.** A browser or edge build imports `@smthrs/platform-node`, which
holds `NodeRuntime` and `SandboxedFlow`, or `@smthrs/platform-bun`. The
`@smthrs/flows` root is browser- and Worker-safe; the native host packages are
not, which is why the native compositions live there.

**Fix.** Keep both out of shared code, and compose `Runtime` from the
`@smthrs/flows` root over the browser or Cloudflare host instead. Durable
execution is tested on Node.js 22.19+ and Bun 1.4+; `engines` requires Node
`>=22.19.0`.

## Example replay and transport failures

Example 10 lists only exports acknowledged with a successful HTTP response;
refused or failed requests do not establish collector receipt. Example 21 seeds
`schema.sql` only when absent, preserving the applied migration when `migrate-1`
is replayed. Example 24 mirrors engine status after a launched drive exits,
including failure, without consuming the launch failure. Example 35 rejects
listener startup failures; `startSharedTier` optionally accepts a port (zero by
default) so an occupied address can be diagnosed by its original error.
