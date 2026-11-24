import { Action, Flow } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { On, Trigger } from "@smthrs/triggers"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Factory from "../src/Factory.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"
import * as Input from "../src/Input.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 15)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/targets Wave-7B: WorkspaceDeclaration, Factory, PackageJson, ToolBuild, SafeFs & SecretProxy", () => {
  it("WorkspaceDeclaration.Cache, Remote, Remotes, Sandboxes, Flags & Workspace reject every invalid option and accept valid combinations", async () => {
    const validCache = WorkspaceDeclaration.Cache({
      directory: ".cache/build",
      outside: true,
      goBuild: false,
      hostDirectories: [".cache/go", ".cache/rust"],
      remote: RemoteCache.make({ endpoint: "https://cache.example.com", token: Secret.Secret("CACHE_TOK") })
    })
    expect(validCache.outside).toBe(true)
    expect(validCache.goBuild).toBe(false)
    expect(validCache.hostDirectories).toEqual([".cache/go", ".cache/rust"])

    const validRemoteCmd = WorkspaceDeclaration.Remote.Command({
      machines: [["ssh", "builder"]],
      workdir: "/work/repo",
      setup: ["echo ready"],
      cli: ["pnpm", "exec", "smthrs"]
    })
    expect(WorkspaceDeclaration.isRemoteDeclaration(validRemoteCmd)).toBe(true)

    const validRemoteHttp = WorkspaceDeclaration.Remote.Http({
      url: "https://runner.example.com",
      token: Secret.Secret("RUNNER_TOK"),
      machines: 2,
      workdir: "/work/repo",
      limits: { cpus: 4, memoryMib: 8192, timeoutSecs: 600 }
    })
    expect(WorkspaceDeclaration.isRemoteDeclaration(validRemoteHttp)).toBe(true)

    const badCalls: ReadonlyArray<() => unknown> = [
      // Cache option errors
      () => WorkspaceDeclaration.Cache(null as never),
      () => WorkspaceDeclaration.Cache({ directory: ".cache", extra: 1 } as never),
      () => WorkspaceDeclaration.Cache({ directory: ".cache", remote: {} as never }),
      () => WorkspaceDeclaration.Cache({ directory: ".cache", outside: "yes" as never }),
      () => WorkspaceDeclaration.Cache({ directory: ".cache", goBuild: 0 as never }),
      () => WorkspaceDeclaration.Cache({ directory: ".cache", hostDirectories: "nope" as never }),
      () => WorkspaceDeclaration.Cache({ directory: ".cache", hostDirectories: [".cache/*"] }),
      // Remote.Command / Remote.Http errors
      () => WorkspaceDeclaration.Remote.Command(null as never),
      () => WorkspaceDeclaration.Remote.Command({ machines: [["ssh"]], workdir: "/w", bogus: 1 } as never),
      () => WorkspaceDeclaration.Remote.Command({ machines: [["ssh"]], workdir: "relative" }),
      () => WorkspaceDeclaration.Remote.Command({ machines: [["ssh"]], workdir: "/w\0x" }),
      () => WorkspaceDeclaration.Remote.Command({ machines: [["ssh"]], workdir: "/w", setup: [""] }),
      () => WorkspaceDeclaration.Remote.Command({ machines: [["ssh"]], workdir: "/w", cli: [] }),
      () => WorkspaceDeclaration.Remote.Command({ machines: [["ssh"]], workdir: "/w", cli: [""] }),
      () =>
        WorkspaceDeclaration.Remote.Http({
          url: "https://r.example",
          token: Secret.Secret("T"),
          machines: 1,
          workdir: "/w",
          limits: [] as never
        }),
      () =>
        WorkspaceDeclaration.Remote.Http({
          url: "https://r.example",
          token: Secret.Secret("T"),
          machines: 1,
          workdir: "/w",
          limits: { cpus: -1 }
        }),
      () =>
        WorkspaceDeclaration.Remote.Http({
          url: "https://r.example",
          token: Secret.Secret("T"),
          machines: 1,
          workdir: "/w",
          limits: { memoryMib: 1.5 }
        }),
      () =>
        WorkspaceDeclaration.Remote.Http({
          url: "https://r.example",
          token: Secret.Secret("T"),
          machines: 1,
          workdir: "/w",
          limits: { bogus: 1 } as never
        }),
      () =>
        WorkspaceDeclaration.Remote.Http({
          url: "http://example.com",
          token: Secret.Secret("T"),
          machines: 1,
          workdir: "/w"
        }),
      // Sandboxes / Remotes errors
      () => WorkspaceDeclaration.Sandboxes(null as never),
      () => WorkspaceDeclaration.Sandboxes({ bad: {} as never }),
      () => WorkspaceDeclaration.Remotes(null as never),
      () => WorkspaceDeclaration.Remotes({ bad: {} as never }),
      // Workspace constructor errors
      () => WorkspaceDeclaration.Workspace(123 as never, {} as never),
      () => WorkspaceDeclaration.Workspace("bad name!", {} as never),
      () => WorkspaceDeclaration.Workspace("ok", null as never),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, bogus: 1 } as never),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "", cache: validCache }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, toolchains: "nope" as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, runtime }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, environment: {} as never }),
      () =>
        WorkspaceDeclaration.Workspace("ok", {
          repository: "r",
          cache: validCache,
          runtime: {} as never,
          packageManager,
          nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: Input.file("package.json") })
        }),
      () =>
        WorkspaceDeclaration.Workspace("ok", {
          repository: "r",
          cache: validCache,
          runtime,
          packageManager: {} as never,
          nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: Input.file("package.json") })
        }),
      () =>
        WorkspaceDeclaration.Workspace("ok", {
          repository: "r",
          cache: validCache,
          runtime,
          packageManager,
          nodeModules: {} as never
        }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, toolchains: [null as never] }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, flags: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, host: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, memory: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, sandboxes: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, remotes: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, agents: {} as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, repos: null as never }),
      () =>
        WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, repos: { "bad!": {} } as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, repos: { sub: {} } as never }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, discovery: null as never }),
      () =>
        WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, discovery: { extra: 1 } as never }),
      () =>
        WorkspaceDeclaration.Workspace("ok", {
          repository: "r",
          cache: validCache,
          discovery: { prune: [123] } as never
        }),
      () =>
        WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, discovery: { prune: ["a", "a"] } }),
      () => WorkspaceDeclaration.Workspace("ok", { repository: "r", cache: validCache, gitHooks: null as never }),
      () =>
        WorkspaceDeclaration.Workspace("ok", {
          repository: "r",
          cache: validCache,
          gitHooks: { unknownHook: {} } as never
        }),
      () =>
        WorkspaceDeclaration.Workspace("ok", {
          repository: "r",
          cache: validCache,
          gitHooks: { preCommit: {} } as never
        })
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badCalls.length - 1 }))
      })
    )
    for (const fn of badCalls) expect(() => fn()).toThrow()
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            expect(() => badCalls[idx]!()).toThrow()
            return true
          }),
        { executions: Math.max(executions, badCalls.length * 3), seed }
      )
    )
    assertPassed(report)
  })

  it("Factory.Factory, Lifecycle.Policy, triggers, issueViews, issueTransitions & manifest/catalog checks cover every validation branch", async () => {
    const policy = Factory.Lifecycle.Policy({
      tests: { artifact: { blocking: true, run: "ci" } }
    })
    expect(policy.tests.artifact.blocking).toBe(true)

    const step = Action.make("wave7/step", { payload: {} })
    const ReviewFlow = Flow.make("review", { payload: {}, body: () => step.call({}) })
    const NightlyFlow = Flow.make("nightly", { payload: {}, body: () => step.call({}) })
    const MissingFlow = Flow.make("missing", { payload: {}, body: () => step.call({}) })
    const validBinding = Trigger.bind({ flow: ReviewFlow, on: On.push({ branches: ["main"] }) })

    const decl = Factory.Factory({
      summary: "Wave 7.",
      on: { "pull_request.opened": "review" },
      issueViews: [{ id: "open-bugs", title: "Open Bugs", state: "open", labels: ["bug", "p1"] }],
      issueTransitions: [{ id: "triage", title: "Triage", from: "inbox", to: "triaged", actor: "anyone" }],
      triggers: { "pr-review": validBinding },
      lifecycle: policy
    })
    const catRow = (id: string, kind: FlowCatalog.Row["kind"]): FlowCatalog.Row => ({
      id,
      description: "Desc.",
      summary: null,
      featured: false,
      kind,
      path: `.smithers/flows/${id}/flow.${kind}`,
      capabilities: [],
      model: null,
      modelInvocable: false
    })
    const manifestJson = Factory.renderProjection(decl, [catRow("review", "ts")])
    expect(manifestJson).toContain("pr-review")
    expect(manifestJson).toContain("issueTransitions")

    // Catalog checks for mdx schedule payload mismatch & trigger flow mismatch
    const mdxCatalog: ReadonlyArray<FlowCatalog.Row> = [catRow("nightly", "mdx")]
    const tsCatalog: ReadonlyArray<FlowCatalog.Row> = [catRow("review", "ts")]

    const badCases: ReadonlyArray<() => unknown> = [
      () => Factory.Lifecycle.Policy({ tests: { artifact: { blocking: true, run: "always" as never } } }),
      () => Factory.Lifecycle.Policy({ tests: { artifact: { blocking: true, run: "ci" }, extra: 1 } as never }),
      // issueViews errors
      () => Factory.Factory({ summary: "Wave 7.", on: {}, issueViews: "not-arr" as never }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueViews: Array.from(
            { length: Factory.maximumIssueViews + 1 },
            (_, i) => ({ id: `v-${i}`, title: "V", state: "open" })
          )
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueViews: [{ id: "dup", title: "A", state: "open" }, { id: "dup", title: "B", state: "open" }]
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueViews: [{
            id: "many",
            title: "M",
            state: "open",
            labels: Array.from({ length: 17 }, (_, i) => `l${i}`)
          }]
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueViews: [{ id: "badl", title: "M", state: "open", labels: [" spaced "] }]
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueViews: [{ id: "dupl", title: "M", state: "open", labels: ["Bug", "bug"] }]
        }),
      // issueTransitions errors
      () => Factory.Factory({ summary: "Wave 7.", on: {}, issueTransitions: "not-arr" as never }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueTransitions: Array.from(
            { length: Factory.maximumIssueTransitions + 1 },
            (_, i) => ({ id: `t-${i}`, title: "T", to: "done", actor: "anyone" })
          )
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueTransitions: [{ id: "dup", title: "A", to: "done", actor: "anyone" }, {
            id: "dup",
            title: "B",
            to: "done",
            actor: "anyone"
          }]
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueTransitions: [{ id: "bad", title: "A", to: "  bad  ", actor: "anyone" }]
        }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          issueTransitions: [{ id: "same", title: "A", from: "Done", to: "done", actor: "anyone" }]
        }),
      // triggers errors
      () => Factory.Factory({ summary: "Wave 7.", on: {}, triggers: [] as never }),
      () =>
        Factory.Factory({
          summary: "Wave 7.",
          on: {},
          triggers: Object.fromEntries(
            Array.from({ length: Factory.maximumTriggers + 1 }, (_, i) => [`t-${i}`, validBinding])
          )
        }),
      () => Factory.Factory({ summary: "Wave 7.", on: {}, triggers: { "INVALID!": validBinding } }),
      () => Factory.Factory({ summary: "Wave 7.", on: {}, triggers: { "ok": {} as never } }),
      // checkCatalog errors: mdx payload with unknown key / non-string args, and trigger flow missing/mdx
      () =>
        Factory.renderProjection(
          Factory.Factory({
            summary: "Wave 7.",
            on: { "schedule:0 * * * *": { flow: "nightly", payload: { extra: "x" } } }
          }),
          mdxCatalog
        ),
      () =>
        Factory.renderProjection(
          Factory.Factory({
            summary: "Wave 7.",
            on: { "schedule:0 * * * *": { flow: "nightly", payload: { args: 123 } } }
          }),
          mdxCatalog
        ),
      () =>
        Factory.renderProjection(
          Factory.Factory({
            summary: "Wave 7.",
            on: {},
            triggers: { t1: Trigger.bind({ flow: NightlyFlow, on: On.push({ branches: ["main"] }) }) }
          }),
          mdxCatalog
        ),
      () =>
        Factory.renderProjection(
          Factory.Factory({
            summary: "Wave 7.",
            on: {},
            triggers: { t1: Trigger.bind({ flow: MissingFlow, on: On.push({ branches: ["main"] }) }) }
          }),
          tsCatalog
        )
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badCases.length - 1 }))
      })
    )
    for (const fn of badCases) expect(() => fn()).toThrow()
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            expect(() => badCases[idx]!()).toThrow()
            return true
          }),
        { executions: Math.max(executions, badCases.length * 3), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("PackageJson.scriptCommand & PackageJson.PackageJson / SyncPackageJson cover validation refusals and field cache error paths", async () => {
    const cleanOnlyTarget = Target.make("Wave7CleanOnly", {
      attrs: Schema.Struct({}),
      kinds: ["clean" as never],
      implementation: () => Effect.void as never
    })({})

    const badCases: ReadonlyArray<() => unknown> = [
      () => PackageJson.scriptCommand("build", cleanOnlyTarget, "//pkg:not safe!"),
      () => PackageJson.scriptCommand("clean", cleanOnlyTarget, "//pkg:clean"),
      () => PackageJson.PackageJson({ name: "@smthrs/x", version: "not-semver" } as never),
      () => PackageJson.PackageJson({ name: "@smthrs/x", version: "1.0.0", description: "  untrimmed  " } as never),
      () => PackageJson.PackageJson({ name: "@smthrs/x", version: "1.0.0", description: "" } as never),
      () => PackageJson.PackageJson({ name: "@smthrs/x", version: "1.0.0", keywords: "not-array" as never } as never),
      () => PackageJson.PackageJson({ name: "@smthrs/x", version: "1.0.0", keywords: ["  bad  "] } as never),
      () =>
        PackageJson.PackageJson(
          { name: "@smthrs/x", version: "1.0.0", keywords: Array.from({ length: 257 }, (_, i) => `k${i}`) } as never
        )
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badCases.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            expect(() => badCases[idx]!()).toThrow()
            return true
          }),
        { executions: Math.max(executions, 40), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  it(
    "ToolBuild.readOutputManifest, measureOutput, verifyOutputs & SafeFs cover replacement/symlink/limit/IO fault branches",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          faultCase: Schema.Literals([
            "manifest-bad-path",
            "manifest-bad-count",
            "manifest-bad-digest",
            "manifest-proxy",
            "verify-missing",
            "verify-drift",
            "symlink-output",
            "depth-exceeded",
            "entries-exceeded",
            "io-lstat-fail",
            "io-readdir-fail",
            "safefs-eloop",
            "safefs-replaced",
            "safefs-close-fail",
            "safefs-dir-replaced"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ faultCase }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-t7b-", async (root) => {
                const outDir = NodePath.join(root, "dist")
                await Fs.mkdir(outDir, { recursive: true })
                await Fs.writeFile(NodePath.join(outDir, "a.txt"), "hello")

                const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist"] }
                const measured = await ToolBuild.measureOutputs(root, ".", ["dist"])
                expect(measured.outputs.length).toBe(1)

                if (faultCase === "manifest-bad-path") {
                  const msg = ToolBuild.readOutputManifest(declared, {
                    outputs: [{ path: "other", fileCount: 1, contentDigest: measured.outputs[0]!.contentDigest }]
                  })
                  expect(typeof msg).toBe("string")
                } else if (faultCase === "manifest-bad-count") {
                  const msg = ToolBuild.readOutputManifest(declared, {
                    outputs: [{ path: "dist", fileCount: -1, contentDigest: measured.outputs[0]!.contentDigest }]
                  })
                  expect(typeof msg).toBe("string")
                } else if (faultCase === "manifest-bad-digest") {
                  const msg = ToolBuild.readOutputManifest(declared, {
                    outputs: [{ path: "dist", fileCount: 1, contentDigest: "not-hex" }]
                  })
                  expect(typeof msg).toBe("string")
                } else if (faultCase === "manifest-proxy") {
                  const throwing = new Proxy({}, {
                    getOwnPropertyDescriptor() {
                      throw new Error("boom")
                    }
                  })
                  const msg = ToolBuild.readOutputManifest(declared, throwing)
                  expect(typeof msg).toBe("string")
                } else if (faultCase === "verify-missing") {
                  await Fs.rm(outDir, { recursive: true, force: true })
                  const msg = await ToolBuild.verifyOutputs(root, declared, measured)
                  expect(typeof msg).toBe("string")
                } else if (faultCase === "verify-drift") {
                  await Fs.writeFile(NodePath.join(outDir, "a.txt"), "mutated!")
                  const msg = await ToolBuild.verifyOutputs(root, declared, measured)
                  expect(typeof msg).toBe("string")
                } else if (faultCase === "symlink-output") {
                  await Fs.symlink(NodePath.join(outDir, "a.txt"), NodePath.join(outDir, "link.txt"))
                  await expect(ToolBuild.measureOutput(root, ".", "dist")).rejects.toThrow(/symbolic link/)
                } else if (faultCase === "depth-exceeded") {
                  await Fs.mkdir(NodePath.join(outDir, "d1", "d2", "d3"), { recursive: true })
                  await expect(
                    ToolBuild.measureOutput(root, ".", "dist", {
                      limits: { ...ToolBuild.defaultCaptureLimits, depth: 1 }
                    })
                  ).rejects.toThrow(/nests more than/)
                } else if (faultCase === "entries-exceeded") {
                  await Fs.writeFile(NodePath.join(outDir, "b.txt"), "2")
                  await Fs.writeFile(NodePath.join(outDir, "c.txt"), "3")
                  await expect(
                    ToolBuild.measureOutput(root, ".", "dist", {
                      limits: { ...ToolBuild.defaultCaptureLimits, entries: 1 }
                    })
                  ).rejects.toThrow(/more than/)
                } else if (faultCase === "io-lstat-fail") {
                  let calls = 0
                  const faultyIo: ToolBuild.CaptureIo = {
                    ...ToolBuild.defaultCaptureIo,
                    lstat: async (p) => {
                      calls++
                      if (calls >= 2) throw Object.assign(new Error("EACCES"), { code: "EACCES" })
                      return ToolBuild.defaultCaptureIo.lstat(p)
                    }
                  }
                  await expect(ToolBuild.measureOutput(root, ".", "dist", { io: faultyIo })).rejects.toThrow()
                } else if (faultCase === "io-readdir-fail") {
                  const faultyIo: ToolBuild.CaptureIo = {
                    ...ToolBuild.defaultCaptureIo,
                    readdir: async () => {
                      throw Object.assign(new Error("EACCES"), { code: "EACCES" })
                    }
                  }
                  await expect(ToolBuild.measureOutput(root, ".", "dist", { io: faultyIo })).rejects.toThrow(
                    /could not be listed/
                  )
                } else if (faultCase === "safefs-eloop") {
                  const filePath = NodePath.join(outDir, "a.txt")
                  const faultyIo: SafeFs.Io = {
                    ...SafeFs.defaultIo,
                    open: async () => {
                      throw Object.assign(new Error("ELOOP"), { code: "ELOOP" })
                    }
                  }
                  await expect(SafeFs.readText(filePath, { root, io: faultyIo })).rejects.toThrow(/symbolic link/)
                } else if (faultCase === "safefs-replaced") {
                  const filePath = NodePath.join(outDir, "a.txt")
                  const faultyIo: SafeFs.Io = {
                    ...SafeFs.defaultIo,
                    open: async (p) => {
                      const h = await SafeFs.defaultIo.open(p)
                      return {
                        ...h,
                        stat: async () => {
                          const s = await h.stat()
                          return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: BigInt(999999999) })
                        }
                      }
                    }
                  }
                  await expect(SafeFs.readText(filePath, { root, io: faultyIo })).rejects.toThrow(/replaced/)
                } else if (faultCase === "safefs-close-fail") {
                  const filePath = NodePath.join(outDir, "a.txt")
                  const faultyIo: SafeFs.Io = {
                    ...SafeFs.defaultIo,
                    open: async (p) => {
                      const h = await SafeFs.defaultIo.open(p)
                      return {
                        read: h.read.bind(h),
                        stat: h.stat.bind(h),
                        close: async () => {
                          await h.close()
                          throw new Error("close-boom")
                        }
                      }
                    }
                  }
                  await expect(SafeFs.readText(filePath, { root, io: faultyIo })).rejects.toThrow(/could not be closed/)
                } else if (faultCase === "safefs-dir-replaced") {
                  let statCount = 0
                  const faultyIo: SafeFs.Io = {
                    ...SafeFs.defaultIo,
                    lstat: async (p) => {
                      statCount++
                      const s = await SafeFs.defaultIo.lstat(p)
                      if (statCount >= 2 && p === outDir) {
                        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: BigInt(888888888) })
                      }
                      return s
                    }
                  }
                  const dirEntry = await SafeFs.resolveDirectory(outDir, { root })
                  await expect(SafeFs.listDirectory(outDir, dirEntry!, { root, io: faultyIo })).rejects.toThrow(
                    /replaced/
                  )
                }
              })
              return true
            }),
          { executions: Math.max(fsExecutions, 20), seed: seed + 3 }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it(
    "SecretProxy.startProxy handles credentials in URL, oversized Content-Length, unknown brokered origin & loopback forwarding",
    async () => {
      let lastAuth = ""
      const upstream = Http.createServer((req, res) => {
        lastAuth = String(req.headers["authorization"] ?? "")
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(`seen:${lastAuth}`)
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
      const addr = upstream.address() as { readonly port: number }
      const upstreamOrigin = `http://127.0.0.1:${addr.port}`

      const vault = SecretProxy.makeVault({
        read: (
          name
        ) => (name === "API_KEY"
          ? "super-secret-value-123"
          : name === "DEST_OK"
          ? `${upstreamOrigin}/hook?k=1`
          : name === "DEST_BAD"
          ? "ftp://bad.invalid"
          : name === "DEST_NOTURL"
          ? ":::not-a-url"
          : undefined)
      })
      const cred = Secret.HttpSecret(Secret.Secret("API_KEY"), [upstreamOrigin])
      const minted = vault.mint(cred)
      const proxy = await SecretProxy.startProxy(vault)

      try {
        const brokered = await proxy.originFor(upstreamOrigin)
        const destOkUrl = proxy.urlFor(Secret.Secret("DEST_OK"))
        const destBadUrl = proxy.urlFor(Secret.Secret("DEST_BAD"))
        const destNotUrl = proxy.urlFor(Secret.Secret("DEST_NOTURL"))
        const destMissingUrl = proxy.urlFor(Secret.Secret("DEST_MISSING"))
        const arb = Arbitrary.schema(
          Schema.Struct({
            reqCase: Schema.Literals([
              "cred-in-url",
              "too-large-cl",
              "denied-audience",
              "broker-ok",
              "urlfor-ok",
              "urlfor-bad-proto",
              "urlfor-not-url",
              "urlfor-missing",
              "urlfor-404",
              "bad-abs-url",
              "bad-proto-url"
            ])
          })
        )
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ reqCase }) =>
              Effect.promise(async () => {
                const proxyUrl = new URL(proxy.endpoint)
                if (reqCase === "cred-in-url") {
                  const status = await new Promise<number>((resolve, reject) => {
                    const req = Http.request(
                      {
                        host: proxyUrl.hostname,
                        port: Number(proxyUrl.port),
                        method: "GET",
                        path: "http://user:pass@example.com/x"
                      },
                      (res) => {
                        res.resume()
                        resolve(res.statusCode ?? 0)
                      }
                    )
                    req.on("error", reject)
                    req.end()
                  })
                  expect(status).toBe(400)
                } else if (reqCase === "too-large-cl") {
                  const status = await new Promise<number>((resolve, reject) => {
                    const req = Http.request(
                      {
                        host: proxyUrl.hostname,
                        port: Number(proxyUrl.port),
                        method: "POST",
                        path: `${upstreamOrigin}/big`,
                        headers: { "content-length": String(SecretProxy.maximumRequestBodyBytes + 10) }
                      },
                      (res) => {
                        res.resume()
                        resolve(res.statusCode ?? 0)
                      }
                    )
                    req.on("error", reject)
                    req.end()
                  })
                  expect(status).toBe(413)
                } else if (reqCase === "denied-audience") {
                  const status = await new Promise<number>((resolve, reject) => {
                    const req = Http.request(
                      {
                        host: proxyUrl.hostname,
                        port: Number(proxyUrl.port),
                        method: "GET",
                        path: "http://denied.invalid/x",
                        headers: { authorization: `Bearer ${minted}` }
                      },
                      (res) => {
                        res.resume()
                        resolve(res.statusCode ?? 0)
                      }
                    )
                    req.on("error", reject)
                    req.end()
                  })
                  expect(status).toBe(403)
                } else if (reqCase === "broker-ok") {
                  const body = await fetch(`${brokered}/ok`, {
                    headers: { authorization: `Bearer ${minted}` }
                  }).then((r) => r.text())
                  expect(lastAuth).toBe("Bearer super-secret-value-123")
                  expect(body).toBe(`seen:Bearer ${minted}`)
                } else if (reqCase === "urlfor-ok") {
                  const res = await fetch(destOkUrl)
                  expect(res.status).toBe(200)
                } else if (reqCase === "urlfor-bad-proto") {
                  const res = await fetch(destBadUrl)
                  expect(res.status).toBe(502)
                } else if (reqCase === "urlfor-not-url") {
                  const res = await fetch(destNotUrl)
                  expect(res.status).toBe(502)
                } else if (reqCase === "urlfor-missing") {
                  const res = await fetch(destMissingUrl)
                  expect(res.status).toBe(502)
                } else if (reqCase === "urlfor-404") {
                  const res = await fetch(`${proxy.endpoint}/.well-known/smithers-secret-url/nonexistent`)
                  expect(res.status).toBe(404)
                } else if (reqCase === "bad-abs-url") {
                  const res = await fetch(`${proxy.endpoint}/relative-only`)
                  expect(res.status).toBe(400)
                } else {
                  const status = await new Promise<number>((resolve, reject) => {
                    const req = Http.request(
                      {
                        host: proxyUrl.hostname,
                        port: Number(proxyUrl.port),
                        method: "GET",
                        path: "ftp://example.com/a"
                      },
                      (res) => {
                        res.resume()
                        resolve(res.statusCode ?? 0)
                      }
                    )
                    req.on("error", reject)
                    req.end()
                  })
                  expect(status).toBe(400)
                }
                return true
              }),
            { executions: Math.min(executions, 20), seed: seed + 4 }
          )
        )
        assertPassed(report)
      } finally {
        await proxy.close()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    },
    30_000
  )
})
