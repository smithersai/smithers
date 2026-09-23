import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { deploy, resolveDeployOptions } from "./deploy.ts"
import { defaultStateDirectory, redactAlchemyState } from "./redact-state.ts"
import { acquireStateOwnership } from "./state-ownership.ts"

const infraRoot = NodePath.resolve(fileURLToPath(new URL("..", import.meta.url).href))

let directory: string

const script = (name: string): string => NodePath.join(directory, `${name}.mjs`)

/** A state directory under the fixture, so no test touches the real deployment state. */
const stateDirectory = (name = "state"): string => NodePath.join(directory, name)

const lockFileIn = (state: string): string => NodePath.join(state, ".smithers-state-owner.lock")

const write = (name: string, body: string): Promise<void> =>
  writeFile(NodePath.join(directory, `${name}.mjs`), body, "utf8")

/** Runs `deploy` with only our own handler installed, then restores the rest. */
const withIsolatedSignals = async <A>(run: () => Promise<A>): Promise<A> => {
  const installed = ["SIGHUP", "SIGINT", "SIGTERM"].map(
    (signal) => [signal, process.listeners(signal as NodeJS.Signals)] as const
  )
  for (const [signal] of installed) process.removeAllListeners(signal)
  try {
    return await run()
  } finally {
    for (const [signal, listeners] of installed) {
      for (const listener of listeners) process.on(signal as NodeJS.Signals, listener)
    }
  }
}

beforeAll(async () => {
  // Redaction refuses a state root reached through a link, and the macOS
  // temporary directory is one, so the fixture is its resolved path.
  directory = await realpath(await mkdtemp(NodePath.join(tmpdir(), "smithers-deploy-")))
  await write("exit-zero", "process.exit(0)\n")
  await write("exit-seven", "process.exit(7)\n")
  // The wrapper spawns [cli, "deploy", "alchemy.run.ts", ...args], so the
  // marker path this stub reports through is argv[4].
  await write(
    "ignores-sigterm",
    `import { writeFileSync } from "node:fs"
const marker = process.argv[4]
process.on("SIGTERM", () => writeFileSync(marker + ".sigterm", "seen"))
process.on("SIGINT", () => writeFileSync(marker + ".sigint", "seen"))
setInterval(() => {}, 1000)
writeFileSync(marker + ".ready", "ready")
`
  )
  // The first wrapper argument names the signal this stub ends itself with.
  await write("self-signal", "process.kill(process.pid, process.argv[4])\nsetInterval(() => {}, 1000)\n")
  await write(
    "descendant",
    `import { appendFileSync, writeFileSync } from "node:fs"
const marker = process.argv[2]
process.on("SIGTERM", () => writeFileSync(marker + ".sigterm", "seen"))
writeFileSync(marker + ".tick", "tick\\n")
setInterval(() => appendFileSync(marker + ".tick", "tick\\n"), 20)
writeFileSync(marker + ".ready", String(process.pid))
`
  )
  await write(
    "exiting-leader",
    `import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
writeFileSync(process.argv[4] + ".leader", String(process.pid))
spawn(process.execPath, [${JSON.stringify(script("descendant"))}, process.argv[4]], { stdio: "inherit" })
setInterval(() => {}, 1000)
`
  )
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("deploy wrapper", () => {
  it.skipIf(process.platform === "win32").each(["deadline", "second-signal", "denied-probe"])(
    "terminates surviving descendants before redaction and return (%s)",
    async (mode) => {
      const marker = NodePath.join(directory, `surviving-descendant-${mode}`)
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const originalKill = process.kill.bind(process)
      let probeDenied = false
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (mode === "denied-probe" && signal === 0 && typeof pid === "number" && pid < 0 && !probeDenied) {
          probeDenied = true
          throw Object.assign(new Error("probe refused"), { code: "EPERM" })
        }
        return originalKill(pid, signal)
      })
      let running: Promise<number> | undefined
      let ticksAtRedaction: string | undefined
      try {
        const code = await withIsolatedSignals(async () => {
          running = deploy([marker], {
            cli: script("exiting-leader"),
            cwd: directory,
            stateDirectory: stateDirectory(),
            escalationDelayMs: mode === "second-signal" ? 10_000 : 300,
            redact: async () => {
              ticksAtRedaction = readFileSync(`${marker}.tick`, "utf8")
              return 0
            }
          })
          await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
          process.emit("SIGTERM")
          await vi.waitFor(() => expect(existsSync(`${marker}.sigterm`)).toBe(true), { timeout: 10_000 })
          if (mode === "second-signal") {
            const leader = Number(readFileSync(`${marker}.leader`, "utf8"))
            await vi.waitFor(() => expect(() => process.kill(leader, 0)).toThrow(), { timeout: 10_000 })
            const signalled = Date.now()
            process.emit("SIGTERM")
            const code = await running
            expect(Date.now() - signalled).toBeLessThan(8_000)
            return code
          }
          return await running
        })

        expect(code).toBe(143)
        const ticksAtReturn = readFileSync(`${marker}.tick`, "utf8")
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(readFileSync(`${marker}.tick`, "utf8")).toBe(ticksAtReturn)
        expect(ticksAtReturn).toBe(ticksAtRedaction)
        expect(() => originalKill(-Number(readFileSync(`${marker}.leader`, "utf8")), 0)).toThrow()
        expect(probeDenied).toBe(mode === "denied-probe")
      } finally {
        // Also reap the fixture when testing the broken implementation, which
        // returns while this group is still writing its heartbeat.
        if (existsSync(`${marker}.leader`)) {
          try {
            process.kill(-Number(readFileSync(`${marker}.leader`, "utf8")), "SIGKILL")
          } catch {
            // A successful wrapper has already removed the process group.
          }
        }
        await running
        kill.mockRestore()
        stdout.mockRestore()
      }
    },
    30_000
  )

  it("drives the pinned Alchemy CLI from this directory and redacts real state by default", () => {
    const resolved = resolveDeployOptions({})

    expect(resolved.cli).toBe(NodePath.join(infraRoot, "node_modules", "alchemy", "bin", "cli.js"))
    expect(existsSync(resolved.cli)).toBe(true)
    expect(resolved.cwd).toBe(infraRoot)
    expect(resolved.stateDirectory).toBe(defaultStateDirectory)
    expect(resolved.redact).toBe(redactAlchemyState)
    expect(resolveDeployOptions({ stateDirectory: "state" }).stateDirectory).toBe("state")
    expect(resolved.escalationDelayMs).toBe(10_000)
    expect(resolveDeployOptions({ cli: "cli", cwd: "cwd", escalationDelayMs: 1 }).escalationDelayMs).toBe(1)
  })

  it.skipIf(process.platform === "win32")("reports a command that ended on a signal of its own", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const options = { cli: script("self-signal"), cwd: directory, stateDirectory: stateDirectory(), redact: async () => 0 }

      // 128 + SIGHUP for a termination signal the wrapper maps, and the
      // generic failure code for one it does not.
      expect(await deploy(["SIGHUP"], options)).toBe(129)
      expect(await deploy(["SIGALRM"], options)).toBe(1)
    } finally {
      stdout.mockRestore()
    }
  })

  it("reports a command the host refuses to start and still redacts", async () => {
    let redactions = 0
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      // A NUL byte is refused by `spawn` itself, before any process exists.
      const code = await deploy([], {
        cli: script("exit-zero"),
        cwd: `${directory}\u0000`,
        stateDirectory: stateDirectory(),
        redact: async () => (redactions += 1, 0)
      })

      expect(code).toBe(1)
      expect(redactions).toBe(1)
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "Alchemy deployment failed: The property 'options.cwd'"
      )
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("kills the command outright when a second termination signal arrives", async () => {
    const marker = NodePath.join(directory, "second-signal")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const started = Date.now()
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          stateDirectory: stateDirectory(),
          escalationDelayMs: 10_000,
          redact: async () => 0
        })
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGTERM")
        await vi.waitFor(() => expect(existsSync(`${marker}.sigterm`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGTERM")
        return await running
      })

      // The child ignored the first SIGTERM, so only the immediate SIGKILL
      // could have ended it this far ahead of the escalation delay.
      expect(code).toBe(143)
      expect(Date.now() - started).toBeLessThan(8_000)
    } finally {
      stdout.mockRestore()
    }
  }, 30_000)

  it("holds a termination signal that arrives while state is being redacted", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await withIsolatedSignals(() =>
        deploy([], {
          cli: script("exit-zero"),
          cwd: directory,
          stateDirectory: stateDirectory(),
          redact: async () => {
            // The command is over, so there is nothing to forward the signal
            // to; the wrapper still reports it once cleanup completes.
            process.emit("SIGTERM")
            return 2
          }
        })
      )

      expect(code).toBe(143)
      expect(stdout.mock.calls.map((call) => String(call[0]))).toContain("Redacted 2 Alchemy Worker state file(s).\n")
      expect(process.listenerCount("SIGTERM")).toBe(0)
    } finally {
      stdout.mockRestore()
    }
  })

  it("forwards a signal to a command that never got a process", async () => {
    let redactions = 0
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const kill = vi.spyOn(process, "kill")
    try {
      const code = await withIsolatedSignals(() => {
        const originalOn = process.on.bind(process)
        const on = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
          const registered = originalOn(event, listener)
          if (event === "SIGTERM") {
            on.mockRestore()
            // The wrapper installs its handlers and spawns in one synchronous
            // run, so a microtask lands once the spawn has failed and left a
            // child without a pid; the signal must be dropped rather than
            // sent to process group zero.
            queueMicrotask(() => process.emit("SIGTERM"))
          }
          return registered
        }) as typeof process.on)
        return deploy([], {
          cli: script("exit-zero"),
          cwd: NodePath.join(directory, "absent-directory"),
          stateDirectory: stateDirectory(),
          escalationDelayMs: 100,
          redact: async () => (redactions += 1, 0)
        })
      })

      expect(code).toBe(1)
      expect(redactions).toBe(1)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("signals the child itself when its process group can no longer be signalled", async () => {
    const marker = NodePath.join(directory, "group-gone")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process group"), { code: "ESRCH" })
    })
    try {
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          stateDirectory: stateDirectory(),
          escalationDelayMs: 300,
          redact: async () => 0
        })
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGTERM")
        return await running
      })

      // The group kill was refused, yet the child still saw the SIGTERM: it
      // arrived through the child's own handle.
      expect(kill.mock.calls[0]?.[1]).toBe("SIGTERM")
      expect(existsSync(`${marker}.sigterm`)).toBe(true)
      expect(code).toBe(143)
    } finally {
      kill.mockRestore()
      stdout.mockRestore()
    }
  }, 30_000)

  it("signals the child through its own handle where process groups do not exist", async () => {
    const marker = NodePath.join(directory, "no-process-groups")
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    if (platform === undefined) throw new Error("process.platform is not an own property")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    // Windows has no process groups to signal, so the wrapper signals the
    // child directly; the branch is real, the platform is not.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    try {
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          stateDirectory: stateDirectory(),
          escalationDelayMs: 300,
          redact: async () => 0
        })
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGTERM")
        return await running
      })

      expect(existsSync(`${marker}.sigterm`)).toBe(true)
      expect(code).toBe(143)
    } finally {
      Object.defineProperty(process, "platform", platform)
      stdout.mockRestore()
    }
  }, 30_000)

  it("refuses to start while another deployment owns the state", async () => {
    const state = stateDirectory("state-owned")
    const marker = NodePath.join(directory, "refused")
    await mkdir(state, { recursive: true })
    const held = await acquireStateOwnership(state)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    let redactions = 0
    try {
      const code = await deploy([marker], {
        cli: script("ignores-sigterm"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => (redactions += 1, 0)
      })

      expect(code).toBe(1)
      // Neither Alchemy nor redaction ran: the command never started.
      expect(existsSync(`${marker}.ready`)).toBe(false)
      expect(redactions).toBe(0)
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
        `Alchemy deployment refused: Alchemy state is owned by another deployment (pid ${process.pid})`
      )
      expect(readFileSync(lockFileIn(state), "utf8")).toBe(`${process.pid}\n`)
    } finally {
      stderr.mockRestore()
      await held.release()
    }
  })

  it.skipIf(process.platform === "win32")(
    "owns the state from before the command starts until after redaction",
    async () => {
      const state = stateDirectory("state-held")
      const marker = NodePath.join(directory, "held")
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      let lockDuringRedaction: string | undefined
      try {
        const code = await withIsolatedSignals(async () => {
          const running = deploy([marker], {
            cli: script("ignores-sigterm"),
            cwd: directory,
            stateDirectory: state,
            escalationDelayMs: 300,
            redact: async (options) => {
              lockDuringRedaction = readFileSync(lockFileIn(state), "utf8")
              expect(options.directory).toBe(state)
              expect(options.ownership?.directory).toBe(state)
              return 0
            }
          })
          try {
            await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
            // The directory was created and owned before Alchemy started, so a
            // standalone redaction cannot replace state under the running command.
            expect(readFileSync(lockFileIn(state), "utf8")).toBe(`${process.pid}\n`)
            await expect(redactAlchemyState({ directory: state, bearerToken: "token" })).rejects.toThrow(
              /owned by another deployment \(pid \d+\)/
            )
          } finally {
            process.emit("SIGTERM")
          }
          return await running
        })

        expect(code).toBe(143)
        expect(lockDuringRedaction).toBe(`${process.pid}\n`)
        expect(existsSync(lockFileIn(state))).toBe(false)
        await expect(redactAlchemyState({ directory: state, bearerToken: "token" })).resolves.toBe(0)
      } finally {
        stdout.mockRestore()
      }
    }
  )

  it("hands its ownership to the real redaction", async () => {
    const state = stateDirectory("state-real")
    const file = NodePath.join(state, "CacheWorker.json")
    await mkdir(state, { recursive: true })
    await writeFile(file, JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw-token" } } } }))
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await deploy([], { cli: script("exit-zero"), cwd: directory, stateDirectory: state })

      expect(code).toBe(0)
      expect(stdout.mock.calls.map((call) => String(call[0]))).toContain(
        "Redacted 1 Alchemy Worker state file(s).\n"
      )
      expect(readFileSync(file, "utf8")).not.toContain("raw-token")
      expect(existsSync(lockFileIn(state))).toBe(false)
    } finally {
      stdout.mockRestore()
    }
  })

  it("returns the command's exit code and redacts state afterwards", async () => {
    let redactions = 0
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const success = await deploy([], {
        cli: script("exit-zero"),
        cwd: directory,
        stateDirectory: stateDirectory(),
        redact: async () => (redactions += 1, 3)
      })
      const failure = await deploy([], {
        cli: script("exit-seven"),
        cwd: directory,
        stateDirectory: stateDirectory(),
        redact: async () => (redactions += 1, 0)
      })

      expect(success).toBe(0)
      expect(failure).toBe(7)
      // Redaction runs on the success path and on the failure path.
      expect(redactions).toBe(2)
      expect(stdout.mock.calls.map((call) => String(call[0]))).toContain(
        "Redacted 3 Alchemy Worker state file(s).\n"
      )
    } finally {
      stdout.mockRestore()
    }
  })

  it("fails the deployment when redaction fails, even after a successful command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await deploy([], {
        cli: script("exit-zero"),
        cwd: directory,
        stateDirectory: stateDirectory(),
        redact: async () => {
          throw new Error("state directory is read-only")
        }
      })

      expect(code).toBe(1)
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "Alchemy state redaction failed: state directory is read-only"
      )
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("reports a command that could not be spawned without leaving redaction undone", async () => {
    let redactions = 0
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await deploy([], {
        cli: script("exit-zero"),
        cwd: NodePath.join(directory, "absent-directory"),
        stateDirectory: stateDirectory(),
        redact: async () => (redactions += 1, 0)
      })

      expect(code).toBe(1)
      expect(redactions).toBe(1)
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("Alchemy deployment failed")
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("escalates to SIGKILL when the command ignores the forwarded signal", async () => {
    const marker = NodePath.join(directory, "escalation")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    let redactions = 0
    try {
      const started = Date.now()
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          stateDirectory: stateDirectory(),
          escalationDelayMs: 300,
          redact: async () => (redactions += 1, 0)
        })
        // Wait for the child to install its ignore handler. Signalling before
        // that would kill it outright and the assertions below would pass
        // without the escalation ever running.
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGTERM")
        return await running
      })

      // The child recorded the forwarded SIGTERM and stayed alive, so the only
      // thing that could have ended it is the SIGKILL escalation.
      expect(existsSync(`${marker}.sigterm`)).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(300)
      // 143 is the conventional 128 + SIGTERM, reported even though the
      // command itself died to the escalation.
      expect(code).toBe(143)
      expect(redactions).toBe(1)
      expect(process.listenerCount("SIGTERM")).toBe(0)
    } finally {
      stdout.mockRestore()
    }
  }, 30_000)

  it("maps SIGINT to its conventional exit code", async () => {
    const marker = NodePath.join(directory, "interrupt")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          stateDirectory: stateDirectory(),
          escalationDelayMs: 300,
          redact: async () => 0
        })
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGINT")
        return await running
      })

      expect(existsSync(`${marker}.sigint`)).toBe(true)
      expect(code).toBe(130)
    } finally {
      stdout.mockRestore()
    }
  }, 30_000)
})
