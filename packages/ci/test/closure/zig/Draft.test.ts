import type * as Path from "effect/Path"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Draft from "../../../src/closure/zig/Draft.ts"
import type * as Graph from "../../../src/closure/zig/Graph.ts"
import type * as Manifest from "../../../src/closure/zig/Manifest.ts"

const place: Draft.Place = {
  root: "/repo",
  directory: "/repo/project",
  version: "0.17.1",
  // Only `relative`, `resolve` and `isAbsolute` are used, and Node's POSIX path has all three.
  path: NodePath.posix as unknown as Path.Path
}

const input = (prefix: Manifest.Prefix, path: string, directory = false): Manifest.Input => ({
  prefix,
  path,
  directory,
  digest: new Uint8Array(16)
})

const step = (kind: string): Graph.Step => ({
  index: 3,
  name: `a ${kind} step`,
  kind,
  deps: [],
  paths: [],
  open: [],
  test: false
})

const admitted = (...inputs: ReadonlyArray<Manifest.Input>) => {
  const draft = Draft.make("entry")
  for (const one of inputs) Draft.admit(place, draft, "who", one)
  return Draft.close("zig", draft, new Map([...draft.files].map((path) => [path, `digest of ${path}`])))
}

describe("Draft.admit", () => {
  it("places a file of the repository by its path from the repository root", () => {
    expect(
      admitted(input("build-root", "src/a.zig"), input("cwd", "/repo/project/b.zig"), input("cwd", "../c.zig")).files
    )
      .toEqual([
        { path: "c.zig", digest: "digest of c.zig" },
        { path: "project/b.zig", digest: "digest of project/b.zig" },
        { path: "project/src/a.zig", digest: "digest of project/src/a.zig" }
      ])
  })

  it("names a directory that is read whole", () => {
    expect(admitted(input("build-root", "src", true), input("build-root", "data", true))).toEqual({
      strategy: "zig",
      entries: ["entry"],
      files: [],
      packages: [],
      unresolved: [],
      dynamic: [],
      directories: ["project/data", "project/src"]
    })
  })

  it("reports the repository root read whole as dynamic", () => {
    expect(admitted(input("cwd", "/repo", true))).toMatchObject({
      packages: [],
      dynamic: [{ from: "who", specifier: "the whole repository" }]
    })
  })

  it("names the package an input outside the repository belongs to", () => {
    expect(
      admitted(
        input("zig-lib", "std/std.zig"),
        input("global-cache", "p/zlib-1.3.1-ZZQ7lVg/src/root.zig"),
        input("global-cache", "b/8ac3e9f9f0d1c65d/builtin.zig"),
        input("cwd", "/usr/include/stdio.h"),
        input("build-root", "../../elsewhere/x.zig")
      )
    ).toEqual({
      strategy: "zig",
      entries: ["entry"],
      files: [],
      packages: ["host", "zig@0.17.1", "zlib-1.3.1-ZZQ7lVg"],
      unresolved: [],
      dynamic: []
    })
  })

  it("leaves out what another step wrote", () => {
    expect(admitted(input("local-cache", "o/abc/words.zig"))).toMatchObject({ files: [], packages: [], unresolved: [] })
  })

  it("reports an input with a prefix Zig 0.17 does not define", () => {
    expect(admitted(input("unknown", "odd")).unresolved).toEqual([{ from: "who", specifier: "odd" }])
  })
})

describe("Draft.settle", () => {
  const digest = "0123456789abcdef0123456789abcdef"
  const manifests = new Map([[digest, [input("build-root", "src/a.zig"), input("zig-lib", "std/std.zig")]]])
  const success = {
    step: 3,
    status: "success" as const,
    problems: [],
    outputs: [{ prefix: "local-cache" as const, path: `o/${digest}/test` }]
  }

  const settled = (kind: string, result: Parameters<typeof Draft.settle>[3], found = manifests) => {
    const draft = Draft.make("entry")
    Draft.settle(place, draft, step(kind), result, found)
    return { files: [...draft.files], packages: [...draft.packages], unresolved: draft.unresolved }
  }

  it("adds the files the compiler listed for a step that was built", () => {
    expect(settled("compile", success)).toEqual({
      files: ["project/src/a.zig"],
      packages: ["zig@0.17.1"],
      unresolved: []
    })
    expect(settled("run", success)).toEqual({ files: ["project/src/a.zig"], packages: ["zig@0.17.1"], unresolved: [] })
  })

  it("reports a compile step the server did not build", () => {
    expect(settled("compile", undefined).unresolved).toEqual([{
      from: "a compile step",
      specifier: "the step was not built"
    }])
    expect(settled("translate_c", undefined).unresolved).toEqual([
      { from: "a translate_c step", specifier: "the step was not built" }
    ])
    // A command that is not a compile step declares its inputs; it need not be built.
    expect(settled("run", undefined).unresolved).toEqual([])
  })

  it("reports each compile error against the file it points at", () => {
    const failure = { step: 3, status: "failure" as const, outputs: [] }
    expect(
      settled("compile", {
        ...failure,
        problems: [{ message: "bad", file: "src/x.zig" }, { message: "worse", file: undefined }]
      })
        .unresolved
    ).toEqual([{ from: "src/x.zig", specifier: "bad" }, { from: "a compile step", specifier: "worse" }])
    expect(settled("compile", { ...failure, status: "skipped", problems: [] }).unresolved).toEqual([
      { from: "a compile step", specifier: "the step ended as skipped" }
    ])
  })

  it("reports a compile step whose list of files cannot be found", () => {
    const left = [{ from: "a compile step", specifier: "the compiler left no list of the files it read" }]
    expect(settled("compile", success, new Map()).unresolved).toEqual(left)
    expect(settled("compile", { ...success, outputs: [] }).unresolved).toEqual(left)
    expect(settled("compile", { ...success, outputs: [{ prefix: "local-cache", path: "tmp/odd" }] }).unresolved)
      .toEqual(left)
    // A step that declares its inputs may leave no list.
    expect(settled("options", success, new Map()).unresolved).toEqual([])
  })
})

describe("Draft.listed", () => {
  it("finds the manifest of a cache path, and nothing for a path with none", () => {
    const digest = "0123456789abcdef0123456789abcdef"
    const inputs = [input("build-root", "a.zig")]
    const manifests = new Map([[digest, inputs]])
    expect(Draft.listed(manifests, `.zig-cache/c/${digest}`)).toBe(inputs)
    expect(Draft.listed(manifests, ".zig-cache/tmp/config")).toBeUndefined()
    expect(Draft.listed(manifests, undefined)).toBeUndefined()
  })
})

describe("Draft.outputOf", () => {
  it("reads the output directory from a cache path", () => {
    const digest = "0123456789abcdef0123456789abcdef"
    expect(Draft.outputOf(`o/${digest}/test`)).toBe(digest)
    expect(Draft.outputOf(`.zig-cache/c/${digest}`)).toBe(digest)
    expect(Draft.outputOf(`.zig-cache/tmp/${digest}`)).toBeUndefined()
    expect(Draft.outputOf("o/short/test")).toBeUndefined()
  })
})

describe("Draft.close", () => {
  it("sorts, drops repeats and reports a file with no digest", () => {
    const draft = Draft.make("entry")
    draft.files.add("b.zig").add("a.zig").add("gone.zig")
    draft.packages.add("zlib").add("host")
    draft.unresolved.push({ from: "z", specifier: "1" }, { from: "a", specifier: "2" }, { from: "a", specifier: "1" }, {
      from: "z",
      specifier: "1"
    })
    draft.dynamic.push({ from: "d", specifier: "x/" }, { from: "d", specifier: "x/" })
    expect(Draft.close("zig", draft, new Map([["a.zig", "1"], ["b.zig", "2"]]))).toEqual({
      strategy: "zig",
      entries: ["entry"],
      files: [{ path: "a.zig", digest: "1" }, { path: "b.zig", digest: "2" }],
      packages: ["host", "zlib"],
      unresolved: [
        { from: "a", specifier: "1" },
        { from: "a", specifier: "2" },
        { from: "gone.zig", specifier: "the file cannot be read" },
        { from: "z", specifier: "1" }
      ],
      dynamic: [{ from: "d", specifier: "x/" }]
    })
  })
})
