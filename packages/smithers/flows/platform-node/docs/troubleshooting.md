---
title: "Troubleshooting"
description: "The failures this Node bundle reports: filesystem refusals from the atomic helper, liveness verdicts that look wrong, reaper outcomes that will not retire a record, Windows behaviour, and language-server refusals and timeouts."
---

The failures here come from four places: the atomic filesystem helper, the
host liveness probe, the process reaper, and the language-server client. Each
answers deliberately, and several answers that look like bugs are the safe
choice.

## `NodeRuntime cannot install signal ...`

This configuration error is raised before listener installation. The name must
appear in `node:os`'s `constants.signals` and cannot be `SIGKILL` or `SIGSTOP`.
An existing listener does not cause this error. Compare the configured name
with the signal constants in the process that constructs the host.

Cross-driver cancellation uses a durable interrupt request and needs no OS
signal: a host can set `signals: []`. The NodeRuntime regression exercises
cancellation both with no listeners and with two hosts listening for `SIGUSR2`.
Worker threads do not receive process signals; see
[Node's worker restrictions](https://nodejs.org/api/worker_threads.html).

## A filesystem call fails with `ENOTSUP`

**Symptom.** An atomic operation fails with:

```text
atomic operation is unsupported
```

**Cause.** The helper was asked for an operation it does not implement. Every
operation is named explicitly, so an unrecognized one is refused rather than
approximated.

**Fix.** Use one of the supported operations. If you reached this through a
higher-level API, the operation name in the error identifies which call needs
a different route.

## A glob fails with `EFBIG`

**Symptom.**

```text
glob result exceeds the response limit
```

**Cause.** The match set was larger than the helper's response limit. The
limit is enforced while matches accumulate, not after, so a runaway pattern
fails fast instead of buffering without bound.

**Fix.** Narrow the pattern, or root it at a deeper directory. See
[match files with a glob pattern](./guides/match-files-with-glob.md).

## Every filesystem call fails on Windows

**Cause.** This is intended. Windows is an unsupported platform, and
`AtomicFileSystem` fails every filesystem call closed there rather than
half-working.

**Fix.** Run the durable engine on a supported platform. There is no flag to
enable a partial Windows path: a filesystem that confines some operations and
not others is worse than one that says it confines none.

## A run's owner reads as alive when the process is gone

**Cause.** The liveness probe fails safe. Only `ESRCH` from a signal-0 probe
counts as gone. `EPERM` means the pid exists and belongs to another user,
which is still a live owner. A throw carrying no code at all, including a
thrown string or `null`, is an answer nobody gave, and so also reads as alive.

This matters because the engine consults the probe before taking a run whose
recorded owner it is not: a wrong `true` strands a run, and a wrong `false`
runs it twice. Stranding is the cheaper mistake, so ambiguity resolves to
alive.

**Fix.** Nothing here is broken. If a run is genuinely stranded, retire the
owner record rather than weakening the probe. See
[answer whether a run owner is alive](./guides/answer-run-ownership.md).

## The liveness probes disagree on a foreign host

**Cause.** Both probes use the same `ESRCH`-only death rule.
`EPERM`, `EINVAL`, and unknown signal errors preserve liveness.
For a valid same-host pid, signal errors do not distinguish the probes.

`HostLiveness.isAlive` compares the owner's host with its configured `hostId`
and reports foreign owners as alive. `Ownership.sameHostPidProbe` compares
with `context.claimant.hostId` and returns `false` for a foreign owner without
probing its pid. The engine consults it after lease expiry, and the store
verifies that expiry before allowing a steal.

**Fix.** Choose the cross-host policy deliberately. `HostLiveness.isAlive`
leaves foreign-host recovery to an operator or another liveness source;
`sameHostPidProbe` lets the expired lease govern reclaiming foreign-host runs.
`HostLiveness.isAlive` reads the context argument only to recognize an
earlier incarnation under the claimant's own pid. See
[answer whether a run owner is alive](./guides/answer-run-ownership.md).

## The reaper answers `failed` and keeps the record

**Cause.** `failed` means the signal was refused and the record must be tried
again later. The reaper refuses a target rather than signalling something it
cannot prove it owns. On POSIX it refuses when:

- the record has no process group (`no-group`)
- the pid or pgid is not a safe integer, or is `1` or lower
- the pgid does not equal the pid, so the record does not name a group leader
- the target is this process's own pid or group, or the owner's

**Fix.** Read the record. A record failing the group-leader check was written
by something that did not spawn through the contained spawner, and reaping it
would signal a group this host does not own. See
[contain child processes](./guides/contain-child-processes.md).

## The reaper answers `unknown` rather than `dead`

**Cause.** `unknown` is not `dead`. `ESRCH` is the only answer that means
gone; a pid this host may not signal answers `EPERM`, and that is not
evidence of death.

**Fix.** Treat `unknown` as "ask again". Retiring on `unknown` would drop a
record describing a live process.

## A pid start-time lookup is `unavailable` rather than `gone`

**Cause.** The three negative answers are distinct because they authorize
different decisions. `gone` is evidence: the pid does not exist, so the record
describes nothing and is retired unsignalled. `unavailable` is the absence of
evidence: `ps` is missing, unanswerable, or printed something unrecognized.

**Fix.** Only `gone` may retire a record. `unavailable` must not, or a host
without `ps` would retire every record it holds.

## Reaping on Windows is weaker

**Cause.** Windows has no process groups and no `lstart`, so two guards cannot
be answered: the identity check falls back to boot-time comparison alone, and
there is no own-group refusal to make. The path runs
`%SystemRoot%\System32\taskkill.exe /T /F` by pid, by absolute path with an
inert working directory, so a `taskkill.exe` planted in the host's directory
never runs.

**Fix.** Nothing, and do not rely on it. Windows is unsupported; this path is
best-effort so that a win32 record is not silently retired as if reaped.

## permission_denied: Language server program is inside the workspace

**Cause.** `NodeLanguageServer.make` resolved `command` to a file under `cwd`
(a `./` path, a `PATH` entry such as `node_modules/.bin`, or a symlink there),
an argument named a file or directory under `cwd`, or `command` was a launcher
(`sh -c`, `env`, `npx`, `pnpm exec`, `yarn`, `bunx`, `bun`, `bundle exec`,
`uvx`, or a wrapper such as `nice` or `timeout`) whose arguments choose what
runs, or an interpreter (`node`, `python`, `ruby`, `perl`) without a host
script file or with a code or module flag such as `-e`, `-pe`, `--import` or
`python -m`. The server would have run workspace-written code on the host. The
message names the program, the argument, or the launcher.

**Fix.** Install the server outside the workspace and pass its absolute path,
not a launcher. For typescript-language-server, also pin
`initializationOptions: { tsserver: { path } }` to a host copy. See
[Run a language server](./guides/run-a-language-server.md#keep-the-servers-code-out-of-the-workspace).

## timeout: Language server published no diagnostics

**Cause.** The server has no pull diagnostics, and it published nothing for
the latest synced text within `settleMs`. typescript-language-server publishes
nothing for a change that leaves a file with no problems, so such a change
always ends here.

**Fix.** Set `settleMs` and `quietMs` from a measurement on your host; see
[Diagnostics](./guides/run-a-language-server.md#diagnostics).

## Model calls fail with ERR_HTTP2_INVALID_SESSION

The October 20 Cerebras campaign used Node's global fetch and reported 58
invalid-session failures at concurrency 10. A separate provider run observed a
TLS `bad record mac` alert before persistent invalid-session failures. This is
a client HTTP/2 session-lifecycle failure, not evidence of provider capacity.
The retained `test/fixtures/provider-fatal-tls.mjs` reproduces the same wedge
without Cerebras. A loopback TCP proxy flips one encrypted record after a
successful HTTP/2 response. On Node 26.5 (bundled Undici 8.7.0) and Node 26.10
(bundled Undici 8.10.2), the next call fails with
`ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC`; every subsequent call to that
origin fails with `ERR_HTTP2_INVALID_SESSION`. Its stack enters
`ClientHttp2Session.request` through Undici's `openStream` and `writeH2`:
the origin's pooled HTTP/2 client continues dispatching against the destroyed
session after a fatal TLS error. No abort or second origin is needed. Normal
GOAWAY/session teardown controls recover, which explains why those controls
alone did not reproduce the historical wedge. The fixture trusts its ephemeral
CA only inside an isolated child; it never disables certificate verification.

The same fault against `providerFetch` yields six successful calls: the damaged
pre-header request repairs once on a fresh HTTP/1.1 pool, and later calls remain
healthy. The regression asserts the old persistent failure on the affected
bundled versions and recovery on the shared provider transport.

A Node model host passes `EgressHttpClient.providerFetch` as `HostModel`'s
`fetch` option; packaged model hosts, the playground, evals and the load
benchmark use the same implementation. Workers and browsers keep their runtime
transport. Provider fetch owns a scoped, proxy-aware HTTP/1.1 pool, avoiding the
affected HTTP/2 session path entirely. Each request it carries logs
`platform-node.provider-fetch` at debug level with its origin.

The `NodeHost` bundles provide no `FetchHttpClient.Fetch`. Effect's fetch client
reads that reference from the fiber making the request, which outranks the
context the client was built in, and a flow runtime runs each step in a fiber
carrying its host's context. A host-wide `Fetch` replaces the fetch every
composition injects: on 2026-10-20 it sent apps/mvp's model tests, which inject
the model through a fetch, to the network, where they hung until their timeout.

A fetch rejection caused by `UND_ERR_SOCKET`, `ERR_HTTP2_INVALID_SESSION`,
`ERR_HTTP2_GOAWAY_SESSION`, `ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC` or
`ERR_SSL_BAD_RECORD_MAC_ALERT` before response headers gets one fresh-pool repair.
Concurrent failures share the replacement pool. Aborts, streaming request bodies,
Request objects, HTTP refusals, and errors while consuming a response body are
never replayed here. The second failure propagates; there is no retry loop or
backoff. Durable flow policy remains responsible for real retries. A connection
loss before headers does not prove the server did no work: provider POST repair
can duplicate work, so this is not an exactly-once guarantee. Retired pools
remain owned by the host scope until its finalizers destroy them, so a pending
response remains cancellable at shutdown.

The sustained 60-second concurrency-10 repeat completed 199 requests, received
343 provider 429s, and had zero other errors. The 63.3% refusal fraction stopped
25/50 escalation. This establishes a provider refusal boundary for that shared
account and workload. The local TLS corruption fixture establishes the transport
failure independently of this capacity experiment.

## Linux host integration fixtures

Runtime registration diagnostics share stdout with fixture output. A host is
ready only when its explicit receipt arrives: `STATUS=running` for signal cleanup,
`SPAWNED=<pid>` for crash reaping. Never signal a PID parsed from an arbitrary
first output line. The Linux integration suites exercise actual orphan reaping
and the journal the next host inherits.

Restart refusal fixtures must change behavior, not just comments. Durable
resume uses the normalized source shape in `@smthrs/crypto`'s
`src/internal/sourceShape.ts`, which drops comments and whitespace. The restart
suite checks both semantic-edit refusal and comment-only resumption.

Linux proc-stat reads can fail with `ENOENT` before open or `ESRCH` if the
process exits after open. Both mean that PID is gone. A different read failure
still makes the snapshot unavailable, preserving the reaper's fail-closed
behavior. The regression retains a real stat descriptor through child exit to
exercise `ESRCH` without a timing-dependent race.
