/**
 * The listing `RemoteSearch` reads back, and the read-only filesystem it
 * serves the in-process peer from.
 *
 * The parity suite proves the walk reads the same tree through it; these
 * cases pin every answer each kind of listed path gives, including the ones
 * a walk only asks in its corners.
 */
import { NodePath } from "@effect/platform-node"
import * as Rooted from "@smthrs/kernel/Rooted"
import { Effect, Path, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as RemoteTree from "../src/internal/RemoteTree.vibe"

const path = Rooted.path(
  Effect.runSync(
    Effect.gen(function*() {
      return yield* Path.Path
    }).pipe(Effect.provide(NodePath.layerPosix))
  ),
  "/w"
)
const encoder = new TextEncoder()

const listing = (records: ReadonlyArray<string>, tail: Uint8Array = new Uint8Array()): Uint8Array => {
  const head = encoder.encode(records.map((record) => `${record}\0`).join(""))
  const bytes = new Uint8Array(head.length + tail.length)
  bytes.set(head)
  bytes.set(tail, head.length)
  return bytes
}

const tree = RemoteTree.parse(
  listing([
    "d/w",
    "d/w/src",
    "f/w/src/a.ts",
    "f/w/src/locked.ts",
    "u/w/sealed",
    "D/w/link-dir",
    "F/w/link-file",
    "L/w/dangling",
    "o/w/fifo",
    "E"
  ]),
  "/w",
  path
)!

const fs = RemoteTree.fileSystem(
  { ...tree, contents: new Map([...tree.contents, ["/w/src/a.ts", encoder.encode("needle\n")]]) },
  path
)

const reason = <A>(effect: Effect.Effect<A, { readonly reason: { readonly _tag: string } }>) =>
  Effect.runSync(Effect.match(effect, { onSuccess: () => "success", onFailure: (error) => error.reason._tag }))

describe("RemoteTree.parse", () => {
  it("files each listed path under its parent, and the root under none", () => {
    expect(tree.children).toEqual(
      new Map([
        ["/w", ["src", "sealed", "link-dir", "link-file", "dangling", "fifo"]],
        ["/w/src", ["a.ts", "locked.ts"]]
      ])
    )
    expect(tree.contents).toEqual(new Map())
  })

  it("refuses a listing that is not records ending in E, or whose ignore files are not tar", () => {
    expect(RemoteTree.parse(listing(["d/w"]), "/w", path)).toBeUndefined()
    expect(RemoteTree.parse(listing(["x/w", "E"]), "/w", path)).toBeUndefined()
    expect(RemoteTree.parse(listing(["", "E"]), "/w", path)).toBeUndefined()
    expect(RemoteTree.parse(listing(["d/w", "E"], new Uint8Array(512).fill(1)), "/w", path)).toBeUndefined()
  })

  it("names tar's stripped members by their absolute paths again", () => {
    expect([...RemoteTree.absolute(new Map([["w/.gitignore", new Uint8Array()]])).keys()]).toEqual(["/w/.gitignore"])
  })
})

describe("RemoteTree.fileSystem", () => {
  it("states each kind the way the platform states what it names", () => {
    const stat = (value: string) =>
      Effect.runSync(Effect.match(fs.stat(value), {
        onSuccess: (info) => `${info.type}:${info.size}`,
        onFailure: (error) => error.reason._tag
      }))
    expect(["/w", "src", "sealed", "link-dir", "src/a.ts", "link-file", "fifo", "dangling", "absent"].map(stat))
      .toEqual([
        "Directory:0",
        "Directory:0",
        "Directory:0",
        "Directory:0",
        "File:7",
        "File:0",
        "Unknown:0",
        "NotFound",
        "NotFound"
      ])
  })

  it("lists only what it may, and refuses the rest with the platform's reasons", () => {
    expect(Effect.runSync(fs.readDirectory("src"))).toEqual(["a.ts", "locked.ts"])
    expect(Effect.runSync(fs.readDirectory("/w/sealed/.."))).toHaveLength(6)
    expect(["sealed", "dangling", "absent", "src/a.ts", "link-dir"].map((value) => reason(fs.readDirectory(value))))
      .toEqual(["PermissionDenied", "NotFound", "NotFound", "BadResource", "BadResource"])
  })

  it("knows a link from what it names", () => {
    expect(["link-dir", "link-file", "dangling", "src", "absent"].map((value) => reason(fs.readLink(value))))
      .toEqual(["success", "success", "success", "BadResource", "NotFound"])
  })

  it("serves the bytes that came back, and refuses a file whose bytes did not", () => {
    expect(Effect.runSync(fs.readFileString("src/a.ts"))).toBe("needle\n")
    const streamed = Array.from(Effect.runSync(Stream.runCollect(fs.stream("/w/src/a.ts"))))
    expect(streamed.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["needle\n"])
    expect(["src/locked.ts", "link-file", "absent", "dangling", "src"].map((value) => reason(fs.readFile(value))))
      .toEqual(["PermissionDenied", "PermissionDenied", "NotFound", "NotFound", "BadResource"])
  })
})
