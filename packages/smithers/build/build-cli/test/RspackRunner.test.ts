/**
 * The bundler runner's process side.
 *
 * The refusal cases run everywhere: they need only the host `node`. The
 * end-to-end cases run a real rsbuild/rspack against the `rsbuild-mini`
 * fixture. `S.Bundler.Rspack` runs the *workspace's* own bundler, never one
 * this package imports, so the fixture workspace needs a `node_modules` tree
 * that provides `@rsbuild/core`: this package declares it as a devDependency
 * and the fixture links that resolved tree in. Every case therefore runs on a
 * clean checkout. `SMTHRS_RSBUILD_MODULES` overrides the tree with another
 * workspace's node_modules; a missing one is a broken install and refuses
 * loudly rather than skipping.
 */
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Exec from "@smthrs/targets/Exec"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { resolveGraph, runBuild } from "../src/RspackRunner.ts"

const fixture = NodePath.join(import.meta.dirname, "fixtures", "rsbuild-mini")

const signalable = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if ((cause as { readonly code?: string }).code === "ESRCH") return false
    throw cause
  }
}

/**
 * Whether a pid still names a process that can run.
 *
 * The runner's child is killed together with the supervisor that parents it,
 * so it is left an orphan zombie until whatever adopts it reaps it; a
 * container's PID 1 may do that late. A zombie is dead but still answers
 * signal 0, so its scheduler state decides.
 */
const runnable = (pid: number): boolean => {
  if (!signalable(pid)) return false
  if (process.platform === "win32") return true
  if (process.platform === "linux") {
    try {
      // `comm` is parenthesised and may hold spaces; the state follows the last ") ".
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      return stat.slice(stat.lastIndexOf(") ") + 2).trimStart().charAt(0) !== "Z"
    } catch {
      return signalable(pid)
    }
  }
  const listed = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2_000,
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
  })
  if (listed.status !== 0) return signalable(pid)
  return !listed.stdout.trim().startsWith("Z")
}

/**
 * The node_modules tree the fixture workspace links in so it provides its own
 * `@rsbuild/core`.
 *
 * The default is this package's own resolved copy of the devDependency, which
 * exists on any clean checkout; under pnpm that is the bundler's virtual-store
 * directory, which carries `@rspack/core` and the rest of its own dependency
 * closure beside it. `SMTHRS_RSBUILD_MODULES` names another workspace's
 * node_modules instead. Failing to resolve either one means a broken install,
 * not a reason to skip.
 */
const resolveModulesSource = (): string => {
  const override = process.env["SMTHRS_RSBUILD_MODULES"]
  if (override !== undefined && override !== "") {
    if (!existsSync(NodePath.join(override, "@rsbuild", "core"))) {
      throw new Error(`SMTHRS_RSBUILD_MODULES=${override} provides no @rsbuild/core`)
    }
    return override
  }
  // <modules>/@rsbuild/core/package.json -> <modules>
  return NodePath.resolve(createRequire(import.meta.url).resolve("@rsbuild/core/package.json"), "../../..")
}

const modulesSource = resolveModulesSource()

const flipped = <A>(effect: Effect.Effect<A, { readonly stderr: string }>) => Effect.runPromise(Effect.flip(effect))

describe("refusals", () => {
  it("refuses a workspace that does not provide @rsbuild/core, loudly", async () => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-none-"))
    const scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-scratch-"))
    try {
      await Fs.writeFile(NodePath.join(root, "package.json"), `{"name":"empty","private":true}\n`)
      await Fs.writeFile(NodePath.join(root, "rsbuild.config.mjs"), "export default {}\n")
      const error = await flipped(resolveGraph(
        { workspaceRoot: root, scratchDirectory: scratch, timeoutMs: 60_000 },
        { configPath: "rsbuild.config.mjs", entries: ["main.ts"], mode: "development" }
      ))
      expect(error.stderr).toContain("does not provide @rsbuild/core")
      expect(await Fs.readdir(scratch)).toEqual([])
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  it("removes scratch files when preparing the request fails", async () => {
    const scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-prepare-"))
    try {
      const entries = ["main.ts"]
      Object.defineProperty(entries, "0", {
        get: () => {
          throw new Error("request serialization failed")
        }
      })
      const error = await flipped(resolveGraph(
        { workspaceRoot: Os.tmpdir(), scratchDirectory: scratch },
        { configPath: "rsbuild.config.mjs", entries, mode: "development" }
      ))
      expect(error.stderr).toContain("request serialization failed")
      expect(await Fs.readdir(scratch)).toEqual([])
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })

  it("refuses a relative scratch directory", async () => {
    const error = await flipped(resolveGraph(
      { workspaceRoot: Os.tmpdir(), scratchDirectory: "relative/scratch" },
      { configPath: "rsbuild.config.mjs", entries: ["main.ts"], mode: "development" }
    ))
    expect(error.stderr).toContain("must be absolute")
  })
  it("refuses a relative scratch directory for a build too", async () => {
    const error = await flipped(runBuild(
      { workspaceRoot: Os.tmpdir(), scratchDirectory: "relative/scratch" },
      { configPath: "rsbuild.config.mjs", environment: "web", mode: "development", env: {}, outDirs: ["dist"] }
    ))
    expect(error.stderr).toBe("the bundler scratch directory must be absolute: relative/scratch")
  })

  it("truncates a refusal longer than the stderr tail to exactly the tail", async () => {
    const scratchDirectory = `relative/${"x".repeat(Exec.stderrTailLimit)}`
    const error = await flipped(resolveGraph(
      { workspaceRoot: Os.tmpdir(), scratchDirectory },
      { configPath: "rsbuild.config.mjs", entries: ["main.ts"], mode: "development" }
    ))
    expect(error.stderr).toHaveLength(Exec.stderrTailLimit)
    expect(error.stderr).toBe(
      `the bundler scratch directory must be absolute: ${scratchDirectory}`.slice(0, Exec.stderrTailLimit)
    )
  })

  it("reports a non-Error thrown while preparing the request as its string form", async () => {
    const scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-prepare-"))
    try {
      const entries = ["main.ts"]
      Object.defineProperty(entries, "0", {
        get: () => {
          throw "request entries are unreadable"
        }
      })
      const error = await flipped(resolveGraph(
        { workspaceRoot: Os.tmpdir(), scratchDirectory: scratch },
        { configPath: "rsbuild.config.mjs", entries, mode: "development" }
      ))
      expect(error.stderr).toBe("request entries are unreadable")
      expect(await Fs.readdir(scratch)).toEqual([])
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })
})

describe("rsbuild-mini end to end", () => {
  let workspace: string
  let scratch: string

  beforeAll(async () => {
    workspace = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-mini-"))
    scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-mini-scratch-"))
    await Fs.mkdir(NodePath.join(scratch, "rspack-cache"))
    await Fs.cp(fixture, workspace, { recursive: true })
    // The fixture runs the linked tree's own bundler, exactly as a real
    // workspace runs its own installed one.
    await Fs.symlink(modulesSource, NodePath.join(workspace, "node_modules"), "dir")
  })

  afterAll(async () => {
    await Fs.rm(workspace, { recursive: true, force: true })
    await Fs.rm(scratch, { recursive: true, force: true })
  })

  afterEach(async () => {
    expect(await Fs.readdir(scratch)).toEqual(["rspack-cache"])
  })

  const options = () => ({
    workspaceRoot: workspace,
    scratchDirectory: scratch,
    timeoutMs: 300_000
  })

  it("resolves the module graph deterministically and never writes into the workspace dist", async () => {
    const first = await Effect.runPromise(resolveGraph(options(), {
      configPath: "rsbuild.config.mjs",
      entries: ["main.ts"],
      mode: "development"
    }))
    expect(first.files.map((file) => file.path)).toEqual(["src/dep.ts", "src/main.ts"])
    for (const file of first.files) expect(file.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.moduleCount).toBeGreaterThanOrEqual(2)
    expect(first.graphDigest).toBe(BundlerTarget.graphDigest(first))
    // Resolution emits into scratch, not the workspace.
    expect(existsSync(NodePath.join(workspace, "dist"))).toBe(false)

    const second = await Effect.runPromise(resolveGraph(options(), {
      configPath: "rsbuild.config.mjs",
      entries: ["main.ts"],
      mode: "development"
    }))
    expect(second.files).toEqual(first.files)
    expect(second.packages).toEqual(first.packages)
    expect(second.graphDigest).toBe(first.graphDigest)
  }, 300_000)

  it("refuses an entry that matches no environment", async () => {
    const error = await flipped(resolveGraph(options(), {
      configPath: "rsbuild.config.mjs",
      entries: ["missing.tsx"],
      mode: "development"
    }))
    expect(error.stderr).toContain("matches no environment")
  }, 300_000)

  it("builds the web environment in development mode and produces the declared outDir", async () => {
    const result = await Effect.runPromise(runBuild(options(), {
      configPath: "rsbuild.config.mjs",
      environment: "web",
      mode: "development",
      env: {},
      outDirs: ["dist"]
    }))
    expect(result.exitCode).toBe(0)
    const produced = await Fs.readdir(NodePath.join(workspace, "dist"), { recursive: true })
    expect(produced.length).toBeGreaterThan(0)
    const bundle = produced.find((name) => String(name).endsWith("index.js"))
    expect(bundle).toBeDefined()
    const text = await Fs.readFile(NodePath.join(workspace, "dist", String(bundle)), "utf8")
    expect(text).toContain("rsbuild-mini")
  }, 300_000)

  it("refuses a green build whose declared outDir was not created", async () => {
    const error = await flipped(runBuild(options(), {
      configPath: "rsbuild.config.mjs",
      environment: "web",
      mode: "development",
      env: {},
      outDirs: ["not-the-dist"]
    }))
    expect(error.stderr).toContain("without creating its declared outDirs")
  }, 300_000)

  it("refuses an environment the config does not declare", async () => {
    const error = await flipped(runBuild(options(), {
      configPath: "rsbuild.config.mjs",
      environment: "server",
      mode: "production",
      env: {},
      outDirs: ["dist"]
    }))
    expect(error.stderr).toContain("is not declared")
  }, 300_000)

  it("includes ..foo modules and hashes their bytes while excluding a real parent escape", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-outside-"))
    const entryPath = NodePath.join(workspace, "src/main.ts")
    const original = await Fs.readFile(entryPath, "utf8")
    const insidePath = NodePath.join(workspace, "..foo/value.ts")
    try {
      await Fs.mkdir(NodePath.dirname(insidePath))
      await Fs.writeFile(insidePath, "export const value = \"inside-before\"\n")
      await Fs.writeFile(NodePath.join(outside, "value.ts"), "export const value = \"outside\"\n")
      const outsideImport = NodePath.relative(NodePath.dirname(entryPath), NodePath.join(outside, "value.ts"))
        .split(NodePath.sep).join("/")
      await Fs.writeFile(
        entryPath,
        [
          "import { value as inside } from \"../..foo/value.ts\"",
          `import { value as outside } from ${JSON.stringify(outsideImport)}`,
          "document.title = inside + outside"
        ].join("\n")
      )
      const payload = { configPath: "rsbuild.config.mjs", entries: ["main.ts"], mode: "development" as const }
      const first = await Effect.runPromise(resolveGraph(options(), payload))
      expect(first.files.map((file) => file.path)).toEqual(["..foo/value.ts", "src/main.ts"])
      // The outside module participates in the compile, but is not a workspace file.
      expect(first.moduleCount).toBeGreaterThanOrEqual(3)
      await Fs.writeFile(insidePath, "export const value = \"inside-after\"\n")
      const second = await Effect.runPromise(resolveGraph(options(), payload))
      expect(second.files.map((file) => file.path)).toEqual(["..foo/value.ts", "src/main.ts"])
      expect(second.files.find((file) => file.path === "..foo/value.ts")?.digest)
        .not.toBe(first.files.find((file) => file.path === "..foo/value.ts")?.digest)
      expect(second.graphDigest).not.toBe(first.graphDigest)
    } finally {
      await Fs.writeFile(entryPath, original)
      await Fs.rm(NodePath.dirname(insidePath), { recursive: true, force: true })
      await Fs.rm(outside, { recursive: true, force: true })
    }
  }, 300_000)

  it.each(["resolve", "build"] as const)("cleans scratch when a %s response is missing", async (kind) => {
    const configPath = "no-response.config.mjs"
    await Fs.writeFile(NodePath.join(workspace, configPath), "process.exit(0)\nexport default {}\n")
    try {
      const effect: Effect.Effect<unknown, { readonly stderr: string }> = kind === "resolve"
        ? resolveGraph(options(), { configPath, entries: ["main.ts"], mode: "development" })
        : runBuild(options(), { configPath, environment: "web", mode: "development", env: {}, outDirs: ["dist"] })
      const error = await flipped(effect)
      expect(error.stderr).toContain("without writing its response file")
    } finally {
      await Fs.rm(NodePath.join(workspace, configPath), { force: true })
    }
  }, 120_000)

  it.each(["resolve", "build"] as const)("cleans scratch after interrupting a %s child", async (kind) => {
    const configPath = "waiting.config.mjs"
    const readyPath = NodePath.join(workspace, "child-ready")
    await Fs.writeFile(
      NodePath.join(workspace, configPath),
      [
        "import { writeFileSync } from \"node:fs\"",
        `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid))`,
        "await new Promise(() => setInterval(() => {}, 1000))",
        "export default {}"
      ].join("\n")
    )
    const effect: Effect.Effect<unknown, { readonly stderr: string }> = kind === "resolve"
      ? resolveGraph(options(), { configPath, entries: ["main.ts"], mode: "development" })
      : runBuild(options(), { configPath, environment: "web", mode: "development", env: {}, outDirs: ["dist"] })
    const fiber = Effect.runFork(effect)
    try {
      // The child creates the file before it writes its pid into it.
      await expect.poll(() => existsSync(readyPath) && readFileSync(readyPath, "utf8") !== "", { timeout: 60_000 })
        .toBe(true)
      const pid = Number(readFileSync(readyPath, "utf8"))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(runnable(pid)).toBe(false)
      expect(await Fs.readdir(scratch)).toEqual(["rspack-cache"])
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
      await Fs.rm(readyPath, { force: true })
      await Fs.rm(NodePath.join(workspace, configPath), { force: true })
    }
  }, 120_000)
  // Effect 4.0.4 removes a typed failure from an interrupted fiber's cause once
  // the unwind passes a recovery handler, as every caller's error mapping is.
  // A scratch tree the runner could not remove must still reach the caller.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["resolve", "build"] as const)(
    "reports a scratch tree it could not remove after interrupting a %s child",
    async (kind) => {
      const configPath = "waiting-locked.config.mjs"
      const readyPath = NodePath.join(workspace, "child-ready")
      await Fs.writeFile(
        NodePath.join(workspace, configPath),
        [
          "import { writeFileSync } from \"node:fs\"",
          `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid))`,
          "await new Promise(() => setInterval(() => {}, 1000))",
          "export default {}"
        ].join("\n")
      )
      const effect: Effect.Effect<unknown, { readonly stderr: string }> = kind === "resolve"
        ? resolveGraph(options(), { configPath, entries: ["main.ts"], mode: "development" })
        : runBuild(options(), { configPath, environment: "web", mode: "development", env: {}, outDirs: ["dist"] })
      const fiber = Effect.runFork(effect.pipe(Effect.mapError((error) => error)))
      try {
        await expect.poll(() => existsSync(readyPath) && readFileSync(readyPath, "utf8") !== "", { timeout: 60_000 })
          .toBe(true)
        // The per-call tree lives in the scratch directory; a read-only scratch
        // directory makes removing it fail.
        await Fs.chmod(scratch, 0o500)
        await Effect.runPromise(Fiber.interrupt(fiber))
        const exit = await Effect.runPromise(Fiber.await(fiber))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          const reported = exit.cause.reasons.flatMap((reason) =>
            reason._tag === "Die" ? [reason.defect] : reason._tag === "Fail" ? [reason.error] : []
          )
          expect(reported).toContainEqual(expect.objectContaining({
            _tag: "smithers-build/ExecError",
            stderr: expect.stringMatching(/EACCES|EPERM/)
          }))
        }
      } finally {
        await Fs.chmod(scratch, 0o700)
        await Effect.runPromise(Fiber.interrupt(fiber))
        for (const entry of await Fs.readdir(scratch)) {
          if (entry !== "rspack-cache") await Fs.rm(NodePath.join(scratch, entry), { recursive: true, force: true })
        }
        await Fs.rm(readyPath, { force: true })
        await Fs.rm(NodePath.join(workspace, configPath), { force: true })
      }
    },
    120_000
  )

  /** A config that, once the runner loads it, plays the child's response step itself and exits green. */
  const respondingConfig = (configPath: string, respond: string) =>
    Fs.writeFile(
      NodePath.join(workspace, configPath),
      [
        "import * as fs from \"node:fs\"",
        "const { responsePath } = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\"))",
        respond,
        "process.exit(0)",
        "export default {}"
      ].join("\n")
    )

  it("refuses a response path the child left as something other than a regular file", async () => {
    const configPath = "directory-response.config.mjs"
    await respondingConfig(configPath, "fs.mkdirSync(responsePath)")
    try {
      const error = await flipped(resolveGraph(options(), { configPath, entries: ["main.ts"], mode: "development" }))
      expect(error.stderr).toBe("the bundler response exceeds 134217728 bytes")
    } finally {
      await Fs.rm(NodePath.join(workspace, configPath), { force: true })
    }
  }, 120_000)

  it.each([
    ["unsorted", ["zod", "effect"], "\"effect\""],
    ["duplicated", ["effect", "effect"], "\"effect\""]
  ])("refuses %s package names in a resolve response", async (_name, packages, at) => {
    const configPath = "unsorted-response.config.mjs"
    const response = { kind: "resolve", environments: ["web"], moduleCount: 0, files: [], packages }
    await respondingConfig(configPath, `fs.writeFileSync(responsePath, ${JSON.stringify(JSON.stringify(response))})`)
    try {
      const error = await flipped(resolveGraph(options(), { configPath, entries: ["main.ts"], mode: "development" }))
      expect(error.stderr).toBe(`the bundler response package names are not sorted and unique at ${at}`)
    } finally {
      await Fs.rm(NodePath.join(workspace, configPath), { force: true })
    }
  }, 120_000)
})
