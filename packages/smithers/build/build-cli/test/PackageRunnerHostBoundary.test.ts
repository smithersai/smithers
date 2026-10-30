import * as Exec from "@smthrs/targets/Exec"
import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import {
  executeEffect,
  ExecutionServices,
  executionServicesLive,
  reviewFailureText
} from "../src/internal/PackageRunner.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { runnerFixture as fixture } from "./helpers/PackageRunnerFixture.ts"

describe("host execution boundaries", () => {
  it("executes a real Bun template with resolved tool constants", async () => {
    const { root, options, plan } = await fixture(`export const Package = S.Package({ targets: {
      command: S.Shell.Run({ bun: "await $\u0060\u0024{shell} -c 'printf actual-bun > observed.txt'\u0060", using: { shell: S.Host.bin("sh") }, sandbox: "none" })
    } })`)
    const result = await PackageExec.execute(plan, options)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await Fs.readFile(Path.join(root, "observed.txt"), "utf8")).toBe("actual-bun")
  })

  it.each([false, true])(
    "keeps overlay file products private until the build settles (failure=%s)",
    async (failure) => {
      const { root, options, plan } = await fixture(
        `
const base = S.Filegroup({ srcs: [S.file("//input.txt")] })
const overlay = S.Overlay({ base, replace: { "input.txt": S.file("//replacement.txt") } })
const command = S.Shell.Build({ shell: ${
          JSON.stringify(`cp input.txt result.txt${failure ? "; exit 41" : ""}`)
        }, data: [overlay], outFiles: ["result.txt"], sandbox: "none" })
export const Package = S.Package({ targets: { base, overlay, command } })`,
        { "input.txt": "original", "replacement.txt": "replacement" }
      )
      const first = await PackageExec.execute(plan, options)
      expect(first.ok, JSON.stringify(first)).toBe(!failure)
      expect(await Fs.readFile(Path.join(root, "input.txt"), "utf8")).toBe("original")
      if (failure) {
        await expect(Fs.stat(Path.join(root, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      } else {
        expect(await Fs.readFile(Path.join(root, "result.txt"), "utf8")).toBe("replacement")
        await Fs.unlink(Path.join(root, "result.txt"))
        const second = await PackageExec.execute(plan, options)
        expect(second.results.find((result) => result.label === "//:command")?.status).toBe("hit")
        expect(await Fs.readFile(Path.join(root, "result.txt"), "utf8")).toBe("replacement")
      }
    }
  )

  it("refuses a write whose workspace disappears after cache acquisition", async () => {
    const { root, options } = await fixture(`export const Package = S.Package({ targets: {
      command: S.Shell.Diff({ shell: "touch launched", changes: ["launched"] })
    } })`)
    const moved = `${root}-moved`
    try {
      const writePlan = await PackageExec.plan({ ...options, write: true })
      const result = await Effect.runPromise(
        executeEffect(writePlan, { ...options, write: true }).pipe(
          Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            cache: (settings) =>
              Effect.gen(function*() {
                const store = yield* executionServicesLive.cache(settings)
                yield* Effect.promise(() => Fs.rename(root, moved))
                return store
              })
          })
        )
      )
      expect(result.ok).toBe(false)
      expect(result.results[0]?.error).toContain("the write-set guard cannot restore the gitignored tree")
      await expect(Fs.stat(Path.join(moved, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await Fs.rename(moved, root)
    }
  })
})

describe("nested agent data", () => {
  it("passes shared nested Filegroup sources once to the real scripted session", async () => {
    const { root, options, plan } = await fixture(
      `
const leaf = S.Filegroup({ srcs: [S.file("//input.txt")] })
const left = S.Filegroup({ srcs: [leaf] })
const right = S.Filegroup({ srcs: [leaf] })
const data = S.Filegroup({ srcs: [left, right] })
const command = S.Agent.Diff({ prompt: S.file("//prompt.md"), data: [data], changes: ["out/**"], gates: [], maxRounds: 1 })
export const Package = S.Package({ targets: { leaf, left, right, data, command } })`,
      { "input.txt": "source", "prompt.md": "Make one file." }
    )
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/result.txt", contents: "settled" }] }]
    })
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(
        Effect.provideService(ExecutionServices, { ...executionServicesLive, sessions: () => scripted })
      )
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(scripted.requests()).toHaveLength(1)
    expect(scripted.requests()[0]?.prompt.match(/--- input\.txt ---/g)).toHaveLength(1)
    expect(scripted.requests()[0]?.prompt).toContain("source")
    expect(await Fs.readFile(Path.join(root, "out/result.txt"), "utf8")).toBe("settled")
  })
})

// Exercise the executor's admitted process plans independently of optional
// toolchain discovery. Every successful process uses the real shell boundary;
// only the failing host is replaced through its Effect service.
describe("admitted formatter and generator execution", () => {
  it.each(["Go.Lint", "Go.Generate", "Foundry.Fmt"] as const)("honors mode and host failures for %s", async (rule) => {
    for (const mode of ["check", "write"] as const) {
      for (const failed of [false, true]) {
        const shell = mode === "write" ? "printf changed > output.txt" : "true"
        const { root, options, plan } = await fixture(
          `export const Package = S.Package({ targets: {
          command: S.Shell.Diff({ shell: ${JSON.stringify(shell)}, changes: ["output.txt"], sandbox: "none" })
        } })`,
          { "output.txt": "original" }
        )
        const node = {
          ...plan.nodes.get("//:command")!,
          rule,
          mode,
          cacheable: true
        } as unknown as PackageExec.PackageNode
        const admitted = { ...plan, nodes: new Map([[node.label, node]]), workList: [node] }
        const fault = Exec.ExecError.make({
          _tag: "smithers-build/ExecError",
          argv: ["sh"],
          cwd: ".",
          code: "exit_status",
          exitCode: 71,
          stdout: "",
          stderr: "formatter host failed"
        })
        const services = {
          ...executionServicesLive,
          exec: failed ? () => Effect.fail(fault) : executionServicesLive.exec
        }
        const first = await Effect.runPromise(
          executeEffect(admitted, options).pipe(Effect.provideService(ExecutionServices, services))
        )
        expect(first.ok, JSON.stringify(first)).toBe(!failed)
        expect(await Fs.readFile(Path.join(root, "output.txt"), "utf8")).toBe(
          mode === "write" && !failed ? "changed" : "original"
        )
        if (failed) {
          expect(first.results[0]?.error).toContain("formatter host failed")
        } else if (rule === "Foundry.Fmt" && mode === "check") {
          const second = await PackageExec.execute(admitted, options)
          expect(second.results[0]?.status).toBe("hit")
        }
      }
    }
  })
})

describe("admitted cargo process plans", () => {
  it.each(["delivered", "missing", "host failure", "write"] as const)(
    "settles a %s fetch without inventing products",
    async (kind) => {
      const { root, options, plan } = await fixture(
        `export const Package = S.Package({ targets: {
      command: S.Shell.Run({ shell: "printf run >> executions", sandbox: "none" })
    } })`,
        kind === "missing" ? {} : { "download/metadata": "delivered" }
      )
      const original = plan.nodes.get("//:command")!
      const node = {
        ...original,
        rule: "Cargo.Fetch",
        mode: kind === "write" ? "write" : "check",
        cacheable: true,
        writeSet: ["executions"],
        lane: {
          kind: "cargo",
          commands: [original.argv, original.argv],
          outFiles: ["download/metadata"],
          crates: [],
          binaries: []
        }
      } as unknown as PackageExec.PackageNode
      const admitted = { ...plan, nodes: new Map([[node.label, node]]), workList: [node] }
      const notes: Array<string> = []
      const result = await Effect.runPromise(
        executeEffect(admitted, { ...options, log: (line) => notes.push(line) }).pipe(
          Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            exec: kind === "host failure"
              ? () => Effect.die(new Error("cargo host failed"))
              : executionServicesLive.exec
          })
        )
      )
      expect(result.ok, JSON.stringify(result)).toBe(kind === "delivered" || kind === "write")
      if (kind === "host failure") {
        expect(result.results[0]?.error).toBe("cargo host failed")
        await expect(Fs.stat(Path.join(root, "executions"))).rejects.toMatchObject({ code: "ENOENT" })
      } else {
        expect(await Fs.readFile(Path.join(root, "executions"), "utf8")).toBe("runrun")
        if (kind === "missing") {
          expect(result.results[0]?.error).toBe(
            "the fetch did not deliver its declared file: download/metadata"
          )
        } else {
          expect(notes.join("\n")).toContain("ran cargo over 2 crate(s)")
          expect((await PackageExec.execute(admitted, options)).results[0]?.status).toBe("hit")
          expect(await Fs.readFile(Path.join(root, "executions"), "utf8")).toBe("runrun")
        }
      }
    }
  )
})

describe("review failure fallback", () => {
  it.each([{}, { findings: "unreadable" }])("reports a typed failure without usable findings (%j)", async (fields) => {
    expect(reviewFailureText({ _tag: "smithers-build/FindingsError", failOn: "error", ...fields }))
      .toBe("0 review finding(s); failing at error")
  })
})

describe("model review result shapes", () => {
  it.each([null, 7])("keeps an ordinary body success without inventing findings from %j", async (value) => {
    const { options, plan } = await fixture(`
import * as Target from "@smthrs/targets/Target"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
const command = Target.make("LlmLint", {
  attrs: Schema.Struct({}), kinds: ["lint"], success: Schema.Unknown,
  implementation: () => Node.succeed(${JSON.stringify(value)})
})({})
export const Package = S.Package({ targets: { command } })`)
    const notes: Array<string> = []
    const result = await PackageExec.execute(plan, { ...options, log: (line) => notes.push(line) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.results[0]?.status).toBe("ran")
    expect(notes.join("\n")).not.toContain("review finding(s)")
  })
})

describe("scratch I/O failure", () => {
  it("settles a scratch write error before reporting failure and preserves the live tree", async () => {
    const { root, options, plan } = await fixture(
      `export const Package = S.Package({ targets: {
      command: S.Generate({ bin: S.Host.bin("sh"), args: ["-c", "printf changed"], stdout: "generated.txt" })
    } })`,
      { "generated.txt": "original" }
    )
    let invalidated: string | undefined
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          exec: (config, payload) =>
            executionServicesLive.exec(config, payload).pipe(Effect.tap(() =>
              Effect.promise(async () => {
                expect(config.workspaceRoot).not.toBe(root)
                invalidated = config.workspaceRoot
                await Fs.rm(config.workspaceRoot, { recursive: true, force: true })
                await Fs.writeFile(config.workspaceRoot, "unavailable scratch directory")
              })
            ))
        })
      )
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toMatch(/EEXIST|ENOTDIR/)
    expect(invalidated).toBeDefined()
    await expect(Fs.stat(invalidated!)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Fs.readFile(Path.join(root, "generated.txt"), "utf8")).toBe("original")
  })
})

describe("joined I/O cancellation ownership", () => {
  it.each(["resolve", "reject"] as const)("awaits a cancelled host operation that later %ss", async (completion) => {
    const { options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "true", sandbox: "none" }) } })`
    )
    const node = { ...plan.nodes.get("//:command")!, rule: "Memory.Retain" } as PackageExec.PackageNode
    const entered = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<Awaited<ReturnType<typeof executionServicesLive.retain>>>()
    let settled = false
    let closed = false
    const controller = new AbortController()
    const running = Effect.runPromiseExit(
      executeEffect({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, {
        ...options,
        signal: controller.signal
      }).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          retain: ({ signal }) => {
            signal!.addEventListener("abort", () => interrupted.resolve(), { once: true })
            entered.resolve()
            return finished.promise.finally(() => {
              settled = true
            })
          },
          cache: (settings) =>
            executionServicesLive.cache(settings).pipe(Effect.map((store) => ({
              ...store,
              close: async () => {
                expect(settled).toBe(true)
                await store.close()
                closed = true
              }
            })))
        })
      ),
      { signal: controller.signal }
    )
    await entered.promise
    controller.abort()
    await interrupted.promise
    expect(settled).toBe(false)
    expect(closed).toBe(false)
    if (completion === "resolve") finished.resolve({ binary: "host", facts: [] })
    else finished.reject(new Error("cancelled host failed while settling"))
    const result = await running
    expect(result._tag).toBe("Failure")
    expect(settled).toBe(true)
    expect(closed).toBe(true)
  })
})

describe("acquired service output", () => {
  it("keeps service output available with an anonymous cache declaration", async () => {
    const { root, options, plan } = await fixture(`
const service = S.Shell.Serve({ shell: "printf ready > ready; exec sleep 60", readiness: { exec: ["/bin/sh", "-c", "test -f ready"], timeout: "20s" }, sandbox: "none" })
const command = S.Shell.Run({ shell: "grep -q ready ready", services: [service], sandbox: "none" })
export const Package = S.Package({ targets: { service, command } })`)
    const notes: Array<string> = []
    const result = await PackageExec.execute(plan, {
      ...options,
      log: (line) => notes.push(line),
      remoteCache: {
        endpoint: "http://127.0.0.1:1",
        credentials: { _tag: "anonymous", writeTokenEnv: "SMTHRS_TEST_UNUSED_CACHE_TOKEN" },
        readToken: () => undefined,
        writeToken: () => undefined,
        publishNamespace: undefined
      }
    })
    expect(result.ok, notes.join("\n")).toBe(true)
    expect(notes.join("\n")).toContain("service //:service: ready")
    expect(await Fs.readFile(Path.join(root, "ready"), "utf8")).toBe("ready")
  })
})

describe("declared Rust host trees", () => {
  it.each([undefined, "Cargo.toml", "crate/Cargo.toml"])(
    "preserves rebuildable artifacts for workspace %s",
    async (workspace) => {
      const target = workspace?.startsWith("crate/") ? "crate/target" : "target"
      const { root, options } = await fixture(
        `export const Package = S.Package({ targets: {
      command: S.Shell.Diff({ shell: ${
          JSON.stringify(`printf changed > owned.txt; printf compiled > ${target}/artifact`)
        }, changes: ["owned.txt"], sandbox: "none" })
    } })`,
        {
          "owned.txt": "original",
          ".gitignore": "target\ncrate/target\n.flows\n",
          [target + "/artifact"]: "previous",
          [workspace ?? "Cargo.toml"]: "[workspace]\nmembers = []\n"
        },
        `toolchains: [S.Rust.Toolchain({ channel: "stable", ${
          workspace === undefined ? "" : `workspace: S.file(${JSON.stringify("//" + workspace)}),`
        } })]`
      )
      const writeOptions = { ...options, write: true }
      const result = await PackageExec.execute(await PackageExec.plan(writeOptions), writeOptions)
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(await Fs.readFile(Path.join(root, "owned.txt"), "utf8")).toBe("changed")
      expect(await Fs.readFile(Path.join(root, target, "artifact"), "utf8")).toBe("compiled")
    }
  )
})

describe("undeclared dependency links", () => {
  it.each([false, true])("refuses a dependency link changed after planning (existing=%s)", async (existing) => {
    const { root, options } = await fixture(`export const Package = S.Package({ targets: {
      command: S.Shell.Run({ shell: "cat node_modules/dependency.txt" })
    } })`)
    const external = `${root}-module-roots`
    for (const name of ["original", "unrelated"]) {
      await Fs.mkdir(Path.join(external, name, "node_modules"), { recursive: true })
      await Fs.writeFile(Path.join(external, name, "node_modules/dependency.txt"), name)
    }
    try {
      if (existing) await Fs.symlink(Path.join(external, "original/node_modules"), Path.join(root, "node_modules"))
      const plan = await PackageExec.plan(options)
      if (existing) await Fs.unlink(Path.join(root, "node_modules"))
      await Fs.symlink(Path.join(external, "unrelated/node_modules"), Path.join(root, "node_modules"))
      const result = await PackageExec.execute(plan, options)
      expect(result.ok, JSON.stringify(result)).toBe(false)
      expect(result.results[0]?.error).toContain("workspace read resolves outside its declared root")
    } finally {
      await Fs.rm(external, { recursive: true, force: true })
    }
  })

  it("requires a declared installation before granting an external node_modules read", async () => {
    const { root, options, plan } = await fixture(
      `export const Package = S.Package({ targets: {
      command: S.Shell.Run({ shell: "cat node_modules/dependency.txt" })
    } })`,
      {},
      `toolchains: [S.Rust.Toolchain({ channel: "stable" })]`,
      false
    )
    const external = `${root}-host`
    await Fs.mkdir(Path.join(external, "node_modules"), { recursive: true })
    await Fs.writeFile(Path.join(external, "node_modules/dependency.txt"), "external dependency")
    try {
      const result = await Effect.runPromise(
        executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          cache: (settings) =>
            executionServicesLive.cache(settings).pipe(
              Effect.tap(() =>
                Effect.promise(() => Fs.symlink(Path.join(external, "node_modules"), Path.join(root, "node_modules")))
              )
            )
        }))
      )
      expect(result.ok, JSON.stringify(result)).toBe(false)
      expect(result.results[0]?.error).toContain("workspace read resolves outside its declared root")
    } finally {
      await Fs.rm(external, { recursive: true, force: true })
    }
  })
})
