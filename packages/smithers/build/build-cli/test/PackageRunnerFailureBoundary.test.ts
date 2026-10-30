import * as Exec from "@smthrs/targets/Exec"
import * as LlmLint from "@smthrs/targets/LlmLint"
import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { runnerFixture as fixture } from "./helpers/PackageRunnerFixture.ts"

const voidOutput = `
import * as Target from "@smthrs/targets/Target"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
const command = Target.make("StoredVoid", {
  attrs: Schema.Struct({}), kinds: ["build"], success: Schema.Undefined, cache: true,
  outputs: () => ({ cwd: ".", paths: ["product.txt"] }),
  implementation: () => Node.map(Node.succeed(null), () => undefined)
})({})
export const Package = S.Package({ targets: { command } })`

describe("declared result cache validation", () => {
  it.each(
    [
      "null",
      "primitive",
      "missing result",
      "invalid manifest",
      "invalid envelope",
      "wrong schema",
      "legacy envelope",
      "invalid declaration"
    ] as const
  )("rejects %s without claiming an output hit", async (fault) => {
    const { root, options, plan } = await fixture(voidOutput, { "product.txt": "product", "unrelated.txt": "keep" })
    expect((await PackageExec.execute(plan, options)).ok).toBe(true)
    const node = plan.nodes.get("//:command")!
    const cache = await Effect.runPromise(
      executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" })
    )
    try {
      const entry = (await cache.get(node.keyPreview))!
      const stored = entry.output as { kind: string; result: unknown; manifests: unknown; files: unknown }
      const output = fault === "null" ? null : fault === "primitive" ?
        7
        : fault === "missing result" ?
        { kind: "target-outputs", manifests: [], files: [] }
        : fault === "invalid manifest" ?
        { ...stored, manifests: "invalid" }
        : fault === "invalid envelope" ?
        { ...stored, result: { unexpected: true } }
        : fault === "wrong schema" ?
        { ...stored, result: { _tag: "smithers-build/cache-output/value-v1", value: 7 } }
        : fault === "legacy envelope"
        ? stored.result
        : stored
      await Fs.writeFile(
        Path.join(root, ".flows/cache", node.keyPreview.slice(0, 2), `${node.keyPreview}.json`),
        JSON.stringify({ ...entry, output })
      )
    } finally {
      await cache.close()
    }
    await Fs.unlink(Path.join(root, "product.txt"))
    const admitted = fault === "invalid declaration"
      ? { ...node, declaredOutputs: { cwd: ".", paths: ["../unrelated.txt"] } } as unknown as PackageExec.PackageNode
      : node
    let bodies = 0
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, admitted]]), workList: [admitted] }, options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          target: (...args) => {
            bodies++
            return executionServicesLive.target(...args)
          }
        })
      )
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.status).toBe("failed")
    expect(result.results[0]?.error).toContain(
      fault === "invalid declaration" ? "escapes the workspace" : "did not produce its declared output"
    )
    expect(bodies).toBe(fault === "invalid declaration" ? 0 : 1)
    expect(await Fs.readFile(Path.join(root, "unrelated.txt"), "utf8")).toBe("keep")
  })
})

describe("file-set operand failure", () => {
  it("reports a missing graph as a failure rather than an empty file set", async () => {
    const { options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Test({ shell: "true" }) } })`
    )
    const node = {
      ...plan.nodes.get("//:command")!,
      rule: "Test",
      lane: {
        kind: "files-test",
        left: { kind: "bundler-files", label: "//:absent" },
        right: { kind: "sources", sources: [] }
      }
    } as unknown as PackageExec.PackageNode
    const result = await PackageExec.execute(
      { ...plan, nodes: new Map([[node.label, node]]), workList: [node] },
      options
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toBe("bundler graph //:absent settled no result in this invocation")
  })
})

describe("output stat failures", () => {
  it.each(["symlink loop", "parent file"] as const)("fails a produced output replaced by a %s", async (fault) => {
    const { root, options, plan } = await fixture(`export const Package = S.Package({ targets: {
      command: S.Shell.Build({ shell: "mkdir -p sealed; printf generated > sealed/file", outFiles: ["sealed/file"], sandbox: "none" })
    } })`)
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        exec: (settings, payload) =>
          executionServicesLive.exec(settings, payload).pipe(Effect.tap(() =>
            Effect.promise(async () => {
              if (fault === "symlink loop") {
                await Fs.unlink(Path.join(root, "sealed/file"))
                await Fs.symlink("file", Path.join(root, "sealed/file"))
              } else {
                await Fs.rm(Path.join(root, "sealed"), { recursive: true })
                await Fs.writeFile(Path.join(root, "sealed"), "unavailable directory")
              }
            })
          ))
      }))
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain(fault === "symlink loop" ? "ELOOP" : "did not produce declared outputs")
  })
})

describe("admitted sandbox plans", () => {
  it("runs a real confined write within its admitted directory", async () => {
    const { root, options } = await fixture(
      `export const Package = S.Package({ targets: {
      command: S.Shell.Diff({ shell: "printf accepted > owned.txt", changes: ["owned.txt"] })
    } })`,
      { "owned.txt": "original", "unrelated.txt": "preserve" }
    )
    const writeOptions = { ...options, write: true }
    const result = await PackageExec.execute(await PackageExec.plan(writeOptions), writeOptions)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await Fs.readFile(Path.join(root, "owned.txt"), "utf8")).toBe("accepted")
    expect(await Fs.readFile(Path.join(root, "unrelated.txt"), "utf8")).toBe("preserve")
  })

  it("refuses a write mount whose directory became a file", async () => {
    const { root, options, plan } = await fixture(
      `export const Package = S.Package({ targets: {
      command: S.Shell.Diff({ shell: "touch launched", changes: ["launched"] })
    } })`,
      { blocked: "original" }
    )
    const original = plan.nodes.get("//:command")!
    const node = { ...original, mode: "write", cleanOutDirs: ["blocked"] } as unknown as PackageExec.PackageNode
    const result = await PackageExec.execute(
      { ...plan, nodes: new Map([[node.label, node]]), workList: [node] },
      options
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toMatch(/not a directory|EEXIST|confinement/)
    expect(await Fs.readFile(Path.join(root, "blocked"), "utf8")).toBe("original")
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("approval plan rechecks", () => {
  it("rechecks a CI target with the automatic verb and refuses a removed approval", async () => {
    const { options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "true" }) } })`
    )
    const original = plan.nodes.get("//:command")!
    const node = { ...original, approval: "a".repeat(64) } as PackageExec.PackageNode
    const result = await PackageExec.execute({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, {
      ...options,
      verb: "ci"
    })
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("is now unplanned")
  })

  it("refuses safely when a closure recheck loses its cache directory", async () => {
    const { root, options, plan } = await fixture(
      `const closure = S.ImportClosure({ entries: [S.file("//src.ts")] })
const command = S.Shell.Test({ shell: "true", data: [closure], sandbox: "none" })
export const Package = S.Package({ targets: { closure, command } })`,
      { "src.ts": "export const value = 1\n" }
    )
    const original = plan.nodes.get("//:command")!
    const node = { ...original, dependencies: [], approval: "b".repeat(64) } as PackageExec.PackageNode
    const notes: Array<string> = []
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, {
        ...options,
        log: (line) => notes.push(line)
      }).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          cache: (settings) =>
            executionServicesLive.cache(settings).pipe(Effect.tap(() =>
              Effect.promise(async () => {
                await Fs.rename(Path.join(root, ".flows/cache"), Path.join(root, "held-cache"))
                await Fs.writeFile(Path.join(root, ".flows/cache"), "cache unavailable")
              })
            ))
        })
      )
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("approval required")
    expect(notes.join("\n")).not.toContain("plan-time cache unavailable")
  })
})

describe("admitted process host failures", () => {
  it.each(
    [
      "Npm.Pack",
      "Changesets.Version",
      "Npm.Published",
      "Size.Budgets",
      "Go.Binary",
      "Go.ModDownload",
      "Go.Test",
      "Go.Fuzz"
    ] as const
  )("does not cache a failed %s process", async (rule) => {
    const { root, options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "touch launched", sandbox: "none" }) } })`
    )
    const node = { ...plan.nodes.get("//:command")!, rule, cacheable: true } as unknown as PackageExec.PackageNode
    let invoked = 0
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          exec: (_settings, payload) => {
            invoked++
            return Effect.fail(
              Exec.ExecError.make({
                _tag: "smithers-build/ExecError",
                argv: payload.argv,
                cwd: payload.cwd,
                code: "exit_status",
                exitCode: 71,
                stdout: "",
                stderr: "host process unavailable"
              })
            )
          }
        })
      )
    )
    expect(invoked).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("host process unavailable")
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
    const cache = await Effect.runPromise(
      executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" })
    )
    try {
      expect(await cache.get(node.keyPreview)).toBeNull()
    } finally {
      await cache.close()
    }
  })
})

describe("admitted outward and value plans", () => {
  it.each(["Npm.Publish", "Changesets.Publish", "Github.Pr", "Github.Release", "Github.Pages"] as const)(
    "refuses an admitted %s plan before any process",
    async (rule) => {
      const { root, options, plan } = await fixture(
        `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "touch launched", sandbox: "none" }) } })`
      )
      const node = { ...plan.nodes.get("//:command")!, rule } as unknown as PackageExec.PackageNode
      const result = await PackageExec.execute(
        { ...plan, nodes: new Map([[node.label, node]]), workList: [node] },
        options
      )
      expect(result.results).toMatchObject([{ status: "failed", error: `${rule}: not implemented by this executor` }])
      await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  )

  it("refuses a service plan without a service definition", async () => {
    const { options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "true" }) } })`
    )
    const node = { ...plan.nodes.get("//:command")!, rule: "Shell.Serve" } as unknown as PackageExec.PackageNode
    expect(
      (await PackageExec.execute({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, options)).results
    )
      .toMatchObject([{ status: "failed", error: "service //:command is not a service target" }])
  })

  it("settles a Go package selector as a value without executing a program", async () => {
    const { root, options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "touch launched", sandbox: "none" }) } })`
    )
    const node = { ...plan.nodes.get("//:command")!, rule: "Go.Packages" } as unknown as PackageExec.PackageNode
    expect(
      (await PackageExec.execute({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, options)).results
    )
      .toMatchObject([{ status: "ran" }])
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("review and commit host faults", () => {
  it("retains typed review findings in the target failure", async () => {
    const { options, plan } = await fixture(voidOutput, { "product.txt": "original" })
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        target: () =>
          Effect.fail(
            new LlmLint.FindingsError({
              failOn: "error",
              findings: [{ file: "src/input.ts", line: 3, severity: "error", message: "host finding" }]
            })
          )
      }))
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("1 review finding(s); failing at error")
    expect(result.results[0]?.error).toContain("src/input.ts:3 error: host finding")
  })

  it("retains an unexpected commit host failure without claiming a commit", async () => {
    const { options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Git.Commit({ gates: [], message: "chore: never" }) } })`
    )
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        commit: () => Effect.runPromise(Effect.fail(new Error("commit host unavailable")))
      }))
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toBe("commit host unavailable")
  })
})

describe("markdown execution boundary", () => {
  it.each(["missing context", "fragments", "missing compiler"] as const)("settles a page with %s", async (fault) => {
    const { root, options, plan } = await fixture(
      `export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "true", sandbox: "none" }) } })`,
      {
        "README.md": fault === "fragments" ? "```ts fragment\nvalue()\n```\n" : "```ts\nexport const value = 1\n```\n",
        "context.md": "```ts title=context.ts\nexport const context = 1\n```\n"
      }
    )
    const node = {
      ...plan.nodes.get("//:command")!,
      rule: "Markdown.CodeBlocks",
      cacheable: true,
      argv: fault === "missing compiler" ? undefined : plan.nodes.get("//:command")!.argv,
      lane: {
        kind: "markdown-code-blocks",
        file: "README.md",
        context: fault === "missing context" ? ["context.md"] : [],
        languages: ["ts"]
      }
    } as unknown as PackageExec.PackageNode
    let executions = 0
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, node]]), workList: [node] }, options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          cache: (settings) =>
            executionServicesLive.cache(settings).pipe(Effect.tap(() =>
              fault === "missing context"
                ? Effect.promise(() => Fs.unlink(Path.join(root, "context.md")))
                : Effect.void
            )),
          exec: (_settings, payload) => {
            executions++
            expect(payload.argv[0]).toContain("block-0.ts")
            return Effect.fail(
              Exec.ExecError.make({
                _tag: "smithers-build/ExecError",
                argv: payload.argv,
                cwd: payload.cwd,
                code: "spawn_failed",
                exitCode: -1,
                stdout: "",
                stderr: "compiler unavailable"
              })
            )
          }
        })
      )
    )
    expect(result.ok, JSON.stringify(result)).toBe(fault === "fragments")
    expect(executions).toBe(fault === "missing compiler" ? 1 : 0)
    if (fault === "missing context") expect(result.results[0]?.error).toContain("context.md")
    if (fault === "missing compiler") expect(result.results[0]?.error).toContain("compiler unavailable")
  })
})

describe("CI publication boundaries", () => {
  const source = `const check = S.Shell.Test({ shell: "true" })
const command = S.Github.Ci({ workflows: { test: { on: { pullRequest: true }, run: check } }, changes: ["workflows/test.yml", "allowed.yml"] })
export const Package = S.Package({ targets: { check, command } })`
  it.each([false, true])("publishes only after validating output parents (fault=%s)", async (fault) => {
    const { root, options } = await fixture(source)
    const writeOptions = { ...options, write: true }
    const plan = await PackageExec.plan(writeOptions)
    const result = await Effect.runPromise(
      executeEffect(plan, writeOptions).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        cache: (settings) =>
          executionServicesLive.cache(settings).pipe(Effect.tap(() =>
            fault
              ? Effect.promise(() => Fs.writeFile(Path.join(root, "workflows"), "unavailable directory"))
              : Effect.void
          ))
      }))
    )
    expect(result.ok, JSON.stringify(result)).toBe(!fault)
    if (fault) expect(result.results[0]?.error).toMatch(/not a directory|ENOTDIR|EEXIST/)
    else expect(await Fs.readFile(Path.join(root, "workflows/test.yml"), "utf8")).toContain("pull_request")
  })
})

describe("inert workflow setup", () => {
  it.each([false, true])("inspects optional setup without running workflow entries (setup=%s)", async (setup) => {
    const { root, options, plan } = await fixture(`
const check = S.Shell.Test({ shell: "touch launched", sandbox: "none" })
const setup = S.Github.Setup({})
const command = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [check], ${setup ? "setup," : ""} })
export const Package = S.Package({ targets: { check, setup, command } })`)
    const result = await PackageExec.execute(plan, options)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.results.find((entry) => entry.label === "//:command")?.status).toBe("ran")
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("CI write-scope validation", () => {
  it("reverts output when an admitted plan's literal write scope points outside the workspace", async () => {
    const { root, options } = await fixture(`const check = S.Shell.Test({ shell: "true" })
const command = S.Github.Ci({ workflows: { test: { on: { pullRequest: true }, run: check } }, changes: ["workflows/**"] })
export const Package = S.Package({ targets: { check, command } })`)
    const writeOptions = { ...options, write: true }
    const planned = await PackageExec.plan(writeOptions)
    const original = planned.nodes.get("//:command")!
    const node = { ...original, writeSet: ["/outside.yml"] } as unknown as PackageExec.PackageNode
    const result = await PackageExec.execute({
      ...planned,
      nodes: new Map([...planned.nodes, [node.label, node]]),
      workList: planned.workList.map((entry) => entry.label === node.label ? node : entry)
    }, writeOptions)
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("outside its declared write-set")
    await expect(Fs.stat(Path.join(root, "workflows/test.yml"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("CI output portal", () => {
  it("refuses a linked output parent without admitting its external directory", async () => {
    const { root, options } = await fixture(`const check = S.Shell.Test({ shell: "true" })
const command = S.Github.Ci({ workflows: { test: { on: { pullRequest: true }, run: check } }, changes: ["workflows/**"] })
export const Package = S.Package({ targets: { check, command } })`)
    const external = `${root}-ci-portal`
    await Fs.mkdir(external)
    await Fs.writeFile(Path.join(external, "original.txt"), "preserve")
    try {
      const writeOptions = { ...options, write: true }
      const result = await Effect.runPromise(
        executeEffect(await PackageExec.plan(writeOptions), writeOptions).pipe(
          Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            cache: (settings) =>
              executionServicesLive.cache(settings).pipe(
                Effect.tap(() => Effect.promise(() => Fs.symlink(external, Path.join(root, "workflows"))))
              )
          })
        )
      )
      expect(result.ok).toBe(false)
      expect(result.results[0]?.error).toBe("wrote outside its declared write-set (reverted): workflows/test.yml")
      expect(await Fs.readFile(Path.join(external, "original.txt"), "utf8")).toBe("preserve")
      await expect(Fs.stat(Path.join(external, "test.yml"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await Fs.rm(external, { recursive: true, force: true })
    }
  })
})

describe("pre-act gate report completeness", () => {
  it("names a missing report when another admitted gate has already failed", async () => {
    const { root, options, plan } = await fixture(`const gate = S.Shell.Test({ shell: "true", sandbox: "none" })
const command = S.Shell.Run({ shell: "touch launched", gates: [gate], sandbox: "none" })
export const Package = S.Package({ targets: { gate, command } })`)
    const original = plan.nodes.get("//:command")!
    const node = { ...original, gateDeps: [...original.gateDeps, "//:missing"] } as unknown as PackageExec.PackageNode
    const result = await Effect.runPromise(
      executeEffect({
        ...plan,
        nodes: new Map([...plan.nodes, [node.label, node]]),
        workList: plan.workList.map((entry) => entry.label === node.label ? node : entry)
      }, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        exec: (_settings, payload) =>
          Effect.fail(
            Exec.ExecError.make({
              _tag: "smithers-build/ExecError",
              argv: payload.argv,
              cwd: payload.cwd,
              code: "exit_status",
              exitCode: 71,
              stdout: "",
              stderr: "gate host failed"
            })
          )
      }))
    )
    expect(result.ok).toBe(false)
    expect(result.results.find((entry) => entry.label === "//:command")?.error).toContain(
      "//:gate=failed, //:missing=unscheduled"
    )
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
