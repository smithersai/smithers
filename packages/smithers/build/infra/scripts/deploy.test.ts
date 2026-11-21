import { ChildProcess, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { loadConfigProvider } from "alchemy/Util/ConfigProvider"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cacheOnlyVariable, stateSyncVariable, wrapperOwnedVariables } from "../deployment.ts"
import { deploy as deployWrapper, type DeployOptions, developmentStage, resolveDeployOptions } from "./deploy.ts"
import { defaultStateDirectory, redactAlchemyState } from "./redact-state.ts"
import {
  legacyStateObjectKey,
  memoryStateBucket,
  migrateSharedState,
  r2StateBucket,
  type StateBucket,
  stateObjectKey
} from "./remote-state.ts"
import { acquireStateOwnership } from "./state-ownership.ts"

const infraRoot = NodePath.resolve(fileURLToPath(new URL("..", import.meta.url).href))

let directory: string

/**
 * The wrapper under test, against an in-memory state bucket unless a test
 * names its own, so no test reaches the production R2 bucket.
 */
const deploy = (args: ReadonlyArray<string>, options: DeployOptions): Promise<number> =>
  deployWrapper(args, {
    stateBucket: async () => memoryStateBucket(),
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
  // A plan: records what it was given and the stage directory it saw
  // (argv[4]), and writes no state.
  await write(
    "plans",
    `import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const stage = process.argv[4]
const worker = join(stage, "CacheWorker.json")
writeFileSync(process.env.SMITHERS_DEPLOY_ARGV_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  cacheOnly: process.env[${JSON.stringify(cacheOnlyVariable)}],
  pulled: existsSync(worker) ? readFileSync(worker, "utf8") : null,
  entries: existsSync(stage) ? readdirSync(stage).sort() : []
}))
`
  )
  // A destroy that converged: Alchemy deletes the stage directory (argv[4]).
  await write(
    "destroys",
    `import { rmSync, writeFileSync } from "node:fs"
writeFileSync(process.env.SMITHERS_DEPLOY_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
rmSync(process.argv[4], { recursive: true, force: true })
`
  )
  // Records the argv the wrapper hands Alchemy, after the script path.
  await write(
    "record-argv",
    `import { writeFileSync } from "node:fs"
writeFileSync(process.env.SMITHERS_DEPLOY_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
`
  )
  // Records the argv and the cache-only switch the stack program would read.
  await write(
    "record-invocation",
    `import { writeFileSync } from "node:fs"
writeFileSync(process.env.SMITHERS_DEPLOY_ARGV_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  cacheOnly: process.env[${JSON.stringify(cacheOnlyVariable)}]
}))
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
          // An empty or torn file reads as 0, and -0 is this test's own group: only a group leader's pid is killed.
          const leader = Number(readFileSync(`${marker}.leader`, "utf8"))
          try {
            if (Number.isInteger(leader) && leader > 1) process.kill(-leader, "SIGKILL")
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
      // A dry run is Alchemy's read-only `plan`, never a `deploy` that a
      // stray `--dry-run false` could turn into a real one.
      expect(await recorded(["--stage=prod", "--dry-run"])).toEqual(["plan", "alchemy.run.ts", "--stage=prod"])
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  // The stage names a directory under the state directory, so a name Alchemy
  // would refuse anyway must not reach a path, a lock, or redaction first.
  it.each([
    [["--stage", "../prod"], "stage \"../prod\" must be"],
    [["--stage=a/b"], "stage \"a/b\" must be"],
    [["--yes", "--stage"], "stage \"\" must be"],
    [["--stage", "--yes"], "stage \"--yes\" must be"],
    [["--stage", "prod", "--stage=dev"], "name one --stage, not several"],
    // Alchemy reads these as a real deployment; the wrapper would plan it.
    [["--dry-run=false"], "pass --dry-run alone, not --dry-run=false"],
    [["--no-dry-run"], "pass --dry-run alone, not --no-dry-run"],
    [["--destroy", "--stage", "prod"], "refusing to destroy stage prod, which is protected; pass --allow-destroy=prod"],
    [["--destroy", "--stage=prod", "--dry-run"], "refusing to destroy stage prod, which is protected"],
    // Protection is a property of the stage, not of the name `prod`.
    [["--destroy", "--stage", "vibelang"], "refusing to destroy stage vibelang, which is protected"],
    [["--destroy", "--stage", "vibelang", "--allow-destroy=prod"], "refusing to destroy stage vibelang, which is protected"],
    [["--destroy", "--stage", "vibelang", "--allow-destroy"], "name the stage: --allow-destroy=<stage>"]
  ])("refuses %j before it touches any state", async (args, message) => {
    const state = stateDirectory(`refused-stage-${message.length}-${args.length}`)
    const bucket = memoryStateBucket()
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    let redactions = 0
    try {
      const code = await deploy(args, {
        cli: script("exit-zero"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => (redactions += 1, 0),
        stateBucket: async () => bucket
      })

      expect(code).toBe(1)
      expect(errors.join("")).toContain(`Alchemy deployment refused: ${message}`)
      expect(redactions).toBe(0)
      expect(existsSync(state)).toBe(false)
      expect(bucket.objects.size).toBe(0)
    } finally {
      stderr.mockRestore()
    }
  })

  /**
   * Alchemy reads `--env-file` before the process environment, so a file
   * passed through the wrapper could set a variable the wrapper sets for the
   * run, such as `SMITHERS_BUILD_INFRA_CACHE_ONLY=1` on a stage the wrapper
   * deploys whole, and Alchemy would delete that stage's sandbox Worker.
   */
  it.each(wrapperOwnedVariables)("refuses --env-file, which overrides the %s the wrapper sets", async (variable) => {
    const envFile = NodePath.join(directory, `override-${variable}.env`)
    await writeFile(envFile, `${variable}=override\n`, "utf8")
    // Alchemy's own config provider, with the value the wrapper exports.
    vi.stubEnv(variable, "set-by-the-wrapper")
    const seen = (envFileFlag: Option.Option<string>): Promise<string> =>
      Effect.runPromise(
        Effect.gen(function*() {
          const provider = yield* loadConfigProvider(envFileFlag)
          return yield* Effect.provide(
            Effect.gen(function*() {
              return yield* Config.String(variable)
            }),
            ConfigProvider.layer(provider)
          )
        }).pipe(Effect.provide(NodeFileSystem.layer))
      )
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (errors.push(String(chunk)), true))
    let redactions = 0
    try {
      expect(await seen(Option.some(envFile))).toBe("override")
      expect(await seen(Option.none())).toBe("set-by-the-wrapper")

      const state = stateDirectory(`env-file-${variable}`)
      for (const args of [["--stage", "vibelang", "--env-file", envFile], ["--stage", "vibelang", `--env-file=${envFile}`]]) {
        const code = await deploy(args, {
          cli: script("exit-zero"),
          cwd: directory,
          stateDirectory: state,
          redact: async () => (redactions += 1, 0)
        })
        expect(code).toBe(1)
      }
      expect(errors.join("")).toContain(
        `Alchemy deployment refused: --env-file is refused because Alchemy reads it before the process ` +
          `environment, so it could override ${wrapperOwnedVariables.join(" and ")}`
      )
      expect(redactions).toBe(0)
      expect(existsSync(state)).toBe(false)
    } finally {
      stderr.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("switches the sandbox off for --cache-only alone, whatever the shell exported", async () => {
    const argvFile = NodePath.join(directory, "recorded-invocation.json")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", argvFile)
    // A shell that exported the switch must not strip production's sandbox.
    vi.stubEnv(cacheOnlyVariable, "1")
    const recorded = async (args: ReadonlyArray<string>): Promise<unknown> => {
      const code = await deploy(args, {
        cli: script("record-invocation"),
        cwd: directory,
        stateDirectory: stateDirectory("cache-only-argv-state"),
        redact: async () => 0
      })
      expect(code).toBe(0)
      return JSON.parse(readFileSync(argvFile, "utf8"))
    }
    try {
      expect(await recorded(["--stage", "prod"])).toEqual({
        argv: ["deploy", "alchemy.run.ts", "--stage", "prod"],
        cacheOnly: "0"
      })
      // The wrapper's own flag never reaches Alchemy, which would refuse it.
      expect(await recorded(["--cache-only", "--", "--stage", "needlefish_poc", "--yes"])).toEqual({
        argv: ["deploy", "alchemy.run.ts", "--stage", "needlefish_poc", "--yes"],
        cacheOnly: "1"
      })
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  // A development cache deploy needs Cloudflare credentials and the two cache
  // tokens; production keeps its sandbox service.
  it("deploys development stages cache-only and production with its sandbox", () => {
    const scripts = (JSON.parse(readFileSync(NodePath.join(infraRoot, "package.json"), "utf8")) as {
      readonly scripts: Record<string, string>
    }).scripts
    expect(scripts["deploy:dev"]).toBe("node scripts/deploy.ts --cache-only")
    expect(scripts["plan:dev"]).toBe("node scripts/deploy.ts --cache-only --dry-run")
    expect(scripts["destroy:dev"]).toBe("node scripts/deploy.ts --destroy")
    expect(scripts["deploy"]).toBe("node scripts/deploy.ts --stage prod")
    expect(scripts["plan"]).toBe("node scripts/deploy.ts --stage prod --dry-run")
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
      await expect(resolved.stateBucket()).rejects.toThrow("CLOUDFLARE_API_TOKEN is required")
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

  it("prints a weak ETag diagnostic at the deployment failure boundary", () => {
    const state = stateDirectory("weak-etag")
    const key = "alchemy/Test.json"
    const etag = 'W/"e1"'
    const run = spawnSync(process.execPath, [
      "--import",
      import.meta.resolve("vibelang/register"),
      "--input-type=module",
      "--eval",
      `import { deploy } from ${JSON.stringify(new URL("./deploy.ts", import.meta.url).href)}
import { WeakEtagError } from ${JSON.stringify(new URL("./remote-state.ts", import.meta.url).href)}
process.exitCode = await deploy([], {
  cli: ${JSON.stringify(script("writes-state"))},
  cwd: ${JSON.stringify(directory)},
  stateDirectory: ${JSON.stringify(state)},
  stateBucket: async () => { throw new WeakEtagError(${JSON.stringify({ key, etag })}) }
})
`
    ], { cwd: infraRoot, encoding: "utf8", timeout: 10_000 })

    expect(run.error).toBeUndefined()
    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      `Alchemy deployment refused: R2 state ${key} carries the weak ETag ${etag}, which R2 never matches on a conditional write\n`
    )
    expect(run.stdout).toBe("")
    expect(existsSync(NodePath.join(state, "prod", "CacheWorker.json"))).toBe(false)
    expect(existsSync(lockFileIn(state))).toBe(false)
  })

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
              // Redaction walks the deployed stage's directory, under the
              // ownership the wrapper holds for the whole state directory.
              expect(options.directory).toBe(NodePath.join(state, developmentStage()))
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
    const file = NodePath.join(state, developmentStage(), "CacheWorker.json")
    await mkdir(NodePath.dirname(file), { recursive: true })
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

  /** The production stage's own state object; `run` deploys that stage. */
  const key = stateObjectKey("prod")

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
      const code = await deployWrapper([state, exitCode, "--stage", "prod"], {
        cli: script("writes-state"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => 0,
        stateBucket: async () => bucket,
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
    await bucket.put(key, snapshotOf({ "CacheWorker.json": `{"live":true}` }), { ifAbsent: true })

    const { code, seen } = await run(bucket, "0")

    expect(code).toBe(0)
    expect(seen).toEqual({ synced: "1", pulled: `{"live":true}` })
    expect(JSON.parse(bucket.objects.get(key)!.body).files).toEqual({
      "CacheWorker.json": `{"deployed":true}`
    })
    expect(bucket.objects.has(`${key}.lock`)).toBe(false)
  })

  /**
   * A stage's credential verifiers derive from that stage's tokens, which the
   * deploying shell holds only for the stage it deploys. One shared object
   * made every deployment lock, pull and republish every stage, and redaction
   * that walked every stage replaced the others' verifiers with the sentinel.
   */
  it("reads, locks and publishes only the stage it deploys, and redacts that stage's sandbox bearer", async () => {
    const memory = memoryStateBucket()
    const touched: Array<string> = []
    const bucket: StateBucket = {
      get: async (target) => (touched.push(`GET ${target}`), memory.get(target)),
      put: async (target, body, condition) => (touched.push(`PUT ${target}`), memory.put(target, body, condition)),
      delete: async (target) => (touched.push(`DELETE ${target}`), memory.delete(target))
    }
    const root = await realpath(await mkdtemp(NodePath.join(directory, "stage-isolation-")))
    const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")
    const workerState = (name: string, value: string): string =>
      JSON.stringify({
        props: { env: { [name]: { __redacted__: value } } },
        bindings: [{ sid: name, data: { bindings: [{ type: "secret_text", name, text: value }] } }]
      })
    const production = snapshotOf({ "CacheWorker.json": workerState("CACHE_READ_TOKEN", sha256("production-read-2026")) })
    await memory.put(key, production, { ifAbsent: true })
    const productionEtag = memory.objects.get(key)!.etag
    const stage = stateObjectKey("needlefish_poc")
    const sandboxBearer = "needlefish-sandbox-bearer-2026"
    await memory.put(stage, snapshotOf({ "SandboxWorker.json": workerState("SANDBOX_TOKEN", sandboxBearer) }), {
      ifAbsent: true
    })
    vi.stubEnv("SMITHERS_CACHE_TOKEN", "")
    vi.stubEnv("SMITHERS_CACHE_READ_TOKEN", "needlefish-read-credential-2026")
    vi.stubEnv("SMITHERS_CACHE_WRITE_TOKEN", "needlefish-write-credential-2026")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await deployWrapper(["--stage", "needlefish_poc"], {
        cli: script("exit-zero"),
        cwd: directory,
        stateDirectory: NodePath.join(root, "state"),
        stateBucket: async () => bucket
      })

      expect(code).toBe(0)
      expect(touched).toEqual([
        `GET ${legacyStateObjectKey}`,
        `PUT ${stage}.lock`,
        `GET ${stage}`,
        `PUT ${stage}`,
        `DELETE ${stage}.lock`
      ])
      expect(memory.objects.get(key)).toEqual({ body: production, etag: productionEtag })
      const published = JSON.parse(JSON.parse(memory.objects.get(stage)!.body).files["SandboxWorker.json"])
      expect(JSON.stringify(published)).not.toContain(sandboxBearer)
      expect(published.props.env.SANDBOX_TOKEN.__redacted__).toBe("__SMITHERS_CACHE_TOKEN_REDACTED__")
      // The working copy is the stage's own directory under the stack's.
      expect(existsSync(NodePath.join(root, "state", "needlefish_poc", "SandboxWorker.json"))).toBe(true)
      expect(existsSync(NodePath.join(root, "state", "prod"))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  it("refuses to deploy while the shared object still holds every stage, and names the migration", async () => {
    const bucket = memoryStateBucket()
    await bucket.put(legacyStateObjectKey, snapshotOf({ "prod/CacheWorker.json": `{"live":true}` }), {
      ifAbsent: true
    })

    const { code, seen, stderr } = await run(bucket, "0")

    expect(code).toBe(1)
    expect(seen).toBeUndefined()
    expect(stderr).toContain(`still the shared object smithers-build-infra-state/${legacyStateObjectKey}`)
    expect(stderr).toContain("pnpm run migrate-state -- --dry-run")
    expect([...bucket.objects.keys()]).toEqual([legacyStateObjectKey])
  })

  it("deploys from the stage's own object once the shared object is migrated", async () => {
    const bucket = memoryStateBucket()
    await bucket.put(legacyStateObjectKey, snapshotOf({ "prod/CacheWorker.json": `{"live":true}` }), {
      ifAbsent: true
    })
    // The migration runs from a machine with no unpublished shared-layout state.
    await migrateSharedState(bucket, directory, { host: "operator", pid: 1, startedAt: "now" })

    const { code, seen } = await run(bucket, "0")

    expect(code).toBe(0)
    expect(seen).toEqual({ synced: "1", pulled: `{"live":true}` })
    expect(JSON.parse(bucket.objects.get(key)!.body).files).toEqual({ "CacheWorker.json": `{"deployed":true}` })
  })

  /**
   * A cache-only program declares no sandbox Worker, so Alchemy would plan
   * the deletion of a stage's existing one and apply it under `--yes`.
   */
  it("refuses a cache-only run of a stage whose state holds a sandbox Worker, and frees both locks", async () => {
    const bucket = memoryStateBucket()
    const stage = stateObjectKey("vibelang")
    const snapshot = snapshotOf({ "CacheWorker.json": "{}", "SandboxWorker.json": "{}" })
    await bucket.put(stage, snapshot, { ifAbsent: true })
    const root = await realpath(await mkdtemp(NodePath.join(directory, "cache-only-guard-")))
    const state = NodePath.join(root, "state")
    const marker = NodePath.join(root, "refused")
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (errors.push(String(chunk)), true))
    let redactions = 0
    try {
      const code = await deployWrapper([marker, "--cache-only", "--stage", "vibelang", "--yes"], {
        cli: script("ignores-sigterm"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => (redactions += 1, 0),
        stateBucket: async () => bucket
      })

      expect(code).toBe(1)
      expect(errors.join("")).toBe(
        "Alchemy deployment refused: stage vibelang has a sandbox Worker, which a --cache-only run would delete; " +
          "deploy it without --cache-only, or destroy the stage\n"
      )
      expect(existsSync(`${marker}.ready`)).toBe(false)
      expect(redactions).toBe(0)
      expect([...bucket.objects.keys()]).toEqual([stage])
      expect(bucket.objects.get(stage)!.body).toBe(snapshot)
      expect(existsSync(lockFileIn(state))).toBe(false)
    } finally {
      stderr.mockRestore()
    }
  })

  /**
   * A plan reads the stage's object to plan against durable state, and must
   * still own the local working copy it pulls into. It takes no remote lock,
   * runs no redaction, and publishes nothing.
   */
  it("plans a stage against its pulled state without its lock, and publishes nothing", async () => {
    const memory = memoryStateBucket()
    const touched: Array<string> = []
    const bucket: StateBucket = {
      ...memory,
      get: async (target) => (touched.push(`GET ${target}`), memory.get(target)),
      put: async (target, body, condition) => (touched.push(`PUT ${target}`), memory.put(target, body, condition)),
      delete: async (target) => (touched.push(`DELETE ${target}`), memory.delete(target))
    }
    const stage = stateObjectKey("needlefish_poc")
    await memory.put(stage, snapshotOf({ "CacheWorker.json": `{"live":true}` }), { ifAbsent: true })
    const root = await realpath(await mkdtemp(NodePath.join(directory, "plan-")))
    const state = NodePath.join(root, "state")
    const argvFile = NodePath.join(root, "plan.json")
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", argvFile)
    let redactions = 0
    try {
      const code = await deployWrapper(
        [NodePath.join(state, "needlefish_poc"), "--cache-only", "--dry-run", "--stage", "needlefish_poc"],
        {
          cli: script("plans"),
          cwd: directory,
          stateDirectory: state,
          redact: async () => (redactions += 1, 0),
          stateBucket: async () => bucket
        }
      )

      expect(code).toBe(0)
      expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual({
        argv: ["plan", "alchemy.run.ts", NodePath.join(state, "needlefish_poc"), "--stage", "needlefish_poc"],
        cacheOnly: "1",
        pulled: `{"live":true}`,
        entries: ["CacheWorker.json"]
      })
      expect(touched).toEqual([`GET ${legacyStateObjectKey}`, `GET ${stage}`])
      expect(redactions).toBe(0)
      expect(existsSync(lockFileIn(state))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /**
   * Destroy goes through the same round trip as a deployment: it pulls the
   * stage's state under its lock so Alchemy deletes what that state records,
   * and the object goes once Alchemy has deleted the stage's state.
   */
  it("destroys a stage through its state round trip and then removes its object", async () => {
    const bucket = memoryStateBucket()
    const stage = stateObjectKey("needlefish_poc")
    await bucket.put(stage, snapshotOf({ "CacheWorker.json": "{}" }), { ifAbsent: true })
    const root = await realpath(await mkdtemp(NodePath.join(directory, "destroy-")))
    const state = NodePath.join(root, "state")
    const stageDirectory = NodePath.join(state, "needlefish_poc")
    const argvFile = NodePath.join(root, "destroy.json")
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", argvFile)
    const out: Array<string> = []
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true))
    try {
      // `deploy:dev -- --destroy` passes --cache-only too; destroy removes
      // every resource whatever the program declares.
      const code = await deployWrapper(
        [stageDirectory, "--cache-only", "--destroy", "--stage", "needlefish_poc", "--yes"],
        { cli: script("destroys"), cwd: directory, stateDirectory: state, stateBucket: async () => bucket }
      )

      expect(code).toBe(0)
      expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
        "destroy",
        "alchemy.run.ts",
        stageDirectory,
        "--stage",
        "needlefish_poc",
        "--yes"
      ])
      expect(out).toContain("Remote Alchemy state removed.\n")
      expect(bucket.objects.size).toBe(0)
      expect(existsSync(lockFileIn(state))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  /**
   * A stage whose state records a sandbox Worker is serving something beyond
   * a throwaway cache, whatever its name, so destroying it takes a flag that
   * names it.
   */
  it("refuses to destroy a stage whose state holds a sandbox Worker unless the flag names that stage", async () => {
    const bucket = memoryStateBucket()
    const stage = stateObjectKey("needlefish_poc")
    const snapshot = snapshotOf({ "CacheWorker.json": "{}", "SandboxWorker.json": "{}" })
    await bucket.put(stage, snapshot, { ifAbsent: true })
    const root = await realpath(await mkdtemp(NodePath.join(directory, "destroy-sandbox-")))
    const state = NodePath.join(root, "state")
    const stageDirectory = NodePath.join(state, "needlefish_poc")
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", NodePath.join(root, "destroy.json"))
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (errors.push(String(chunk)), true))
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      for (const extra of [[], ["--allow-destroy=other"]]) {
        const refused = await deployWrapper(
          [stageDirectory, "--destroy", "--stage", "needlefish_poc", "--yes", ...extra],
          { cli: script("destroys"), cwd: directory, stateDirectory: state, stateBucket: async () => bucket }
        )
        expect(refused).toBe(1)
        expect(bucket.objects.get(stage)!.body).toBe(snapshot)
        expect(bucket.objects.has(`${stage}.lock`)).toBe(false)
        expect(existsSync(lockFileIn(state))).toBe(false)
      }
      expect(errors.join("")).toContain(
        "Alchemy deployment refused: refusing to destroy stage needlefish_poc, whose state holds a sandbox " +
          "Worker; pass --allow-destroy=needlefish_poc to destroy it"
      )

      const destroyed = await deployWrapper(
        [stageDirectory, "--destroy", "--stage", "needlefish_poc", "--yes", "--allow-destroy=needlefish_poc"],
        { cli: script("destroys"), cwd: directory, stateDirectory: state, stateBucket: async () => bucket }
      )
      expect(destroyed).toBe(0)
      expect(bucket.objects.size).toBe(0)
    } finally {
      vi.unstubAllEnvs()
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("keeps the stage's object when the destroy fails, and destroys production only when told twice", async () => {
    const bucket = memoryStateBucket()
    const snapshot = snapshotOf({ "CacheWorker.json": "{}" })
    await bucket.put(key, snapshot, { ifAbsent: true })
    const root = await realpath(await mkdtemp(NodePath.join(directory, "destroy-production-")))
    const state = NodePath.join(root, "state")
    const argvFile = NodePath.join(root, "destroy.json")
    vi.stubEnv("SMITHERS_DEPLOY_ARGV_FILE", argvFile)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const failed = await deployWrapper(["--destroy", "--allow-destroy=prod", "--stage", "prod"], {
        cli: script("exit-seven"),
        cwd: directory,
        stateDirectory: state,
        stateBucket: async () => bucket
      })
      expect(failed).toBe(7)
      expect(bucket.objects.get(key)!.body).toBe(snapshot)

      const destroyed = await deployWrapper(
        [NodePath.join(state, "prod"), "--destroy", "--allow-destroy=prod", "--stage", "prod", "--dry-run"],
        { cli: script("destroys"), cwd: directory, stateDirectory: state, stateBucket: async () => bucket }
      )
      expect(destroyed).toBe(0)
      // A destroy plan is read-only, like any other plan: the object stays.
      expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
        "destroy",
        "alchemy.run.ts",
        NodePath.join(state, "prod"),
        "--stage",
        "prod",
        "--dry-run"
      ])
      expect(bucket.objects.get(key)!.body).toBe(snapshot)
    } finally {
      vi.unstubAllEnvs()
      stdout.mockRestore()
    }
  })

  it("refuses local state a deployment from before per-stage state never published", async () => {
    const bucket = memoryStateBucket()
    const root = await realpath(await mkdtemp(NodePath.join(directory, "shared-marker-")))
    const state = NodePath.join(root, "state")
    const marker = NodePath.join(state, ".smithers-unpublished-state")
    await mkdir(state)
    await writeFile(marker, JSON.stringify({ format: "smithers-unpublished-state/1", etag: null, baseline: "x" }))
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (errors.push(String(chunk)), true))
    try {
      const code = await deployWrapper([state, "0", "--stage", "prod"], {
        cli: script("writes-state"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => 0,
        stateBucket: async () => bucket
      })

      expect(code).toBe(1)
      expect(errors.join("")).toContain(`${marker} records state a deployment from before per-stage state`)
      expect(bucket.objects.size).toBe(0)
      expect(existsSync(NodePath.join(root, "seen.json"))).toBe(false)
      expect(existsSync(lockFileIn(state))).toBe(false)
    } finally {
      stderr.mockRestore()
    }
  })

  it("publishes the state a failed run left, because only it records what was created", async () => {
    const bucket = memoryStateBucket()

    const { code } = await run(bucket, "7")

    expect(code).toBe(7)
    expect(bucket.objects.has(key)).toBe(true)
    expect(bucket.objects.has(`${key}.lock`)).toBe(false)
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
    await bucket.put(key, snapshotOf({ "CacheWorker.json": `{"live":true}` }), { ifAbsent: true })
    const marker = NodePath.join(root, "refused")
    const errors: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    let redactions = 0
    try {
      const code = await deployWrapper([marker, "--stage", "prod"], {
        cli: script("ignores-sigterm"),
        cwd: directory,
        stateDirectory: state,
        redact: async () => (redactions += 1, 0),
        stateBucket: async () => bucket
      })

      expect(code).toBe(1)
      expect(errors.join("")).toBe(
        `Alchemy deployment refused: symbolic links are not allowed in the Alchemy state root: ${link}\n`
      )
      // Neither Alchemy nor redaction ran, the remote lock was never taken, and
      // the link's target holds exactly the bytes it held before.
      expect(existsSync(`${marker}.ready`)).toBe(false)
      expect(redactions).toBe(0)
      expect([...bucket.objects.keys()]).toEqual([key])
      expect(await readdir(outside, { recursive: true })).toEqual(["important.json"])
      expect(readFileSync(NodePath.join(outside, "important.json"), "utf8")).toBe(`{"keep":"me"}`)
    } finally {
      stderr.mockRestore()
    }
  })

  it("refuses to start Alchemy while another deployment holds the remote lock", async () => {
    const bucket = memoryStateBucket()
    await bucket.put(`${key}.lock`, JSON.stringify({ host: "ci", pid: 9, startedAt: "then" }), {
      ifAbsent: true
    })

    const { code, seen, stderr } = await run(bucket, "0")

    expect(code).toBe(1)
    expect(seen).toBeUndefined()
    expect(stderr).toContain("locked by ci pid 9")
    expect(bucket.objects.has(key)).toBe(false)
  })

  it("refuses to start Alchemy when R2 cannot be reached, and frees local ownership", async () => {
    const bucket = memoryStateBucket()
    const { code, seen, stderr } = await run(bucket, "0", {
      stateBucket: async () => {
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
        get: async (target) => {
          // The lock is taken; the operator presses Ctrl-C during the pull.
          if (target === key) process.emit(signal)
          return bucket.get(target)
        }
      }

      const { code, seen } = await withIsolatedSignals(() => run(interrupting, "0"))

      expect(code).toBe(exitCode)
      expect(seen).toBeUndefined()
      expect(bucket.objects.has(key)).toBe(false)
      expect(bucket.objects.has(`${key}.lock`)).toBe(false)
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
        get: async (target, signal) => {
          if (target === legacyStateObjectKey) return bucket.get(target)
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
          expect(bucket.objects.has(`${key}.lock`)).toBe(true)
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
          expect(bucket.objects.has(`${key}.lock`)).toBe(false)
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
          // No shared object from before per-stage state exists.
          if (new URL(request.url).pathname.endsWith(legacyStateObjectKey)) return new Response(null, { status: 404 })
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
        if (new URL(request.url).pathname.endsWith(legacyStateObjectKey)) return new Response(null, { status: 404 })
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
        get: async (target, s) => {
          if (target === legacyStateObjectKey) return memory.get(target)
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
        stateBucket: async s => {
          if (stage !== "initialization") return bucket
          signal = s
          return new Promise(() => {})
        }
      }))
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("timed out after 20ms")
      expect(signal?.aborted).toBe(true)
      expect(memory.objects.has(`${key}.lock`)).toBe(stage.endsWith("cleanup"))
      const ownership = await acquireStateOwnership(state)
      await ownership.release()
      for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) expect(process.listenerCount(signal)).toBe(0)
    }
  )

  it("cancels a stalled state factory before any lock or child exists", async () => {
    const bucket = memoryStateBucket()
    let signal: AbortSignal | undefined
    const result = await withIsolatedSignals(() => run(bucket, "0", {
      stateBucket: async s => {
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
      get: async (target) => {
        if (target === key) process.emit("SIGTERM")
        return bucket.get(target)
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
    expect(bucket.objects.has(key)).toBe(false)
    expect(bucket.objects.has(`${key}.lock`)).toBe(false)
  })

  it("fails the run when remote state changed underneath it", async () => {
    const bucket = memoryStateBucket()
    const racing: StateBucket = {
      ...bucket,
      put: async (target, body, condition) => target.endsWith(".lock") ? bucket.put(target, body, condition) : false
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
