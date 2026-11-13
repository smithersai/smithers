import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { compileFunction } from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Clean } from "../src/Compose.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const runLive = async (workspaceRoot: string, payload: Filegroup.Payload): Promise<Filegroup.Files> => {
  type Registered = (
    payload: Filegroup.Payload,
    executionId: string
  ) => Effect.Effect<Filegroup.Files, Filegroup.FilegroupError>
  let registered: Registered | undefined
  const runtime = FlowRuntime.FlowRuntime.of(
    {
      register: (_flow: unknown, execute: Registered) =>
        Effect.sync(() => {
          registered = execute
        }),
      actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
        Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
    } as unknown as FlowRuntime.FlowRuntime["Service"]
  )
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Layer.build(
      Filegroup.ExpandFilegroupLive({ workspaceRoot }).pipe(
        Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
      )
    )
    if (registered === undefined) throw new Error("filegroup action was not registered")
    const instance = FlowRuntime.FlowInstance.of({
      executionId: "filegroup-live-test",
      actionState: {
        count: 0,
        latch: Latch.makeUnsafe()
      }
    } as never)
    return yield* registered(payload, "filegroup-live-test").pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provideService(FlowRuntime.FlowRuntime, runtime)
    )
  })))
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-filegroup-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("Filegroup metadata", () => {
  it("joins no verb and stays addressable", () => {
    const group = Filegroup.Filegroup({ srcs: [Input.glob("src/**/*.ts")] })
    const metadata = Target.metadata(group)
    expect(metadata.target).toBe("Filegroup")
    expect(metadata.kinds).toEqual([])
    expect(Target.isTarget(group)).toBe(true)
    expect(Filegroup.isFilegroup(group)).toBe(true)
    expect(Filegroup.isFilegroup(Input.glob("src/**/*.ts"))).toBe(false)
  })

  it("records declared sources as inputs and nested groups as dependencies", () => {
    const nested = Filegroup.Filegroup({ srcs: [Input.file("a.ts")] })
    const group = Filegroup.Filegroup({ srcs: [nested, Input.glob("src/**/*.ts")] })
    const metadata = Target.metadata(group)
    expect(metadata.inputs).toEqual([Input.glob("src/**/*.ts")])
    expect(metadata.dependencies).toEqual([nested])
  })
})

const outsidePackage: Target.ImplementationContext = { sourceFile: undefined, packageDirectory: undefined }

const declareGroup = (directory: string, attrs: Parameters<typeof Filegroup.Filegroup>[0]): Target.AnyTarget =>
  compileFunction("return make(attrs)", ["make", "attrs"], {
    filename: NodePath.join(root, directory, "PACKAGE.ts")
  })(Filegroup.Filegroup, attrs) as Target.AnyTarget

describe("Filegroup.sources", () => {
  it("resolves an explicit cwd against the workspace instead of the declaration context", () => {
    const group = Filegroup.Filegroup({
      srcs: [
        Input.file("index.ts"),
        Input.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] }),
        Input.file("//root.ts")
      ],
      cwd: "packages/a"
    })
    expect(Filegroup.sources(Target.metadata(group).attrs as Filegroup.Attrs, {
      sourceFile: NodePath.join(root, "tools/PACKAGE.ts"),
      packageDirectory: NodePath.join(root, "tools")
    })).toEqual([
      { base: "", source: Input.file("packages/a/index.ts") },
      { base: "", source: Input.glob("packages/a/src/**/*.ts", { exclude: ["packages/a/src/**/*.gen.ts"] }) },
      { base: "", source: Input.file("root.ts") }
    ])
  })

  it("composes groups into a transitive union in srcs order", () => {
    const leaf = Filegroup.Filegroup({ srcs: [Input.file("leaf.ts")], cwd: "packages/leaf" })
    const middle = Filegroup.Filegroup({ srcs: [leaf, Input.file("middle.ts")], cwd: "packages/middle" })
    const top = Filegroup.Filegroup({ srcs: [Input.file("top.ts"), middle], cwd: "packages/top" })
    expect(Filegroup.sources(Target.metadata(top).attrs as Filegroup.Attrs, outsidePackage)).toEqual([
      { base: "", source: Input.file("packages/top/top.ts") },
      { base: "", source: Input.file("packages/leaf/leaf.ts") },
      { base: "", source: Input.file("packages/middle/middle.ts") }
    ])
  })

  it("enters a shared group once and retains each group's own declaration anchor", () => {
    const shared = declareGroup("packages/shared", { srcs: [Input.file("shared.ts")] })
    const left = declareGroup("packages/left", { srcs: [shared, Input.file("left.ts")] })
    const right = declareGroup("packages/right", { srcs: [shared, Input.file("right.ts")] })
    const diamond = Filegroup.Filegroup({ srcs: [left, right, Input.file("top.ts")] })
    const attrs = Target.metadata(diamond).attrs as Filegroup.Attrs
    const context = {
      sourceFile: NodePath.join(root, "packages/top/PACKAGE.ts"),
      packageDirectory: NodePath.join(root, "packages/top")
    }
    expect(Filegroup.sources(attrs, context)).toEqual([
      { base: NodePath.join(root, "packages/shared"), source: Input.file("shared.ts") },
      { base: NodePath.join(root, "packages/left"), source: Input.file("left.ts") },
      { base: NodePath.join(root, "packages/right"), source: Input.file("right.ts") },
      { base: NodePath.join(root, "packages/top"), source: Input.file("top.ts") }
    ])
    expect(Filegroup.sources(attrs, context)).toEqual(Filegroup.sources(attrs, context))
  })

  it("keeps unscoped groups workspace anchored and non-group targets as dependency edges", () => {
    const other = Clean({ paths: ["dist"] })
    const nested = Filegroup.Filegroup({ srcs: [Input.file("nested.ts")] })
    const group = Filegroup.Filegroup({ srcs: [other, nested, Input.file("only.ts")] })
    expect(Filegroup.sources(Target.metadata(group).attrs as Filegroup.Attrs, outsidePackage)).toEqual([
      { base: "", source: Input.file("nested.ts") },
      { base: "", source: Input.file("only.ts") }
    ])
    expect(Target.metadata(group).dependencies).toEqual([other, nested])
  })
})

describe("Filegroup.expand", () => {
  it("deduplicates by path, sorts, and digests", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write("src/b.ts", "export const b = 2\n")
    const expanded = await Filegroup.expand(root, [
      { _tag: "Glob", pattern: "src/**/*.ts", exclude: [] },
      { _tag: "File", path: "src/a.ts" }
    ])
    expect(expanded.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(expanded.every((entry) => typeof entry.digest === "string")).toBe(true)
  })

  it("is stable across repeated expansion and changes with content", async () => {
    await write("src/a.ts", "export const a = 1\n")
    const sources = [{ _tag: "Glob", pattern: "src/**/*.ts", exclude: [] }] as const
    const first = await Filegroup.expand(root, sources)
    expect(await Filegroup.expand(root, sources)).toEqual(first)
    await write("src/a.ts", "export const a = 2\n")
    expect(await Filegroup.expand(root, sources)).not.toEqual(first)
  })

  it("records a named file that does not exist with a null digest", async () => {
    expect(await Filegroup.expand(root, [{ _tag: "File", path: "missing.ts" }])).toEqual([
      { path: "missing.ts", digest: null }
    ])
  })

  it("never expands into the cache directory", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write(".flows/cache/entry.ts", "export const cached = 1\n")
    const expanded = await Filegroup.expand(root, [
      { _tag: "Glob", pattern: "**/*.ts", exclude: [] }
    ])
    expect(expanded.map((entry) => entry.path)).toEqual(["src/a.ts"])
  })
})

describe("ExpandFilegroupLive", () => {
  it("expands a default-cwd plan from its declaring package instead of the workspace root", async () => {
    await write("a.ts", "export const root = true\n")
    await write("packages/x/a.ts", "export const member = true\n")
    const filename = NodePath.join(root, "packages/x/PACKAGE.ts")
    const declare = compileFunction("return make(attrs)", ["make", "attrs"], { filename })
    const group = declare(Filegroup.Filegroup, { srcs: [Input.file("a.ts")] }) as Target.AnyTarget
    expect(Target.metadata(group).sourceFile).toBe(filename)
    const call = plannedCalls(group)[0]!
    expect(call.action).toBe("smithers-build/filegroup")
    const payload = call.payload as unknown as Filegroup.Payload
    const expected = await Input.digestFiles(root, ["packages/x/a.ts"])
    const first = await runLive(root, payload)
    expect(first).toEqual(expected)
    await write("a.ts", "export const root = false\n")
    expect(await runLive(root, payload)).toEqual(first)
    await write("packages/x/a.ts", "export const member = false\n")
    expect(await runLive(root, payload)).not.toEqual(first)
  })

  it("executes the registered action against real workspace files", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await expect(runLive(root, { sources: [{ base: "", source: Input.file("src/a.ts") }] })).resolves.toEqual([
      { path: "src/a.ts", digest: expect.stringMatching(/^[0-9a-f]{64}$/) }
    ])
  })

  it("expands nested package globs with exclusions, package boundaries and workspace-root references", async () => {
    await write("packages/x/PACKAGE.ts", "// package boundary\n")
    await write("packages/x/src/a.ts", "export const a = 1\n")
    await write("packages/x/src/a.gen.ts", "export const generated = 1\n")
    await write("packages/x/src/ignored.ts", "export const ignored = 1\n")
    await write("packages/x/.gitignore", "src/ignored.ts\n")
    await write("packages/x/src/nested/PACKAGE.ts", "// subpackage boundary\n")
    await write("packages/x/src/nested/hidden.ts", "export const hidden = 1\n")
    await write("packages/y/PACKAGE.ts", "// package boundary\n")
    await write("packages/y/src/b.ts", "export const b = 1\n")
    await write("shared.ts", "export const shared = 1\n")
    await write("assets/explicit.ts", "export const explicit = 1\n")
    const nested = declareGroup("packages/x", {
      srcs: [
        Input.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] }),
        Input.file("//shared.ts"),
        Input.file("missing.ts")
      ]
    })
    const other = declareGroup("packages/y", { srcs: [Input.glob("src/**/*.ts")] })
    const explicit = declareGroup("tools", { srcs: [Input.file("explicit.ts")], cwd: "assets" })
    const group = declareGroup("packages/top", { srcs: [nested, other, nested, explicit, Input.file("//shared.ts")] })
    const payload = plannedCalls(group)[0]!.payload as unknown as Filegroup.Payload
    expect(payload.sources).toEqual([
      { base: NodePath.join(root, "packages/x"), source: Input.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] }) },
      { base: NodePath.join(root, "packages/x"), source: Input.file("//shared.ts") },
      { base: NodePath.join(root, "packages/x"), source: Input.file("missing.ts") },
      { base: NodePath.join(root, "packages/y"), source: Input.glob("src/**/*.ts") },
      { base: "", source: Input.file("assets/explicit.ts") },
      { base: NodePath.join(root, "packages/top"), source: Input.file("//shared.ts") }
    ])
    expect(await runLive(root, payload)).toEqual([
      ...(await Input.digestFiles(root, ["assets/explicit.ts"])),
      { path: "packages/x/missing.ts", digest: null },
      ...(await Input.digestFiles(root, ["packages/x/src/a.ts", "packages/y/src/b.ts", "shared.ts"]))
    ])
  })

  it("accepts the root and a package whose name begins with two dots", async () => {
    await write("entry.ts", "root\n")
    await write("..package/entry.ts", "nested\n")
    expect(
      await runLive(root, {
        sources: [
          { base: root, source: Input.file("entry.ts") },
          { base: NodePath.join(root, "..package"), source: Input.file("entry.ts") }
        ]
      })
    ).toEqual(await Input.digestFiles(root, ["entry.ts", "..package/entry.ts"]))
  })

  it.each(["..", "../outside"])("refuses an anchor outside the workspace: %s", async (base) => {
    await expect(runLive(root, {
      sources: [{ base: NodePath.resolve(root, base), source: Input.file("entry.ts") }]
    })).rejects.toMatchObject({
      _tag: "smithers-build/FilegroupError",
      message: "filegroup source is declared outside the workspace"
    })
  })

  it("maps filesystem failures to the action's stable error tag", async () => {
    await expect(runLive(NodePath.join(root, "missing"), {
      sources: [{ base: "", source: Input.glob("**/*.ts") }]
    })).rejects.toMatchObject({ _tag: "smithers-build/FilegroupError" })
  })
})
