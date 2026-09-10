/**
 * Signalling a remote process, and pinging the session it runs in.
 *
 * The adapter used to answer every `kill` with `BadArgument`: a remote session
 * ended only by closing its scope, so a provider that CAN stop one command
 * without tearing down the whole session had no way to say so. These cases pin
 * both halves of the optional contract — a provider that implements `kill` gets
 * the signal, and a provider that does not keeps the old, honest refusal.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, PlatformError, Ref, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawn as spawnNode } from "node:child_process"
import { once } from "node:events"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cancelGuard, cancelledStatus, cancelMarker, hostKillScript, killScript } from "../src/internal/killScript.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

const reason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("RemoteChildProcessSpawner kill", () => {
  it.effect("signals a live remote process when its scope closes", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { serve: { pending: true } }
      })

      yield* Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.spawn(ChildProcess.make("serve"))).pipe(
        Effect.scoped,
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )

      expect(provider.state.kills).toEqual([{ command: "serve", signal: "SIGTERM" }])
      expect(provider.state.cancellations).toBe(1)
    }))

  for (const exits of [true, false]) {
    it.live(
      exits
        ? "returns string promptly when exit is observed during a hung closing-scope kill"
        : "bounds string cleanup to five seconds when both kill and exit observation hang",
      () =>
        Effect.gen(function*() {
          const exited = yield* Deferred.make<number>()
          const signalling = yield* Deferred.make<void>()
          const provider: RemoteChildProcessSpawner.Provider = {
            session: "hung-kill",
            open: () => Effect.void,
            spawn: () => Effect.succeed({
              stdout: Stream.make(new TextEncoder().encode("hi")),
              stderr: Stream.empty,
              exitCode: Deferred.await(exited)
            }),
            kill: () => Effect.andThen(Deferred.succeed(signalling, undefined), Effect.never)
          }
          const reading = yield* Effect.flatMap(
            ChildProcessSpawner,
            (spawner) => spawner.string(ChildProcess.make("greet"))
          ).pipe(
            Effect.provide(RemoteChildProcessSpawner.layer(provider)),
            Effect.forkScoped
          )

          // Kill is entered only once stdout has ended and the process scope
          // is closing. Keep exit pending until after that point, so the test
          // exercises the finalizer's race rather than its already-exited path.
          yield* Deferred.await(signalling)
          expect(yield* Deferred.isDone(exited)).toBe(false)
          const started = performance.now()
          if (exits) {
            yield* Effect.sleep("100 millis")
            yield* Deferred.succeed(exited, 0)
          }
          expect(yield* Fiber.join(reading)).toBe("hi")
          const took = performance.now() - started
          if (exits) {
            expect(took).toBeLessThan(2_000)
          } else {
            expect(took).toBeGreaterThanOrEqual(4_500)
            expect(took).toBeLessThan(8_000)
          }
        }).pipe(Effect.scoped),
      12_000
    )
  }

  it.effect("signals with the kill signal the command configured", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { serve: { pending: true } }
      })

      yield* Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.spawn(ChildProcess.make("serve", [], { killSignal: "SIGHUP" }))
      ).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(provider.state.kills).toEqual([{ command: "serve", signal: "SIGHUP" }])
    }))

  it.effect("kills through the handle on request", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { serve: { pending: true } }
      })

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("serve"))
        yield* handle.kill({ killSignal: "SIGKILL" })
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(provider.state.kills[0]).toEqual({ command: "serve", signal: "SIGKILL" })
    }))

  it.effect("leaves a process that already exited unsignalled", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { greet: { stdout: "hi" } }
      })

      const code = yield* Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make("greet"))
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(code).toBe(0)
      expect(provider.state.kills).toEqual([])
    }))

  it.effect("reports a provider kill failure as a PlatformError", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        killFailure: new ProviderError({ code: "unavailable", message: "session is gone" }),
        scripts: { serve: { pending: true } }
      })

      const error = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("serve"))
        return yield* Effect.flip(handle.kill())
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(reason(error)).toBe("NotFound")
      expect(error.message).toContain("session is gone")
    }))

  it.effect("still runs the session finalizer for a provider that cannot kill", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { serve: { pending: true } } })

      const error = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("serve"))
        return yield* Effect.flip(handle.kill())
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(reason(error)).toBe("BadArgument")
      expect(provider.state.kills).toEqual([])
      expect(provider.state.cancellations).toBe(1)
    }))
})

/**
 * The guest-side programs are shipped as text into a container, a Pod, or an
 * ECS task and run by a shell this repository never sees. They are exercised
 * behaviorally elsewhere, against real shells; pinned here because a refactor
 * of the `/proc` parse or of the collect-then-signal ordering can regress the
 * descendant walk into a silent no-op that every behavioral test still passes.
 */
describe("guest kill scripts", () => {
  it("pins the pidfile-waiting guest script", () => {
    expect(killScript("/tmp/.smthrs-sbx/0.pid", "TERM")).toBe(
      ": > /tmp/.smthrs-sbx/0.pid.cancel || exit 1; "
        + "n=0; while [ ! -s /tmp/.smthrs-sbx/0.pid ] && [ \"$n\" -lt 5 ]; do sleep 1; n=$((n+1)); done; "
        + "p=$(cat /tmp/.smthrs-sbx/0.pid 2>/dev/null); "
        + "if [ -z \"$p\" ]; then exit 0; fi; "
        + "kids() { t=$1; for d in /proc/[0-9]*; do read -r s 2>/dev/null < \"$d/stat\" || continue; "
        + "r=${s##*) }; set -- $r; printf '%s %s\\n' \"${d#/proc/}\" \"$2\"; "
        + "done | awk -v root=\"$t\" '{ pid=$1+0; parent=$2+0; sibling[pid]=first[parent]; first[parent]=pid } "
        + "END { root+=0; stack[1]=root; seen[root]=1; depth=1; while (depth) { "
        + "pid=stack[depth]; child=first[pid]; if (child != \"\") { first[pid]=sibling[child]; "
        + "if (!seen[child]++) stack[++depth]=child; "
        + "} else { if (pid != root) print pid; depth-- } } }'; }; "
        + "set -- $(kids \"$p\") \"$p\"; "
        + "kill -s TERM \"$@\" 2>/dev/null && exit 0; "
        + "kill -s TERM \"$p\" 2>/dev/null && exit 0; "
        + "kill -0 \"$p\" 2>/dev/null || exit 0; "
        + "exit 1"
    )
  })

  it("plants cancellation before reading an empty pidfile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-kill-order-"))
    const bin = join(directory, "bin")
    const pidfile = join(directory, "command.pid")
    const read = join(directory, "cat-read")
    const release = join(directory, "release-cat")
    const ran = join(directory, "command-ran")
    mkdirSync(bin)
    writeFileSync(pidfile, "\n")
    writeFileSync(
      join(bin, "cat"),
      "#!/bin/sh\n/bin/cat \"$1\"\n: > \"$SMTHRS_READ\"\n"
        + "while [ ! -e \"$SMTHRS_RELEASE\" ]; do /bin/sleep 0.01; done\n"
    )
    chmodSync(join(bin, "cat"), 0o755)

    const killer = spawnNode("/bin/sh", ["-c", killScript(pidfile, "TERM")], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        SMTHRS_READ: read,
        SMTHRS_RELEASE: release
      },
      stdio: "ignore"
    })
    let wrapperCode: number | null = null
    let commandRan = false
    try {
      // The intercepted cat has already read the old newline, which command
      // substitution turns into an empty pid, but it holds the kill before
      // the following shell statement so the wrapper can take the old window.
      for (let attempts = 0; !existsSync(read) && attempts < 200; attempts++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(existsSync(read)).toBe(true)
      const wrapper = spawnNode(
        "/bin/sh",
        ["-c", `echo $$ > ${pidfile}; ${cancelGuard(pidfile)}; : > ${ran}`],
        { stdio: "ignore" }
      )
      const wrapperExit = await once(wrapper, "exit") as [number | null, NodeJS.Signals | null]
      wrapperCode = wrapperExit[0]
      commandRan = existsSync(ran)
      writeFileSync(release, "")
      await once(killer, "exit")
    } finally {
      if (!existsSync(release)) writeFileSync(release, "")
      if (killer.exitCode === null) killer.kill()
      rmSync(directory, { recursive: true, force: true })
    }

    expect(wrapperCode).toBe(cancelledStatus)
    expect(commandRan).toBe(false)
  })

  it("pins the host-side script and its pgrep-or-proc descent", () => {
    expect(hostKillScript(1234, "TERM")).toBe(
      "p=1234; "
        + "if command -v pgrep >/dev/null 2>&1; "
        + "then kids() { for c in $(pgrep -P \"$1\" 2>/dev/null); do ( kids \"$c\" ); echo \"$c\"; done; }; "
        + "else kids() { t=$1; for d in /proc/[0-9]*; do read -r s 2>/dev/null < \"$d/stat\" || continue; "
        + "r=${s##*) }; set -- $r; printf '%s %s\\n' \"${d#/proc/}\" \"$2\"; "
        + "done | awk -v root=\"$t\" '{ pid=$1+0; parent=$2+0; sibling[pid]=first[parent]; first[parent]=pid } "
        + "END { root+=0; stack[1]=root; seen[root]=1; depth=1; while (depth) { "
        + "pid=stack[depth]; child=first[pid]; if (child != \"\") { first[pid]=sibling[child]; "
        + "if (!seen[child]++) stack[++depth]=child; "
        + "} else { if (pid != root) print pid; depth-- } } }'; }; fi; "
        + "set -- $(kids \"$p\") \"$p\"; "
        + "kill -s TERM \"$@\" 2>/dev/null && exit 0; "
        + "kill -s TERM \"$p\" 2>/dev/null && exit 0; "
        + "kill -0 \"$p\" 2>/dev/null || exit 0; "
        + "exit 1"
    )
  })

  it("pins the cancellation marker the two halves agree on", () => {
    // The kill writes this path before it reads any pid and the wrapper reads
    // it before becoming the command. They are two programs on two machines;
    // only this literal keeps them talking about the same file.
    expect(cancelMarker("/tmp/.smthrs-sbx/7.pid")).toBe("/tmp/.smthrs-sbx/7.pid.cancel")
    expect(cancelGuard("/tmp/.smthrs-sbx/7.pid")).toBe(
      "if [ -e /tmp/.smthrs-sbx/7.pid.cancel ]; then exit 143; fi"
    )
    expect(cancelledStatus).toBe(143)
  })
})

describe("SandboxHealth from a provider", () => {
  it.effect("probes a provider that answers its ping", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ ping: Effect.void })

      const state = yield* SandboxHealth.make(provider).check

      expect(state._tag).toBe("Healthy")
    }))

  it.effect("reports a failed provider ping as unhealthy", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(new ProviderError({ code: "unavailable", message: "no session" }))
      })

      const state = yield* SandboxHealth.make(provider).check

      expect(state).toMatchObject({ _tag: "Unhealthy", reason: "ping_failed", message: "no session" })
    }))

  it.effect("reports a provider that cannot be pinged as healthy, the way an unsandboxed host is", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({})

      const state = yield* SandboxHealth.make(provider).check

      expect(state._tag).toBe("Healthy")
    }))

  it.effect("provides the provider-backed service as a layer", () =>
    Effect.gen(function*() {
      const pings = yield* Ref.make(0)
      const provider = RemoteChildProcessSpawner.TestRemote.make({ ping: Ref.update(pings, (n) => n + 1) })

      const state = yield* Effect.flatMap(SandboxHealth.SandboxHealth, (health) => health.check).pipe(
        Effect.provide(SandboxHealth.layer(provider))
      )

      expect(state._tag).toBe("Healthy")
      expect(yield* Ref.get(pings)).toBe(1)
    }))
})
