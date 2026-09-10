import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Digest from "@smthrs/core/Digest"
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Option } from "effect"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BodyRefMarkdown,
  DiscoveryWarning,
  executionDigest,
  FlowDescriptor,
  Provenance,
  SchemaRefInline,
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput,
  type Source,
  SourceScan
} from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Registry from "../src/Registry.ts"
import type { DiscoveryError, RegistryError } from "../src/RegistryError.ts"
import { discoveryError } from "../src/RegistryError.ts"

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url))
const projectRoot = `${fixtures}/project/flows`
const foreignRoot = `${fixtures}/foreign`

const project: Source = {
  source: "project",
  root: projectRoot,
  naming: "path"
}

const foreign: Source = {
  source: "foreign",
  root: foreignRoot,
  naming: "frontmatter"
}

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Registry.Registry>,
  sources: ReadonlyArray<Source> = [project, foreign]
): Effect.Effect<A, E | DiscoveryError | RegistryError> =>
  effect.pipe(
    Effect.provide(Registry.layer({ sources })),
    Effect.provide(Discovery.layer),
    Effect.provide(platformLayer)
  )

const descriptor = (
  name: string,
  options: { readonly path?: string; readonly modelInvocable?: boolean } = {}
): FlowDescriptor => {
  const path = options.path ?? `${fixtures}/${name}.md`
  return new FlowDescriptor({
    name,
    description: `Flow ${name}.`,
    body: new BodyRefMarkdown({ path, baseDirectory: fixtures }),
    input: new SchemaRefMarkdownArgs({}),
    output: new SchemaRefMarkdownOutput({}),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    modelInvocable: options.modelInvocable ?? true,
    path,
    frontmatter: {},
    provenance: new Provenance({ source: "test", root: fixtures })
  })
}

const fromDescriptors = (entries: ReadonlyArray<FlowDescriptor>) =>
  Registry.layerFromDescriptors(entries).pipe(Layer.provide(platformLayer))

const attemptMutation = (mutation: () => void): void => {
  try {
    mutation()
  } catch {
    // Frozen registry values reject writes in strict mode. The second read is
    // the behavioral assertion, independent of whether the host throws here.
  }
}

describe("Registry", () => {
  it.each(["changelog", "review/read-pr"])("refuses an unmeasured body for %s", async (name) => {
    const measured = await Effect.runPromise(provideRegistry(Effect.gen(function*() {
      return yield* (yield* Registry.Registry).get(name)
    })))
    const entry = new FlowDescriptor({ ...measured, body: { ...measured.body, contentDigest: undefined } })
    expect(executionDigest(entry)).toBeUndefined()
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* Effect.flip((yield* Registry.Registry).loadBody(name))
      }).pipe(Effect.provide(fromDescriptors([entry])))
    )
    expect(failure).toMatchObject({
      _tag: "flows/registry/RegistryError",
      code: "body_unavailable",
      method: "loadBody"
    })
    expect(failure.message).toContain("unmeasured")
    expect(failure.message).toContain("refresh")
  })

  it("loads a measured markdown body through a file URL", async () => {
    const measured = await Effect.runPromise(provideRegistry(Effect.gen(function*() {
      return yield* (yield* Registry.Registry).get("changelog")
    })))
    const entry = new FlowDescriptor({
      ...measured,
      body: { ...measured.body, path: pathToFileURL(measured.body.path).href }
    })
    const body = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* Registry.Registry).loadBody(entry.name)
      }).pipe(Effect.provide(fromDescriptors([entry])))
    )
    expect(body._tag).toBe("Prompt")
    if (body._tag === "Prompt") expect(body.text).toContain("changelog")
  })

  it("loads only the executable identity the caller reviewed", async () => {
    await Effect.runPromise(provideRegistry(Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const current = yield* registry.get("changelog")
      const expected = executionDigest(current)
      expect(expected).toMatch(/^[0-9a-f]{64}$/)
      expect((yield* registry.loadBody("changelog", expected))._tag).toBe("Prompt")
      const failure = yield* Effect.flip(registry.loadBody("changelog", "0".repeat(64)))
      expect(failure.code).toBe("execution_changed")
      expect(failure.message).toContain("create and approve a new plan")
    })))
  })

  it("owns descriptors and warnings after layerFromDescriptors constructs the service", async () => {
    const entry = new FlowDescriptor({
      ...descriptor("owned"),
      flows: ["test/delegate"],
      capabilities: ["fs:read:notes/**"],
      effects: {
        reads: ["notes/**"],
        writes: ["out/**"],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      budget: { tokens: 100 },
      frontmatter: { nested: { value: "original" } },
      provenance: new Provenance({
        source: "test",
        root: fixtures,
        pack: { name: "fixture-pack", version: "1.0.0", origin: "local" }
      })
    })
    const cause: { detail: string; self?: unknown } = { detail: "original" }
    cause.self = cause
    const warning = new DiscoveryWarning({
      code: "unknown_frontmatter_key",
      path: entry.path,
      name: entry.name,
      message: "Original warning",
      cause
    })
    const entries = [entry]
    const warnings = [warning]

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        yield* Effect.sync(() => {
          entries.length = 0
          warnings.length = 0
          attemptMutation(() => Object.assign(entry, { name: "mutated", modelInvocable: false }))
          attemptMutation(() => (entry.capabilities as Array<string>).push("fs:write:**"))
          attemptMutation(() => (entry.flows as Array<string>).push("test/other"))
          attemptMutation(() => (entry.effects.reads as Array<string>).push("secrets/**"))
          attemptMutation(() => (entry.effects.writes as Array<string>).push("elsewhere/**"))
          attemptMutation(() => Object.assign(entry.budget!, { tokens: 999 }))
          attemptMutation(() => Object.assign(entry.body, { path: "/mutated/body.mdx" }))
          attemptMutation(() => Object.assign(entry.provenance, { source: "mutated" }))
          attemptMutation(() => {
            ;(entry.frontmatter.nested as { value: string }).value = "mutated"
          })
          attemptMutation(() => Object.assign(warning, { message: "Mutated warning" }))
          cause.detail = "mutated"
        })
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          found: yield* registry.get("owned"),
          mutated: yield* registry.getOption("mutated"),
          warnings: yield* registry.warnings()
        }
      }).pipe(
        Effect.provide(Registry.layerFromDescriptors(entries, warnings)),
        Effect.provide(platformLayer)
      )
    )

    expect(result.entries.map((item) => item.name)).toEqual(["owned"])
    expect(result.visible.map((item) => item.name)).toEqual(["owned"])
    expect(result.found).toMatchObject({
      name: "owned",
      modelInvocable: true,
      capabilities: ["fs:read:notes/**"],
      flows: ["test/delegate"],
      effects: { reads: ["notes/**"], writes: ["out/**"] },
      budget: { tokens: 100 },
      body: { path: `${fixtures}/owned.md` },
      provenance: { source: "test" },
      frontmatter: { nested: { value: "original" } }
    })
    expect(result.mutated).toEqual(Option.none())
    expect(result.warnings.map((item) => item.message)).toEqual(["Original warning"])
    expect(Object.isFrozen(result.found.body)).toBe(true)
    expect(Object.isFrozen(result.found.budget)).toBe(true)
    expect(Object.isFrozen(result.found.frontmatter.nested)).toBe(true)
    expect(Object.isFrozen(result.found.provenance.pack)).toBe(true)
    expect(Object.isFrozen(result.warnings[0])).toBe(true)
    expect(result.warnings[0]?.cause).not.toBe(cause)
    expect(result.warnings[0]?.cause).toMatchObject({ detail: "original" })
    expect((result.warnings[0]?.cause as { self?: unknown }).self).toBe(result.warnings[0]?.cause)
    expect(Object.isFrozen(result.warnings[0]?.cause)).toBe(true)
  })

  it("keeps every registry projection consistent after a returned descriptor is mutated", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const first = yield* registry.list()
        const exposed = first[0]!
        yield* Effect.sync(() => {
          attemptMutation(() => Object.assign(exposed, { name: "mutated", modelInvocable: false }))
          attemptMutation(() => (exposed.capabilities as Array<string>).push("fs:write:**"))
          attemptMutation(() => (exposed.effects.reads as Array<string>).push("secrets/**"))
          attemptMutation(() => Object.assign(exposed.frontmatter, { changed: true }))
        })
        return {
          first: exposed,
          listed: yield* registry.list(),
          visible: yield* registry.visible(),
          found: yield* registry.get("original"),
          mutated: yield* registry.getOption("mutated")
        }
      }).pipe(Effect.provide(fromDescriptors([descriptor("original")])))
    )

    expect(result.listed.map((item) => item.name)).toEqual(["original"])
    expect(result.visible.map((item) => item.name)).toEqual(["original"])
    expect(result.found.name).toBe("original")
    expect(result.mutated).toEqual(Option.none())
    expect(Object.isFrozen(result.first)).toBe(true)
    expect(Object.isFrozen(result.first.capabilities)).toBe(true)
    expect(Object.isFrozen(result.first.effects)).toBe(true)
    expect(Object.isFrozen(result.first.effects.reads)).toBe(true)
    expect(Object.isFrozen(result.first.effects.writes)).toBe(true)
    expect(Object.isFrozen(result.first.provenance)).toBe(true)
    expect(Object.isFrozen(result.first.frontmatter)).toBe(true)
  })

  /**
   * The ownership copy is one traversal per descriptor, sharing one identity
   * map. That is what keeps the cost at one copy per source object and what
   * keeps a value two fields reference from coming back as two objects. A copy
   * per field, each with its own map, duplicated both.
   */
  it("copies a value two descriptor fields share exactly once", async () => {
    const shared = new SchemaRefInline({ document: { type: "object" } })
    const entry = new FlowDescriptor({ ...descriptor("aliased"), input: shared, output: shared })

    const found = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.get("aliased")
      }).pipe(Effect.provide(fromDescriptors([entry])))
    )

    expect(found.input).toBe(found.output)
    expect(found.input).not.toBe(shared)
    expect(found.input).toEqual(shared)
    expect(Object.isFrozen(found.input)).toBe(true)
  })

  it("snapshots source configuration before a layer is built", async () => {
    const entry = descriptor("configured")
    const source: Source = { source: "original", root: fixtures, naming: "path" }
    const sources: Array<Source> = [source]
    const seen: Array<Source> = []
    const discovery = Discovery.makeNoop({
      scan: (current) =>
        Effect.sync(() => {
          seen.push(current)
          return new SourceScan({ entries: [entry], warnings: [] })
        })
    })
    const layer = Registry.layer({ sources }).pipe(
      Layer.provide(Layer.succeed(Discovery.Discovery)(discovery)),
      Layer.provide(platformLayer)
    )

    sources.length = 0
    Object.assign(source, { source: "mutated", root: "/mutated" })

    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return (yield* registry.list()).map((item) => item.name)
      }).pipe(Effect.provide(layer))
    )

    expect(names).toEqual(["configured"])
    expect(seen).toEqual([{ source: "original", root: fixtures, naming: "path" }])
  })

  it("scans sources concurrently and folds them in caller order", async () => {
    const record = { inFlight: 0, peak: 0 }
    const finished: Array<string> = []
    // Reverse of the caller order, so the fold cannot be reading completion order.
    const delays: Record<string, Duration.Input> = { a: "40 millis", b: "20 millis", c: "1 millis" }
    const discovery = Discovery.makeNoop({
      scan: (source) =>
        Effect.gen(function*() {
          record.inFlight += 1
          record.peak = Math.max(record.peak, record.inFlight)
          yield* Effect.sleep(delays[source.source]!)
          record.inFlight -= 1
          finished.push(source.source)
          return new SourceScan({
            entries: [descriptor(`${source.source}-flow`)],
            warnings: [
              new DiscoveryWarning({
                code: "unreadable",
                path: `${fixtures}/${source.source}`,
                message: source.source
              })
            ]
          })
        })
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return { entries: yield* registry.list(), warnings: yield* registry.warnings() }
      }).pipe(
        Effect.provide(Registry.layer({
          sources: ["a", "b", "c"].map((source) => ({
            source,
            root: `${fixtures}/${source}`,
            naming: "path" as const
          }))
        })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer)
      )
    )

    // A sequential loop awaits each scan before issuing the next, so its peak
    // is one and the scans finish in caller order.
    expect(record.peak).toBeGreaterThan(1)
    expect(record.inFlight).toBe(0)
    expect(finished).toEqual(["c", "b", "a"])
    expect(result.entries.map((entry) => entry.name)).toEqual(["a-flow", "b-flow", "c-flow"])
    expect(result.warnings.map((item) => item.message)).toEqual(["a", "b", "c"])
  })

  it("checks every pack before an earlier pack source can fail", async () => {
    let scanCalls = 0
    const discovery = Discovery.makeNoop({
      scan: (source) => {
        scanCalls++
        return Effect.fail(
          discoveryError({ code: "read_failed", method: "scan", path: source.root })
        )
      }
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Registry.Registry
      }).pipe(
        Effect.provide(Registry.layer({
          sources: [],
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixtures,
                origin: "installed",
                manifest: { name: "first", version: "1.0.0", flows: ["project/flows"] } as never
              },
              {
                dir: fixtures,
                origin: "installed",
                manifest: {
                  name: "future",
                  version: "2.0.0",
                  flows: [],
                  requires: { smithers: ">=9.0.0" }
                } as never
              }
            ]
          }
        })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("incompatible_pack")
    expect(scanCalls).toBe(0)
  })

  it("checks every pack range is readable before scanning any pack", async () => {
    let scanCalls = 0
    const discovery = Discovery.makeNoop({
      scan: () => {
        scanCalls++
        return Effect.succeed(new SourceScan({ entries: [], warnings: [] }))
      }
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Registry.Registry
      }).pipe(
        Effect.provide(Registry.layer({
          sources: [],
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixtures,
                origin: "installed",
                manifest: { name: "first", version: "1.0.0", flows: ["project/flows"] } as never
              },
              {
                dir: fixtures,
                origin: "installed",
                manifest: {
                  name: "unreadable",
                  version: "1.0.0",
                  flows: [],
                  requires: { smithers: "not-a-range" }
                } as never
              }
            ]
          }
        })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("unreadable_pack_range")
    expect(scanCalls).toBe(0)
  })

  it("attaches a pack source path to an invalid_pack wrapper", async () => {
    const sourceRoot = `${fixtures}/project/flows`
    const discovery = Discovery.makeNoop({
      scan: (source) =>
        Effect.fail(discoveryError({
          code: "read_failed",
          method: "scan",
          path: source.root
        }))
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Registry.Registry
      }).pipe(
        Effect.provide(Registry.layer({
          sources: [],
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: fixtures,
              origin: "installed",
              manifest: { name: "broken", version: "1.0.0", flows: ["project/flows"] } as never
            }]
          }
        })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("invalid_pack")
    expect(error.path).toBe(sourceRoot)
    expect(error.message).toContain(sourceRoot)
  })

  it("merges sources in order, warns on duplicates, and keeps first provenance", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const entries = yield* registry.list()
          const warnings = yield* registry.warnings()
          return { entries, warnings }
        })
      )
    )

    const review = result.entries.find((entry) => entry.name === "review")
    expect(review?.provenance).toEqual(new Provenance({ source: "project", root: projectRoot }))
    expect(
      result.warnings.some((warning) => warning.code === "duplicate_name" && warning.name === "review")
    ).toBe(true)
  })

  it("loads an unmodified third-party skill through progressive disclosure", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const entries = yield* registry.list()
          const descriptor = yield* registry.get("pdf-processing")
          const body = yield* registry.loadBody("pdf-processing")
          const rendered = yield* registry.runPrompt("pdf-processing", { args: "Extract report.pdf" })
          return { entries, descriptor, body, rendered }
        })
      )
    )

    expect(result.entries.map((entry) => entry.name)).toContain("pdf-processing")
    expect(result.descriptor.name).toBe("pdf-processing")
    expect(result.descriptor.output._tag).toBe("MarkdownOutput")
    expect(result.body._tag).toBe("Prompt")
    expect(result.rendered).toContain("Do not overwrite the source document")
    expect(result.rendered).toContain(`- Base directory: ${foreignRoot}/pdf`)
    expect(result.rendered.endsWith("\n\nExtract report.pdf")).toBe(true)
    if (result.body._tag === "Prompt") {
      expect(result.body.text).toContain("# PDF Processing")
      expect(result.body.text).not.toContain("name: pdf-processing")
      expect(result.body.text.startsWith("---")).toBe(false)
      expect(result.body.baseDirectory).toBe(`${foreignRoot}/pdf`)
    }
  })

  it("keeps hidden entries lookup- and body-loadable while excluding them from visible", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const visible = yield* registry.visible()
          const hidden = yield* registry.get("hidden")
          const body = yield* registry.loadBody("hidden")
          return { visible, hidden, body }
        })
      )
    )

    expect(result.visible.map((entry) => entry.name)).not.toContain("hidden")
    expect(result.hidden.name).toBe("hidden")
    expect(result.body._tag).toBe("Prompt")
  })

  it("rejects module flows at the markdown prompt boundary", async () => {
    const error = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* Effect.flip(registry.runPrompt("review/read-pr", { args: "4821" }))
        })
      )
    )

    expect(error.code).toBe("not_prompt_flow")
  })

  it("fails unknown lookup with not_found", async () => {
    const error = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* Effect.flip(registry.get("does-not-exist"))
        })
      )
    )

    expect(error.code).toBe("not_found")
  })

  it("names the method the caller invoked on every not_found", async () => {
    const failures = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return {
            get: yield* Effect.flip(registry.get("does-not-exist")),
            loadBody: yield* Effect.flip(registry.loadBody("does-not-exist")),
            runPrompt: yield* Effect.flip(registry.runPrompt("does-not-exist", { args: "" }))
          }
        })
      )
    )

    expect(failures.get).toMatchObject({
      code: "not_found",
      method: "get",
      message: `not_found: Registry.get: flow "does-not-exist" was not found`
    })
    expect(failures.loadBody).toMatchObject({
      code: "not_found",
      method: "loadBody",
      message: `not_found: Registry.loadBody: flow "does-not-exist" was not found`
    })
    expect(failures.runPrompt).toMatchObject({
      code: "not_found",
      method: "runPrompt",
      message: `not_found: Registry.runPrompt: flow "does-not-exist" was not found`
    })
  })

  it("fails construction when either colliding source is system", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(
        Effect.provide(Registry.layer({ sources: [{ ...project, system: true }, foreign] })),
        Effect.provide(Discovery.layer),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("system_collision")
  })

  it("fails construction when a pack redefines a system flow name", async () => {
    const discovery = Discovery.makeNoop({
      scan: () => Effect.succeed(new SourceScan({ entries: [descriptor("review")], warnings: [] }))
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Registry.Registry
      }).pipe(
        Effect.provide(Registry.layer({
          sources: [{ ...project, system: true }],
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [
              {
                dir: fixtures,
                origin: "installed",
                manifest: { name: "first", version: "1.0.0", flows: ["project/flows"] } as never
              }
            ]
          }
        })),
        Effect.provide(Layer.succeed(Discovery.Discovery)(discovery)),
        Effect.provide(platformLayer),
        Effect.flip
      )
    )

    expect(error.code).toBe("system_collision")
  })

  it("defers body reads until loadBody and returns a typed read failure", async () => {
    const descriptor = new FlowDescriptor({
      name: "lazy",
      description: "Loads only when requested.",
      body: new BodyRefMarkdown({
        path: `${fixtures}/does-not-exist.md`,
        baseDirectory: fixtures,
        contentDigest: "0".repeat(64)
      }),
      input: new SchemaRefMarkdownArgs({}),
      output: new SchemaRefMarkdownOutput({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: `${fixtures}/does-not-exist.md`,
      frontmatter: {},
      provenance: new Provenance({ source: "test", root: fixtures })
    })
    const registryLayer = Registry.layerFromDescriptors([descriptor]).pipe(Layer.provide(platformLayer))

    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(Effect.provide(registryLayer))
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* Effect.flip(registry.loadBody("lazy"))
      }).pipe(Effect.provide(registryLayer))
    )

    expect(entries.map((entry) => entry.name)).toEqual(["lazy"])
    expect(error.code).toBe("body_unavailable")
    expect(error.path).toBe(`${fixtures}/does-not-exist.md`)
    expect(error.cause).toMatchObject({ _tag: "PlatformError" })
  })

  it("returns an optional lookup for a known and an unknown name", async () => {
    const result = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return {
            known: yield* registry.getOption("changelog"),
            unknown: yield* registry.getOption("does-not-exist"),
            empty: yield* registry.getOption("")
          }
        })
      )
    )

    expect(Option.getOrThrow(result.known).name).toBe("changelog")
    expect(result.unknown).toEqual(Option.none())
    expect(result.empty).toEqual(Option.none())
  })

  it("is empty in every projection when no descriptors are supplied", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          warnings: yield* registry.warnings(),
          missing: yield* registry.getOption("anything")
        }
      }).pipe(Effect.provide(fromDescriptors([])))
    )

    expect(result.entries).toEqual([])
    expect(result.visible).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.missing).toEqual(Option.none())
  })

  it("keeps the first of two same-named descriptors and warns about the rest", async () => {
    const first = descriptor("review", { path: `${fixtures}/first-review.md` })
    const second = descriptor("review", { path: `${fixtures}/second-review.md` })
    const third = descriptor("review", { path: `${fixtures}/third-review.md` })
    const hidden = descriptor("hidden", { modelInvocable: false })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          found: yield* registry.get("review"),
          warnings: yield* registry.warnings()
        }
      }).pipe(Effect.provide(fromDescriptors([first, second, third, hidden])))
    )

    expect(result.entries.map((entry) => entry.path)).toEqual([first.path, hidden.path])
    expect(result.visible.map((entry) => entry.name)).toEqual(["review"])
    expect(result.found.path).toBe(first.path)
    expect(result.warnings.map((warning) => warning.path)).toEqual([second.path, third.path])
    expect(result.warnings[0]).toMatchObject({
      code: "duplicate_name",
      name: "review",
      message: `Duplicate flow name "review"; keeping first entry from "${first.path}"`
    })
  })

  it.each(["success", "failure", "overlapping body load"] as const)(
    "publishes two-source refreshes atomically: %s",
    async (outcome) => {
      await Effect.runPromise(Effect.gen(function*() {
        const aPending = yield* Deferred.make<void>()
        const releaseA = yield* Deferred.make<void>()
        const bPending = yield* Deferred.make<void>()
        const releaseB = yield* Deferred.make<void>()
        const bodyPending = yield* Deferred.make<void>()
        const releaseBody = yield* Deferred.make<void>()
        const beforeText = "---\ndescription: Before refresh.\n---\nOld body."
        const afterText = "---\ndescription: After refresh.\n---\nNew body."
        const bodyDescriptor = (version: string, text: string) => {
          const path = `${fixtures}/${version}-body.md`
          return new FlowDescriptor({
            ...descriptor("body", { path }),
            description: version,
            body: new BodyRefMarkdown({
              path,
              baseDirectory: fixtures,
              contentDigest: Digest.digest(new TextEncoder().encode(text))
            })
          })
        }
        const beforeBody = bodyDescriptor("before", beforeText)
        const afterBody = bodyDescriptor("after", afterText)
        const beforeA = [descriptor("before-a"), beforeBody]
        const beforeB = [descriptor("before-b", { modelInvocable: false })]
        const afterA = [descriptor("after-a", { modelInvocable: false }), afterBody]
        const afterB = [descriptor("after-b")]
        const warning = (version: string, source: string) =>
          new DiscoveryWarning({
            code: "unreadable",
            path: `${fixtures}/${source}/${version}`,
            message: `${source}: ${version}`
          })
        const oldWarnings = [warning("before", "a"), warning("before", "b")]
        const newWarnings = [warning("after", "a"), warning("after", "b")]
        const scans: Array<string> = []
        let refreshing = false
        let failB = outcome === "failure"
        const discovery = Discovery.makeNoop({
          scan: (source) =>
            Effect.gen(function*() {
              scans.push(`${refreshing ? "refresh" : "initial"}:${source.source}`)
              if (refreshing && source.source === "a") {
                yield* Deferred.succeed(aPending, undefined)
                yield* Deferred.await(releaseA)
              }
              if (refreshing && source.source === "b") {
                // Reaching B proves A's scan was issued; the snapshot assertions
                // below prove neither source is published before both return.
                yield* Deferred.succeed(bPending, undefined)
                yield* Deferred.await(releaseB)
                if (failB) {
                  return yield* discoveryError({ code: "read_failed", method: "scan", description: "source B failed" })
                }
              }
              const index = source.source === "a" ? 0 : 1
              return new SourceScan({
                entries: (refreshing ? [afterA, afterB] : [beforeA, beforeB])[index]!,
                warnings: [(refreshing ? newWarnings : oldWarnings)[index]!]
              })
            })
        })
        const fs = FileSystem.makeNoop({
          readFile: (path) =>
            Effect.gen(function*() {
              if (path === beforeBody.body.path) {
                yield* Deferred.succeed(bodyPending, undefined)
                yield* Deferred.await(releaseBody)
                return new TextEncoder().encode(beforeText)
              }
              expect(path).toBe(afterBody.body.path)
              return new TextEncoder().encode(afterText)
            })
        })
        const registry = yield* Registry.make({
          sources: [
            { source: "a", root: `${fixtures}/a`, naming: "path" },
            { source: "b", root: `${fixtures}/b`, naming: "path" }
          ]
        }).pipe(
          Effect.provideService(Discovery.Discovery, discovery),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provide(NodePath.layer)
        )
        const assertSnapshot = (
          entries: ReadonlyArray<FlowDescriptor>,
          warnings: ReadonlyArray<DiscoveryWarning>,
          absent: ReadonlyArray<string>
        ) =>
          Effect.gen(function*() {
            expect(yield* registry.list()).toEqual(entries)
            expect(yield* registry.visible()).toEqual(entries.filter((entry) => entry.modelInvocable))
            expect(yield* registry.warnings()).toEqual(warnings)
            for (const entry of entries) {
              expect(yield* registry.get(entry.name)).toEqual(entry)
              expect(yield* registry.getOption(entry.name)).toEqual(Option.some(entry))
            }
            for (const name of absent) {
              expect(yield* registry.getOption(name)).toEqual(Option.none())
              expect((yield* Effect.flip(registry.get(name))).code).toBe("not_found")
            }
          })
        yield* assertSnapshot([...beforeA, ...beforeB], oldWarnings, ["after-a", "after-b"])
        refreshing = true
        const refresh = yield* registry.refresh().pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(aPending)
        yield* assertSnapshot([...beforeA, ...beforeB], oldWarnings, ["after-a", "after-b"])
        yield* Deferred.succeed(releaseA, undefined)
        yield* Deferred.await(bPending)
        expect(scans).toEqual(["initial:a", "initial:b", "refresh:a", "refresh:b"])
        yield* assertSnapshot([...beforeA, ...beforeB], oldWarnings, ["after-a", "after-b"])

        const body = outcome === "overlapping body load"
          ? yield* registry.loadBody("body").pipe(Effect.forkChild)
          : undefined
        if (body !== undefined) {
          yield* Deferred.await(bodyPending)
          yield* assertSnapshot([...beforeA, ...beforeB], oldWarnings, ["after-a", "after-b"])
        }
        yield* Deferred.succeed(releaseB, undefined)
        const refreshed = yield* Fiber.join(refresh)
        if (outcome === "failure") {
          expect(refreshed).toMatchObject({ _tag: "Failure", failure: { code: "read_failed" } })
          yield* assertSnapshot([...beforeA, ...beforeB], oldWarnings, ["after-a", "after-b"])
        } else {
          expect(refreshed).toMatchObject({ _tag: "Success" })
          yield* assertSnapshot([...afterA, ...afterB], newWarnings, ["before-a", "before-b"])
        }
        if (body !== undefined) {
          yield* Deferred.succeed(releaseBody, undefined)
          // The read began in the old snapshot and finishes after publication.
          expect(yield* Fiber.join(body)).toMatchObject({ _tag: "Prompt", text: "Old body." })
          expect(yield* registry.loadBody("body")).toMatchObject({ _tag: "Prompt", text: "New body." })
        }
        if (outcome !== "failure") {
          failB = true
          expect((yield* Effect.flip(registry.refresh())).code).toBe("read_failed")
          yield* assertSnapshot([...afterA, ...afterB], newWarnings, ["before-a", "before-b"])
        }
      }))
    }
  )

  it("preserves lenient discovery warnings without logging or throwing", async () => {
    const warnings = await Effect.runPromise(
      provideRegistry(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return yield* registry.warnings()
        })
      )
    )

    expect(
      warnings.some(
        (warning) => warning.code === "missing_description" && warning.path.endsWith("/broken/flow.mdx")
      )
    ).toBe(true)
  })
})

describe("Registry stubs", () => {
  it("answers every method from an empty stub", async () => {
    const registry = Registry.makeNoop()

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          warnings: yield* registry.warnings(),
          option: yield* registry.getOption("missing"),
          refreshed: yield* registry.refresh(),
          get: yield* Effect.flip(registry.get("missing")),
          body: yield* Effect.flip(registry.loadBody("missing")),
          prompt: yield* Effect.flip(registry.runPrompt("missing", { args: "" }))
        }
      })
    )

    expect(result.entries).toEqual([])
    expect(result.visible).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.option).toEqual(Option.none())
    expect(result.refreshed).toBeUndefined()
    expect(result.get).toMatchObject({
      code: "not_found",
      message: `not_found: Registry.get: flow "missing" was not found`
    })
    expect(result.body).toMatchObject({
      code: "not_found",
      message: `not_found: Registry.loadBody: flow "missing" was not found`
    })
    expect(result.prompt).toMatchObject({
      code: "not_found",
      message: `not_found: Registry.runPrompt: flow "missing" was not found`
    })
  })

  it("keeps stub methods that are not overridden", async () => {
    const entry = descriptor("stubbed")
    const registry = Registry.makeNoop({
      list: () => Effect.succeed([entry]),
      get: () => Effect.succeed(entry)
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return {
          entries: yield* registry.list(),
          visible: yield* registry.visible(),
          found: yield* registry.get("stubbed"),
          option: yield* registry.getOption("stubbed")
        }
      })
    )

    expect(result.entries.map((item) => item.name)).toEqual(["stubbed"])
    expect(result.visible).toEqual([])
    expect(result.found.name).toBe("stubbed")
    expect(result.option).toEqual(Option.none())
  })

  it.each([
    ["without overrides", undefined, []],
    ["with overrides", [descriptor("stubbed")], ["stubbed"]]
  ])("provides a stub layer %s", async (_label, entries, names) => {
    const layer = entries === undefined
      ? Registry.layerNoop()
      : Registry.layerNoop({ list: () => Effect.succeed(entries) })

    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.list()
      }).pipe(Effect.provide(layer))
    )

    expect(listed.map((entry) => entry.name)).toEqual(names)
  })
})

describe("project source lifecycle", () => {
  it.each([false, true])("discovers added and recreated flows when initially present: %s", async (initiallyPresent) => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const flows = `${root}/flows`
        if (initiallyPresent) {
          yield* fs.makeDirectory(`${flows}/original`, { recursive: true })
          yield* fs.writeFileString(
            `${flows}/original/flow.mdx`,
            "---\ndescription: Original flow.\n---\nOriginal body."
          )
        }
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          expect((yield* registry.visible()).map((entry) => entry.name)).toEqual(initiallyPresent ? ["original"] : [])
          yield* fs.makeDirectory(`${flows}/added`, { recursive: true })
          yield* fs.writeFileString(`${flows}/added/flow.mdx`, "---\ndescription: Added flow.\n---\nAdded body.")
          yield* registry.refresh()
          expect((yield* registry.visible()).map((entry) => entry.name)).toEqual(
            initiallyPresent ? ["added", "original"] : ["added"]
          )
          yield* fs.remove(flows, { recursive: true })
          yield* registry.refresh()
          expect(yield* registry.list()).toEqual([])
          yield* fs.makeDirectory(`${flows}/recreated`, { recursive: true })
          yield* fs.writeFileString(
            `${flows}/recreated/flow.mdx`,
            "---\ndescription: Recreated flow.\n---\nRecreated body."
          )
          yield* registry.refresh()
          expect((yield* registry.visible()).map((entry) => entry.name)).toEqual(["recreated"])
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      })).pipe(Effect.provide(platformLayer))
    )
  })
})

describe("optional project roots with required packs", () => {
  it("keeps missing pack roots strict on construction and refresh", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const packRoot = `${root}/pack`
        const options: Registry.ProjectOptions = {
          root,
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: packRoot,
              origin: "installed",
              manifest: { name: "required", version: "1.0.0", flows: ["flows"] } as never
            }]
          }
        }
        const failure = yield* Effect.flip(Effect.provide(Effect.void, Registry.layerProject(options)))
        expect(failure.code).toBe("invalid_pack")
        expect(failure.message).toContain("required@1.0.0")
        yield* fs.makeDirectory(`${packRoot}/flows/packed`, { recursive: true })
        yield* fs.writeFileString(`${packRoot}/flows/packed/flow.mdx`, "---\ndescription: Pack flow.\n---\nPack body.")
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          expect((yield* registry.visible()).map((entry) => entry.name)).toEqual(["packed"])
          yield* fs.remove(`${packRoot}/flows`, { recursive: true })
          const failure = yield* Effect.flip(registry.refresh())
          expect(failure.code).toBe("invalid_pack")
          expect(failure.message).toContain("required@1.0.0")
          expect((yield* registry.visible()).map((entry) => entry.name)).toEqual(["packed"])
        }).pipe(Effect.provide(Registry.layerProject(options)))
      })).pipe(Effect.provide(platformLayer))
    )
  })

  it("rejects a project flows root that is a file", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${root}/flows`, "not a directory")
        const failure = yield* Effect.flip(Effect.provide(Effect.void, Registry.layerProject({ root })))
        expect(failure.code).toBe("invalid_root")
      })).pipe(Effect.provide(platformLayer))
    )
  })
})
