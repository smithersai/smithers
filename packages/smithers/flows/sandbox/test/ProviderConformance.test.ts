/**
 * The suite a provider implementation has to pass.
 *
 * Vendor providers live in plugin packages, so this package cannot test them.
 * What it can do is state the contract as behavior and hand the statement to
 * the adapter author. These cases pin the statement itself: a provider that
 * honors the contract reports nothing, and each way of missing it is named.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Stream } from "effect"
import { defaultCheckTimeout, elapsed } from "../src/internal/deadline.vibe"
import * as ProviderConformance from "../src/ProviderConformance/index.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.vibe"

const commands: ProviderConformance.Commands = {
  writes: "greet",
  output: "hello",
  fails: "boom",
  failureCode: 3,
  runs: "serve",
  // Short, because one case below is a provider that will never stop and the
  // suite has to wait out the whole window to say so.
  stopsWithin: "250 millis"
}

const scripts = {
  greet: { stdout: "hello" },
  boom: { exitCode: 3 },
  serve: { pending: true },
  cat: { stdout: "sandbox-conformance-stdin" }
}

const gone = () => new ProviderError({ code: "unavailable", message: "session is gone" })

const checks = (violations: ReadonlyArray<ProviderConformance.Violation>) =>
  violations.map((violation) => violation.check)

describe("ProviderConformance", () => {
  for (const phase of ["acquire", "body", "release"] as const) {
    it.effect(`bounds a stuck transport ${phase} and starts cleanup`, () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const cleanups: Array<Deferred.Deferred<void>> = []
        let releases = 0
        const base = RemoteChildProcessSpawner.TestRemote.make({ scripts })
        const provider: RemoteChildProcessSpawner.Provider = {
          ...base,
          open: () =>
            Effect.acquireRelease(
              Effect.gen(function*() {
                const done = yield* Deferred.make<void>()
                cleanups.push(done)
                if (phase === "acquire") yield* Deferred.await(gate)
                return done
              }),
              (done) =>
                Effect.gen(function*() {
                  releases++
                  if (phase === "release") yield* Deferred.await(gate)
                  yield* Deferred.succeed(done, undefined)
                })
            ).pipe(Effect.asVoid),
          spawn: (command, options) =>
            phase === "body"
              ? Effect.andThen(Deferred.await(gate), base.spawn(command, options))
              : base.spawn(command, options)
        }
        const running = yield* Effect.forkDetach(
          ProviderConformance.check(provider, commands, { checkTimeout: "20 millis" })
        )
        yield* Effect.gen(function*() {
          const violations = yield* Effect.raceFirst(Fiber.join(running), Effect.as(elapsed("2 seconds"), undefined))
          expect(violations, "the deadline must return before the stuck boundary is released").toBeDefined()
          expect(violations?.map(({ check }) => check)).toEqual(["writes-its-output", "reports-a-nonzero-exit"])
          for (const violation of violations ?? []) {
            expect(violation.actual).toContain("did not finish within 20 milliseconds")
          }
          if (phase !== "acquire") expect(releases).toBeGreaterThan(0)
        }).pipe(Effect.ensuring(Effect.andThen(Deferred.succeed(gate, undefined), Fiber.interrupt(running))))
        yield* Effect.all(cleanups.map(Deferred.await))
        expect(releases).toBe(cleanups.length)
      }))
  }

  it.effect("requests cleanup when the caller cancels without awaiting a stuck release", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const releasing = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const provider: RemoteChildProcessSpawner.Provider = {
        ...RemoteChildProcessSpawner.TestRemote.make({ scripts }),
        open: () =>
          Effect.acquireRelease(Effect.void, () =>
            Effect.gen(function*() {
              yield* Deferred.succeed(releasing, undefined)
              yield* Deferred.await(gate)
              yield* Deferred.succeed(released, undefined)
            })),
        spawn: () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)
      }
      const running = yield* Effect.forkDetach(ProviderConformance.check(provider, commands))
      yield* Effect.gen(function*() {
        yield* Deferred.await(entered)
        const interrupted = yield* Effect.raceFirst(
          Effect.as(Fiber.interrupt(running), true),
          Effect.as(elapsed("1 second"), false)
        )
        expect(interrupted).toBe(true)
        const cleanupStarted = yield* Effect.raceFirst(
          Effect.as(Deferred.await(releasing), true),
          Effect.as(elapsed("1 second"), false)
        )
        expect(cleanupStarted).toBe(true)
      }).pipe(Effect.ensuring(Effect.andThen(Deferred.succeed(gate, undefined), Fiber.interrupt(running))))
      yield* Deferred.await(released)
    }))

  it.effect("uses the wall clock for a no-op kill under a frozen TestClock", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts, kill: true, killIsNoop: true })
      const violations = yield* ProviderConformance.check(provider, { ...commands, stopsWithin: "20 millis" }, {
        checkTimeout: "500 millis"
      })
      expect(checks(violations)).toEqual(["signals-a-running-command"])
      expect(violations[0]?.actual).toBe("the command was still running after the signal")
    }))

  it("defaults to a deadline below the shortest bundled provider test budget", () => {
    expect(Duration.toMillis(defaultCheckTimeout)).toBeLessThan(30_000)
    expect(Duration.toMillis(defaultCheckTimeout)).toBeGreaterThan(
      Duration.toMillis(ProviderConformance.defaultStopsWithin)
    )
  })

  it.live("reports nothing for a provider that honors the whole contract", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts, kill: true, ping: Effect.void })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(violations).toEqual([])
    }))

  it.effect("skips the optional capabilities a provider does not declare", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(violations).toEqual([])
      expect(provider.state.kills).toEqual([])
    }))

  it.effect("names a provider whose command writes the wrong bytes", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, greet: { stdout: "goodbye" } }
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["writes-its-output"])
      expect(violations[0]?.actual).toContain("goodbye")
    }))

  it.effect("names a provider whose command cannot be started", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, greet: { failure: gone() } }
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["writes-its-output"])
      expect(violations[0]?.actual).toContain("a failure")
    }))

  it.effect("names a provider that loses a nonzero exit code", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, boom: { exitCode: 0 } }
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["reports-a-nonzero-exit"])
      expect(violations[0]?.expected).toContain("3")
    }))

  it.effect("names a provider whose declared ping does not answer", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts, ping: Effect.fail(gone()) })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["answers-a-ping"])
    }))

  it.live("names a provider whose declared kill refuses a live process", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts,
        kill: true,
        killFailure: gone()
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["signals-a-running-command"])
      expect(violations[0]?.actual).toContain("a failure")
    }))

  it.live("names a provider whose declared kill is a silent no-op", () =>
    Effect.gen(function*() {
      // The dangerous adapter: `kill` satisfies the type, answers success, and
      // leaves the process running. Accepting it would make every cancelled
      // action leak a process inside the sandbox with the suite reporting
      // conformance.
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts,
        kill: true,
        killIsNoop: true
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["signals-a-running-command"])
      expect(violations[0]?.actual).toBe("the command was still running after the signal")
      // The signal was delivered and accepted. That is exactly the point.
      expect(provider.state.kills).toContainEqual({ command: "serve", signal: "SIGTERM" })
    }))

  // SandboxConformance bounded its own checks, but the delegated spawner-level
  // suite had no deadline anywhere. An adapter that never answered therefore
  // hung both public entry points instead of producing a violation. The kill
  // shape is the one the deadline alone could not save: losing the race closes
  // the process scope, and the scope's finalizer sends the same signal again,
  // uninterruptibly, which is why `layer` bounds that one too.
  it.live(
    "convicts every provider boundary that never answers",
    () =>
      Effect.gen(function*() {
        const complete = () =>
          RemoteChildProcessSpawner.TestRemote.make({ scripts, kill: true, ping: Effect.void, stdin: true })
        const open = complete()
        const spawn = complete()
        const quiet = complete()
        const ping = complete()
        const kill = complete()
        const hung: ReadonlyArray<{
          readonly provider: RemoteChildProcessSpawner.Provider
          /** The checks whose own boundary cannot answer, so the deadline is what names them. */
          readonly timesOut: ReadonlyArray<string>
          /** Checks this shape must also name, for a reason other than the deadline. */
          readonly alsoNames?: ReadonlyArray<string>
        }> = [
          {
            // Nothing runs at all: every check waits on the session.
            provider: { ...open, open: () => Effect.never },
            timesOut: [
              "writes-its-output",
              "reports-a-nonzero-exit",
              "delivers-standard-input",
              "answers-a-ping",
              "signals-a-running-command"
            ]
          },
          {
            // The session opens and `ping` answers; nothing else can start.
            provider: { ...spawn, spawn: () => Effect.never },
            timesOut: [
              "writes-its-output",
              "reports-a-nonzero-exit",
              "delivers-standard-input",
              "signals-a-running-command"
            ]
          },
          {
            // The transport starts a command and then goes quiet: the streams
            // never end and the exit never arrives. Its `kill` still answers,
            // so `signals-a-running-command` is convicted by the survivor wait
            // rather than by the deadline.
            provider: {
              ...quiet,
              spawn: () =>
                Effect.succeed({
                  stdout: Stream.never,
                  stderr: Stream.empty,
                  exitCode: Effect.never
                })
            },
            timesOut: ["writes-its-output", "reports-a-nonzero-exit", "delivers-standard-input"],
            alsoNames: ["signals-a-running-command"]
          },
          {
            provider: { ...ping, ping: Effect.never },
            timesOut: ["answers-a-ping"]
          },
          {
            provider: { ...kill, kill: () => Effect.never },
            timesOut: ["signals-a-running-command"]
          }
        ]

        for (const expected of hung) {
          const violations = yield* ProviderConformance.check(expected.provider, commands, {
            checkTimeout: "1 second"
          })
          const timedOut = violations
            .filter((violation) => violation.actual.includes("did not finish within"))
            .map((violation) => violation.check)
          // Every boundary that cannot answer is named, and the deadline is
          // given as the reason, so an adapter author reads "this never
          // returned" rather than watching the suite hang. The assertion is
          // containment, not equality: a machine under load can starve a check
          // that would otherwise have answered, and convicting one check too
          // many is not the failure this case is about.
          expect(timedOut).toEqual(expect.arrayContaining([...expected.timesOut]))
          expect(checks(violations)).toEqual(expect.arrayContaining([...expected.alsoNames ?? []]))
        }
      }),
    // Four shapes wait out their own one-second deadlines; the fifth also
    // waits out the scope-closing signal's bound, on a loaded machine.
    120_000
  )

  // `checkTimeout` says how long a single check may take before it is
  // convicted, and it used to say it about the check's BODY only. Losing the
  // race interrupts the check, interruption closes the process scope, and that
  // scope's finalizer sends the signal this provider never answers under its
  // own five-second bound, so a hundred-millisecond deadline cost more than
  // five seconds per hung check and the suite convicted checks that were only
  // ever queued behind that wait. The containment assertion above cannot see
  // that: it accepts a suite that convicts too much and takes as long as it
  // likes. This case measures both.
  it.live(
    "returns within the deadline it was given rather than the abandoned signal's bound",
    () =>
      Effect.gen(function*() {
        const provider: RemoteChildProcessSpawner.Provider = {
          ...RemoteChildProcessSpawner.TestRemote.make({ scripts, kill: true, ping: Effect.void, stdin: true }),
          kill: () => Effect.never
        }

        const started = Date.now()
        const violations = yield* ProviderConformance.check(provider, commands, { checkTimeout: "200 millis" })
        const took = Date.now() - started

        // Only the check whose own boundary hangs is named. Everything else
        // answered, so a suite that also convicted them would be reporting the
        // deadline's own cost as the adapter's defect.
        expect(checks(violations)).toEqual(["signals-a-running-command"])
        expect(violations[0]?.actual).toContain("did not finish within 200 milliseconds")
        // Comfortably under `signalWithin`, the five seconds the closing scope
        // gives the same unanswerable signal. Before the check was abandoned
        // rather than raced, this alone took longer than that.
        expect(took).toBeLessThan(3_000)
      }),
    30_000
  )

  it.effect("holds a provider that declares standard input to actually delivering it", () =>
    Effect.gen(function*() {
      // `Provider.stdin` exists so a transport that cannot deliver input
      // refuses the command instead of dropping it. A suite that took the flag
      // at its word would pass an adapter that sets it and then ignores
      // `RemoteOptions.stdin`, which is the exact silent input loss the flag
      // was added to close.
      const discards = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, cat: { stdout: "" } },
        stdin: true
      })
      const dropped = yield* ProviderConformance.check(discards, commands)
      expect(checks(dropped)).toEqual(["delivers-standard-input"])
      // The bytes reached the provider. It simply did not put them anywhere.
      expect(discards.state.inputs.some((input) => input !== undefined)).toBe(true)

      // The same provider with a `spawn` that hands the input back conforms.
      const delivers: RemoteChildProcessSpawner.Provider = {
        ...discards,
        spawn: (command, spawnOptions) =>
          command === "cat" && spawnOptions.stdin !== undefined
            ? Effect.succeed({
              stdout: Stream.make(spawnOptions.stdin),
              stderr: Stream.empty,
              exitCode: Effect.succeed(0)
            })
            : discards.spawn(command, spawnOptions)
      }
      expect(yield* ProviderConformance.check(delivers, commands)).toEqual([])

      // A provider that never declared the capability is never asked: the
      // adapter refuses input-fed commands for it, so there is nothing to
      // prove and nothing to convict.
      const silent = RemoteChildProcessSpawner.TestRemote.make({ scripts })
      expect(yield* ProviderConformance.check(silent, commands)).toEqual([])
      expect(silent.state.commands).not.toContain("cat")
    }))

  it.effect("uses the fixture's own copiesStdin command when it names one", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, tee: { stdout: "" } },
        stdin: true
      })
      const violations = yield* ProviderConformance.check(provider, { ...commands, copiesStdin: "tee" })
      expect(checks(violations)).toEqual(["delivers-standard-input"])
      expect(provider.state.commands).toContain("tee")
      expect(provider.state.commands).not.toContain("cat")
    }))

  it("names the deadline a signalled command has to stop inside", () => {
    expect(ProviderConformance.defaultStopsWithin).toBe("5 seconds")
  })

  it("renders a report an adapter author can act on", () => {
    expect(ProviderConformance.format([])).toBe("provider conforms")
    expect(
      ProviderConformance.format([{ check: "writes-its-output", expected: "hello", actual: "goodbye" }])
    ).toBe("writes-its-output: expected hello, got goodbye")
  })

  it.effect("convicts a kill whose wrapper died while the command's work survived", () =>
    Effect.gen(function*() {
      // The wrapper stops (a captured exit), and the machine still answers
      // the survivor probe with 0: the shell died, the work did not.
      const surviving = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: {
          holding: { pending: true },
          "still-there": { exitCode: 0 }
        }
      })
      const survivors = yield* ProviderConformance.check(surviving, {
        writes: "printf-fixture",
        output: "",
        fails: "fails-fixture",
        failureCode: 127,
        runs: "holding",
        survivor: "still-there"
      })
      expect(survivors.map(({ check }) => check)).toContain("signals-a-running-command")
      expect(survivors.find(({ check }) => check === "signals-a-running-command")?.actual).toContain(
        "work was still running"
      )

      // A survivor probe that finds nothing leaves a working kill conforming.
      const clean = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: {
          holding: { pending: true },
          "still-there": { exitCode: 1 }
        }
      })
      const none = yield* ProviderConformance.check(clean, {
        writes: "printf-fixture",
        output: "",
        fails: "fails-fixture",
        failureCode: 127,
        runs: "holding",
        survivor: "still-there"
      })
      expect(none.map(({ check }) => check)).not.toContain("signals-a-running-command")
    }))
})
