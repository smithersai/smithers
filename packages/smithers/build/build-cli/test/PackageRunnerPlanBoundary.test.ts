import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Exec from "@smthrs/targets/Exec"
import * as LlmLint from "@smthrs/targets/LlmLint"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import {
  executeEffect,
  ExecutionServices,
  executionServicesLive,
  sandboxRequest
} from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const fixture = async (
  source?: string,
  inputs?: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>> = {}
) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-runner-plan-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("runner-plan", {
  repository: "git+https://example.invalid/runner-plan.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})`
  )
  await write(root, "prompt.md", "Produce a confined candidate.\n")
  await write(root, "package.json", "{\"name\":\"runner-plan\",\"private\":true}\n")
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  await write(
    root,
    "PACKAGE.ts",
    source ?? `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "touch launched", sandbox: "none" }) } })`
  )
  for (const [path, contents] of Object.entries(files)) await write(root, path, contents)
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:command"], inputs }
  const plan = await PackageExec.plan(options)
  return { root, options, plan, node: plan.workList[0]! }
}

/** The public execute boundary must reject incomplete plans before any process starts. */
const refusals = [
  ["Cargo.Fetch", "cargo target planned no commands"],
  ["Repo.Target", "repository target planned no child resolution"],
  ["Alias", "alias names no target"],
  ["Materialize", "materialize names no target"],
  ["Git.Submodule", "Git.Submodule planned no gitlinks"],
  ["Markdown.CodeBlocks", "Markdown.CodeBlocks planned no source"],
  ["Api.Compat", "Api.Compat planned no producers"],
  ["ImportClosure", "import closure planned no entries"],
  ["Test", "file-set test planned no operands"],
  ["Bundler.Rspack.resolve", "bundler resolve planned no payload"],
  ["Bundler.Rspack.build", "bundler build planned no payload"],
  ["Agent.Lint", "agent lint planned no payload"],
  ["Agent.Diff", "agent target planned no payload"],
  ["Docker.Push", "docker push planned no commands"],
  ["Npm.Downstream", "Npm.Downstream: not implemented by this executor"],
  ["Git.Pr", "Git.Pr: not implemented by this executor"]
] as const

describe("public plan execution validation", () => {
  it.each(refusals)("refuses an incomplete %s plan", async (rule, error) => {
    const { root, options, plan, node } = await fixture()
    const invalid = { ...node, rule, lane: undefined, refusal: undefined } as PackageExec.PackageNode
    const result = await PackageExec.execute(
      { ...plan, nodes: new Map([[node.label, invalid]]), workList: [invalid] },
      options
    )
    expect(result.ok).toBe(false)
    expect(result.results).toMatchObject([{ label: node.label, status: "failed", error }])
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a materialization whose producer was not planned", async () => {
    const { options, plan, node } = await fixture()
    const invalid = { ...node, rule: "Materialize", materializeOf: "//:absent" } as PackageExec.PackageNode
    const result = await PackageExec.execute(
      { ...plan, nodes: new Map([[node.label, invalid]]), workList: [invalid] },
      options
    )
    expect(result.results).toMatchObject([{ status: "failed", error: "materialize target //:absent was not planned" }])
  })

  it("refuses a bundler build whose graph has no result", async () => {
    const { options, plan, node } = await fixture()
    const invalid = {
      ...node,
      rule: "Bundler.Rspack.build",
      keyTemplate: node.keyMaterial,
      lane: { kind: "bundler-build", graphLabel: "//:absent", payload: {} }
    } as PackageExec.PackageNode
    const result = await PackageExec.execute(
      { ...plan, nodes: new Map([[node.label, invalid]]), workList: [invalid] },
      options
    )
    expect(result.results).toMatchObject([{
      status: "failed",
      error: "bundler graph //:absent settled no result in this invocation"
    }])
  })

  it("refuses an approval whose declaration disappeared after planning", async () => {
    const { root, options, plan, node } = await fixture()
    const approved = { ...node, approval: "approved-revision" }
    await write(
      root,
      "PACKAGE.ts",
      "import { Smithers as S } from \"@smthrs/targets\"; export const Package = S.Package({ targets: {} })"
    )
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
    const result = await PackageExec.execute({
      ...plan,
      nodes: new Map([[node.label, approved]]),
      workList: [approved]
    }, { ...options, index })
    expect(result.ok).toBe(false)
    expect(result.results).toMatchObject([{
      status: "failed",
      error: expect.stringContaining("could not be checked again before it ran")
    }])
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("invocation-local host failures", () => {
  it("reports an unexpected execution failure without launching or caching the command", async () => {
    const { root, options, plan } = await fixture()
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        exec: () => Effect.die(new Error("host execution unavailable"))
      }))
    )
    expect(result.results).toMatchObject([{ status: "failed", error: "host execution unavailable" }])
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps a successful target green and logs a failed cache write", async () => {
    const { options, plan, node } = await fixture()
    const cached = { ...node, rule: "Filegroup", cacheable: true } as PackageExec.PackageNode
    const notes: Array<string> = []
    let writes = 0
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, cached]]), workList: [cached] }, {
        ...options,
        log: (line) => notes.push(line)
      }).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        cache: (config) =>
          executionServicesLive.cache(config).pipe(Effect.map((store) => ({
            ...store,
            put: () => {
              writes++
              return Effect.runPromise(Effect.fail(new Error("cache volume unavailable")))
            }
          })))
      }))
    )
    expect(result.results).toMatchObject([{ status: "ran" }])
    expect(writes).toBe(1)
    expect(notes.join("\n")).toContain("could not store //:command in the cache: cache volume unavailable")
  })

  it("treats a failed cache read as a miss and closes the store even when closing fails", async () => {
    const { options, plan, node } = await fixture()
    const cached = { ...node, rule: "Filegroup", cacheable: true } as PackageExec.PackageNode
    let reads = 0
    let closed = false
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, cached]]), workList: [cached] }, options)
        .pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          cache: (config) =>
            executionServicesLive.cache(config).pipe(Effect.map((store) => ({
              ...store,
              get: () => {
                reads++
                return Effect.runPromise(Effect.fail(new Error("cache read unavailable")))
              },
              close: async () => {
                await store.close()
                closed = true
                await Effect.runPromise(Effect.fail(new Error("cache close unavailable")))
              }
            })))
        }))
    )
    expect(result.results).toMatchObject([{ status: "ran" }])
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  })
})

const materialization = (cache: boolean) =>
  `import { Smithers as S } from "@smthrs/targets"
const build = S.Shell.Build({ shell: "mkdir -p dist && printf built > dist/a.txt && printf built > out.txt", outDirs: ["dist"], outFiles: ["out.txt"], ${
    cache ? "" : "cache: false,"
  } sandbox: "none" })
export const Package = S.Package({ targets: { build, command: S.Materialize(build) } })`

describe("materialization after a producer settles", () => {
  it.each([
    ["absent directory", "no artifacts available to materialize: dist is absent"],
    ["directory replaced by a file", "declared outDir is not a directory: dist"],
    ["absent file", "no artifacts available to materialize: out.txt is absent"],
    ["file replaced by a directory", "no artifacts available to materialize: out.txt is absent"]
  ])("refuses an uncached producer with an %s", async (fault, error) => {
    const { root, options, plan } = await fixture(materialization(false))
    let injected = false
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        cache: (config) =>
          executionServicesLive.cache(config).pipe(Effect.map((store) => ({
            ...store,
            get: async (key) => {
              injected = true
              const path = Path.join(
                root,
                fault.includes("directory") && !fault.startsWith("file") ? "dist" : "out.txt"
              )
              await Fs.rm(path, { recursive: true })
              if (fault === "directory replaced by a file") await Fs.writeFile(path, "replacement")
              if (fault === "file replaced by a directory") await Fs.mkdir(path)
              return store.get(key)
            }
          })))
      }))
    )
    expect(injected).toBe(true)
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "//:build", status: "ran" }),
      expect.objectContaining({ label: "//:command", status: "failed", error })
    ]))
  })

  it.each(["wrong output root", "missing directory blob", "missing file blob", "changed tree"])(
    "checks the current cache and artifacts after %s",
    async (fault) => {
      const { root, options, plan } = await fixture(materialization(true))
      let injected = false
      const result = await Effect.runPromise(
        executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          cache: (config) =>
            executionServicesLive.cache(config).pipe(Effect.map((store) => ({
              ...store,
              get: async (key) => {
                const entry = await store.get(key)
                if (entry !== null) {
                  injected = true
                  const output = entry.output as {
                    kind: string
                    manifests: Array<{ outDir: string; entries: Array<{ digest: string }> }>
                    files: Array<{ path: string; digest: string }>
                  }
                  if (fault === "wrong output root") {
                    await Fs.writeFile(
                      Path.join(root, ".flows/cache", key.slice(0, 2), `${key}.json`),
                      JSON.stringify({
                        ...entry,
                        output: {
                          ...output,
                          manifests: output.manifests.map((manifest) => ({ ...manifest, outDir: "other" }))
                        }
                      })
                    )
                  } else if (fault === "missing directory blob") {
                    await Fs.writeFile(Path.join(root, "dist/a.txt"), "changed")
                    await Fs.rm(Path.join(root, ".flows/cas", output.manifests[0]!.entries[0]!.digest))
                  } else if (fault === "missing file blob") {
                    await Fs.rm(Path.join(root, ".flows/cas", output.files[0]!.digest))
                  } else {
                    await Fs.writeFile(Path.join(root, "dist/a.txt"), "changed")
                  }
                }
                return store.get(key)
              }
            })))
        }))
      )
      expect(injected).toBe(true)
      expect(result.results.find((entry) => entry.label === "//:build")).toMatchObject({ status: "ran" })
      if (fault === "changed tree") {
        expect(result.results.find((entry) => entry.label === "//:command")).toMatchObject({
          label: "//:command",
          status: "ran"
        })
        expect(await Fs.readFile(Path.join(root, "dist/a.txt"), "utf8")).toBe("built")
      } else {
        expect(result.results.find((entry) => entry.label === "//:command")).toMatchObject({
          label: "//:command",
          status: "failed"
        })
        expect(result.results.find((entry) => entry.label === "//:command")!.error).toContain("cannot materialize:")
      }
    }
  )
})

const valueTarget = (success: string, result: string, outputs = "") =>
  `import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
const value = Target.make("ValueBoundary", {
  attrs: Schema.Struct({}), kinds: ["build"], success: ${success}, cache: true,
  ${outputs}
  implementation: () => Node.map(Node.succeed(null), () => (${result}))
})({})
export const Package = S.Package({ targets: { command: value } })`

describe("target result boundaries", () => {
  it("replays a validated value without an output declaration", async () => {
    const { options, plan } = await fixture(valueTarget("Schema.Number", "42"))
    expect((await PackageExec.execute(plan, options)).results).toMatchObject([{ status: "ran" }])
    expect((await PackageExec.execute(plan, options)).results).toMatchObject([{ status: "hit" }])
  })

  it("runs an unencodable value twice without inventing a cache hit", async () => {
    const { options, plan } = await fixture(valueTarget("Schema.Unknown", "{ value: undefined }"))
    const notes: Array<string> = []
    for (let round = 0; round < 2; round++) {
      const result = await PackageExec.execute(plan, { ...options, log: (line) => notes.push(line) })
      expect(result.results).toMatchObject([{ status: "ran" }])
    }
    expect(notes.filter((line) => line.includes("skipped the cache store"))).toHaveLength(2)
  })

  it("rejects a body result outside its declared success schema", async () => {
    const { options, plan } = await fixture(valueTarget("Schema.Number", "\"invalid\""))
    const result = await PackageExec.execute(plan, options)
    expect(result.results).toMatchObject([{
      status: "failed",
      error: expect.stringContaining("success schema rejected the target result")
    }])
  })

  it("keeps the success envelope when a declared output cannot be captured, then measures it on a hit", async () => {
    const { root, options, plan } = await fixture(
      valueTarget("Schema.Void", "undefined", "outputs: () => ({ cwd: \".\", paths: [\"product\"] }),")
    )
    await write(root, "source.txt", "linked output")
    await Fs.symlink("source.txt", Path.join(root, "product"))
    const notes: Array<string> = []
    const first = await PackageExec.execute(plan, { ...options, log: (line) => notes.push(line) })
    expect(first.results).toMatchObject([{ status: "ran" }])
    expect(notes.join("\n")).toContain("declared outputs were not stored")
    const second = await PackageExec.execute(plan, options)
    expect(second.results).toMatchObject([{ status: "hit" }])
    expect(await Fs.readFile(Path.join(root, "product"), "utf8")).toBe("linked output")
  })
})

const agentTarget = (payload = "") =>
  `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { command: S.Agent.Diff({
  agent: S.Agent.Codex({ model: "fixture" }), prompt: S.file("//prompt.md"),
  data: [], changes: ["out/**"], gates: [], maxRounds: 1, ${payload}
}) } })`

describe("agent and memory failure diagnostics", () => {
  it("rechecks payload inputs when executing an admitted agent plan", async () => {
    const { options, plan } = await fixture(agentTarget("payload: { issue: S.Input.String(\"issue id\") }"), {
      issue: "present"
    })
    const result = await PackageExec.execute(plan, { ...options, inputs: {} })
    expect(result.results).toMatchObject([{
      status: "failed",
      error: "needs input: required payload input \"issue\" is missing (expected: issue id)"
    }])
  })

  it.each(["typed", "defect", "primitive"] as const)("renders a %s agent host failure", async (fault) => {
    const { options, plan } = await fixture(agentTarget())
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        sessions: () => ({
          open: () =>
            fault === "typed"
              ? Effect.fail(new AgentTarget.AgentSessionError({ phase: "spawn", message: "agent host unavailable" }))
              : Effect.die(fault === "primitive" ? "agent host unavailable" : new Error("agent host unavailable"))
        })
      }))
    )
    expect(result.results).toMatchObject([{
      status: "failed",
      error: fault === "typed" ? "agent spawn: agent host unavailable" : "agent host unavailable"
    }])
  })

  it("retains an unexpected memory backend failure in the target report", async () => {
    const { options, plan, node } = await fixture()
    const memory = { ...node, rule: "Memory.Retain" } as PackageExec.PackageNode
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[node.label, memory]]), workList: [memory] }, options)
        .pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          retain: () => Effect.runPromise(Effect.fail(new Error("memory transport unavailable")))
        }))
    )
    expect(result.results).toMatchObject([{ status: "failed", error: "memory transport unavailable" }])
  })
})

describe("model review execution reports", () => {
  it("marks an unavailable model host as skipped and never as a green review", async () => {
    const { options, plan } = await fixture(valueTarget("Schema.Unknown", "null"))
    const notes: Array<string> = []
    const result = await Effect.runPromise(
      executeEffect(plan, { ...options, log: (line) => notes.push(line) })
        .pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          target: () =>
            Effect.fail(
              new LlmLint.ModelCliMissing({
                engine: "codex",
                executable: "codex",
                message: "model CLI absent"
              })
            )
        }))
    )
    expect(result.results).toMatchObject([{
      status: "skipped",
      error: "the codex CLI is not installed on this host, so the review did not run"
    }])
    expect(result.counts).toMatchObject({ hit: 0, ran: 0, skipped: 1 })
    expect(notes.join("\n")).toContain("smthrs: skipped //:command:")
  })

  it("logs successful review findings through the same target result boundary", async () => {
    const { options, plan } = await fixture(
      valueTarget(
        "Schema.Unknown",
        `{
      findings: [{ file: "src/a.ts", line: 3, severity: "info", message: "review detail" }]
    }`
      ).replace("\"ValueBoundary\"", "\"LlmLint\"")
    )
    const notes: Array<string> = []
    const result = await PackageExec.execute(plan, { ...options, log: (line) => notes.push(line) })
    expect(result.results).toMatchObject([{ status: "ran" }])
    expect(notes.join("\n")).toContain("1 review finding(s)")
    expect(notes.join("\n")).toContain("src/a.ts:3 info: review detail")
  })
})

describe("bundler host defects", () => {
  it.each([new Error("bundler host unavailable"), null, "bundler host unavailable"])(
    "reports a resolve defect without treating it as an exit status: %j",
    async (defect) => {
      const { options, plan, node } = await fixture()
      const graph = {
        ...node,
        rule: "Bundler.Rspack.resolve",
        lane: {
          kind: "bundler-resolve",
          payload: { configPath: "rsbuild.config.ts", entries: [], mode: "development" }
        }
      } as PackageExec.PackageNode
      const result = await Effect.runPromise(
        executeEffect({ ...plan, nodes: new Map([[node.label, graph]]), workList: [graph] }, options)
          .pipe(Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            resolveGraph: () => Effect.die(defect)
          }))
      )
      expect(result.results).toMatchObject([{
        status: "failed",
        error: defect === null ? "bundler resolve failed" : "bundler host unavailable"
      }])
    }
  )

  it.each([false, true])(
    "reports a build host failure after reading its graph from the real cache (typed=%s)",
    async (typed) => {
      const { root, options, plan, node } = await fixture()
      const graph = {
        ...node,
        label: "//:graph",
        rule: "Bundler.Rspack.resolve",
        keyPreview: "a".repeat(64),
        cacheable: true,
        lane: {
          kind: "bundler-resolve",
          payload: { configPath: "rsbuild.config.ts", entries: [], mode: "development" }
        }
      } as PackageExec.PackageNode
      const build = {
        ...node,
        rule: "Bundler.Rspack.build",
        keyTemplate: node.keyMaterial,
        dependencies: [graph.label],
        lane: {
          kind: "bundler-build",
          graphLabel: graph.label,
          payload: {
            configPath: "rsbuild.config.ts",
            environment: "web",
            mode: "production",
            env: {},
            outDirs: []
          }
        }
      } as PackageExec.PackageNode
      const result = {
        files: [],
        packages: [],
        moduleCount: 0,
        graphDigest: BundlerTarget.graphDigest({ files: [], packages: [] })
      }
      const store = await Effect.runPromise(
        executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" })
      )
      await store.put(graph.keyPreview, {
        key: graph.keyPreview,
        label: graph.label,
        target: graph.rule,
        exitOk: true,
        output: { kind: "bundler-resolve", result },
        storedAt: new Date().toISOString()
      })
      await store.close()
      const summary = await Effect.runPromise(
        executeEffect(
          { ...plan, nodes: new Map([[graph.label, graph], [node.label, build]]), workList: [graph, build] },
          options
        )
          .pipe(Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            build: () =>
              typed
                ? Effect.fail(
                  Exec.ExecError.make({
                    _tag: "smithers-build/ExecError",
                    argv: ["rspack"],
                    cwd: ".",
                    code: "exit_status",
                    exitCode: 71,
                    stdout: "",
                    stderr: "bundler build host unavailable"
                  })
                )
                : Effect.die(new Error("bundler build host unavailable"))
          }))
      )
      expect(summary.results).toMatchObject([
        { label: graph.label, status: "hit" },
        {
          label: build.label,
          status: "failed",
          error: typed ? expect.stringContaining("command failed (exit 71)") : "bundler build host unavailable"
        }
      ])
    }
  )
})

describe("empty crate plans", () => {
  it.each([
    "Cargo.Fetch",
    "Cargo.Build",
    "Cargo.Doc",
    "Cargo.Test",
    "Cargo.Nextest",
    "Cargo.Clippy",
    "Cargo.Deny",
    "Cargo.Fmt"
  ])(
    "settles %s without launching a tool when its crate set is empty",
    async (rule) => {
      const { root, options, plan, node } = await fixture()
      const empty = {
        ...node,
        rule,
        lane: { kind: "cargo", commands: [], outFiles: [], crates: [], binaries: [] }
      } as PackageExec.PackageNode
      const notes: Array<string> = []
      const result = await PackageExec.execute({ ...plan, nodes: new Map([[node.label, empty]]), workList: [empty] }, {
        ...options,
        log: (line) => notes.push(line)
      })
      expect(result.results).toMatchObject([{ status: "ran" }])
      expect(notes.join("\n")).toContain("crate set is empty; nothing to run")
      await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  )
})

describe("linked dependency confinement", () => {
  it.each([true, false])(
    "grants an installed dependency root and keeps other host directories closed: %s",
    async (installed) => {
      const { root, options, plan } = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { command: S.Shell.Run({ shell: "cat node_modules/fixture.txt" }) } })`)
      const external = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-dependency-root-")))
      roots.push(external)
      const directory = Path.join(external, installed ? "node_modules" : "private")
      await Fs.mkdir(directory)
      await Fs.writeFile(Path.join(directory, "fixture.txt"), "dependency bytes\n")
      await Fs.symlink(directory, Path.join(root, "node_modules"))
      const output: Array<string> = []
      const result = await PackageExec.execute(await PackageExec.plan(options), {
        ...options,
        reporter: {
          renderer: "plain",
          begin: () => {},
          targetStarted: () => {},
          targetFinished: () => {},
          toolOutput: (_label, _stream, chunk) => output.push(chunk),
          note: () => {},
          warn: () => {},
          summary: () => {},
          close: () => {}
        }
      })
      if (installed) {
        expect(result.results).toMatchObject([{ status: "ran" }])
        expect(output.join("")).toBe("dependency bytes\n")
      } else {
        expect(result.results).toMatchObject([{
          status: "failed",
          error: expect.stringContaining("workspace read resolves outside its declared root")
        }])
        expect(output.join("")).not.toContain("dependency bytes")
      }
    }
  )
})

describe("service preflight failures", () => {
  it.each([
    ["absent", "service //:service was not planned"],
    ["refused", "service //:service: service declaration refused"],
    ["not a service", "service //:service is not a service target"],
    ["no program", "service //:service: Shell.Serve planned no executable"],
    ["docker", "service definition unavailable"],
    ["anvil", "service definition unavailable"]
  ])("refuses a consumer before executing it when its service is %s", async (fault, error) => {
    const { root, options, plan, node } = await fixture()
    const consumer = { ...node, serviceDeps: ["//:service"] } as unknown as PackageExec.PackageNode
    let service: PackageExec.PackageNode | undefined
    if (fault !== "absent") {
      service = {
        ...node,
        label: "//:service",
        rule: fault === "docker" ? "Docker.Service" : fault === "anvil" ? "Anvil.Fork" : "Shell.Serve",
        refusal: fault === "refused" ? "service declaration refused" : undefined,
        argv: fault === "no program" ? undefined : node.argv,
        lane: fault === "not a service"
          ? undefined
          : fault === "docker"
          ? { kind: "docker-service", attrs: {} }
          : fault === "anvil"
          ? { kind: "anvil-fork", attrs: {} }
          : { kind: "serve" }
      } as unknown as PackageExec.PackageNode
    }
    const nodes = new Map<string, PackageExec.PackageNode>([[node.label, consumer]])
    if (service !== undefined) nodes.set(service.label, service)
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes, workList: [consumer] }, options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          dockerService: () => Effect.runPromise(Effect.fail(new Error("service definition unavailable"))),
          anvilService: () => Effect.runPromise(Effect.fail(new Error("service definition unavailable")))
        })
      )
    )
    expect(result.results).toMatchObject([{ status: "failed", error }])
    await expect(Fs.stat(Path.join(root, "launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("planned sandbox authority", () => {
  it("collects transitive products and file sources once while excluding diff snapshots", async () => {
    const { options, node } = await fixture()
    const filegroup = {
      ...node,
      label: "//:files",
      rule: "Filegroup",
      dependencies: ["//:cargo"],
      outDirs: [],
      outFiles: [],
      declaredInputs: [
        { declaration: { _tag: "File" }, files: [{ path: "pkg/input.ts" }] },
        { declaration: { _tag: "GitDiff" }, files: [{ path: "private-diff-only.ts" }] }
      ]
    } as unknown as PackageExec.PackageNode
    const cargo = {
      ...node,
      label: "//:cargo",
      rule: "Cargo.Fetch",
      dependencies: [filegroup.label],
      outDirs: ["vendor"],
      outFiles: ["generated.txt"],
      lane: { kind: "cargo", commands: [], outFiles: ["Cargo.lock"], crates: [], binaries: [] }
    } as PackageExec.PackageNode
    const consumer = {
      ...node,
      packagePath: "pkg",
      cwd: "pkg/inner",
      declaredInputs: [],
      readSet: ["pkg/config.json"],
      dependencies: [filegroup.label, cargo.label, "//:missing"],
      outDirs: ["dist", "nested/bin"],
      outFiles: ["bundle.js"],
      cleanOutDirs: [],
      cleanPaths: [],
      writeSet: ["pkg/*.ts", "plain.txt"],
      declaredOutputs: { cwd: ".", paths: ["dist", "nested", "out.txt"] }
    } as unknown as PackageExec.PackageNode
    const request = sandboxRequest(
      consumer,
      new Map([[filegroup.label, filegroup], [cargo.label, cargo]]),
      options.index.workspace,
      ".flows",
      ["candidate.txt"]
    )
    expect(request.reads).toEqual(expect.arrayContaining([
      "package.json",
      "yarn.lock",
      "pkg",
      "pkg/config.json",
      "pkg/input.ts",
      "vendor",
      "generated.txt",
      "Cargo.lock",
      "node_modules",
      "pkg/node_modules",
      "pkg/inner/node_modules",
      "candidate.txt"
    ]))
    expect(request.reads).not.toContain("private-diff-only.ts")
    expect(request.reads?.filter((path) => path === "Cargo.lock")).toHaveLength(1)
    expect(new Set(request.writes)).toEqual(new Set([".flows", "dist", "nested/bin", "pkg"]))
    expect(new Set(request.writeFiles)).toEqual(new Set(["bundle.js", "out.txt", "plain.txt"]))
    expect(request.readOnly).toEqual([".flows/cache"])
  })

  it.each(["", "crate"])("keeps a Cargo fetch's writes under its own package: %j", async (packagePath) => {
    const { options, node } = await fixture()
    const cargo = {
      ...node,
      rule: "Cargo.Fetch",
      packagePath,
      dependencies: [],
      lane: {
        kind: "cargo",
        commands: [],
        outFiles: ["Cargo.lock"],
        crates: [],
        binaries: []
      }
    } as PackageExec.PackageNode
    const request = sandboxRequest(cargo, new Map(), options.index.workspace, ".flows")
    expect(request.writes).toContain(packagePath === "" ? "target" : "crate/target")
    expect(request.writeFiles).toContain("Cargo.lock")
    if (packagePath !== "") expect(request.writes).not.toContain("target")
  })
})

const closureTarget = `import { Smithers as S } from "@smthrs/targets"
const sources = S.Filegroup({ srcs: [S.glob("src/*.ts")] })
const closure = S.ImportClosure({ entries: [S.file("//src/entry.ts")] })
const command = S.Test({ expect: S.Files.difference(sources, closure), toBe: "empty" })
export const Package = S.Package({ targets: { sources, closure, command } })`

describe("file-set and closure boundaries", () => {
  it("computes a closure when its optional plan memo is absent", async () => {
    const { options, plan } = await fixture(closureTarget, undefined, { "src/entry.ts": "export const value = 1\n" })
    const notes: Array<string> = []
    const result = await PackageExec.execute({ ...plan, closures: new Map() }, {
      ...options,
      log: (line) => notes.push(line)
    })
    expect(result.ok).toBe(true)
    expect(result.results.find((entry) => entry.label === "//:closure")).toMatchObject({ status: "ran" })
    expect(notes.join("\n")).toContain("closure: 1 files, 0 packages, 0 unresolved, 0 dynamic")
  })

  it.each([1, 21])(
    "reports and bounds %i unresolved and dynamic imports without calling them an empty set",
    async (count) => {
      const imports = Array.from(
        { length: count },
        (_, index) => `import "./absent-${index}.ts"; const name${index} = "value"; void import("./" + name${index});`
      ).join("\n")
      const { options, plan } = await fixture(closureTarget, undefined, { "src/entry.ts": imports })
      const result = await PackageExec.execute(plan, options)
      const command = result.results.find((entry) => entry.label === "//:command")!
      expect(command.status).toBe("failed")
      expect(command.error).toContain("unresolved: src/entry.ts -> ./absent-0.ts")
      expect(command.error).toContain("dynamic: src/entry.ts -> \"./\" + name0")
      if (count > 20) expect(command.error).toContain("(+1 more)")
    }
  )

  it("bounds a large leftover set in the target failure report", async () => {
    const files: Record<string, string> = { "src/entry.ts": "export const value = 1\n" }
    for (let index = 0; index < 21; index++) {
      files[`src/unused-${String(index).padStart(2, "0")}.ts`] = `export const unused = ${index}\n`
    }
    const { options, plan } = await fixture(closureTarget, undefined, files)
    const result = await PackageExec.execute(plan, options)
    const command = result.results.find((entry) => entry.label === "//:command")!
    expect(command.status).toBe("failed")
    expect(command.error).toContain("leftover: src/unused-00.ts")
    expect(command.error).toContain("(+1 more)")
    expect(command.error).not.toContain("src/unused-20.ts")
  })
})

describe("value plans with missing members", () => {
  it.each(
    [
      ["Alias", { aliasOf: "//:absent" }, "aliased target //:absent did not succeed"],
      ["Suite", { members: ["//:absent"] }, "suite is red; members: //:absent=unscheduled"],
      ["Api.Compat", {
        lane: {
          kind: "api-compat",
          baselineLabel: "//:baseline",
          surfaceLabel: "//:surface",
          manifestPath: "package.json"
        }
      }, "Api.Compat could not resolve baseline and surface"],
      [
        "Test",
        { lane: { kind: "files-digest", targetLabel: "//:absent", expectedPath: "baseline.json" } },
        "digest target //:absent was not planned"
      ],
      [
        "Docker.Push",
        { lane: { kind: "docker-push", commands: [] } },
        "Docker.Push image is not a planned Docker.Build or Docker.Bake"
      ]
    ] as const
  )("refuses %s instead of claiming its missing member ran", async (rule, extra, error) => {
    const { options, plan, node } = await fixture()
    const invalid = { ...node, rule, ...extra } as unknown as PackageExec.PackageNode
    const result = await PackageExec.execute(
      { ...plan, nodes: new Map([[node.label, invalid]]), workList: [invalid] },
      options
    )
    expect(result.results).toMatchObject([{ status: "failed", error }])
  })
})

describe("published package artifacts", () => {
  it("clears stale extraction products and restores the captured package on a cache hit", async () => {
    const { root, options, plan, node } = await fixture()
    await write(root, "published/stale.txt", "stale")
    await write(root, "registry/package/index.d.ts", "export declare const published: true;")
    execFileSync("tar", ["-cf", Path.join(root, "published.tar"), "-C", Path.join(root, "registry/package"), "."])
    const published = {
      ...node,
      rule: "Npm.Published",
      cacheable: true,
      outDirs: ["published"],
      argv: [
        "/bin/sh",
        "-c",
        "mkdir -p published .flows/tmp; tar -xf published.tar -C published; printf executed >> .flows/tmp/extractions"
      ]
    } as PackageExec.PackageNode
    const prepared = { ...plan, nodes: new Map([[node.label, published]]), workList: [published] }
    const first = await PackageExec.execute(prepared, options)
    expect(first.results).toMatchObject([{ status: "ran" }])
    await expect(Fs.stat(Path.join(root, "published/stale.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    const declarations = await Fs.readFile(Path.join(root, "published/index.d.ts"), "utf8")
    await Fs.rm(Path.join(root, "published"), { recursive: true })
    const second = await PackageExec.execute(prepared, options)
    expect(second.results).toMatchObject([{ status: "hit" }])
    expect(await Fs.readFile(Path.join(root, "published/index.d.ts"), "utf8")).toBe(declarations)
    expect(await Fs.readFile(Path.join(root, ".flows/tmp/extractions"), "utf8")).toBe("executed")
  })
})

describe("agent verdict store failures", () => {
  it.each(["throws", "rejects"] as const)(
    "handles a verdict store that %s through its injected service",
    async (fault) => {
      const { options, plan } = await fixture(agentTarget())
      const scripted = AgentFake.makeScriptedSessionFactory({ responses: [{ fail: "stop after cache miss" }] })
      const result = await Effect.runPromise(
        executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          sessions: () => scripted,
          cache: (config) =>
            executionServicesLive.cache(config).pipe(Effect.map((store) => ({
              ...store,
              get: () => {
                if (fault === "throws") throw new Error("verdict store unavailable")
                return Effect.runPromise(Effect.fail(new Error("verdict store unavailable")))
              }
            })))
        }))
      )
      expect(result.results).toMatchObject([{
        status: "failed",
        error: fault === "throws" ? "agent cache: verdict store unavailable" : "agent spawn: stop after cache miss"
      }])
      expect(scripted.spawns()).toBe(fault === "throws" ? 0 : 1)
    }
  )

  it.each([
    ["null", null],
    ["primitive", "invalid"],
    ["wrong kind", { kind: "other", value: "invalid" }],
    ["wrong value", { kind: "agent-verdict", value: 7 }]
  ])("rejects a stored verdict with %s output before asking the real scripted session", async (_fault, output) => {
    const { options, plan } = await fixture(agentTarget())
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ fail: "session reached after invalid verdict" }]
    })
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        sessions: () => scripted,
        cache: (config) =>
          executionServicesLive.cache(config).pipe(Effect.map((store) => ({
            ...store,
            get: async (key) => {
              await store.put(key, {
                key,
                target: "Agent.Diff",
                label: "//:command",
                exitOk: true,
                output,
                storedAt: new Date().toISOString()
              })
              return store.get(key)
            }
          })))
      }))
    )
    expect(result.results).toMatchObject([{
      status: "failed",
      error: "agent spawn: session reached after invalid verdict"
    }])
    expect(scripted.spawns()).toBe(1)
  })
})

describe("cache envelope identity", () => {
  it.each([
    ["failed result", { exitOk: false }],
    ["another rule", { target: "OtherRule" }],
    ["another label", { label: "//:other" }]
  ])("does not replay a %s as this target", async (_fault, invalid) => {
    const { root, options, plan, node } = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { command: S.Filegroup({ srcs: [S.file("//prompt.md")] }) } })`)
    const store = await Effect.runPromise(
      executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" })
    )
    await store.put(node.keyPreview, {
      key: node.keyPreview,
      target: node.rule,
      label: node.label,
      exitOk: true,
      output: { kind: "filegroup" },
      storedAt: new Date().toISOString(),
      ...invalid
    })
    await store.close()
    const result = await PackageExec.execute(plan, options)
    expect(result.results).toMatchObject([{ status: "ran" }])
    const corrected = await Effect.runPromise(
      executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" })
    )
    try {
      expect(await corrected.get(node.keyPreview)).toMatchObject({ target: node.rule, label: node.label, exitOk: true })
    } finally {
      await corrected.close()
    }
  })
})

describe("declared output cache recovery failures", () => {
  it.each(["missing blob", "write denied", "undeclared path"] as const)(
    "refuses an unrestorable output after %s",
    async (fault) => {
      const { root, options, plan, node } = await fixture(
        valueTarget(
          "Schema.Void",
          "undefined",
          "outputs: () => ({ cwd: \".\", paths: [\"product/item.txt\"] }),"
        ),
        undefined,
        { "product/item.txt": "product", "unrelated.txt": "keep" }
      )
      expect((await PackageExec.execute(plan, options)).results).toMatchObject([{ status: "ran" }])
      await Fs.unlink(Path.join(root, "product/item.txt"))
      const notes: Array<string> = []
      const services = {
        ...executionServicesLive,
        cache: (config: Parameters<typeof executionServicesLive.cache>[0]) =>
          executionServicesLive.cache(config).pipe(Effect.map((store) => ({
            ...store,
            get: async (key: string) => {
              const entry = await store.get(key)
              if (entry !== null) {
                const output = entry.output as { files: Array<{ path: string; digest: string }> }
                if (fault === "missing blob") {
                  await Fs.rm(Path.join(root, ".flows/cas", output.files[0]!.digest), { force: true })
                } else if (fault === "write denied") await Fs.chmod(Path.join(root, "product"), 0o500)
                else {await Fs.writeFile(
                    Path.join(root, ".flows/cache", key.slice(0, 2), `${key}.json`),
                    JSON.stringify({
                      ...entry,
                      output: { ...output, files: output.files.map((file) => ({ ...file, path: "unrelated.txt" })) }
                    })
                  )}
              }
              return store.get(key)
            }
          })))
      }
      try {
        const result = await Effect.runPromise(
          executeEffect(plan, { ...options, log: (line) => notes.push(line) })
            .pipe(Effect.provideService(ExecutionServices, services))
        )
        expect(result.results).toMatchObject([{
          status: "failed",
          error: expect.stringContaining("did not produce its declared output")
        }])
        expect(await Fs.readFile(Path.join(root, "unrelated.txt"), "utf8")).toBe("keep")
        if (fault !== "undeclared path") expect(notes.join("\n")).toContain("cache miss:")
      } finally {
        await Fs.chmod(Path.join(root, "product"), 0o700)
      }
    }
  )
})

describe("materialization cache outage", () => {
  it("uses a freshly produced tree when the materializer cannot read its cache", async () => {
    const { root, options, plan } = await fixture(materialization(true))
    let reads = 0
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        cache: (settings) =>
          executionServicesLive.cache(settings).pipe(Effect.map((store) => ({
            ...store,
            get: (key) =>
              ++reads === 2
                ? Effect.runPromise(Effect.fail(new Error("materializer cache unavailable")))
                : store.get(key)
          })))
      }))
    )
    expect(reads).toBe(2)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "//:build", status: "ran" }),
      expect.objectContaining({ label: "//:command", status: "ran" })
    ]))
    expect(await Fs.readFile(Path.join(root, "dist/a.txt"), "utf8")).toBe("built")
    expect(await Fs.readFile(Path.join(root, "out.txt"), "utf8")).toBe("built")
  })
})

describe("invalid cached bundler graph", () => {
  it("tries the real host boundary rather than trusting an invalid cached graph", async () => {
    const { root, options, plan, node } = await fixture()
    const graph = {
      ...node,
      rule: "Bundler.Rspack.resolve",
      cacheable: true,
      lane: { kind: "bundler-resolve", payload: { configPath: "rsbuild.config.ts", entries: [], mode: "development" } }
    } as unknown as PackageExec.PackageNode
    const store = await Effect.runPromise(
      executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" })
    )
    try {
      await store.put(graph.keyPreview, {
        key: graph.keyPreview,
        label: graph.label,
        target: graph.rule,
        exitOk: true,
        output: { kind: "invalid-graph" },
        storedAt: new Date().toISOString()
      })
    } finally {
      await store.close()
    }
    let invocations = 0
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes: new Map([[graph.label, graph]]), workList: [graph] }, options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          resolveGraph: () => {
            invocations++
            return Effect.fail(
              Exec.ExecError.make({
                _tag: "smithers-build/ExecError",
                argv: ["rspack"],
                cwd: ".",
                code: "exit_status",
                exitCode: 71,
                stdout: "",
                stderr: "graph host unavailable"
              })
            )
          }
        })
      )
    )
    expect(invocations).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("command failed (exit 71)")
    expect(result.results[0]?.error).toContain("graph host unavailable")
  })
})
