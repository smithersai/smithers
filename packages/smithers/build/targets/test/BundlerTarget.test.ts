/**
 * Construct-time semantics of the implemented `S.Bundler.Rspack` targets:
 * dependency edges, declared inputs, declared outputs, cacheability, result
 * schemas, and the canonical graph digest. The process side is exercised in
 * `build-cli/test/RspackRunner.test.ts`.
 */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as BundlerTarget from "../src/BundlerTarget.ts"
import { Filegroup } from "../src/Filegroup.vibe"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const config = Input.file("//rsbuild.config.ts")
const srcs = Filegroup({ srcs: [Input.glob("src/**")] })
const rspack = BundlerTarget.Rspack({ config })

const resolveTarget = () => rspack.resolve({ entries: ["client.tsx", "server"], universe: [srcs] })

describe("Bundler.Rspack.resolve", () => {
  it("constructs a cacheable build target with the universe as edges and the config as input", () => {
    const resolved = resolveTarget()
    const metadata = Target.metadata(resolved)
    expect(metadata.target).toBe("Bundler.Rspack.resolve")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.cacheable).toBe(true)
    expect(metadata.dependencies).toContain(srcs)
    expect(metadata.inputs).toContainEqual(config)
    expect(metadata.outputs).toBeUndefined()
  })

  it("exposes the .files reference for the file algebra", () => {
    const resolved = resolveTarget()
    expect(resolved.files).toEqual({ _tag: "TargetFiles", target: resolved })
  })

  it("requires at least one entry", () => {
    expect(() => rspack.resolve({ entries: [], universe: [srcs] })).toThrow(/at least one entry/)
  })

  it("validates result rows through the success schema", () => {
    const digest = "a".repeat(64)
    const decode = Schema.decodeUnknownSync(BundlerTarget.ResolveResult)
    const value = {
      files: [{ path: "src/client.tsx", digest }],
      packages: ["react"],
      moduleCount: 2,
      graphDigest: digest
    }
    expect(decode(value)).toEqual(value)
    expect(() => decode({ ...value, files: [{ path: "src/client.tsx", digest: "nope" }] })).toThrow()
    expect(() => decode({ ...value, moduleCount: -1 })).toThrow()
  })
})

describe("Bundler.Rspack.build", () => {
  const build = (overrides: Partial<Parameters<typeof rspack.build>[0]> = {}) =>
    rspack.build({
      environment: "client",
      mode: "production",
      graph: resolveTarget(),
      outDirs: ["dist"],
      ...overrides
    })

  it("constructs a cacheable build target that declares its outDirs as outputs", () => {
    const target = build()
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("Bundler.Rspack.build")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.cacheable).toBe(true)
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["dist"] })
  })

  it("records the graph target as a dependency edge, so the graph key is build key material", () => {
    const graph = resolveTarget()
    const target = build({ graph })
    expect(Target.metadata(target).dependencies).toContain(graph)
  })

  it("accepts only the two observed modes", () => {
    expect(() => build({ mode: "dev" as never })).toThrow(/declaration.*is invalid/s)
  })

  it("requires at least one outDir", () => {
    expect(() => build({ outDirs: [] })).toThrow(/at least one outDir/)
  })

  it("keeps env an optional string record", () => {
    const target = build({ env: { BUNDLE_ANALYZE: "true" } })
    const attrs = Target.metadata(target).attrs as { readonly env?: Record<string, string> }
    expect(attrs.env).toEqual({ BUNDLE_ANALYZE: "true" })
  })

  it.each(
    [
      [undefined, {}],
      [{ BUNDLE_ANALYZE: "true" }, { BUNDLE_ANALYZE: "true" }]
    ] as const
  )("plans the sealed build payload with env %j", (env, expectedEnv) => {
    const calls = plannedCalls(build({ env }))

    expect(calls[0]).toEqual({
      action: "smithers-build/bundler-build",
      payload: {
        configPath: "rsbuild.config.ts",
        environment: "client",
        mode: "production",
        env: expectedEnv,
        outDirs: ["dist"]
      }
    })
    expect(calls[1]).toEqual({
      action: "smithers-build/capture-outputs",
      payload: { cwd: ".", paths: ["dist"] }
    })
  })
})

describe("Bundler.Rspack declaration boundaries", () => {
  it.each([
    [() => BundlerTarget.Rspack(null as never), "Bundler.Rspack requires a declared config file"],
    [() => BundlerTarget.Rspack({} as never), "Bundler.Rspack requires a declared config file"],
    [
      () => BundlerTarget.Rspack({ config, typo: true } as never),
      "Bundler.Rspack received unknown option \"typo\""
    ],
    [() => rspack.resolve(null as never), "Bundler.Rspack resolve options must be an object"],
    [() => rspack.build(null as never), "Bundler.Rspack build options must be an object"]
  ])("rejects malformed factory input before rebuilding attrs", (operation, message) => {
    expect(operation).toThrow(TypeError)
    expect(operation).toThrow(message)
  })
})

describe("graphDigest", () => {
  const digest = "b".repeat(64)
  const rows = {
    files: [
      { path: "src/a.ts", digest },
      { path: "src/b.ts", digest }
    ],
    packages: ["react", "react-dom"]
  }

  it("is deterministic over equal rows", () => {
    expect(BundlerTarget.graphDigest(rows)).toBe(BundlerTarget.graphDigest({
      files: [...rows.files],
      packages: [...rows.packages]
    }))
    expect(BundlerTarget.graphDigest(rows)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("changes when any row changes", () => {
    const base = BundlerTarget.graphDigest(rows)
    expect(BundlerTarget.graphDigest({ ...rows, packages: ["react"] })).not.toBe(base)
    expect(BundlerTarget.graphDigest({
      ...rows,
      files: [rows.files[0]!, { path: "src/b.ts", digest: "c".repeat(64) }]
    })).not.toBe(base)
  })

  it("ignores moduleCount, which is diagnostic metadata", () => {
    const withCount = { ...rows, moduleCount: 5, graphDigest: digest }
    expect(BundlerTarget.graphDigest(withCount)).toBe(BundlerTarget.graphDigest(rows))
  })
})
