---
title: "Troubleshooting"
description: "The refusals @smthrs/kernel produces, what each one means, and what to change: policy misses, ceiling denials, filesystem confinement, grant replies, journal replay, and composition errors."
---

Every refusal this package produces is typed and carries a stable code. Find
the message or the code and read the matching section.

Where Effect owns the tag, the failure arrives projected. Read it back first:

```ts
import { HttpClient, Permission } from "@smthrs/kernel"
import { Option } from "effect"

// FileSystem and ChildProcessSpawner failures.
Option.getOrThrow(Permission.fromPlatformError(failure))
// HttpClient failures.
Option.getOrThrow(HttpClient.fromHttpClientError(failure))
```

`Jj` names `Permission.PermissionError` in its own channel, so there is
nothing to unwrap.

## permission_required

**What happened.** No rule matched the capability, so the decision defaulted to
`ask`, and the store is unattended. The failure names the request id, the
capability, its effect tier, and the display metadata.

**What to change.** Add an allow rule for the capability, or run an attended
store so an operator can answer. This is the expected refusal for a headless
host meeting an operation nobody authorized; it is not a bug in the caller.

## permission_denied: denied by permission policy

**What happened.** A rule matched and denied it. Rules are last-match-wins
across the four rulesets, and an effective denial in the **configured** ruleset
is a hard veto no envelope, run grant, or remembered grant can lift.

**What to change.** If the denial is in the configured policy and intended,
nothing: that is the veto working. If it is not intended, add a later allow in
the same configured ruleset, since a configured deny superseded within its own
ruleset is not a veto.

## permission_denied: outside capability ceiling

**What happened.** The fiber passed through `CapabilitySet.attenuate` and the
capability is outside the resulting ceiling. This is checked before any rule,
so no policy and no operator reply can override it.

**What to change.** Widen the group you passed to `attenuate`, or do the work
outside the attenuated scope. There is no public widening operation by design:
authority only narrows.

## permission_denied: grant store closed, and store_closed

**What happened.** The store's scope closed. A request that was parked at that
moment fails with `permission_denied` and `"grant store closed"`; a call made
afterwards fails with the `GrantStoreError` code `store_closed`.

**What to change.** Keep the store's scope open for as long as the work that
uses it. A store built inside `Effect.scoped` around a short program, while the
guarded host outlives it, produces exactly this.

## permission_denied: host does not provide descriptor-relative, no-follow filesystem isolation

**What happened.** The filesystem in the composition carries neither
confinement extension, so every path, directory, stream, glob, and handle
operation fails closed.

**What to change.** A native adapter attaches
`FileSystem.withAtomicFileSystem` with operations rooted at a pinned
descriptor. A volume that genuinely cannot address the host filesystem attests
with `FileSystem.withIsolatedFileSystem`. Attaching neither is not a
configuration to relax; the check exists because a path-delegating filesystem
cannot be confined. See
[Filesystem confinement](./concepts/filesystem-confinement.md).

If the failure names `../<system-temp>`, the operation was
`makeTempDirectory`, `makeTempFile`, or one of their scoped forms: they name no
directory, so the kernel authorizes the system temporary directory sentinel.

## permission_denied: hard-linked files cannot be confined to the workspace

**What happened.** The target is a regular file with more than one link. A hard
link is a second name for the same inode with no ancestry to check, so there is
no canonical resource to authorize.

**What to change.** Copy the file rather than hard-linking it, or operate on it
outside the guarded surface. This refusal is always on and there is no option
to disable it.

## permission_denied: path no longer names the resource that was authorized

**What happened.** The grant decision suspended (an attended request, or a
journal write), and when it came back the path resolved to something else. A
symlink or a rename swapped in during the wait.

**What to change.** Usually nothing in the caller: this is the protection
working. If it fires without an adversary, something else is rewriting the tree
concurrently, most often a build or a watcher touching the same paths.

## permission_denied: descriptor no longer names the resource at its authorized path

**What happened.** An open handle's `device:inode` identity, captured at open
time, no longer matches what the authorized path names. After a rename the
descriptor can address an inode outside the workspace even when the replacement
path is still allowed.

**What to change.** Reopen the file. Holding a handle across a rename is what
produces this.

## Throw: filesystem already carries a descriptor-relative executor

**What happened.** `withIsolatedFileSystem` was called on a filesystem that
already carries a descriptor-relative executor. The refusal is a throw at
composition time, so a host cannot be assembled that way.

**What to change.** Do not attest whole-volume isolation over a native host.
The executor is the stronger guarantee, and replacing it with a path-delegating
attestation reopens the symlink-swap window. If you meant to layer over the
existing executor, read it first and delegate to it; that replacement is your
own decision and is allowed.

## invalid_resolution: run grants require a plan digest

**What happened.** A `"run"` reply arrived on a store built without
`planDigest`. A run grant is bound to the exact active plan, and there is
nothing to bind it to.

**What to change.** Pass `planDigest` when building the store, or reply `once`
or `remembered` instead.

## invalid_resolution: grant pattern exceeds the requested authority

**What happened.** The pattern supplied to `reply` names a different action,
reaches a more dangerous effect tier than the request displayed, or is a
wildcard-bearing pattern identical to the resource. The last case is refused
because the grammar has no escape, so the pattern's wildcard reading would
silently widen access.

**What to change.** Supply a pattern within the request's own action and tier,
or omit it and let the exact capability derive one.

## invalid_resolution: the requested resource contains glob metacharacters

**What happened.** A `"run"` or `"remembered"` reply with no explicit pattern,
for a resource containing `*` or `?`. There is no unambiguous pattern to
derive.

**What to change.** Supply an explicit pattern, as the message says, or resolve
`once`.

## request_not_found

**What happened.** No parked request has that id. It was already answered, the
asking fiber was interrupted, or the store was rebuilt.

**What to change.** Re-read `store.list` before replying. Reply ids are only
valid for the store instance that issued them.

## invalid_resolution: rules exceed 1024 entries

**What happened.** A bound was reached. One store retains at most 1,024 rules
across all four rulesets, 1,024 envelope signatures, 256 patterns per
envelope, and 1,024 parked requests. Every bound failure happens **before**
any state or journal authority changes.

**What to change.** Narrow the policy: one broad pattern replaces many exact
ones. If the count is coming from replay, the message from
`JournalGrantStore` names the policy run and the counts, and the fix is to
compact that journal. Check against the exported constants
(`GrantStore.maximumRules` and its siblings) rather than hardcoding numbers.

## journal_failed

**What happened.** `JournalGrantStore` could not persist a decision, or could
not replay history. The decision is **not** activated: a permission that could
not be written down was not granted.

**What to change.** Fix the journal (space, permissions, connectivity). Check
that a `SqlJournal` uses the `reject` overflow policy: a dropped grant decision
cannot safely be treated as persisted, so drop-capable policies are
unsupported.

## invalid_resolution: non-advancing journal page

**What happened.** A journal page did not advance past the cursor it was asked
for. Following it would replay the same events forever; accepting it would
double-apply them, so construction is refused. The message names the run
(`policyRunId` or `runId`) whose page failed to advance, and the sequence.

**What to change.** This is corrupt journal output, not a policy problem.
Investigate the journal implementation or the store beneath it.

## invalid_resolution: run-scoped event found in policy journal

**What happened.** Replay found an event in the wrong run: a run-scoped event
in the policy run, or a remembered event in the operational run. The sibling
failures are `"grant payload run mismatch"`, `"invalid grant payload"`,
`"grant envelope/payload type mismatch"`, and the `"unsafe ... event"`
refusals. Sequences are per run and the store replays two runs, so every one
of these names the run it was replaying and the sequence within it, for
example `invalid grant payload in run kernel-policy at journal sequence 7`.
That row is the one to inspect or compact.

**What to change.** Check that `runId`, `policyRunId`, and `sourceId` are the
ones this store has always used. Reusing an operational run id as a policy run
id, or writing kernel event types from another producer under the same source
id, produces exactly this.

## invalid_resolution: runId and policyRunId must be distinct

**What happened.** `JournalGrantStore` was given the same id for both. Run
grants and remembered grants must live in separate runs, because remembered
policy has to outlive any single run.

**What to change.** Keep `policyRunId` stable across every run and give each
operational run its own `runId`.

## permission_denied: HTTP capability checks require an absolute, parseable URL

**What happened.** The request URL did not parse as an absolute URL, so there
is no host to name as a resource.

**What to change.** Build requests with an absolute URL. A relative path
resolved by a base elsewhere never reaches the decorator as one.

## A grant for a host does not cover http:// to that host

**What happened.** This is the design, not a bug. `https` is the implicit
scheme: an `https:` URL names the bare lowercased host, and every other scheme
names `<scheme>//<host>`. A grant for `api.example.test` therefore never
authorizes `http://api.example.test`.

**What to change.** Use `https`, or write the cleartext resource explicitly in
the rule if a downgrade is genuinely intended.

## Snapshot refusals

Three failures mean a caller handed in something that could still change after
the capability was checked:

- `"filesystem options must contain only data properties"`: an options object
  carrying a getter rather than plain data.
- `"HTTP request must be an immutable supported request description"`: a
  request body that is neither immutable nor copyable.
- `"command must be an immutable supported process description"`, a
  `PlatformError` with reason `InvalidData`: a command that could not be
  snapshotted.

**What to change.** Pass plain data. The snapshot exists so the operation
executed after a grant arrives is the operation that was authorized.

## NotFound: no process host for `<command>`

**What happened.** The composition has `ChildProcessSpawner.layerNoop()`, the
stub for a host that cannot start processes. The matching HTTP stub reports
`"HTTP is unavailable on this host"` as a `TransportError`.

**What to change.** Provide a real platform bundle. `TestHost` composes the
HTTP stub deliberately, so a test that expected a network call will see this.

## A spawn fails and no process is running

**What happened.** The spawn's durable `ProcessLedger` record failed to commit.
The child was signalled, the call failed, and no pid was left in
`ProcessLedger.live`.

**What to change.** Fix the journal. Do not catch this failure and proceed: a
child no incarnation of the host can discover is the one outcome containment
exists to prevent.

## Related

- [Handle a permission failure](/pkg/capability/guides/handle-a-permission-failure):
  the error shapes themselves.
- [How a grant decision is made](./concepts/grant-decisions.md): the order that
  produces each of these.
