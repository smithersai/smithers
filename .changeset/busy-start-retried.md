---
"@smthrs/platform-node": patch
"@smthrs/targets": patch
"@smthrs/build-cli": patch
---

A target the machine was too busy to start is started again instead of failing.
On a loaded host a target failed with `TimedOut: ChildProcess.spawn (/bin/sh):
The machine was too busy to start the process within 5 s` and every target
behind it was skipped. When the supervisor missed its bound before it had
connected, its cleanup also waited out a stop the supervisor never read, and the
miss surfaced as a defect rather than a typed error.

Now the supervisor stops an owner that has not connected at once, and a miss
before the owner is asked to start the target is a typed `startup_timeout`: the
target never ran. `Exec.run` retries such a start under `Exec.StartupRetry`
(15 s, 30 s and 60 s attempts, 1 s then 2 s apart, never beyond the tool's
`timeoutMs`), and dependents run when a retry succeeds. When every attempt
misses, the run fails with the new `ExecError` code `start_timed_out`, and the
target reports `command did not start`. A miss after the owner was asked to
start the target is the new `activation_timeout`, bounded by the tool's own
deadline through `ScopedProcess.spawn`'s new `activationTimeoutMs`, and is
never retried.

```ts
Exec.run(settings, payload).pipe(
  Effect.provideService(Exec.StartupRetry, { attemptsMs: [10_000, 20_000], backoffMs: 500 })
)
```
