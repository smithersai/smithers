/**
 * A planted symlink cannot carry a tool outside the workspace.
 *
 * `Preserve` follows an existing symlink to replace its target, `Write` and
 * `ApplyPatch` create parent directories before writing, and the native
 * search peer hands file names to an `rg` process of its own, so the guarded
 * filesystem every tool runs over must refuse each link shape that leaves the
 * workspace: a link to a host file, a link to a host directory, a dangling
 * link into a host directory, and a patch whose add or move destination is
 * one of those. These cases run the real kernel guard over the real Node
 * filesystem, for the mutation tools and for every read tool (`read`, `ls`,
 * and `grep` and `glob` through both search peers).
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, FileSystem, Layer, Option, type Path } from "effect"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as Ls from "../src/Ls.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Read from "../src/Read.ts"
import type * as Search from "../src/Search.ts"
import type * as StdError from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

const guarded = (workspace: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(
      Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, KernelFileSystem.withIsolatedFileSystem))
        .pipe(Layer.provide(NodeFileSystem.layer))
    ),
    Layer.provide(Layer.effect(
      GrantStore.GrantStore,
      GrantStore.make({
        attended: false,
        rules: [workspace, join(workspace, "**")].map((resource) =>
          new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "fs:*", resource }) })
        )
      })
    )),
    Layer.provide(Workspace.layer(workspace)),
    Layer.provideMerge(NodePath.layer)
  )

/**
 * A workspace holding two real files and every link shape under test, beside
 * a host directory holding one secret: `link` names the secret, `dir` names
 * the host directory, and `dangling` names a file the host directory does not
 * have yet.
 */
const plant = () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "std-symlink-ws-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "std-symlink-host-")))
  const secret = join(outside, "authorized_keys")
  writeFileSync(secret, "original host bytes\n")
  writeFileSync(join(workspace, "inside.txt"), "inside bytes\n")
  writeFileSync(join(workspace, "source.txt"), "source bytes\n")
  symlinkSync(secret, join(workspace, "link"))
  symlinkSync(outside, join(workspace, "dir"), "dir")
  symlinkSync(join(outside, "absent"), join(workspace, "dangling"))
  return { workspace, outside, secret }
}

const untouched = (fixture: ReturnType<typeof plant>) => {
  expect(readFileSync(fixture.secret, "utf8")).toBe("original host bytes\n")
  expect(readdirSync(fixture.outside)).toEqual(["authorized_keys"])
  expect(readFileSync(join(fixture.workspace, "source.txt"), "utf8")).toBe("source bytes\n")
  expect(readdirSync(fixture.workspace).sort()).toEqual(["dangling", "dir", "inside.txt", "link", "source.txt"])
}

const discard = (fixture: ReturnType<typeof plant>) => {
  rmSync(fixture.workspace, { recursive: true, force: true })
  rmSync(fixture.outside, { recursive: true, force: true })
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const patch = (...lines: ReadonlyArray<string>) =>
  ApplyPatch.run({ input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") })

type Call<R> = (target: string, workspace: string) => Effect.Effect<unknown, StdError.StdError, R>

const update = (target: string) => patch(`*** Update File: ${target}`, "@@", "-original host bytes", "+planted")
const add = (target: string) => patch(`*** Add File: ${target}`, "+planted")
const move = (target: string, workspace: string) =>
  patch(
    `*** Update File: ${join(workspace, "source.txt")}`,
    `*** Move to: ${target}`,
    "@@",
    "-source bytes",
    "+planted"
  )

const mutations: ReadonlyArray<
  [tool: string, shape: string, target: string, call: Call<FileSystem.FileSystem | Path.Path>]
> = [
  ["write", "a link to a host file", "link", (target) => Write.run({ path: target, content: "planted\n" })],
  [
    "edit",
    "a link to a host file",
    "link",
    (target) => Edit.run({ path: target, oldString: "original", newString: "planted" })
  ],
  ["apply_patch", "a link to a host file", "link", update],
  [
    "write",
    "a new file under a link to a host directory",
    "dir/new.txt",
    (target) => Write.run({ path: target, content: "planted\n" })
  ],
  [
    "edit",
    "a host file under a link to a host directory",
    "dir/authorized_keys",
    (target) => Edit.run({ path: target, oldString: "original", newString: "planted" })
  ],
  ["apply_patch", "a new file under a link to a host directory", "dir/new.txt", add],
  ["apply_patch", "a host file under a link to a host directory", "dir/authorized_keys", update],
  [
    "write",
    "a dangling link into a host directory",
    "dangling",
    (target) => Write.run({ path: target, content: "planted\n" })
  ],
  [
    "edit",
    "a dangling link into a host directory",
    "dangling",
    (target) => Edit.run({ path: target, oldString: "original", newString: "planted" })
  ],
  ["apply_patch", "a dangling link into a host directory", "dangling", add],
  ["apply_patch", "a link to a host file as the add destination", "link", add],
  ["apply_patch", "a link to a host file as the move destination", "link", move],
  ["apply_patch", "a dangling link as the move destination", "dangling", move],
  ["apply_patch", "a link to a host directory as the move destination", "dir/moved.txt", move]
]

it.each(mutations)(
  "%s through %s is refused and the host directory is untouched",
  async (_tool, _shape, target, call) => {
    const fixture = plant()
    try {
      const path = join(fixture.workspace, target)
      const exit = await Effect.runPromiseExit(
        Effect.scoped(call(path, fixture.workspace).pipe(Effect.provide(guarded(fixture.workspace))))
      )
      expect(failureOf(exit)).toMatchObject({ code: "permission_denied", path })
      untouched(fixture)
    } finally {
      discard(fixture)
    }
  }
)

const reads: ReadonlyArray<
  [tool: string, shape: string, target: string, call: Call<FileSystem.FileSystem | Path.Path>]
> = [
  ["read", "a link to a host file", "link", (target) => Read.run({ path: target })],
  [
    "read",
    "a host file under a link to a host directory",
    "dir/authorized_keys",
    (target) => Read.run({ path: target })
  ],
  ["read", "a dangling link into a host directory", "dangling", (target) => Read.run({ path: target })],
  ["ls", "a link to a host directory", "dir", (target) => Ls.run({ path: target })],
  ["ls", "a link to a host file", "link", (target) => Ls.run({ path: target })]
]

it.each(reads)("%s through %s is refused", async (_tool, _shape, target, call) => {
  const fixture = plant()
  try {
    const path = join(fixture.workspace, target)
    const exit = await Effect.runPromiseExit(
      Effect.scoped(call(path, fixture.workspace).pipe(Effect.provide(guarded(fixture.workspace))))
    )
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied", path })
    untouched(fixture)
  } finally {
    discard(fixture)
  }
})

const peers: ReadonlyArray<
  [peer: string, layer: Layer.Layer<Search.Search, never, FileSystem.FileSystem | Path.Path>]
> = [
  ["portable", PortableSearch.layer],
  ["native", NativeSearch.layer.pipe(Layer.provide(NodeChildProcessSpawner.layer))]
]

const searches: ReadonlyArray<[tool: string, shape: string, target: string, call: Call<Search.Search>]> = [
  ["grep", "a link to a host directory as the root", "dir", (root) => Grep.run({ pattern: "bytes", root })],
  ["grep", "a link to a host file as the root", "link", (root) => Grep.run({ pattern: "bytes", root })],
  ["glob", "a link to a host directory as the root", "dir", (root) => Glob.run({ pattern: "**", root })],
  ["glob", "a link to a host file as the root", "link", (root) => Glob.run({ pattern: "**", root })]
]

for (const [peer, search] of peers) {
  it.each(searches)(`%s through %s is refused by the ${peer} peer`, async (_tool, _shape, target, call) => {
    const fixture = plant()
    try {
      const root = join(fixture.workspace, target)
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          call(root, fixture.workspace).pipe(Effect.provide(search), Effect.provide(guarded(fixture.workspace)))
        )
      )
      expect(failureOf(exit)).toMatchObject({ code: "permission_denied", path: root })
      untouched(fixture)
    } finally {
      discard(fixture)
    }
  })

  it(`a search of the workspace by the ${peer} peer reaches no host file through a link`, async () => {
    const fixture = plant()
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.all({
            grep: Grep.run({ pattern: "bytes", root: fixture.workspace }),
            glob: Glob.run({ pattern: "**", root: fixture.workspace })
          }).pipe(Effect.provide(search), Effect.provide(guarded(fixture.workspace)))
        )
      )
      expect(result.grep.matches.map((match) => [basename(match.file), match.text]).sort()).toEqual([
        ["inside.txt", "inside bytes"],
        ["source.txt", "source bytes"]
      ])
      expect(result.glob.paths.map((path) => basename(path)).sort()).toEqual(["inside.txt", "source.txt"])
      untouched(fixture)
    } finally {
      discard(fixture)
    }
  })
}
