import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Clean } from "../src/Compose.ts"
import * as Filegroup from "../src/Filegroup.vibe"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { runtime } from "./toolchain.ts"

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

describe("Filegroup.sources", () => {
  it("resolves declared sources against the declaring group's cwd", () => {
    const group = Filegroup.Filegroup({
      srcs: [
        Input.file("index.ts"),
        Input.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] }),
        Input.file("//root.ts")
      ],
      cwd: "packages/a"
    })
    expect(Filegroup.sources(Target.metadata(group).attrs as Filegroup.Attrs)).toEqual([
      { _tag: "File", path: "packages/a/index.ts" },
      {
        _tag: "Glob",
        pattern: "packages/a/src/**/*.ts",
        exclude: ["packages/a/src/**/*.gen.ts"]
      },
      { _tag: "File", path: "root.ts" }
    ])
  })

  it("composes groups into a transitive union in srcs order", () => {
    const leaf = Filegroup.Filegroup({ srcs: [Input.file("leaf.ts")], cwd: "packages/leaf" })
    const middle = Filegroup.Filegroup({ srcs: [leaf, Input.file("middle.ts")], cwd: "packages/middle" })
    const top = Filegroup.Filegroup({ srcs: [Input.file("top.ts"), middle], cwd: "packages/top" })
    expect(Filegroup.sources(Target.metadata(top).attrs as Filegroup.Attrs)).toEqual([
      { _tag: "File", path: "packages/top/top.ts" },
      { _tag: "File", path: "packages/leaf/leaf.ts" },
      { _tag: "File", path: "packages/middle/middle.ts" }
    ])
  })

  it("enters a shared group once and is deterministic", () => {
    const shared = Filegroup.Filegroup({ srcs: [Input.file("shared.ts")] })
    const left = Filegroup.Filegroup({ srcs: [shared, Input.file("left.ts")] })
    const right = Filegroup.Filegroup({ srcs: [shared, Input.file("right.ts")] })
    const diamond = Filegroup.Filegroup({ srcs: [left, right] })
    const attrs = Target.metadata(diamond).attrs as Filegroup.Attrs
    expect(Filegroup.sources(attrs)).toEqual([
      { _tag: "File", path: "shared.ts" },
      { _tag: "File", path: "left.ts" },
      { _tag: "File", path: "right.ts" }
    ])
    expect(Filegroup.sources(attrs)).toEqual(Filegroup.sources(attrs))
  })

  it("keeps a target that is not a group as a dependency contributing no files", () => {
    const other = Clean({ paths: ["dist"] })
    const group = Filegroup.Filegroup({ srcs: [other, Input.file("only.ts")] })
    expect(Filegroup.sources(Target.metadata(group).attrs as Filegroup.Attrs)).toEqual([
      { _tag: "File", path: "only.ts" }
    ])
    expect(Target.metadata(group).dependencies).toEqual([other])
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
  it("executes the registered action against real workspace files", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await expect(runLive(root, { sources: [Input.file("src/a.ts")] })).resolves.toEqual([
      { path: "src/a.ts", digest: expect.stringMatching(/^[0-9a-f]{64}$/) }
    ])
  })

  it("maps filesystem failures to the action's stable error tag", async () => {
    await expect(runLive(NodePath.join(root, "missing"), {
      sources: [Input.glob("**/*.ts")]
    })).rejects.toMatchObject({ _tag: "smithers-build/FilegroupError" })
  })
})
