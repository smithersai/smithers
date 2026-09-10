/**
 * The descriptor-to-runtime bridge, seen from the outside.
 *
 * Discovery hands back metadata; this suite is about what the bridge does with
 * it before the engine ever sees a flow. Delegate resolution, annotation
 * lowering, and every refusal happen here, at load time, because a wiring
 * mistake surfaced at dispatch reaches an operator as an empty `AnyOf` defect
 * that names nothing.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Annotations, Flow as CoreFlow, Placement as CorePlacement } from "@smthrs/core"
import * as Digest from "@smthrs/core/Digest"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Node } from "@smthrs/plan"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { execFile } from "node:child_process"
import { relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"
import greetModule from "./fixtures/executable/flows/greet/flow.ts"

const flowsRoot = fileURLToPath(new URL("./fixtures/executable/flows", import.meta.url))
const projectRoot = fileURLToPath(new URL("./fixtures/executable", import.meta.url))
const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const fixturesRoot = fileURLToPath(new URL("./fixtures", import.meta.url))

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** The delegate every fixture that resolves one names. */
const Echo = Flow.make("test/echo", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.flow)
})

/** A second registered flow, so an ambiguous declaration has two real targets. */
const Other = Flow.make("test/other", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.flow)
})

/** The agent driver a descriptor falls back to when it names no single flow. */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.prompt)
})

/**
 * The options every case starts from.
 *
 * `load` is deliberately absent, so the default loader's verified sibling
 * module is the path under test everywhere a fixture module is read. A stand-in is passed only by the
 * cases that need a module no file can contain, such as one with no default
 * export.
 */
const options = (
  overrides: Partial<Executable.Options> = {}
): Executable.Options => ({ delegates: [Echo, Other, Agent], ...overrides })

const scan = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
}).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))), Effect.provide(platform))

const descriptorNamed = (name: string) =>
  Effect.map(scan, (result) => {
    const found = result.entries.find((entry) => entry.name === name)
    expect(found, name).toBeDefined()
    return found as Descriptor.FlowDescriptor
  })

const registryLayer = Registry.layer({
  sources: [{ source: "project", root: flowsRoot, naming: "path" }]
}).pipe(Layer.provide(Layer.merge(Discovery.layer.pipe(Layer.provide(platform)), platform)))

const invocationGolden = {
  flow: "greet",
  input: { name: "world" },
  prompt: "",
  model: null,
  placement: "local",
  placementOptions: null,
  capabilities: ["*"],
  flows: ["test/echo"]
}

const attemptMutation = (mutation: () => void): void => {
  try {
    mutation()
  } catch {
    // Frozen invocation values reject writes in strict mode. Assertions read
    // the envelope again so both throwing and silent hosts prove ownership.
  }
}

describe("delegate resolution", () => {
  for (const name of ["greet", "tuned"]) {
    it.effect(`preserves delegate result codecs through ${name}'s bridge`, () =>
      Effect.gen(function*() {
        class Refused extends Schema.TaggedError<Refused>()("test/Refused", { message: Schema.String }) {}
        const Typed = Flow.make("test/echo", {
          payload: Executable.Invocation,
          success: Schema.NumberFromString,
          error: Refused,
          body: () => Node.succeed(42)
        })
        const descriptor = yield* descriptorNamed(name)
        const executable = yield* Executable.fromDescriptor(descriptor, options({ delegates: [Typed] }))
        const codec = Schema.toCodecJson(
          Flow.Result({ success: executable.flow.successSchema, error: executable.flow.errorSchema })
        )
        const success = new Flow.Complete({ exit: Exit.succeed(42) })
        const encoded = yield* Schema.encodeEffect(codec)(success)
        expect(encoded).toMatchObject({ _tag: "Complete", exit: { _tag: "Success", value: "42" } })
        expect(yield* Schema.decodeEffect(codec)(encoded)).toEqual(success)
        const failed = new Flow.Complete({ exit: Exit.fail(new Refused({ message: "expected refusal" })) })
        const failure = yield* Schema.encodeEffect(codec)(failed)
        const decoded = yield* Schema.decodeEffect(codec)(failure)
        expect(decoded).toEqual(failed)
      }).pipe(Effect.provide(platform)))
  }

  it.effect("delegates to the one flow a descriptor names", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe("test/echo")
      expect(executable.flow._tag).toBe("greet")
    }).pipe(Effect.provide(platform)))

  it.effect("delegates a markdown flow to the flow its frontmatter names", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("changelog")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe("test/echo")
      // The prompt is the rendered body, not the raw file: frontmatter is gone
      // and the skill-resources block a driver reads is present.
      expect(executable.invocation(null).prompt).toContain("Summarize the changes")
      expect(executable.invocation(null).prompt).not.toContain("description:")
    }).pipe(Effect.provide(platform)))

  it.effect("delegates to the agent when a descriptor names no flow", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        name: "bare",
        flows: []
      })
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe(Executable.defaultAgent)
    }).pipe(Effect.provide(platform)))

  it.effect("delegates to the agent a host renamed", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        name: "bare",
        flows: []
      })
      const driver = Flow.make("host/driver", {
        payload: Executable.Invocation,
        success: Schema.String,
        body: (payload) => Node.succeed(payload.flow)
      })
      const executable = yield* Executable.fromDescriptor(
        descriptor,
        options({ delegates: [driver], agent: "host/driver" })
      )
      expect(executable.delegate).toBe("host/driver")
    }).pipe(Effect.provide(platform)))

  it.effect("delegates a model-backed descriptor to the agent even when it names tools", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("undecided")),
        model: Option.some("smart")
      })
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe(Executable.defaultAgent)
      expect(executable.invocation(null).flows).toEqual(["test/echo", "test/other"])
    }).pipe(Effect.provide(platform)))
})

describe("refusals", () => {
  for (const name of ["changelog", "greet"]) {
    it.effect(`refuses an unmeasured ${name} body before invoking a loader`, () =>
      Effect.gen(function*() {
        const measured = yield* descriptorNamed(name)
        const descriptor = new Descriptor.FlowDescriptor({
          ...measured,
          body: { ...measured.body, contentDigest: undefined }
        })
        expect(Descriptor.executionDigest(descriptor)).toBeUndefined()
        let loaded = false
        const failure = yield* Effect.flip(Executable.fromDescriptor(
          descriptor,
          options({
            load: () => {
              loaded = true
              return Effect.succeed({ default: greetModule })
            }
          })
        ))
        expect(loaded).toBe(false)
        expect(failure).toMatchObject({ _tag: "flows/registry/ExecutableError", code: "body_unavailable" })
        expect(failure.message).toContain("unmeasured")
        expect(failure.message).toContain("refresh")
      }).pipe(Effect.provide(platform)))
  }

  it.effect("verifies a percent-encoded file URL and preserves it for the module loader", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".g2-" })
      const sourcePath = `${directory}/flow #100%.ts`
      const bytes = yield* fs.readFile(`${flowsRoot}/greet/flow.ts`)
      yield* fs.writeFile(sourcePath, bytes)
      const url = pathToFileURL(sourcePath).href
      expect(url).toContain("flow%20%23100%25.ts")
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path: url, contentDigest: Digest.digest(bytes) })
      })
      const loadedPaths: Array<string> = []
      const executable = yield* Executable.fromDescriptor(
        descriptor,
        options({
          load: (path, source) => {
            expect(source.bytes).toEqual(bytes)
            expect(source.contentDigest).toBe(Digest.digest(bytes))
            loadedPaths.push(path)
            return Effect.succeed({ default: greetModule })
          }
        })
      )
      expect(loadedPaths).toEqual([url])
      expect(executable.delegate).toBe("test/echo")
    }).pipe(Effect.scoped, Effect.provide(platform)))

  for (const path of ["file://%", "file:///bad%2Fpath.mjs"]) {
    it.effect(`refuses an invalid file URL as body_unavailable: ${path}`, () =>
      Effect.gen(function*() {
        const descriptor = new Descriptor.FlowDescriptor({
          ...(yield* descriptorNamed("greet")),
          body: new Descriptor.BodyRefModule({ path, contentDigest: "0".repeat(64) })
        })
        const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
        expect(failure.code).toBe("body_unavailable")
        expect(failure.path).toBe(path)
        expect(failure.cause).toBeDefined()
      }).pipe(Effect.provide(platform)))
  }

  it.effect("names the missing flow rather than dying inside the engine", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("orphan")
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("missing_delegate")
      expect(failure.delegate).toBe("test/missing")
      expect(failure.flow).toBe("orphan")
      expect(failure.message).toContain("test/missing")
      // The refusal also says what IS registered, so an operator can see the
      // spelling they missed.
      expect(failure.available).toEqual(["agent", "test/echo", "test/other"])
    }).pipe(Effect.provide(platform)))

  /**
   * A delegate is resolved by TAG alone, so nothing at run time re-checks that
   * the flow found under a name can read the envelope the bridge hands it. The
   * type contract is where that is refused: this registration compiles only
   * while `Delegate` accepts a payload other than `Invocation`, so `tsc -p
   * tsconfig.test.json` is the assertion, and it fails if the `any` returns.
   */
  it("does not admit a delegate whose payload is not the invocation envelope", () => {
    const Mismatched = Flow.make("test/mismatched", {
      payload: Schema.Struct({ command: Schema.String }),
      success: Schema.String,
      body: (payload) => Node.succeed(payload.command)
    })

    // @ts-expect-error the envelope has no `command`, so this flow is not a delegate
    const refused: ReadonlyArray<Executable.Delegate> = [Mismatched]

    expect(refused.map((delegate) => delegate._tag)).toEqual(["test/mismatched"])
  })

  it.effect("refuses a declaration with nothing to choose between", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("undecided")
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("ambiguous_delegate")
      expect(failure.message).toContain("undecided")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a markdown body it cannot read", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("changelog")),
        body: new Descriptor.BodyRefMarkdown({
          path: `${flowsRoot}/changelog/absent.mdx`,
          baseDirectory: `${flowsRoot}/changelog`,
          contentDigest: "0".repeat(64)
        })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.path).toBe(`${flowsRoot}/changelog/absent.mdx`)
      expect(failure.message).toContain("absent.mdx")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a module body it cannot read", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path: `${modulesRoot}/absent.mjs`, contentDigest: "0".repeat(64) })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.path).toBe(`${modulesRoot}/absent.mjs`)
      expect(failure.message).toContain("absent.mjs")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a module whose bytes changed after discovery", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({
          path: `${modulesRoot}/plain.mjs`,
          contentDigest: "0".repeat(64)
        })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure).toMatchObject({ code: "body_unavailable", flow: "greet" })
      expect(failure.path).toBe(`${modulesRoot}/plain.mjs`)
      expect(failure.message).toContain("changed")
      expect(failure.message).toContain("refresh")
    }).pipe(Effect.provide(platform)))

  it.effect("loads a measured module from a file URL with the default loader", () =>
    Effect.gen(function*() {
      const measured = yield* descriptorNamed("greet")
      const descriptor = new Descriptor.FlowDescriptor({
        ...measured,
        body: { ...measured.body, path: pathToFileURL(measured.body.path).href }
      })
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.delegate).toBe("test/echo")
      expect(executable.lowered.placement).toEqual(CorePlacement.local())
    }).pipe(Effect.provide(platform)))

  it.effect("accepts a body path already written as a file URL", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({
          path: `file://${modulesRoot}/plain.mjs`,
          contentDigest: Digest.digest(yield* (yield* FileSystem.FileSystem).readFile(`${modulesRoot}/plain.mjs`))
        })
      })
      // The loader reached the module — it refused what the module exports,
      // not the specifier it was given.
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("invalid_module")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a body path that is not absolute", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({
          path: "fixtures/executable/modules/plain.mjs",
          contentDigest: "0".repeat(64)
        })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a module that default-exports something other than a flow", () =>
    Effect.gen(function*() {
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({
          path: `${modulesRoot}/plain.mjs`,
          contentDigest: Digest.digest(yield* (yield* FileSystem.FileSystem).readFile(`${modulesRoot}/plain.mjs`))
        })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("invalid_module")
      expect(failure.path).toBe(`${modulesRoot}/plain.mjs`)
      expect(failure.message).toContain("plain.mjs")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a verified module whose import fails", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".g2-" })
      const path = `${directory}/broken.mjs`
      const bytes = new TextEncoder().encode("throw new Error(\"module import failed\")")
      yield* fs.writeFile(path, bytes)
      const descriptor = new Descriptor.FlowDescriptor({
        ...(yield* descriptorNamed("greet")),
        body: new Descriptor.BodyRefModule({ path, contentDigest: Digest.digest(bytes) })
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, options()))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.cause).toMatchObject({ message: "module import failed" })
      expect(failure.message).toContain("could not be loaded")
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("refuses a module with no default export at all", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(descriptor, options({ load: () => Effect.succeed({}) }))
      )
      expect(failure.code).toBe("invalid_module")
    }).pipe(Effect.provide(platform)))
})

describe("verified module revisions", () => {
  const source = (priority: number) => `
import { Annotations, Flow, Placement } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Schema } from "effect"
import { identity } from "./helper.ts"
export default Flow.make({
  description: "Priority ${priority}",
  input: Schema.Unknown,
  output: Schema.Unknown,
  flows: ["test/echo"]
}).pipe(
  Flow.annotate(Annotations.Priority, identity(${priority})),
  Flow.annotate(CacheEnvironment.CachePolicyAnnotation, { ttlMs: ${priority * 1000}, scope: "shared" }),
  Flow.annotate(Annotations.Placement, Placement.${priority === 7 ? "local" : "sandbox"}())
)
`

  it.effect("adopts edited priority, cache, and placement after registry refresh in one process", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".g4-" })
      yield* fs.makeDirectory(`${root}/flows/revision`, { recursive: true })
      const path = `${root}/flows/revision/flow.ts`
      yield* fs.writeFileString(`${root}/flows/revision/helper.ts`, "export const identity = (n: number) => n")
      yield* fs.writeFileString(path, source(7))
      yield* Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const first = yield* Executable.fromRegistry("revision", options())
        expect(first.lowered.priority).toBe(7)
        yield* fs.writeFileString(path, source(9))
        yield* registry.refresh()
        const second = yield* Executable.fromRegistry("revision", options())
        expect(second.descriptor.body.contentDigest).not.toBe(first.descriptor.body.contentDigest)
        expect(second.lowered.priority).toBe(9)
        expect(second.lowered.cache).toEqual({ ttlMs: 9000, scope: "shared" })
        expect(second.invocation(null).placement).toBe("sandbox")
        expect(yield* fs.readDirectory(`${root}/flows/revision`)).toEqual(["flow.ts", "helper.ts"])
      }).pipe(Effect.provide(Registry.layerProject({ root })))
    }).pipe(Effect.scoped, Effect.provide(platform)))

  for (const filename of ["flow.ts", "flow"]) {
    it.effect(`evaluates verified bytes when ${filename} is replaced after the read`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".g4-" })
        const path = `${root}/${filename}`
        const bytes = new TextEncoder().encode(source(7))
        yield* fs.writeFileString(`${root}/helper.ts`, "export const identity = (n: number) => n")
        yield* fs.writeFile(path, bytes)
        const descriptor = new Descriptor.FlowDescriptor({
          ...(yield* descriptorNamed("greet")),
          body: new Descriptor.BodyRefModule({ path, contentDigest: Digest.digest(bytes) })
        })
        const racingFs = FileSystem.make({
          ...fs,
          readFile: (requested) =>
            fs.readFile(requested).pipe(
              Effect.tap(() => requested === path ? fs.writeFileString(path, source(9)) : Effect.void)
            )
        })
        const executable = yield* Executable.fromDescriptor(descriptor, options()).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFs)
        )
        expect(executable.lowered.priority).toBe(7)
        expect(executable.lowered.cache).toEqual({ ttlMs: 7000, scope: "shared" })
        expect(executable.invocation(null).placement).toBe("local")
        expect(yield* fs.readDirectory(root)).toEqual([filename, "helper.ts"])
      }).pipe(Effect.scoped, Effect.provide(platform)))
  }

  it.live("bounds a stuck top-level await, logs its refusal, and loads the next entry", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".g4-" })
      for (const name of ["aaa-hung", "healthy"]) {
        const directory = `${root}/flows/${name}`
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.writeFileString(`${directory}/helper.ts`, "export const identity = (n: number) => n")
        yield* fs.writeFileString(
          `${directory}/flow.ts`,
          source(7) +
            (name === "aaa-hung" ? "\nawait new Promise(() => {})" : "")
        )
      }
      const logs: Array<string> = []
      const capture = Logger.make((entry) => void logs.push(JSON.stringify(entry.message)))
      const built = yield* Executable.catalog(options({ loadTimeoutMs: 500 })).pipe(
        Effect.provide(Registry.layerProject({ root })),
        Effect.provide(Logger.layer([capture])),
        Effect.timeout(5000)
      )
      expect(built.executables.map((entry) => entry.descriptor.name)).toEqual(["healthy"])
      expect(built.refused).toHaveLength(1)
      expect(built.refused[0]).toMatchObject({
        code: "body_unavailable",
        flow: "aaa-hung",
        path: `${root}/flows/aaa-hung/flow.ts`
      })
      expect(built.refused[0]!.message).toContain("500")
      expect(built.refused[0]!.message).toContain("aaa-hung/flow.ts")
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain("aaa-hung")
      expect(yield* fs.readDirectory(`${root}/flows/aaa-hung`)).toEqual(["flow.ts", "helper.ts"])
    }).pipe(Effect.scoped, Effect.provide(platform)))
})

describe("the module specifier", () => {
  it.each([
    ["backslash", "/repo/we\\ird/flow.ts"],
    ["newline", "/repo/a\nb/flow.ts"],
    ["tab", "/repo/a\tb/flow.ts"],
    ["space", "/repo/a b/flow.ts"],
    ["fragment marker", "/repo/a#b/flow.ts"],
    ["query marker", "/repo/a?b/flow.ts"],
    ["percent", "/repo/a%b/flow.ts"],
    ["non-ASCII", "/repo/üní/flow.ts"],
    ["plain", "/repo/plain/flow.ts"]
  ])("matches pathToFileURL for a %s in a POSIX path", (_label, path) => {
    expect(Executable.fileSpecifier(path)).toBe(pathToFileURL(path).href)
  })

  it("escapes the characters a path and a URL both claim", () => {
    // `#`, `?`, and a literal `%` are legal in a filename and structural in a
    // URL. Concatenating one truncates the specifier at it, so the loader
    // addresses a shorter path and reports a module that is right there as
    // missing.
    expect(Executable.fileSpecifier("/flows/rev#2/flow.ts")).toBe("file:///flows/rev%232/flow.ts")
    expect(Executable.fileSpecifier("/flows/a?b/flow.ts")).toBe("file:///flows/a%3Fb/flow.ts")
    // `%` is escaped FIRST, so a path that already contains `%23` survives as
    // a literal instead of decoding back into a `#`.
    expect(Executable.fileSpecifier("/flows/a%23b/flow.ts")).toBe("file:///flows/a%2523b/flow.ts")
    // Anything already written as a specifier is the caller's own, untouched.
    expect(Executable.fileSpecifier("file:///flows/greet/flow.ts")).toBe("file:///flows/greet/flow.ts")
  })

  it("keeps a Windows drive path and a rootless path addressable", () => {
    // A drive path is the one case where a backslash is a separator rather
    // than a legal filename character, so it becomes `/` before escaping.
    // `pathToFileURL` is not the oracle here: on POSIX it reads `C:\...` as a
    // relative name and resolves it against the process directory.
    expect(Executable.fileSpecifier("C:\\repo\\flow.ts")).toBe("file:///C:/repo/flow.ts")
    expect(Executable.fileSpecifier("C:/repo/we\\ird.ts")).toBe("file:///C:/repo/we/ird.ts")
    // A rootless path is not an absolute filesystem path, and the loader
    // resolves one against the ambient `Path` service before it reaches here.
    // Reaching this conversion with one anyway still produces a specifier a
    // loader can report, rather than a bare `file:` scheme.
    expect(Executable.fileSpecifier("flows/greet/flow.ts")).toBe("file:///flows/greet/flow.ts")
  })

  it("builds a specifier Node's own loader resolves", async () => {
    // The default loader's `import` runs under whatever loader the host has,
    // and this suite's is vite-node, which resolves neither form. So the proof
    // is Node itself: a real subprocess, the real ESM resolver, the production
    // specifier, and a fixture that really does live under a directory named
    // `rev#2`.
    const specifier = Executable.fileSpecifier(`${modulesRoot}/rev#2/plain.mjs`)
    const loaded = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(specifier)}); process.stdout.write(m.default.notAFlow)`
        ],
        (error, stdout, stderr) => error === null ? resolve(stdout) : reject(new Error(stderr))
      )
    })
    expect(loaded).toBe("rev#2")
  })
})

describe("annotation lowering", () => {
  it.effect("reads the cache policy, the priority, and the placement a body declares", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("tuned")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.lowered.cache).toEqual({ ttlMs: 60_000, scope: "shared" })
      expect(executable.lowered.priority).toBe(7)
      expect(executable.lowered.placement).toEqual(CorePlacement.sandbox())
    }).pipe(Effect.provide(platform)))

  it.effect("puts the policy under the identifier the engine reads at dispatch", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("tuned")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      // The declaration and the dispatch name ONE key. This assertion is the
      // drift guard: it reads the bridge's bag back with `@smthrs/flow`'s own
      // reader, so it fails the moment the two identifiers stop matching.
      expect(CacheEnvironment.cachePolicyOf(executable.flow.annotations)).toEqual({
        ttlMs: 60_000,
        scope: "shared"
      })
    }).pipe(Effect.provide(platform)))

  it.effect("carries the placement into the plan and into the delegate's envelope", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("tuned")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(Context.getOption(executable.flow.annotations, Flow.Placement)).toEqual(
        Option.some(CorePlacement.sandbox())
      )
      expect(executable.invocation(null).placement).toBe("sandbox")
      expect(executable.invocation(null).placementOptions).toBeNull()
    }).pipe(Effect.provide(platform)))

  it.effect("prefers a placement the body annotates over the descriptor's directive", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const annotated = CoreFlow.within(greetModule, CorePlacement.remote({ profile: "builder" }))
      const executable = yield* Executable.fromDescriptor(
        descriptor,
        options({ load: () => Effect.succeed({ default: annotated }) })
      )
      expect(executable.lowered.placement).toEqual(CorePlacement.remote({ profile: "builder" }))
      const invocation = executable.invocation(null)
      expect(invocation.placement).toBe("remote")
      expect(invocation.placementOptions).toEqual({ profile: "builder" })
      expect(Object.isFrozen(invocation.placementOptions)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("round trips every lowered placement through the Invocation schema", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const variants: ReadonlyArray<
        readonly [
          CorePlacement.Placement,
          Executable.Invocation["placement"],
          Executable.Invocation["placementOptions"]
        ]
      > = [
        [CorePlacement.client(), "client", null],
        [CorePlacement.local(), "local", null],
        [CorePlacement.sandbox({ image: "registry-sandbox:latest" }), "sandbox", {
          image: "registry-sandbox:latest"
        }],
        [CorePlacement.remote({ profile: "builder", target: "control-plane" }), "remote", {
          profile: "builder",
          target: "control-plane"
        }]
      ]

      for (const [placement, kind, placementOptions] of variants) {
        const annotated = CoreFlow.within(greetModule, placement)
        const executable = yield* Executable.fromDescriptor(
          descriptor,
          options({ load: () => Effect.succeed({ default: annotated }) })
        )
        const invocation = executable.invocation({ variant: kind })
        const encoded = Schema.encodeUnknownSync(Executable.Invocation)(invocation)
        const decoded = Schema.decodeUnknownSync(Executable.Invocation)(encoded)
        expect(encoded).toMatchObject({ placement: kind, placementOptions })
        expect(decoded).toEqual(invocation)
      }
    }).pipe(Effect.provide(platform)))

  /**
   * Hosts pass `Invocation` itself as an `Action.make` payload schema
   * (`examples/src/16-fan-out-fan-in.ts`, `examples/src/24-control-plane-and-gateway.ts`),
   * so an envelope is decoded again from the journal on replay. A row written
   * before `placementOptions` existed carries no such key, and a required key
   * would fail that replay. The decoding default is what keeps it readable.
   */
  it("decodes a journal row written before placementOptions existed", () => {
    const journaled = {
      flow: "greet",
      input: null,
      prompt: "",
      model: null,
      placement: "sandbox",
      capabilities: ["fs:read"],
      flows: []
    }

    const decoded = Schema.decodeUnknownSync(Executable.Invocation)(journaled)

    expect(decoded.placementOptions).toBeNull()
    expect(decoded.placement).toBe("sandbox")
  })

  it("still decodes an explicit placementOptions and re-encodes the key", () => {
    const journaled = {
      flow: "greet",
      input: null,
      prompt: "",
      model: null,
      placement: "remote",
      placementOptions: { profile: "builder", target: "control-plane" },
      capabilities: [],
      flows: []
    }

    const decoded = Schema.decodeUnknownSync(Executable.Invocation)(journaled)

    expect(decoded.placementOptions).toEqual({ profile: "builder", target: "control-plane" })
    // Encoding is untouched by the decoding default, so the step key an
    // envelope carrying a placement hashes to does not move.
    expect(Schema.encodeUnknownSync(Executable.Invocation)(decoded)).toMatchObject({
      placementOptions: { profile: "builder", target: "control-plane" }
    })
  })

  it.effect("lowers every placement literal a descriptor can carry", () =>
    Effect.gen(function*() {
      const base = yield* descriptorNamed("greet")
      const lowered = (placement: Descriptor.Placement) =>
        Executable.lower(
          new Descriptor.FlowDescriptor({ ...base, placement: Option.some(placement) }),
          Context.empty()
        ).placement
      expect(lowered("client")).toEqual(CorePlacement.client())
      expect(lowered("local")).toEqual(CorePlacement.local())
      expect(lowered("sandbox")).toEqual(CorePlacement.sandbox())
      expect(lowered("remote")).toEqual(CorePlacement.remote())
    }).pipe(Effect.provide(platform)))

  /**
   * The envelope does not re-spell the descriptor's placements; it carries the
   * descriptor's own schema. A hand-copied second list passes the round trip
   * above while it happens to agree, and stops agreeing silently the day a
   * placement is added on one side only, so the reuse is pinned by identity.
   */
  it("spells the envelope's placement with the descriptor's own schema", () => {
    expect(Executable.Invocation.fields.placement.members[0]).toBe(Descriptor.Placement)
  })

  it.effect("carries every descriptor placement through lower and the envelope", () =>
    Effect.gen(function*() {
      const base = yield* descriptorNamed("greet")
      for (const placement of Descriptor.Placement.literals) {
        const lowered = Executable.lower(
          new Descriptor.FlowDescriptor({ ...base, placement: Option.some(placement) }),
          Context.empty()
        ).placement
        expect(lowered, placement).toBeDefined()
        const decoded = Schema.decodeUnknownSync(Executable.Invocation)({ ...invocationGolden, placement })
        expect(decoded.placement, placement).toBe(placement)
        expect(Schema.encodeUnknownSync(Executable.Invocation)(decoded)).toMatchObject({ placement })
      }
    }).pipe(Effect.provide(platform)))

  it.effect("leaves an undeclared policy, priority, and placement undeclared", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("changelog")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      expect(executable.lowered.cache).toBeUndefined()
      expect(executable.lowered.priority).toBeUndefined()
      expect(executable.lowered.placement).toBeUndefined()
      expect(Context.getOption(executable.flow.annotations, Flow.Placement)).toEqual(Option.none())
    }).pipe(Effect.provide(platform)))

  it.effect("puts an authored priority on the delegating node", () =>
    Effect.gen(function*() {
      const tuned = yield* Executable.fromDescriptor(yield* descriptorNamed("tuned"), options())
      const plain = yield* Executable.fromDescriptor(yield* descriptorNamed("greet"), options())
      const priorityOf = (flow: Flow.Any) =>
        Graph.drafts(Graph.build(flow, { input: null })).map((draft) => draft.priority ?? 0)
      // The root is the flow's own call and states none; the delegating node
      // beneath it carries what the body declared.
      expect(priorityOf(tuned.flow)).toContain(7)
      expect(priorityOf(plain.flow).every((priority) => priority === 0)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("makes a changed policy a changed step key", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const withPolicy = (policy: CacheEnvironment.CachePolicy | undefined) =>
        Executable.fromDescriptor(
          descriptor,
          options({
            load: () =>
              Effect.succeed({
                default: policy === undefined
                  ? greetModule
                  : CoreFlow.annotate(greetModule, CacheEnvironment.CachePolicyAnnotation, policy)
              })
          })
        )
      const keys = (flow: Flow.Any) =>
        Graph.drafts(Graph.build(flow, { input: null })).map((draft) => JSON.stringify(draft.material))
      const first = yield* withPolicy({ ttlMs: 1000 })
      const same = yield* withPolicy({ ttlMs: 1000 })
      const other = yield* withPolicy({ ttlMs: 2000 })
      const none = yield* withPolicy(undefined)
      expect(keys(first.flow)).toEqual(keys(same.flow))
      expect(keys(first.flow)).not.toEqual(keys(other.flow))
      // An undeclared policy captures nothing, so a flow that never declared
      // one keys exactly as it did before the policy existed.
      // And the two plans are not the same plan. A declared policy makes the
      // delegation one dispatched action the engine can record; without one the
      // delegate's own call is the plan, exactly as it was before a policy
      // could be declared at all.
      expect(keys(none.flow)).not.toEqual(keys(first.flow))
      expect(keys(first.flow).some((material) => material.includes(`"action":"registry/greet"`))).toBe(true)
      expect(keys(none.flow).some((material) => material.includes(`"flow":"test/echo"`))).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("lowers a priority a flow states through Node.priority on its body", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const bag = Context.add(Context.empty(), Annotations.Priority, -3)
      expect(Executable.lower(descriptor, bag).priority).toBe(-3)
    }).pipe(Effect.provide(platform)))
})

describe("the host's catalog", () => {
  it.effect("makes every runnable discovered flow available and reports the rest", () =>
    Effect.gen(function*() {
      const built = yield* Executable.catalog(options())
      expect(built.executables.map((executable) => executable.descriptor.name).sort()).toEqual([
        "cacheable",
        "cacheable-expiring",
        "cacheable-plain",
        "cacheable-reads",
        "cacheable-scoped",
        "changelog",
        "greet",
        "scoped",
        "tuned"
      ])
      expect(built.refused.map((failure) => `${failure.flow}:${failure.code}`).sort()).toEqual([
        "orphan:missing_delegate",
        "undecided:ambiguous_delegate"
      ])
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("reports a defective entry instead of failing the whole catalog", () =>
    Effect.gen(function*() {
      // Every module body is now unreadable; only the markdown flow survives.
      // `flows/` is a directory a person edits, so one entry being broken is an
      // ordinary state, and taking the host's other flows down with it would
      // make `ls` and every unrelated `up` fail for an unrelated typo.
      const built = yield* Executable.catalog(options({ load: () => Effect.succeed({}) }))
      expect(built.executables.map((executable) => executable.descriptor.name)).toEqual(["changelog"])
      expect(built.refused.map((failure) => `${failure.flow}:${failure.code}`).sort()).toEqual([
        "cacheable-expiring:invalid_module",
        "cacheable-plain:invalid_module",
        "cacheable-reads:invalid_module",
        "cacheable-scoped:invalid_module",
        "cacheable:invalid_module",
        "greet:invalid_module",
        "orphan:missing_delegate",
        "scoped:invalid_module",
        "tuned:invalid_module",
        "undecided:ambiguous_delegate"
      ])
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("looks one flow up by registry name", () =>
    Effect.gen(function*() {
      const executable = yield* Executable.fromRegistry("greet", options())
      expect(executable.delegate).toBe("test/echo")
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("fails a name the registry does not hold", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Executable.fromRegistry("absent", options()))
      expect(failure._tag).toBe("flows/registry/RegistryError")
    }).pipe(Effect.provide(registryLayer), Effect.provide(platform)))
})

describe("the project registry", () => {
  it("retains the project constructor compatibility alias", () => {
    expect(Executable.layerProject).toBe(Registry.layerProject)
  })

  it.effect("loads a module discovered through a relative project root", () =>
    Effect.gen(function*() {
      const executable = yield* Executable.fromRegistry("greet", options())
      expect(executable.delegate).toBe("test/echo")
      expect(executable.invocation({ name: "relative" }).input).toEqual({ name: "relative" })
    }).pipe(
      Effect.provide(Registry.layerProject({ root: relative(process.cwd(), projectRoot) })),
      Effect.provide(platform)
    ))

  it.effect("discovers a project's own flows", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const names = (yield* registry.list()).map((entry) => entry.name).sort()
      expect(names).toEqual([
        "cacheable",
        "cacheable-expiring",
        "cacheable-plain",
        "cacheable-reads",
        "cacheable-scoped",
        "changelog",
        "greet",
        "orphan",
        "scoped",
        "tuned",
        "undecided"
      ])
    }).pipe(
      Effect.provide(Registry.layerProject({ root: projectRoot })),
      Effect.provide(platform)
    ))

  it.effect("treats a project with no flows directory as a project with no flows", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      expect(yield* registry.list()).toEqual([])
    }).pipe(
      Effect.provide(Registry.layerProject({ root: `${projectRoot}/absent` })),
      Effect.provide(platform)
    ))

  it.effect("scans installed packs beside the project's own flows, local packs first", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const entries = yield* registry.list()
      const names = entries.map((entry) => entry.name)
      expect(names).toContain("greet")
      expect(names).toContain("pdf")
      expect(names).toContain("template-skill")
      // Pack entries carry the pack they came from. A host that cannot say
      // which pack a flow arrived in cannot answer "why is this here" or
      // "which pack do I uninstall".
      const pdf = entries.find((entry) => entry.name === "pdf")
      expect(pdf?.provenance.pack?.name).toBe("fixtures")
      expect(pdf?.provenance.pack?.origin).toBe("local")
      // The project's own flows are not pack flows.
      expect(entries.find((entry) => entry.name === "greet")?.provenance.pack).toBeUndefined()
    }).pipe(
      Effect.provide(
        Registry.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixturesRoot,
                origin: "installed",
                manifest: { name: "installed", version: "1.0.0", flows: ["foreign"] } as never
              },
              {
                dir: fixturesRoot,
                origin: "local",
                manifest: { name: "fixtures", version: "1.0.0", flows: ["foreign"] } as never
              }
            ]
          }
        })
      ),
      Effect.provide(platform)
    ))

  it.effect("reports a name two packs both define as shadowed, naming both", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const warnings = yield* registry.warnings()
      const shadowed = warnings.filter((warning) => warning.code === "shadowed")
      // Two packs over one directory define the same names. The `local` pack
      // wins whatever order the host listed them in, and the loser is named:
      // `duplicate_name` would say only "kept the first", which is the caller's
      // order and not the rule that actually decided.
      expect(shadowed.length).toBeGreaterThan(0)
      expect(shadowed[0]!.message).toContain("fixtures@1.0.0 (local)")
      expect(shadowed[0]!.message).toContain("installed@1.0.0 (installed)")
    }).pipe(
      Effect.provide(
        Registry.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixturesRoot,
                origin: "installed",
                manifest: { name: "installed", version: "1.0.0", flows: ["foreign"] } as never
              },
              {
                dir: fixturesRoot,
                origin: "local",
                manifest: { name: "fixtures", version: "1.0.0", flows: ["foreign"] } as never
              }
            ]
          }
        })
      ),
      Effect.provide(platform)
    ))

  it.effect("names the pack when it declares a flows directory it does not ship", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.provide(
        Effect.void,
        Registry.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: projectRoot,
              origin: "installed",
              manifest: { name: "broken", version: "1.0.0", flows: ["does-not-exist"] } as never
            }]
          }
        })
      ))
      // The regression this pins: the missing root used to be caught as "this
      // project has no flows", replacing the WHOLE registry with an empty one,
      // so the project's own five flows silently disappeared behind one
      // defective pack.
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("invalid_pack")
      expect(JSON.stringify(exit)).toContain("broken@1.0.0")
    }).pipe(Effect.provide(platform)))

  it.effect("fails loudly when the project root cannot be read at all", () =>
    Effect.gen(function*() {
      const unreadable = Layer.succeed(FileSystem.FileSystem)(FileSystem.makeNoop({
        exists: () =>
          Effect.fail(
            PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "exists" })
          )
      }))
      const failure = yield* Effect.flip(Effect.provide(
        Effect.void,
        Registry.layerProject({ root: projectRoot }).pipe(Layer.provide(Layer.merge(unreadable, NodePath.layer)))
      ))
      // "I could not look" is not "there is nothing there". Reporting an
      // unreadable root as an empty project would hide every flow behind a
      // permissions mistake.
      expect(failure.code).toBe("read_failed")
      expect(failure.path).toBe(`${projectRoot}/flows`)
    }))

  it.effect("keeps a pack's flows when the project has no flows directory of its own", () =>
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const names = (yield* registry.list()).map((entry) => entry.name)
      expect(names).toContain("pdf")
    }).pipe(
      Effect.provide(
        Registry.layerProject({
          root: `${projectRoot}/absent`,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: fixturesRoot,
              origin: "local",
              manifest: { name: "fixtures", version: "1.0.0", flows: ["foreign"] } as never
            }]
          }
        })
      ),
      Effect.provide(platform)
    ))

  it.effect("dies on a pack source that is not a directory", () =>
    Effect.gen(function*() {
      const built = yield* Effect.exit(Effect.provide(
        Effect.void,
        Registry.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: modulesRoot,
              origin: "local",
              manifest: { name: "broken", version: "1.0.0", flows: ["plain.mjs"] } as never
            }]
          }
        })
      ))
      expect(built._tag).toBe("Failure")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a pack this runtime is too old for", () =>
    Effect.gen(function*() {
      const registry = yield* Effect.exit(Effect.provide(
        Effect.void,
        Registry.layerProject({
          root: projectRoot,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: projectRoot,
              origin: "installed",
              manifest: {
                name: "future",
                version: "2.0.0",
                flows: ["flows"],
                requires: { smithers: ">=9.0.0" }
              } as never
            }]
          }
        })
      ))
      expect(registry._tag).toBe("Failure")
    }).pipe(Effect.provide(platform)))
})

describe("the delegating body", () => {
  it.effect("owns every mutable value in each invocation", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      const input = { nested: { values: ["original"] } }
      const first = executable.invocation(input)

      attemptMutation(() => (first.capabilities as Array<string>).push("fs:write:**"))
      attemptMutation(() => (first.flows as Array<string>).push("test/other"))
      attemptMutation(() => {
        ;(first.input as { nested: { values: Array<string> } }).nested.values.push("mutated")
      })

      const second = executable.invocation(input)
      expect(input).toEqual({ nested: { values: ["original"] } })
      expect(second.capabilities).toEqual(["*"])
      expect(second.flows).toEqual(["test/echo"])
      expect(second.input).toEqual({ nested: { values: ["original"] } })
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.capabilities)).toBe(true)
      expect(Object.isFrozen(first.flows)).toBe(true)
      expect(Object.isFrozen(first.input)).toBe(true)
      expect(Object.isFrozen((first.input as { nested: object }).nested)).toBe(true)
      expect(Object.isFrozen((first.input as { nested: { values: object } }).nested.values)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("keeps asynchronous delegate input stable after the caller mutates its object", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      const input = { nested: { values: ["original"] } }
      const readAfterYield = async (invocation: Executable.Invocation) => {
        await Promise.resolve()
        return invocation.input
      }

      const pending = readAfterYield(executable.invocation(input))
      input.nested.values.push("mutated")
      const observed = yield* Effect.promise(() => pending)

      expect(observed).toEqual({ nested: { values: ["original"] } })
    }).pipe(Effect.provide(platform)))

  it.effect("hands the delegate the descriptor's metadata and the caller's input", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      const encoded = Schema.encodeUnknownSync(Executable.Invocation)(
        executable.invocation({ name: "world" })
      )
      expect(JSON.stringify(encoded)).toBe(JSON.stringify(invocationGolden))
    }).pipe(Effect.provide(platform)))

  it.effect("defaults an absent input to null rather than to undefined", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("greet")
      const executable = yield* Executable.fromDescriptor(descriptor, options())
      const graph = Graph.build(executable.flow, {})
      expect(Graph.diagnostics(graph)).toEqual([])
    }).pipe(Effect.provide(platform)))
})

describe("registration", () => {
  it.effect("hands the host the refusals it registered around", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const capture = Logger.make((entry) => void logs.push(String(entry.message)))
      const runtime = Layer.succeed(
        FlowRuntime.FlowRuntime,
        { register: () => Effect.void } as never
      )
      const built = yield* Effect.provide(
        Executable.Catalog,
        Executable.layer(options()).pipe(
          Layer.provideMerge(Layer.mergeAll(runtime, Action.layerImplementations, NodeCrypto.layer))
        )
      ).pipe(Effect.provide(Logger.layer([capture])))

      // Registration is where a host learns what it CANNOT run. Without this
      // the refusals were computed and thrown away, so `up orphan` reached the
      // runtime's generic unregistered-flow failure instead of the typed
      // refusal that names the missing delegate.
      expect(built.refused.map((failure) => failure.flow).sort()).toEqual(["orphan", "undecided"])
      expect(logs.filter((message) => message.includes("not runnable")).length).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(registryLayer), Effect.provide(platform)))

  it.effect("registers every runnable flow with the runtime", () =>
    Effect.gen(function*() {
      const registered: Array<string> = []
      const runtime = Layer.succeed(
        FlowRuntime.FlowRuntime,
        {
          register: (flow: Flow.Any) => Effect.sync(() => void registered.push(flow._tag))
        } as never
      )
      yield* Layer.build(
        // `Crypto` is part of the registration requirement now: the action the
        // bridged flow dispatches derives its delegate's child execution id.
        Executable.layer(options()).pipe(
          Layer.provideMerge(Layer.mergeAll(runtime, Action.layerImplementations, NodeCrypto.layer))
        )
      )
      // One registration per runnable flow, plus a second for each descriptor
      // that declares a cache policy: `@smthrs/flow` `Action.toLayer` registers
      // a flow form for the action such a flow dispatches, which is how a
      // driver expanding a persisted plan finds the code for that node. A
      // descriptor declaring no policy calls its delegate directly and adds
      // nothing to the runtime's registry.
      expect(registered.sort()).toEqual([
        "cacheable",
        "cacheable-expiring",
        "cacheable-plain",
        "cacheable-reads",
        "cacheable-scoped",
        "changelog",
        "greet",
        "registry/cacheable",
        "registry/cacheable-expiring",
        "registry/cacheable-reads",
        "registry/cacheable-scoped",
        "registry/scoped",
        "registry/tuned",
        "scoped",
        "tuned"
      ])
    }).pipe(Effect.scoped, Effect.provide(registryLayer), Effect.provide(platform)))
})
