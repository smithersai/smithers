import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as CachePolicy from "../src/CachePolicy.vibe"
import * as FileSet from "../src/FileSet.ts"
import { GraphBuildError } from "../src/GraphBuildError.vibe"
import * as Node from "../src/Node.ts"

describe("confirmed plan regressions", () => {
  it("decodes historical cache scopes and writes current scopes", () => {
    for (const [old, current] of [["workflow", "flow"], ["global", "shared"]] as const) {
      const policy = Schema.decodeUnknownSync(CachePolicy.CachePolicy)({ scope: old, ttlMs: 123 })
      expect(policy).toEqual({ scope: current, ttlMs: 123 })
      expect(Schema.encodeSync(CachePolicy.CachePolicy)(policy)).toEqual({ scope: current, ttlMs: 123 })
      expect(Schema.decodeUnknownSync(CachePolicy.CacheScope)(old)).toBe(current)
      expect(Schema.encodeSync(CachePolicy.CacheScope)(current)).toBe(current)
    }
  })

  const make = (annotations = Context.empty()): Declaration => ({
    annotations,
    annotate: (key, value) => make(Context.add(annotations, key, value))
  })
  interface Declaration {
    annotations: Context.Context<never>
    annotate: (key: typeof CachePolicy.CachePolicyAnnotation, value: CachePolicy.CachePolicy) => Declaration
  }

  it("snapshots the annotated policy", () => {
    const policy: { ttlMs: number; scope: "run" | "shared" } = { ttlMs: 10, scope: "run" }
    const annotated = CachePolicy.annotate(make(), policy)
    policy.ttlMs = 0
    policy.scope = "shared"
    expect(CachePolicy.cachePolicyOf(annotated.annotations)).toEqual({ ttlMs: 10, scope: "run" })
    expect(Object.isFrozen(CachePolicy.cachePolicyOf(annotated.annotations))).toBe(true)
  })

  it("rejects invalid policies before attaching them", () => {
    for (const policy of [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: 1.5 }, { scope: "unknown" }]) {
      expect(() => CachePolicy.annotate(make(), policy as CachePolicy.CachePolicy)).toThrow()
    }
  })

  it("bounds retained compiled patterns after many unique declarations", () => {
    const output = execFileSync(process.execPath, [
      "--expose-gc",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
      import { matchesPattern } from ${JSON.stringify(new URL("../src/FileSet.ts", import.meta.url).href)};
      for (let i = 0; i < 1000; i++) matchesPattern('warm' + i + '/**/*.ts', 'file');
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 40000; i++) matchesPattern('unique' + i + '/**/*.ts', 'file');
      globalThis.gc();
      console.log(process.memoryUsage().heapUsed - before);
    `
    ], { encoding: "utf8" })
    expect(Number(output.trim())).toBeLessThan(12 * 1024 * 1024)
    expect(FileSet.matchesPattern("src/**/*.ts", "src/a/b.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**/*.ts", "src/a/b.js")).toBe(false)
  })

  it("refuses traversal and path aliases at replay containment", () => {
    for (
      const entry of [
        { _tag: "TreeArtifact", path: "dist" },
        { _tag: "Glob", include: ["dist/**"] },
        "dist/../secret"
      ] as const
    ) {
      for (const path of ["dist/../secret", "dist/./a", "dist//a", "dist/..\\secret", "dist/a\u0000"]) {
        expect(FileSet.contains(entry, path)).toBe(false)
      }
    }
    expect(FileSet.contains({ _tag: "TreeArtifact", path: "dist" }, "dist/a")).toBe(true)
    expect(FileSet.contains({ _tag: "Glob", include: ["dist/**"] }, "dist/a")).toBe(true)
    expect(FileSet.contains({ _tag: "TreeArtifact", path: "dist" }, "distribution/a")).toBe(false)
    expect(FileSet.contains("dist/a", "dist\\a")).toBe(true)
  })

  it("refuses bigint in succeed JSON projections with a typed build error", () => {
    for (const value of [1n, { x: 1n }, [1n], { toJSON: () => 1n }]) {
      expect(() => Node.succeed(value)).toThrow(GraphBuildError)
      try {
        Node.succeed(value)
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_payload" })
      }
    }
  })

  it("refuses invalid self before invoking continuation builders", () => {
    const self = {} as Node.Node<number>
    let calls = 0
    const build = () => {
      calls++
      return Node.succeed(1)
    }
    expect(() => Node.branch(self, { if: () => true, then: build, else: build })).toThrow(GraphBuildError)
    expect(() => Node.catch(self, { onFailure: build })).toThrow(GraphBuildError)
    expect(calls).toBe(0)
  })

  it("refuses unchecked self nodes before constructing combinator topology", () => {
    for (const invalid of [{}, { ast: { _tag: "Succeed", value: 1 } }, null, undefined]) {
      const self = invalid as Node.Node<number>
      for (
        const build of [
          () => Node.map(self, (x) => x),
          () => Node.map((x: number) => x)(self),
          () => Node.andThen(self, Node.succeed(1)),
          () => Node.andThen(Node.succeed(1))(self),
          () => Node.bindPlanned(self, () => Node.succeed(1)),
          () => Node.bindPlanned(() => Node.succeed(1))(self),
          () => Node.branch(self, { if: () => true, then: () => Node.succeed(1), else: () => Node.succeed(2) }),
          () => Node.catch(self, { onFailure: () => Node.succeed(1) }),
          () => Node.priority(self, 1)
        ]
      ) expect(build).toThrow(GraphBuildError)
    }
  })
})
