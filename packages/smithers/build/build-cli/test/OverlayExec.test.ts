import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as OverlayExec from "../src/OverlayExec.ts"
import * as PackageTree from "../src/PackageTree.ts"

let base: string
let root: string
let scratch: string | undefined

beforeEach(async () => {
  base = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-overlay-")))
  root = NodePath.join(base, "workspace")
  await Fs.mkdir(root)
  await Fs.writeFile(NodePath.join(root, "original.txt"), "original")
  await Fs.writeFile(NodePath.join(root, "replacement.txt"), "replacement")
})

afterEach(async () => {
  if (scratch !== undefined) await Fs.rm(scratch, { recursive: true, force: true })
  scratch = undefined
  await Fs.rm(base, { recursive: true, force: true })
})

const replacement = (path: string, source = "replacement.txt"): OverlayExec.Replacement => ({
  overlay: "//:overlay",
  path,
  source,
  digest: "unused-by-apply"
})

describe("apply", () => {
  it("refuses an absolute link back into the original workspace that the portal census excludes", async () => {
    ChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root })
    await Fs.symlink(NodePath.join(root, "original.txt"), NodePath.join(root, "destination.txt"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals).toEqual([])
      scratch = await PackageTree.scratchCopy(root, ".flows")
      const refusal = await OverlayExec.apply(scratch, [replacement("destination.txt")]).catch((cause: unknown) =>
        cause
      )
      // Check durable bytes before any rollback: the census cannot restore this link.
      expect(await Fs.readFile(NodePath.join(root, "original.txt"), "utf8")).toBe("original")
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual([])
      expect(refusal).toBeInstanceOf(Error)
      expect(String(refusal)).toMatch(/Overlay destination.*workspace/)
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("refuses a symlinked parent before creating directories outside scratch", async () => {
    await Fs.symlink(base, NodePath.join(root, "portal"))
    await expect(OverlayExec.apply(root, [replacement("portal/new/destination.txt")])).rejects.toThrow(
      /Overlay destination/
    )
    await expect(Fs.lstat(NodePath.join(base, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("replaces an internal final symlink without changing its target", async () => {
    await Fs.symlink("original.txt", NodePath.join(root, "destination.txt"))
    await OverlayExec.apply(root, [replacement("destination.txt")])
    expect(await Fs.readFile(NodePath.join(root, "original.txt"), "utf8")).toBe("original")
    expect((await Fs.lstat(NodePath.join(root, "destination.txt"))).isSymbolicLink()).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "destination.txt"), "utf8")).toBe("replacement")
  })

  it.each(["destination.txt", "portal/new/destination.txt"])("refuses a dangling link at %s", async (path) => {
    const target = NodePath.join(base, "missing")
    await Fs.symlink(target, NodePath.join(root, path.split("/")[0]!))
    await expect(OverlayExec.apply(root, [replacement(path)])).rejects.toThrow(/Overlay destination/)
    await expect(Fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses an internal directory link without changing its target", async () => {
    await Fs.mkdir(NodePath.join(root, "directory"))
    await Fs.symlink("directory", NodePath.join(root, "alias"))
    await expect(OverlayExec.apply(root, [replacement("alias/destination.txt")])).rejects.toThrow(
      /Overlay destination directory/
    )
    expect(await Fs.readdir(NodePath.join(root, "directory"))).toEqual([])
  })

  it("refuses an escaping replacement source before creating its destination", async () => {
    await Fs.writeFile(NodePath.join(base, "outside.txt"), "outside")
    await Fs.symlink(NodePath.join(base, "outside.txt"), NodePath.join(root, "source.txt"))
    await expect(OverlayExec.apply(root, [replacement("new/destination.txt", "source.txt")])).rejects.toThrow(
      /Overlay source/
    )
    await expect(Fs.lstat(NodePath.join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["source", "destination"])("refuses a lexical %s escape", async (side) => {
    await Fs.writeFile(NodePath.join(base, "outside.txt"), "outside")
    const entry = side === "source"
      ? replacement("destination.txt", "../outside.txt")
      : replacement("../outside.txt")
    await expect(OverlayExec.apply(root, [entry])).rejects.toThrow(/Overlay .*outside/)
    expect(await Fs.readFile(NodePath.join(base, "outside.txt"), "utf8")).toBe("outside")
  })

  it("refuses a source behind an escaping parent", async () => {
    await Fs.symlink(base, NodePath.join(root, "portal"))
    await Fs.writeFile(NodePath.join(base, "outside.txt"), "outside")
    await expect(OverlayExec.apply(root, [replacement("new/destination.txt", "portal/outside.txt")])).rejects.toThrow(
      /Overlay source/
    )
    await expect(Fs.lstat(NodePath.join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a missing source before creating destination directories", async () => {
    await expect(OverlayExec.apply(root, [replacement("new/destination.txt", "missing.txt")])).rejects.toThrow(
      /Overlay source is missing/
    )
    await expect(Fs.lstat(NodePath.join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("replaces a regular file and preserves the replacement's executable mode", async () => {
    await Fs.chmod(NodePath.join(root, "replacement.txt"), 0o755)
    const mode = (await Fs.stat(NodePath.join(root, "replacement.txt"))).mode & 0o777
    if (process.platform !== "win32") expect(mode).toBe(0o755)
    await OverlayExec.apply(root, [replacement("original.txt")])
    expect(await Fs.readFile(NodePath.join(root, "original.txt"), "utf8")).toBe("replacement")
    expect((await Fs.stat(NodePath.join(root, "original.txt"))).mode & 0o777).toBe(mode)
  })

  it("creates nested destinations and reads an internal replacement source link", async () => {
    await Fs.symlink("replacement.txt", NodePath.join(root, "source.txt"))
    await OverlayExec.apply(root, [replacement("new/nested/destination.txt", "source.txt")])
    expect(await Fs.readFile(NodePath.join(root, "new/nested/destination.txt"), "utf8")).toBe("replacement")
    expect(await Fs.readdir(NodePath.join(root, "new/nested"))).toEqual(["destination.txt"])
  })
})

const Consumer = Target.make("Consumer", {
  attrs: Schema.Struct({ data: Schema.Unknown }),
  kinds: ["build"],
  implementation: () => Target.notImplemented("Consumer")
})

/** A rule that shares the Overlay id but leaves `replace` unchecked, as a foreign catalog may. */
const LooseOverlay = Target.make("Overlay", {
  attrs: Schema.Struct({ base: Schema.Unknown, replace: Schema.Unknown }),
  kinds: ["build"],
  implementation: () => Target.notImplemented("Overlay")
})

const Bare = Target.make("Bare", {
  attrs: Schema.Unknown as never,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Bare")
})

describe("resolve", () => {
  const labels = new Map<Target.AnyTarget, string>()
  const label = (target: Target.AnyTarget, name: string): Target.AnyTarget => {
    labels.set(target, `//pkg:${name}`)
    return target
  }
  const resolveFor = (consumer: Target.AnyTarget) =>
    OverlayExec.resolve({
      root,
      consumer,
      packagePathOf: () => "pkg",
      labelOf: (target) => labels.get(target) ?? "//pkg:unlabelled"
    })
  const base = () => S.Filegroup({ srcs: [S.file("original.txt")] })

  beforeEach(async () => {
    await Fs.mkdir(NodePath.join(root, "pkg"))
    for (const name of ["a.txt", "b.txt", "c.txt"]) await Fs.writeFile(NodePath.join(root, "pkg", name), name)
  })

  it("sorts replacements by destination and anchors them to the overlay's package", async () => {
    const overlay = label(
      S.Overlay({
        base: base(),
        replace: { "z.txt": S.file("c.txt"), "x.txt": S.file("a.txt"), "y.txt": S.file("b.txt") }
      }),
      "overlay"
    )
    const resolution = await resolveFor(Consumer({ data: [overlay] }))
    expect(resolution.refusal).toBeUndefined()
    expect(resolution.replacements.map((entry) => [entry.path, entry.source])).toEqual([
      ["pkg/x.txt", "pkg/a.txt"],
      ["pkg/y.txt", "pkg/b.txt"],
      ["pkg/z.txt", "pkg/c.txt"]
    ])
    expect(resolution.replacements.every((entry) => entry.overlay === "//pkg:overlay")).toBe(true)
  })

  it("refuses one overlay that names a destination twice", async () => {
    const overlay = label(
      S.Overlay({ base: base(), replace: { "x.txt": S.file("a.txt"), "./x.txt": S.file("b.txt") } }),
      "twice"
    )
    const resolution = await resolveFor(Consumer({ data: [overlay] }))
    expect(resolution.refusal).toBe("Overlay conflict: //pkg:twice and //pkg:twice both replace pkg/x.txt")
  })

  it("refuses an overlay whose replacement source is missing", async () => {
    const overlay = label(S.Overlay({ base: base(), replace: { "x.txt": S.file("absent.txt") } }), "missing")
    const resolution = await resolveFor(Consumer({ data: [overlay] }))
    expect(resolution).toEqual({
      replacements: [],
      refusal: "Overlay //pkg:missing replacement source is missing: pkg/absent.txt"
    })
  })

  it("searches only plain data records of a forged consumer and never runs its getters", async () => {
    const plain = label(S.Overlay({ base: base(), replace: { "plain.txt": S.file("a.txt") } }), "plain")
    const bare = label(S.Overlay({ base: base(), replace: { "bare.txt": S.file("b.txt") } }), "bare")
    const hidden = label(S.Overlay({ base: base(), replace: { "hidden.txt": S.file("c.txt") } }), "hidden")
    let getterCalls = 0
    const data = {
      plain: { overlay: plain },
      nullPrototype: Object.assign(Object.create(null) as Record<string, unknown>, { overlay: bare }),
      map: new Map([["overlay", hidden]]),
      get accessor() {
        getterCalls += 1
        return hidden
      }
    }
    // Target.make snapshots attrs into plain data; a forged marker skips that, and Target.isTarget still admits it.
    const forged = { _tag: "Consumer" }
    Object.defineProperty(forged, Target.TargetTypeId, {
      value: Object.freeze({ ...Target.metadata(Consumer({ data: [] })), attrs: { data } })
    })
    expect(Target.isTarget(forged)).toBe(true)
    const resolution = await resolveFor(forged as Target.AnyTarget)
    expect(resolution.replacements.map((entry) => entry.overlay)).toEqual(["//pkg:bare", "//pkg:plain"])
    expect(getterCalls).toBe(0)
  })

  it("skips replace members that are not file declarations", async () => {
    const notRecord = label(LooseOverlay({ base: base(), replace: "x.txt" }), "string")
    const notFiles = label(
      LooseOverlay({
        base: base(),
        replace: { "n.txt": null, "s.txt": "a.txt", "g.txt": { _tag: "Glob", path: "a.txt" }, "f.txt": S.file("a.txt") }
      }),
      "mixed"
    )
    const resolution = await resolveFor(Consumer({ data: [notRecord, notFiles] }))
    expect(resolution.refusal).toBeUndefined()
    expect(resolution.replacements.map((entry) => [entry.overlay, entry.path])).toEqual([["//pkg:mixed", "pkg/f.txt"]])
  })

  it("resolves nothing for a consumer whose attrs are not a record", async () => {
    expect(Target.metadata(Bare(null as never)).attrs).toBeNull()
    expect(await resolveFor(Bare(null as never))).toEqual({ replacements: [] })
  })

  it("reaches overlays through filegroup sources once, but not through another target's data", async () => {
    const overlay = label(S.Overlay({ base: base(), replace: { "x.txt": S.file("a.txt") } }), "shared")
    const privateOverlay = label(S.Overlay({ base: base(), replace: { "y.txt": S.file("b.txt") } }), "private")
    const group = S.Filegroup({ srcs: [overlay] })
    const builder = Consumer({ data: [privateOverlay] })
    const resolution = await resolveFor(Consumer({ data: [group, overlay, builder] }))
    expect(resolution).toEqual({
      replacements: [{ overlay: "//pkg:shared", path: "pkg/x.txt", source: "pkg/a.txt", digest: expect.any(String) }]
    })
  })

  it("resolves nothing for a consumer that declares no data", async () => {
    expect(await resolveFor(Bare({} as never))).toEqual({ replacements: [] })
  })

  it("applies a resolved replacement inside an existing package directory", async () => {
    const overlay = label(S.Overlay({ base: base(), replace: { "a.txt": S.file("c.txt") } }), "apply")
    const resolution = await resolveFor(Consumer({ data: [overlay] }))
    await OverlayExec.apply(root, resolution.replacements)
    expect(await Fs.readFile(NodePath.join(root, "pkg", "a.txt"), "utf8")).toBe("c.txt")
    expect((await Fs.readdir(NodePath.join(root, "pkg"))).sort()).toEqual(["a.txt", "b.txt", "c.txt"])
  })
})
