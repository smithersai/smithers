import { ChildProcess, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { stateSyncVariable } from "../deployment.ts"
import { deploy as deployWrapper, type DeployOptions, developmentStage, resolveDeployOptions } from "./deploy.ts"
import { defaultStateDirectory, redactAlchemyState } from "./redact-state.ts"
import { memoryStateBucket, r2StateBucket, type StateBucket } from "./remote-state.ts"
import { acquireStateOwnership } from "./state-ownership.ts"

const infraRoot = NodePath.resolve(fileURLToPath(new URL("..", import.meta.url).href))

let directory: string

/**
 * The wrapper under test, against an in-memory state bucket unless a test
 * names its own, so no test reaches the production R2 bucket.
 */
const deploy = (args: ReadonlyArray<string>, options: DeployOptions): Promise<number> =>
  deployWrapper(args, {
    remoteState: async () => ({ bucket: memoryStateBucket(), key: "alchemy/Test.json" }),
    ...options
  })

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
  // Records what Alchemy would see, then writes the state a deployment leaves.
  // argv[4] is the state directory, argv[5] the exit code.
  await write(
    "writes-state",
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const state = process.argv[4]
const pulled = join(state, "prod", "CacheWorker.json")
writeFileSync(join(state, "..", "seen.json"), JSON.stringify({
  synced: process.env[${JSON.stringify(stateSyncVariable)}],
  pulled: existsSync(pulled) ? readFileSync(pulled, "utf8") : null
}))
mkdirSync(join(state, "prod"), { recursive: true })
writeFileSync(pulled, JSON.stringify({ deployed: true }))
process.exit(Number(process.argv[5] ?? "0"))
`
  )
  await write("exit-seven", "process.exit(7)\n")
  // Records the argv the wrapper hands Alchemy, after the script path.
  await write(
    "record-argv",
    `import { writeFileSync } from "node:fs"
writeFileSync(process.env.SMITHERS_DEPLOY_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
`
  )
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
  // Model the POSIX group syscalls on every host; the real descendant cases
  // below additionally prove the kernel behavior on POSIX hosts.
  it.each([false, true])("waits through a denied group probe before redaction (second signal %s)", async (second) => {
    const marker = NodePath.join(directory, `modeled-process-group-${second}`)
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    const originalKill = process.kill.bind(process)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    let probes = 0
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        if (signal === 0) {
          probes++
          if (probes === 2) return true
          throw Object.assign(new Error("group probe"), { code: probes === 1 ? "EPERM" : "ESRCH" })
        }
        if (signal === "SIGTERM") return true
        return originalKill(-pid, signal)
      }
      return originalKill(pid, signal)
    })
    let running: Promise<number> | undefined
    try {
      const code = await withIsolatedSignals(async () => {
        running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          stateDirectory: stateDirectory(`modeled-process-group-${second}`),
          escalationDelayMs: 100,
          redact: async () => {
            Object.defineProperty(process, "platform", platform)
            expect(probes).toBe(3)
            return 0
          }
        })
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        Object.defineProperty(process, "platform", { ...platform, value: "linux" })
        process.emit("SIGTERM")
        if (second) process.emit("SIGTERM")
        return await running
      })
      expect(code).toBe(143)
      expect(kill.mock.calls.some(([pid, signal]) => typeof pid === "number" && pid < 0 && signal === "SIGKILL"))
        .toBe(true)
    } finally {
      Object.defineProperty(process, "platform", platform)
      await running
      kill.mockRestore()
      stdout.mockRestore()
    }
  })

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

  it("drops the `--` separator pnpm forwards literally before Alchemy parses its flags", async () => {
    const argvFile = NodePath.join(directory, "recorded-argv.json")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", argvFile)
    try {
      // `pnpm run deploy -- --yes` runs `deploy.ts --stage prod -- --yes`.
      const code = await deploy(["--stage", "prod", "--", "--yes"], {
        cli: script("record-argv"),
        cwd: directory,
        stateDirectory: stateDirectory("argv-state"),
        redact: async () => 0
      })

      expect(code).toBe(0)
      expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(["deploy", "alchemy.run.ts", "--stage", "prod", "--yes"])
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  // Alchemy's default stage moved from `dev_$USER` to `live_$USER`. A stage's
  // resources and state are recorded under its name, so `pnpm run deploy:dev`
  // left to that default would deploy a second development stack.
  it("names the dev_$USER stage for a command that names none", async () => {
    const argvFile = NodePath.join(directory, "recorded-stage-argv.json")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", argvFile)
    vi.stubEnv("USER", "ada")
    const recorded = async (args: ReadonlyArray<string>): Promise<unknown> => {
      const code = await deploy(args, {
        cli: script("record-argv"),
        cwd: directory,
        stateDirectory: stateDirectory("stage-argv-state"),
        redact: async () => 0
      })
      expect(code).toBe(0)
      return JSON.parse(readFileSync(argvFile, "utf8"))
    }
    try {
      // `pnpm run deploy:dev` runs `deploy.ts` with no arguments.
      expect(await recorded([])).toEqual(["deploy", "alchemy.run.ts", "--stage", "dev_ada"])
      // The stage follows the caller's own arguments, which keep their places.
      expect(await recorded(["--", "--yes"])).toEqual(["deploy", "alchemy.run.ts", "--yes", "--stage", "dev_ada"])
      // A stage the caller named is the only one Alchemy sees, in either spelling.
      expect(await recorded(["--stage", "pr-1347"])).toEqual(["deploy", "alchemy.run.ts", "--stage", "pr-1347"])
      expect(await recorded(["--stage=prod", "--dry-run"])).toEqual(["deploy", "alchemy.run.ts", "--stage=prod", "--dry-run"])
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  it("derives the development stage from the deploying user", () => {
    expect(developmentStage({ USER: "ada", USERNAME: "grace" })).toBe("dev_ada")
    // Windows names the user in USERNAME.
    expect(developmentStage({ USERNAME: "grace" })).toBe("dev_grace")
    // No user, or an empty one, must not collapse every such machine onto `dev_`.
    expect(developmentStage({})).toBe("dev_unknown")
    expect(developmentStage({ USER: "", USERNAME: "" })).toBe("dev_unknown")
  })

  // The pinned CLI imports every provider at startup, so one provider that
  // no longer loads under the pinned Effect breaks every deploy and plan.
  it("boots the pinned Alchemy CLI", () => {
    const { cli, cwd } = resolveDeployOptions({})
    const help = spawnSync(process.execPath, [cli, "--help"], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NO_TRACK: "1" }
    })

    expect(help.stderr).not.toContain("is not a function")
    expect(help.status).toBe(0)
    expect(help.stdout).toContain("deploy")
  }, 70_000)

  it("loads the stack and stops at its own configuration on a dry run", () => {
    const { cli, cwd } = resolveDeployOptions({})
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_TRACK: "1", [stateSyncVariable]: "1" }
    // Without the cache credentials the stack refuses before any provider call.
    delete env.SMITHERS_CACHE_READ_TOKEN
    delete env.SMITHERS_CACHE_WRITE_TOKEN
    const dryRun = (runEnv: NodeJS.ProcessEnv): string => {
      const run = spawnSync(process.execPath, [cli, "deploy", "alchemy.run.ts", "--dry-run", "--stage", "test"], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: runEnv
      })
      return `${run.stdout}${run.stderr}`
    }
    const output = dryRun(env)

    expect(output).not.toMatch(/is not a function|Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError/)
    expect(output).toContain("SMITHERS_CACHE_READ_TOKEN")

    // Run directly rather than through the wrapper, the stack refuses before
    // it reads local state that was never synced with R2.
    const direct = { ...env }
    delete direct[stateSyncVariable]
    expect(dryRun(direct)).toContain(`${stateSyncVariable} is not set`)
  }, 120_000)

  it("drives the pinned Alchemy CLI from this directory and redacts real state by default", async () => {
    const resolved = resolveDeployOptions({})

    expect(resolved.cli).toBe(NodePath.join(infraRoot, "node_modules", "alchemy", "bin", "cli.js"))
    expect(existsSync(resolved.cli)).toBe(true)
    expect(resolved.cwd).toBe(infraRoot)
    expect(resolved.stateDirectory).toBe(defaultStateDirectory)
    expect(resolved.redact).toBe(redactAlchemyState)
    // By default the durable state is the production R2 bucket, reached with
    // the deploying shell's Cloudflare credentials.
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "")
    try {
      await expect(resolved.remoteState()).rejects.toThrow("CLOUDFLARE_API_TOKEN is required")
    } finally {
      vi.unstubAllEnvs()
    }
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
      // Signals that arrive while remote state is pulled cancel the run before
      // Alchemy starts, so the signal has to land after the spawn itself. The
      // wrapper subscribes to the child's events right after spawning; a spawn
      // in a missing directory has failed there and left a child without a
      // pid, and the signal must be dropped rather than sent to process group
      // zero.
      const once = vi.spyOn(ChildProcess.prototype, "once").mockImplementation(function(
        this: ChildProcess,
        ...args: Parameters<ChildProcess["once"]>
      ) {
        once.mockRestore()
        process.emit("SIGTERM")
        return this.once(...args)
      })
      const code = await withIsolatedSignals(() =>
        deploy([], {
          cli: script("exit-zero"),
          cwd: NodePath.join(directory, "absent-directory"),
          stateDirectory: stateDirectory(),
          escalationDelayMs: 100,
          redact: async () => (redactions += 1, 0)
        })
      )

      expect(code).toBe(1)
      expect(redactions).toBe(1)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("retries through the child handle when the first signal delivery is refused", async () => {
    const marker = NodePath.join(directory, "group-gone")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const childKill = vi.spyOn(ChildProcess.prototype, "kill")
    const refuse = () => { throw Object.assign(new Error("signal delivery refused"), { code: "ESRCH" }) }
    const groupKill = vi.spyOn(process, "kill")
    if (process.platform === "win32") childKill.mockImplementationOnce(refuse)
    else groupKill.mockImplementationOnce(refuse)
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

      expect(childKill).toHaveBeenCalledWith("SIGTERM")
      // Windows terminates the process without running its signal handler.
      expect(existsSync(`${marker}.sigterm`)).toBe(process.platform !== "win32")
      expect(childKill.mock.contexts[0]).toMatchObject({ signalCode: expect.any(String) })
      expect(code).toBe(143)
    } finally {
      childKill.mockRestore()
      groupKill.mockRestore()
      stdout.mockRestore()
    }
  }, 30_000)

  it("signals the child through its own handle where process groups do not exist", async () => {
    const marker = NodePath.join(directory, "no-process-groups")
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    if (platform === undefined) throw new Error("process.platform is not an own property")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const childKill = vi.spyOn(ChildProcess.prototype, "kill")
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

      expect(childKill).toHaveBeenCalledWith("SIGTERM")
      expect(childKill.mock.contexts[0]).toMatchObject({ signalCode: expect.any(String) })
      expect(existsSync(`${marker}.sigterm`)).toBe(platform.value !== "win32")
      expect(code).toBe(143)
    } finally {
      Object.defineProperty(process, "platform", platform)
      childKill.mockRestore()
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
    const realKill = ChildProcess.prototype.kill
    const childKill = vi.spyOn(ChildProcess.prototype, "kill")
    if (process.platform === "win32") {
      // Windows cannot ignore an OS SIGTERM. Model that first delivery being
      // ineffective, then let the escalation terminate the real child.
      childKill.mockImplementation(function(this: ChildProcess, signal) {
        return signal === "SIGTERM" ? true : realKill.call(this, signal)
      })
    }
    const groupKill = vi.spyOn(process, "kill")
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
      expect(existsSync(`${marker}.sigterm`)).toBe(process.platform !== "win32")
      if (process.platform === "win32") {
        expect(childKill).toHaveBeenCalledWith("SIGKILL")
        expect(childKill.mock.contexts[0]).toMatchObject({ signalCode: "SIGKILL" })
      } else {
        expect(groupKill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(true)
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(300)
      // 143 is the conventional 128 + SIGTERM, reported even though the
      // command itself died to the escalation.
      expect(code).toBe(143)
      expect(redactions).toBe(1)
      expect(process.listenerCount("SIGTERM")).toBe(0)
    } finally {
      childKill.mockRestore()
      groupKill.mockRestore()
      stdout.mockRestore()
    }
  }, 30_000)

  it("maps SIGINT to its conventional exit code", async () => {
    const marker = NodePath.join(directory, "interrupt")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const childKill = vi.spyOn(ChildProcess.prototype, "kill")
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

      expect(existsSync(`${marker}.sigint`)).toBe(process.platform !== "win32")
      if (process.platform === "win32") {
        expect(childKill).toHaveBeenCalledWith("SIGINT")
        expect(childKill.mock.contexts[0]).toMatchObject({ signalCode: "SIGINT" })
      }
      expect(code).toBe(130)
    } finally {
      childKill.mockRestore()
      stdout.mockRestore()
    }
  }, 30_000)
})

describe("deploy wrapper remote state", () => {
  const snapshotOf = (files: Record<string, string>): string =>
    JSON.stringify({ format: "smithers-alchemy-state/1", files }, null, 2)

  const run = async (
    bucket: StateBucket,
    exitCode: string,
    extra: DeployOptions = {}
  ): Promise<{ code: number; seen: { synced?: string; pulled: string | null } | undefined; stderr: string }> => {
    const root = await realpath(await mkdtemp(NodePath.join(directory, "remote-")))
    const state = NodePath.join(root, "state")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    try {
      const code = await deployWrapper([state, exitCode], {
        cli: script("writes-state"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => 0,
        remoteState: async () => ({ bucket, key: "alchemy/Test.json" }),
        ...extra
      })
      const seenFile = NodePath.join(root, "seen.json")
      return {
        code,
        seen: existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : undefined,
        stderr: errors.join("")
      }
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  }

  it("pulls production state before Alchemy runs and publishes what it wrote", async () => {
    const bucket = memoryStateBucket()
    await bucket.put("alchemy/Test.json", snapshotOf({ "prod/CacheWorker.json": `{"live":true}` }), { ifAbsent: true })

    const { code, seen } = await run(bucket, "0")

    expect(code).toBe(0)
    expect(seen).toEqual({ synced: "1", pulled: `{"live":true}` })
    expect(JSON.parse(bucket.objects.get("alchemy/Test.json")!.body).files).toEqual({
      "prod/CacheWorker.json": `{"deployed":true}`
    })
    expect(bucket.objects.has("alchemy/Test.json.lock")).toBe(false)
  })

  it("publishes the state a failed run left, because only it records what was created", async () => {
    const bucket = memoryStateBucket()

    const { code } = await run(bucket, "7")

    expect(code).toBe(7)
    expect(bucket.objects.has("alchemy/Test.json")).toBe(true)
    expect(bucket.objects.has("alchemy/Test.json.lock")).toBe(false)
  })

  it.each([
    ["the state directory", (root: string) => ({ link: NodePath.join(root, "state"), state: NodePath.join(root, "state") })],
    [
      "an ancestor of the state directory",
      (root: string) => ({ link: NodePath.join(root, "linked"), state: NodePath.join(root, "linked", "state") })
    ]
  ])("refuses to deploy when %s is a symbolic link, before anything in its target changes", async (_name, shape) => {
    const root = await realpath(await mkdtemp(NodePath.join(directory, "linked-")))
    const outside = NodePath.join(root, "outside")
    await mkdir(outside)
    await writeFile(NodePath.join(outside, "important.json"), `{"keep":"me"}`, "utf8")
    const { link, state } = shape(root)
    await symlink(outside, link)
    const bucket = memoryStateBucket()
    await bucket.put("alchemy/Test.json", snapshotOf({ "prod/CacheWorker.json": `{"live":true}` }), { ifAbsent: true })
    const marker = NodePath.join(root, "refused")
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    let redactions = 0
    try {
      const code = await deployWrapper([marker], {
        cli: script("ignores-sigterm"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => (redactions += 1, 0),
        remoteState: async () => ({ bucket, key: "alchemy/Test.json" })
      })

      expect(code).toBe(1)
      expect(errors.join("")).toBe(
        `Alchemy deployment refused: symbolic links are not allowed in the Alchemy state root: ${link}\n`
      )
      // Neither Alchemy nor redaction ran, the remote lock was never taken, and
      // the link's target holds exactly the bytes it held before.
      expect(existsSync(`${marker}.ready`)).toBe(false)
      expect(redactions).toBe(0)
      expect([...bucket.objects.keys()]).toEqual(["alchemy/Test.json"])
      expect(await readdir(outside, { recursive: true })).toEqual(["important.json"])
      expect(readFileSync(NodePath.join(outside, "important.json"), "utf8")).toBe(`{"keep":"me"}`)
    } finally {
      stderr.mockRestore()
    }
  })

  it("refuses to start Alchemy while another deployment holds the remote lock", async () => {
    const bucket = memoryStateBucket()
    await bucket.put("alchemy/Test.json.lock", JSON.stringify({ host: "ci", pid: 9, startedAt: "then" }), {
      ifAbsent: true
    })

    const { code, seen, stderr } = await run(bucket, "0")

    expect(code).toBe(1)
    expect(seen).toBeUndefined()
    expect(stderr).toContain("locked by ci pid 9")
    expect(bucket.objects.has("alchemy/Test.json")).toBe(false)
  })

  it("refuses to start Alchemy when R2 cannot be reached, and frees local ownership", async () => {
    const bucket = memoryStateBucket()
    const { code, seen, stderr } = await run(bucket, "0", {
      remoteState: async () => {
        throw new Error("CLOUDFLARE_API_TOKEN is required to reach the R2 state bucket")
      }
    })

    expect(code).toBe(1)
    expect(seen).toBeUndefined()
    expect(stderr).toContain("CLOUDFLARE_API_TOKEN is required")
  })

  it.each([["SIGHUP", 129], ["SIGTERM", 143], ["SIGINT", 130]] as const)(
    "honors %s that arrives while remote state is pulled, without starting Alchemy",
    async (signal, exitCode) => {
      const bucket = memoryStateBucket()
      const interrupting: StateBucket = {
        ...bucket,
        get: async (key) => {
          // The lock is taken; the operator presses Ctrl-C during the pull.
          process.emit(signal)
          return bucket.get(key)
        }
      }

      const { code, seen } = await withIsolatedSignals(() => run(interrupting, "0"))

      expect(code).toBe(exitCode)
      expect(seen).toBeUndefined()
      expect(bucket.objects.has("alchemy/Test.json")).toBe(false)
      expect(bucket.objects.has("alchemy/Test.json.lock")).toBe(false)
      expect(process.listenerCount(signal)).toBe(0)
    }
  )

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
    "cancels a permanently stalled pull on %s and releases both locks", async signal => {
      const bucket = memoryStateBucket()
      const state = stateDirectory("stalled-" + signal)
      let resume: (() => void) | undefined
      let pulling = false
      let pullSignal: AbortSignal | undefined
      const stuck: StateBucket = {
        ...bucket,
        get: async (_key, signal) => {
          pullSignal = signal
          pulling = true
          await new Promise<void>(resolve => { resume = resolve })
          return undefined
        }
      }
      await withIsolatedSignals(async () => {
        const pending = run(stuck, "0", { stateDirectory: state })
        try {
          await vi.waitFor(() => expect(pulling).toBe(true))
          expect(bucket.objects.has("alchemy/Test.json.lock")).toBe(true)
          process.emit(signal)
          process.emit(signal)
          const result = await Promise.race([
            pending,
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 300))
          ])
          expect(result?.code).toBe(signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 129)
          expect(result?.seen).toBeUndefined()
          expect(existsSync(NodePath.join(state, "prod", "CacheWorker.json"))).toBe(false)
          expect(pullSignal?.aborted).toBe(true)
          expect(bucket.objects.has("alchemy/Test.json.lock")).toBe(false)
          const ownership = await acquireStateOwnership(state)
          await ownership.release()
        } finally {
          resume?.()
          await pending
        }
      })
    }
  )

  it.each(["response", "body"] as const)(
    "reconciles an accepted lock whose PUT %s stalls during termination", async stage => {
      const state = stateDirectory("lock-put-" + stage)
      let lockBody: string | undefined
      let accepted = false
      let deleted = false
      const bucket = r2StateBucket({
        accountId: "acct", bucket: "state", accessKeyId: "key", secretAccessKey: "secret",
        fetch: async (input, init) => {
          const request = new Request(input, init)
          if (request.method === "PUT") {
            lockBody = await request.text()
            accepted = true
            if (stage === "response") return new Promise(() => {})
            return new Response(new ReadableStream({
              cancel() {
                process.emit("SIGTERM")
                return new Promise(() => {})
              }
            }))
          }
          if (request.method === "DELETE") {
            deleted = true
            return new Response(null, { status: 204 })
          }
          expect(new URL(request.url).pathname.endsWith(".lock")).toBe(true)
          return new Response(lockBody, { headers: { etag: '"lock"' } })
        }
      })
      await withIsolatedSignals(async () => {
        const result = run(bucket, "0", { stateDirectory: state })
        if (stage === "response") {
          await vi.waitFor(() => expect(accepted).toBe(true))
          process.emit("SIGTERM")
        }
        const finished = await result
        expect(finished.code).toBe(143)
        expect(deleted).toBe(true)
        expect(existsSync(NodePath.join(state, "prod", "CacheWorker.json"))).toBe(false)
        const ownership = await acquireStateOwnership(state)
        await ownership.release()
      })
    }
  )

  it("cancels a permanently pending signed response body on termination", async () => {
    let locked = false
    let reading = false
    let cancelled = false
    let requestSignal: AbortSignal | undefined
    const bucket = r2StateBucket({
      accountId: "acct", bucket: "state", accessKeyId: "key", secretAccessKey: "secret",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.method === "PUT") {
          locked = true
          return new Response(null)
        }
        if (request.method === "DELETE") {
          locked = false
          return new Response(null, { status: 204 })
        }
        reading = true
        requestSignal = request.signal
        return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { etag: '"v1"' } })
      }
    })
    await withIsolatedSignals(async () => {
      const result = run(bucket, "0")
      await vi.waitFor(() => expect(reading).toBe(true))
      expect(locked).toBe(true)
      process.emit("SIGTERM")
      const finished = await result
      expect(finished.code).toBe(143)
      expect(finished.seen).toBeUndefined()
      expect(requestSignal?.aborted).toBe(true)
      expect(cancelled).toBe(true)
      expect(locked).toBe(false)
    })
  })

  it.each(["initialization", "pull", "interrupted-cleanup", "final-cleanup"] as const)(
    "bounds a stalled %s and frees local ownership", async stage => {
      const memory = memoryStateBucket()
      const state = stateDirectory("deadline-" + stage)
      let signal: AbortSignal | undefined
      const bucket: StateBucket = {
        ...memory,
        get: async (_key, s) => {
          if (stage === "interrupted-cleanup") process.emit("SIGTERM")
          if (stage === "final-cleanup") return undefined
          signal = s
          return new Promise(() => {})
        },
        delete: async (key, s) => {
          if (stage === "pull") return memory.delete(key)
          signal = s
          if (stage === "final-cleanup") process.emit("SIGTERM")
          return new Promise(() => {})
        }
      }
      const result = await withIsolatedSignals(() => run(bucket, "0", {
        stateDirectory: state,
        remoteStateTimeoutMs: 20,
        remoteState: async s => {
          if (stage !== "initialization") return { bucket, key: "alchemy/Test.json" }
          signal = s
          return new Promise(() => {})
        }
      }))
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("timed out after 20ms")
      expect(signal?.aborted).toBe(true)
      expect(memory.objects.has("alchemy/Test.json.lock")).toBe(stage.endsWith("cleanup"))
      const ownership = await acquireStateOwnership(state)
      await ownership.release()
      for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) expect(process.listenerCount(signal)).toBe(0)
    }
  )

  it("cancels a stalled state factory before any lock or child exists", async () => {
    const bucket = memoryStateBucket()
    let signal: AbortSignal | undefined
    const result = await withIsolatedSignals(() => run(bucket, "0", {
      remoteState: async s => {
        signal = s
        process.emit("SIGTERM")
        return new Promise(() => {})
      }
    }))
    expect(result.code).toBe(143)
    expect(result.seen).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(bucket.objects.size).toBe(0)
  })

  it("fails an interrupted run whose remote lock cannot be released", async () => {
    const bucket = memoryStateBucket()
    const stuck: StateBucket = {
      ...bucket,
      get: async (key) => {
        process.emit("SIGTERM")
        return bucket.get(key)
      },
      delete: async () => {
        throw new Error("R2 state DELETE answered 503")
      }
    }

    const { code, seen, stderr } = await withIsolatedSignals(() => run(stuck, "0"))

    expect(code).toBe(1)
    expect(seen).toBeUndefined()
    expect(stderr).toContain("lock was not released: R2 state DELETE answered 503")
  })

  it("never publishes state that failed redaction", async () => {
    const bucket = memoryStateBucket()

    const { code } = await run(bucket, "0", {
      redact: async () => {
        throw new Error("redaction refused")
      }
    })

    expect(code).toBe(1)
    expect(bucket.objects.has("alchemy/Test.json")).toBe(false)
    expect(bucket.objects.has("alchemy/Test.json.lock")).toBe(false)
  })

  it("fails the run when remote state changed underneath it", async () => {
    const bucket = memoryStateBucket()
    const racing: StateBucket = {
      ...bucket,
      put: async (key, body, condition) => key.endsWith(".lock") ? bucket.put(key, body, condition) : false
    }

    const { code, stderr } = await run(racing, "0")

    expect(code).toBe(1)
    expect(stderr).toContain("Remote Alchemy state was not published")
    expect(stderr).toContain("changed during this deployment")
  })

  it("fails the run when the remote lock cannot be released", async () => {
    const bucket = memoryStateBucket()
    const stuck: StateBucket = {
      ...bucket,
      delete: async () => {
        throw new Error("R2 state DELETE answered 500")
      }
    }

    const { code, stderr } = await run(stuck, "0")

    expect(code).toBe(1)
    expect(stderr).toContain("R2 state DELETE answered 500")
  })
})
