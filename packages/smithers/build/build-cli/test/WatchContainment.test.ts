import { ScopedProcess } from "@smthrs/platform-node"
import { Effect, PlatformError } from "effect"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import * as Watch from "../src/Watch.ts"

const fixtureEntry = {
  services: Watch.makeServices(),
  // A faulty notifier can lose real events or deliver a nameless notification.
  drop: false,
  notify: (_file: string | null) => {},
  fail: (_error: Error) => {},
  rootReads: 0,
  scanned: () => {},
  rescanFailure: undefined as unknown,
  closed: 0
}
const roots: Array<string> = []
const pids: Array<number> = []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
    return false
  }
}
afterEach(async () => {
  fixtureEntry.drop = false
  fixtureEntry.rootReads = 0
  fixtureEntry.scanned = () => {}
  fixtureEntry.rescanFailure = undefined
  fixtureEntry.closed = 0
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
  for (const root of roots.splice(0)) await Fs.rm(root, { recursive: true, force: true })
})

const fixture = async (body: string) => {
  const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "smithers-watch-")))
  roots.push(root)
  await Fs.writeFile(join(root, "package.json"), "{\"type\":\"module\"}")
  await Fs.mkdir(join(root, "src"))
  await Fs.writeFile(join(root, "src/main.js"), body)
  const real = Watch.makeServices({ entry: join(root, "src/main.js") })
  fixtureEntry.services = {
    ...real,
    notifier: (root, changed, failed) =>
      real.notifier(
        root,
        (file) => {
          if (!fixtureEntry.drop) changed(file)
        },
        failed
      ).pipe(Effect.map((close) => {
        fixtureEntry.notify = changed
        fixtureEntry.fail = failed
        return () => {
          close()
          fixtureEntry.closed++
        }
      })),
    digest: (root, relevant) =>
      Effect.suspend(() => {
        if (fixtureEntry.rescanFailure !== undefined) return Effect.fail(fixtureEntry.rescanFailure)
        return real.digest(root, relevant).pipe(Effect.tap(() =>
          Effect.sync(() => {
            fixtureEntry.rootReads++
            fixtureEntry.scanned()
          })
        ))
      })
  }
  return root
}

const readyProcess = "process.stdout.write(process.pid + \"\\n\"); setInterval(() => {}, 1000);"
const ready = (onPid: (pid: number) => void) => {
  let pending = ""
  return (text: string) => {
    pending += text
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n")
      const pid = Number(pending.slice(0, end))
      pending = pending.slice(end + 1)
      expect(pid).toBeGreaterThan(1)
      expect(alive(pid)).toBe(true)
      pids.push(pid)
      onPid(pid)
    }
  }
}

// Every handle is real. Only its cleanup result or an event during cleanup
// is injected; ContainedProcess still owns spawning, output and error mapping.
const processSpawner = (onKill: () => Effect.Effect<void> = () => Effect.void) => ({
  spawn: (options: ScopedProcess.Options) =>
    ScopedProcess.spawn(options).pipe(Effect.map((handle) => ({
      ...handle,
      kill: (options: Parameters<typeof handle.kill>[0]) => onKill().pipe(Effect.andThen(handle.kill(options)))
    })))
})

const resistantDescendant = `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", pid => {
  process.stdout.write(JSON.stringify({ leader: process.pid, descendant: pid }) + "\\n");
});
setInterval(() => {}, 1000);
`

describe.skipIf(process.platform === "win32")("watch process-group containment", () => {
  it.for(["change", "abort"])(
    "surfaces real runner cleanup failure after %s and starts no replacement",
    async (trigger, { signal }) => {
      const root = await fixture(readyProcess)
      const controller = new AbortController()
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "kill",
        description: "cleanup confirmation unavailable"
      })
      let launches = 0
      let cleanups = 0
      const spawner = {
        spawn: (options: ScopedProcess.Options) =>
          ScopedProcess.spawn(options).pipe(Effect.map((handle) => {
            launches++
            return {
              ...handle,
              kill: (options: Parameters<typeof handle.kill>[0]) =>
                handle.kill(options).pipe(
                  Effect.andThen(Effect.sync(() => {
                    cleanups++
                  })),
                  Effect.andThen(Effect.fail(failure))
                )
            }
          }))
      }
      const services = {
        ...fixtureEntry.services,
        processRunner: (options: Parameters<typeof ContainedProcess.runEffect>[0]) =>
          fixtureEntry.services.processRunner(options).pipe(
            Effect.provideService(ContainedProcess.ProcessSpawner, spawner)
          )
      }
      await expect(Watch.run({
        root,
        services,
        args: [],
        ignored: [],
        debounceMs: 1,
        once: false,
        signal: AbortSignal.any([controller.signal, signal]),
        stdout: ready(() => {
          if (trigger === "abort") controller.abort()
          else fixtureEntry.notify("changed.txt")
        }),
        stderr: () => {}
      })).rejects.toMatchObject({ code: "cleanup_failed", cause: failure })
      expect(launches).toBe(1)
      expect(cleanups).toBe(1)
      expect(pids).toHaveLength(1)
      expect(pids.every((pid) => !alive(pid))).toBe(true)
      expect(fixtureEntry.closed).toBe(1)
    }
  )

  it("keeps a relevant change when ignored events arrive in the same turn", async ({ signal }) => {
    const root = await fixture(readyProcess)
    const controller = new AbortController()
    let started = 0
    let previous = 0
    const result = await Watch.run({
      root,
      services: fixtureEntry.services,
      args: [],
      ignored: [],
      debounceMs: 1,
      once: false,
      signal: AbortSignal.any([controller.signal, signal]),
      stdout: ready((pid) => {
        started++
        if (started === 1) {
          previous = pid
          fixtureEntry.notify("changed.txt")
          fixtureEntry.notify("node_modules/ignored.txt")
        } else {
          expect(alive(previous)).toBe(false)
          controller.abort()
        }
      }),
      stderr: () => {}
    })
    expect(result).toEqual({ cycles: 2, exitCode: 1, stopped: true })
    expect(started).toBe(2)
    expect(pids.every((pid) => !alive(pid))).toBe(true)
  })

  it("folds changes seen during a stale cycle's real cleanup into one replacement", async ({ signal }) => {
    const root = await fixture(readyProcess)
    const controller = new AbortController()
    let started = 0
    let duringCleanup = 0
    const services = {
      ...fixtureEntry.services,
      processRunner: (options: Parameters<typeof ContainedProcess.runEffect>[0]) =>
        fixtureEntry.services.processRunner(options).pipe(Effect.provideService(
          ContainedProcess.ProcessSpawner,
          processSpawner(() =>
            Effect.sync(() => {
              if (started === 1) {
                duringCleanup++
                fixtureEntry.notify("changed.txt")
              }
            })
          )
        ))
    }
    const result = await Watch.run({
      root,
      services,
      args: [],
      ignored: [],
      debounceMs: 1,
      once: false,
      signal: AbortSignal.any([controller.signal, signal]),
      stdout: ready(() => {
        started++
        if (started === 1) fixtureEntry.notify("changed.txt")
        else controller.abort()
      }),
      stderr: () => {}
    })
    expect(result).toEqual({ cycles: 2, exitCode: 1, stopped: true })
    expect(duringCleanup).toBe(1)
    expect(started).toBe(2)
    expect(pids.every((pid) => !alive(pid))).toBe(true)
  })

  // These cases start real process groups. A fixture that never reports
  // is stopped by the test's own timeout through its `signal`, not by a fixed
  // wall-clock abort: under a parallel file pool on 4 vCPUs a 15 s abort fired
  // before the fixture's leader had printed its pids.
  it.for(["default", "ignores TERM", "exits zero"])(
    "awaits the resistant descendant before reporting cancellation (leader %s)",
    async (leader, { signal }) => {
      const root = await fixture(
        resistantDescendant + (leader === "default" ? "" : leader === "ignores TERM"
          ? "\nprocess.on(\"SIGTERM\", () => {});"
          : "\nprocess.on(\"SIGTERM\", () => process.exit(0));")
      )
      const controller = new AbortController()
      let pending = ""
      let descendant = 0
      let leaderPid = 0
      let completed = false
      let errors = ""
      const result = await Watch.run({
        root,
        services: fixtureEntry.services,
        args: [],
        ignored: [basename(root), "src", "package.json"],
        debounceMs: 20,
        once: false,
        signal: AbortSignal.any([controller.signal, signal]),
        stdout: (text) => {
          pending += text
          if (!pending.includes("\n")) return
          const message = JSON.parse(pending)
          descendant = message.descendant
          leaderPid = message.leader
          pids.push(descendant, leaderPid)
          expect(alive(descendant)).toBe(true)
          controller.abort()
        },
        stderr: (text) => {
          errors += text
        },
        cycleCompleted: () => {
          expect(descendant, errors).toBeGreaterThan(1)
          expect(alive(descendant)).toBe(false)
          expect(alive(leaderPid)).toBe(false)
          expect(alive(-leaderPid)).toBe(false)
          completed = true
        }
      })
      expect(result).toEqual({ cycles: 1, exitCode: 1, stopped: true })
      expect(completed).toBe(true)
    }
  )

  it("contains a surviving descendant even when its leader succeeds naturally", async () => {
    const root = await fixture(resistantDescendant.replace(
      "process.stdout.write(JSON.stringify({ leader: process.pid, descendant: pid }) + \"\\n\");",
      "process.stdout.write(JSON.stringify({ leader: process.pid, descendant: pid }) + \"\\n\", () => process.exit(0));"
    ))
    let descendant = 0
    let pending = ""
    const result = await Watch.run({
      root,
      services: fixtureEntry.services,
      args: [],
      ignored: [],
      debounceMs: 20,
      once: true,
      stdout: (text) => {
        pending += text
        if (!pending.includes("\n")) return
        const message = JSON.parse(pending)
        descendant = message.descendant
        pids.push(descendant, message.leader)
      },
      stderr: () => {}
    })
    expect(result).toEqual({ cycles: 1, exitCode: 0, stopped: false })
    expect(descendant).toBeGreaterThan(1)
    expect(alive(descendant)).toBe(false)
  })

  it("waits for group cleanup before surfacing a watcher error", async ({ signal }) => {
    const root = await fixture(resistantDescendant)
    const failure = new Error("fixture watch failed")
    let descendant = 0
    let pending = ""
    await expect(Watch.run({
      root,
      services: fixtureEntry.services,
      args: [],
      ignored: [basename(root), "src", "package.json"],
      debounceMs: 20,
      once: false,
      signal,
      stdout: (text) => {
        pending += text
        if (!pending.includes("\n")) return
        const message = JSON.parse(pending)
        descendant = message.descendant
        pids.push(descendant, message.leader)
        fixtureEntry.fail(failure)
      },
      stderr: () => {}
    })).rejects.toBe(failure)
    expect(descendant).toBeGreaterThan(1)
    expect(alive(descendant)).toBe(false)
  })

  it("does not launch a replacement until the stale cycle's descendant is gone", async ({ signal }) => {
    const root = await fixture(resistantDescendant)
    const controller = new AbortController()
    let firstDescendant = 0
    let frames = 0
    let pending = ""
    let changed: Promise<void> | undefined
    const result = await Watch.run({
      root,
      services: fixtureEntry.services,
      args: [],
      ignored: [basename(root), "src", "package.json"],
      debounceMs: 20,
      once: false,
      signal: AbortSignal.any([controller.signal, signal]),
      stdout: (text) => {
        pending += text
        if (!pending.includes("\n")) return
        const message = JSON.parse(pending)
        pending = ""
        pids.push(message.descendant, message.leader)
        frames += 1
        if (frames === 1) {
          firstDescendant = message.descendant
          changed = Fs.writeFile(join(root, "changed.txt"), "new input")
        } else {
          expect(alive(firstDescendant)).toBe(false)
          controller.abort()
        }
      },
      stderr: () => {}
    })
    await changed
    expect(frames).toBe(2)
    expect(result).toEqual({ cycles: 2, exitCode: 1, stopped: true })
    expect(pids.every((pid) => !alive(pid))).toBe(true)
  })

  it.for(["dropped", "unnamed"])(
    "rescans and replaces a real cycle after an %s notification",
    async (notification, { signal }) => {
      const root = await fixture(readyProcess)
      fixtureEntry.drop = true
      const controller = new AbortController()
      let started = 0
      let changed: Promise<void> | undefined
      const result = await Watch.run({
        root,
        services: fixtureEntry.services,
        args: [],
        ignored: [],
        debounceMs: 1,
        // Only the nameless notification can trigger this rescan within the test budget.
        rescanMs: notification === "unnamed" ? 3_600_000 : 5,
        once: false,
        signal: AbortSignal.any([controller.signal, signal]),
        stdout: ready(() => {
          started++
          if (started === 1) {
            changed = Fs.writeFile(join(root, "src/edited.ts"), "export {}").then(() => {
              if (notification === "unnamed") fixtureEntry.notify(null)
            })
          } else {
            expect(alive(pids[0]!)).toBe(false)
            controller.abort()
          }
        }),
        stderr: () => {}
      })
      await changed
      expect(result).toEqual({ cycles: 2, exitCode: 1, stopped: true })
      expect(started).toBe(2)
      expect(pids.every((pid) => !alive(pid))).toBe(true)
    }
  )

  it("keeps a real cycle when rescans find only unchanged or ignored paths", async ({ signal }) => {
    const root = await fixture(readyProcess)
    fixtureEntry.drop = true
    const controller = new AbortController()
    let changed: Promise<void> | undefined
    const result = await Watch.run({
      root,
      services: fixtureEntry.services,
      args: [],
      ignored: ["out"],
      debounceMs: 1,
      rescanMs: 5,
      once: false,
      signal: AbortSignal.any([controller.signal, signal]),
      stdout: ready(() => {
        changed = (async () => {
          await Fs.mkdir(join(root, "node_modules/dep"), { recursive: true })
          await Fs.writeFile(join(root, "node_modules/dep/index.js"), "")
          await Fs.mkdir(join(root, "out"))
          await Fs.writeFile(join(root, "out/built.js"), "")
          const reads = fixtureEntry.rootReads
          const scanned = Promise.withResolvers<void>()
          fixtureEntry.scanned = () => {
            if (fixtureEntry.rootReads > reads + 3) scanned.resolve()
          }
          fixtureEntry.notify(null)
          await scanned.promise
          controller.abort()
        })()
      }),
      stderr: () => {}
    })
    await changed
    expect(result).toEqual({ cycles: 1, exitCode: 1, stopped: true })
    expect(pids).toHaveLength(1)
    expect(pids.every((pid) => !alive(pid))).toBe(true)
  })

  it.each([new TypeError("rescan unavailable"), { detail: "rescan unavailable" }])(
    "preserves initial rescan failures and never launches a cycle: %j",
    async (cause) => {
      const root = await fixture(readyProcess)
      fixtureEntry.rescanFailure = cause
      let launches = 0
      const services = {
        ...fixtureEntry.services,
        processRunner: (options: Parameters<typeof ContainedProcess.runEffect>[0]) => {
          launches++
          return fixtureEntry.services.processRunner(options)
        }
      }
      const result = Watch.run({
        root,
        services,
        args: [],
        ignored: [],
        debounceMs: 1,
        once: false,
        stdout: () => {},
        stderr: () => {}
      })
      if (cause instanceof Error) await expect(result).rejects.toBe(cause)
      else {await expect(result).rejects.toMatchObject({
          _tag: "smithers-build/PackageError",
          code: "watch_refresh_failed",
          cause
        })}
      expect(launches).toBe(0)
      expect(fixtureEntry.closed).toBe(1)
    }
  )

  it("fails the watch when a rescan cannot read the workspace and joins its real cycle", async ({ signal }) => {
    const root = await fixture(readyProcess)
    fixtureEntry.drop = true
    let changed: Promise<void> | undefined
    await expect(Watch.run({
      root,
      services: fixtureEntry.services,
      args: [],
      ignored: [],
      debounceMs: 1,
      rescanMs: 5,
      once: false,
      signal,
      stdout: ready(() => {
        changed = (async () => {
          // A self-referential symlink fails with ELOOP, not a missing or unreadable entry.
          await Fs.rename(root, `${root}.moved`)
          roots.push(`${root}.moved`)
          await Fs.symlink(root, `${root}.loop`)
          await Fs.rename(`${root}.loop`, root)
        })()
      }),
      stderr: () => {}
    })).rejects.toMatchObject({ code: "ELOOP" })
    await changed
    expect(pids).toHaveLength(1)
    expect(pids.every((pid) => !alive(pid))).toBe(true)
    expect(fixtureEntry.closed).toBe(1)
  })

  it("preserves notifier acquisition failure without launching a cycle", async () => {
    const root = await fixture(readyProcess)
    const cause = new Error("notifier unavailable")
    let launches = 0
    await expect(Watch.run({
      root,
      services: {
        ...fixtureEntry.services,
        notifier: () => Effect.fail(cause),
        processRunner: (options) => {
          launches++
          return fixtureEntry.services.processRunner(options)
        }
      },
      args: [],
      ignored: [],
      debounceMs: 1,
      once: false,
      stdout: () => {},
      stderr: () => {}
    })).rejects.toBe(cause)
    expect(launches).toBe(0)
    expect(fixtureEntry.closed).toBe(0)
  })

  it.for(["abort", "notifier error"])(
    "interrupts and joins an in-flight rescan after %s",
    async (trigger, { signal }) => {
      const root = await fixture(readyProcess)
      const controller = new AbortController()
      const failure = new Error("notifier failed during rescan")
      const real = fixtureEntry.services
      let reads = 0
      let finalized = false
      const result = Watch.run({
        root,
        services: {
          ...real,
          digest: (root, relevant) =>
            Effect.suspend(() => {
              reads++
              if (reads === 1) return real.digest(root, relevant)
              return Effect.sync(() => {
                if (trigger === "abort") controller.abort()
                else fixtureEntry.fail(failure)
              }).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
                  finalized = true
                }))))
              )
            })
        },
        args: [],
        ignored: [],
        debounceMs: 1,
        rescanMs: 3_600_000,
        once: false,
        signal: AbortSignal.any([controller.signal, signal]),
        stdout: ready(() => fixtureEntry.notify(null)),
        stderr: () => {}
      })
      if (trigger === "abort") await expect(result).resolves.toEqual({ cycles: 1, exitCode: 1, stopped: true })
      else await expect(result).rejects.toBe(failure)
      expect(reads).toBe(2)
      expect(finalized).toBe(true)
      expect(fixtureEntry.closed).toBe(1)
      expect(pids).toHaveLength(1)
      expect(pids.every((pid) => !alive(pid))).toBe(true)
    }
  )

  it("runs once with the real runner without acquiring notifier or digest services", async () => {
    const root = await fixture("process.stdout.write(\"once\");")
    let output = ""
    expect(
      await Watch.run({
        root,
        services: {
          ...fixtureEntry.services,
          notifier: () => Effect.die("once acquired a notifier"),
          digest: () => Effect.die("once read a digest")
        },
        args: [],
        ignored: [],
        debounceMs: 1,
        once: true,
        stdout: (text) => {
          output += text
        },
        stderr: () => {}
      })
    ).toEqual({ cycles: 1, exitCode: 0, stopped: false })
    expect(output).toBe("once")
  })
})
