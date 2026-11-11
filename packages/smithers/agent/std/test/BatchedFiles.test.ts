/**
 * The standard file flows over a batched host.
 *
 * The provider here stands in for a remote one (the Linux guest's lives in
 * `@smthrs/sandbox`, whose own suite runs these flows against its real
 * scripts). It serves real files from a temporary directory, counts its
 * calls, and can be told to fail, so these cases pin what each flow asks of
 * the seam, how many calls it makes, and how it reports each answer. The
 * filesystem's own operations are trapped, so a flow that fell back to them
 * fails loudly.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Option, Path, PlatformError, Result } from "effect"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as FileMutation from "../src/internal/FileMutation.ts"
import * as Ls from "../src/Ls.ts"
import * as Read from "../src/Read.ts"
import type { StdError } from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

type Files = NonNullable<Read.BatchedFileSystem[typeof Read.Batched]>

interface Options {
  /** Runs before the commit compares versions, as an outside writer would. */
  readonly beforeCommit?: () => Promise<void>
  /** Stops the commit at `index`: while staging (nothing applied) or after applying the changes before it. */
  readonly stop?: {
    readonly index: number
    readonly method: string
    readonly tag: PlatformError.SystemErrorTag
    readonly staged: boolean
  }
  /** Fails the snapshot call itself, as an unreachable host does. */
  readonly snapshot?: PlatformError.PlatformError
  /** Replaces one path's snapshot. */
  readonly seen?: (path: string, taken: FileMutation.Snapshot) => FileMutation.Snapshot
  /** Refuses the commit because another writer holds the lock of the change at this index. */
  readonly locked?: number
}

const failure = (method: string, tag: PlatformError.SystemErrorTag = "Unknown") =>
  PlatformError.systemError({ _tag: tag, module: "FileSystem", method, description: `${method} failed` })

/** A batched provider over `fs`, with the calls a round-trip test counts. */
const provider = (fs: FileSystem.FileSystem, path: Path.Path, options: Options = {}) => {
  const calls = {
    snapshot: [] as Array<unknown>,
    commit: [] as Array<ReadonlyArray<FileMutation.BatchedChange>>,
    list: 0
  }
  const version = (file: string) =>
    fs.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type === "File"
          ? Effect.map(fs.readFile(file), (bytes) => `${Option.getOrElse(info.ino, () => 0n)} ${bytes.join(",")}`)
          : Effect.succeed(`${info.type} ${Option.getOrElse(info.ino, () => 0n)}`)
      ),
      Effect.orElseSucceed(() => "absent")
    )
  const canonical = (file: string) =>
    fs.realPath(file).pipe(
      Effect.catch(() =>
        Effect.map(fs.realPath(path.dirname(file)), (parent) => path.join(parent, path.basename(file)))
      ),
      Effect.option,
      Effect.map(Option.getOrUndefined)
    )
  const files: Files = {
    snapshot: (paths, request) =>
      Effect.gen(function*() {
        calls.snapshot.push({ paths, ...request })
        if (options.snapshot !== undefined) return yield* Effect.fail(options.snapshot)
        return yield* Effect.forEach(paths, (file) =>
          Effect.gen(function*() {
            const info = yield* Effect.result(
              Effect.map(fs.stat(file), ({ size, type }) => ({ type, size: Number(size) }))
            )
            const asked = request?.read?.includes(file) === true
            const content = !asked
              ? undefined
              : Result.isFailure(info)
              ? Result.fail(info.failure)
              : info.success.type !== "File"
              ? Result.fail(failure("readFile", "BadResource"))
              : yield* Effect.result(fs.readFile(file))
            const taken: FileMutation.Snapshot = {
              canonical: yield* canonical(file),
              version: yield* version(file),
              info,
              ...(content === undefined ? {} : { content })
            }
            return options.seen?.(file, taken) ?? taken
          }))
      }),
    commit: (changes) =>
      Effect.gen(function*() {
        calls.commit.push(changes)
        if (options.locked !== undefined) {
          return { applied: 0, stopped: { index: options.locked, reason: "locked" as const } }
        }
        yield* Effect.promise(() => options.beforeCommit?.() ?? Promise.resolve())
        for (const [index, change] of changes.entries()) {
          if ((yield* version(change.path)) !== change.version) {
            return { applied: 0, stopped: { index, reason: "changed" as const } }
          }
        }
        const stop = options.stop
        if (stop?.staged === true) {
          return { applied: 0, stopped: { index: stop.index, reason: failure(stop.method, stop.tag) } }
        }
        for (const [index, change] of changes.entries()) {
          if (index === stop?.index) {
            return { applied: index, stopped: { index, reason: failure(stop.method, stop.tag) } }
          }
          if (change.content === null) yield* fs.remove(change.path)
          else {
            yield* fs.makeDirectory(path.dirname(change.path), { recursive: true })
            yield* fs.writeFile(change.path, change.content)
          }
        }
        return { applied: changes.length }
      }).pipe(Effect.orDie),
    list: (directory) =>
      Effect.gen(function*() {
        calls.list++
        const info = yield* fs.stat(directory)
        if (info.type !== "Directory") return yield* Effect.fail(failure("readDirectory", "BadResource"))
        return yield* Effect.forEach(yield* fs.readDirectory(directory), (name) =>
          Effect.map(
            Effect.option(fs.stat(path.join(directory, name))),
            (entry) => ({ name, directory: Option.isSome(entry) && entry.value.type === "Directory" })
          ))
      })
  }
  // Every operation a flow would use without the seam is trapped; `readDirectory`
  // stays for `read`'s not-found hint.
  const trapped = () => Effect.die("the flow bypassed the batched calls")
  const host: FileSystem.FileSystem = {
    ...fs,
    exists: trapped,
    stat: trapped,
    readFile: trapped,
    realPath: trapped,
    makeDirectory: trapped,
    writeFile: trapped,
    writeFileString: trapped,
    remove: trapped,
    rename: trapped,
    chmod: trapped,
    chown: trapped
  }
  Object.defineProperty(host, Read.Batched, { value: files, enumerable: false })
  return { host, calls }
}

const fixture = async <A>(body: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "std-batched-"))
  try {
    await writeFile(join(root, "a.txt"), "alpha\nbeta\n")
    await writeFile(join(root, "move.txt"), "moving\n")
    await writeFile(join(root, "gone.txt"), "gone\n")
    await mkdir(join(root, "dir"))
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Runs `flow` over the batched host the options describe. */
const run = <A>(flow: Effect.Effect<A, StdError, FileSystem.FileSystem | Path.Path>, options?: Options) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const { calls, host } = provider(yield* FileSystem.FileSystem, yield* Path.Path, options)
      const result = yield* Effect.result(Effect.provideService(flow, FileSystem.FileSystem, host))
      return { result, calls }
    }).pipe(Effect.provide(NodeServices.layer))
  )

/** The refusal a run ended with. */
const refusal = <A>(result: Result.Result<A, StdError>): StdError => {
  if (Result.isSuccess(result)) throw new Error("expected a refusal")
  return result.failure
}

/** The value a run answered. */
const answer = <A>(result: Result.Result<A, StdError>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

describe("batched hosts", () => {
  it("are ignored by a versioned host, whose provider always decides", async () => {
    await fixture(async (root) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const { calls, host } = provider(yield* FileSystem.FileSystem, yield* Path.Path)
          const versioned = {
            ...host,
            [Read.Preconditions]: { record: () => Effect.void, validate: () => Effect.void }
          }
          Object.defineProperty(versioned, Read.Batched, { value: FileMutation.batched(host) })
          expect(FileMutation.batched(versioned)).toBeUndefined()
          const refused = yield* Effect.flip(
            Edit.run({ path: join(root, "a.txt"), oldString: "alpha", newString: "x" }).pipe(
              Effect.provideService(FileSystem.FileSystem, versioned)
            )
          )
          expect(refused.code).toBe("provider_unavailable")
          expect(calls.snapshot).toEqual([])
        }).pipe(Effect.provide(NodeServices.layer))
      )
    })
  })

  it("are not inherited by a wrapper that spreads the filesystem", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const { host } = provider(yield* FileSystem.FileSystem, yield* Path.Path)
        expect(FileMutation.batched(host)).toBeDefined()
        expect(FileMutation.batched({ ...host })).toBeUndefined()
      }).pipe(Effect.provide(NodeServices.layer))
    )
  })
})

describe("read on a batched host", () => {
  it("describes and reads the file in one call", async () => {
    await fixture(async (root) => {
      const { calls, result } = await run(Read.run({ path: join(root, "a.txt") }))
      expect(answer(result)).toMatchObject({ content: "alpha\nbeta", totalLines: 2 })
      expect(calls.snapshot).toEqual([
        { paths: [join(root, "a.txt")], read: [join(root, "a.txt")], maxBytes: Read.MAX_READ_FILE_BYTES }
      ])
      expect(calls.commit).toEqual([])
    })
  })

  it.each(
    [
      ["a directory", "dir", undefined, "is_directory"],
      ["an absent file", "absent.txt", undefined, "not_found"],
      ["an unreadable file", "a.txt", "PermissionDenied", "permission_denied"],
      ["a file the host could not read", "a.txt", "Unknown", "command_failed"]
    ] as const
  )("refuses %s as the portable flow does", async (_case, name, contentFailure, code) => {
    await fixture(async (root) => {
      const { result } = await run(
        Read.run({ path: join(root, name) }),
        contentFailure === undefined ? {} : {
          seen: (_path, taken) => ({ ...taken, content: Result.fail(failure("readFile", contentFailure)) })
        }
      )
      expect(refusal(result)).toMatchObject({ code, path: join(root, name) })
    })
  })

  it("refuses a file over the limit without its bytes, a special file, and a host it cannot reach", async () => {
    await fixture(async (root) => {
      const target = join(root, "a.txt")
      const large = await run(Read.run({ path: target }), {
        seen: (_path, { canonical, version }) => ({
          canonical,
          version,
          info: Result.succeed({ type: "File", size: Read.MAX_READ_FILE_BYTES + 1 })
        })
      })
      expect(refusal(large.result).code).toBe("response_too_large")
      const fifo = await run(Read.run({ path: target }), {
        seen: (_path, taken) => ({ ...taken, info: Result.succeed({ type: "FIFO", size: 0 }) })
      })
      expect(refusal(fifo.result).code).toBe("not_found")
      const unreachable = await run(Read.run({ path: target }), { snapshot: failure("stat") })
      expect(refusal(unreachable.result).code).toBe("command_failed")
    })
  })
})

describe("edit on a batched host", () => {
  it("snapshots and commits once, against the version it read", async () => {
    await fixture(async (root) => {
      const target = join(root, "a.txt")
      const { calls, result } = await run(Edit.run({ path: target, oldString: "beta", newString: "gamma" }))
      expect(answer(result)).toMatchObject({ replacements: 1 })
      expect(calls.snapshot).toEqual([{ paths: [target], read: [target] }])
      expect(calls.commit).toEqual([[
        {
          path: target,
          content: new TextEncoder().encode("alpha\ngamma\n"),
          version: expect.any(String),
          lock: expect.stringMatching(/\.lock$/)
        }
      ]])
      expect(await readFile(target, "utf8")).toBe("alpha\ngamma\n")
    })
  })

  it("hands the commit the lock the ordinary path takes, and none for a path it could not resolve", async () => {
    await fixture(async (root) => {
      const target = join(root, "a.txt")
      // The ordinary path, over the real filesystem, names its lock in the file's directory.
      const ordinary = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          yield* FileMutation.acquire(yield* FileSystem.FileSystem, [target], yield* Path.Path)
          return yield* Effect.promise(() => readdir(root))
        })).pipe(Effect.provide(NodeServices.layer))
      )
      const lock = ordinary.filter((name) => name.endsWith(".lock"))
      expect(lock).toHaveLength(1)
      const { calls } = await run(Edit.run({ path: target, oldString: "beta", newString: "gamma" }))
      expect(calls.commit[0]![0]!.lock).toBe(join(await realpath(root), lock[0]!))
      const unresolved = await run(Edit.run({ path: target, oldString: "gamma", newString: "delta" }), {
        seen: (_path, taken) => ({ ...taken, canonical: undefined })
      })
      expect(answer(unresolved.result)).toMatchObject({ replacements: 1 })
      expect(unresolved.calls.commit[0]![0]!.lock).toBeUndefined()
    })
  })

  it("refuses a file whose lock another writer holds, with the ordinary path's refusal", async () => {
    await fixture(async (root) => {
      const target = join(root, "a.txt")
      const { calls, result } = await run(Edit.run({ path: target, oldString: "beta", newString: "gamma" }), {
        locked: 0
      })
      expect(refusal(result)).toMatchObject({
        code: "no_match",
        path: target,
        message: `Concurrent mutation of ${target}: lock ${
          calls.commit[0]![0]!.lock
        } is held. Re-read and retry after the other writer finishes; a stopped writer's lock requires explicit recovery.`
      })
      expect(await readFile(target, "utf8")).toBe("alpha\nbeta\n")
    })
  })

  it("refuses a file that changed after the snapshot and leaves it as the other writer left it", async () => {
    await fixture(async (root) => {
      const target = join(root, "a.txt")
      const { result } = await run(Edit.run({ path: target, oldString: "beta", newString: "gamma" }), {
        beforeCommit: () => writeFile(target, "alpha\nbeta\nother\n")
      })
      expect(refusal(result)).toMatchObject({ code: "no_match", path: target })
      expect(refusal(result).message).toContain("nothing was written")
      expect(await readFile(target, "utf8")).toBe("alpha\nbeta\nother\n")
    })
  })

  it.each(
    [
      ["chmod", "Unknown", "command_failed", "Could not preserve the mode"],
      ["chown", "PermissionDenied", "permission_denied", "Permission denied"],
      ["rename", "Unknown", "command_failed", "Could not write"]
    ] as const
  )("reports a commit that failed in %s as the portable flow does", async (method, tag, code, message) => {
    await fixture(async (root) => {
      const target = join(root, "a.txt")
      const { result } = await run(Edit.run({ path: target, oldString: "beta", newString: "gamma" }), {
        stop: { index: 0, method, tag, staged: true }
      })
      expect(refusal(result)).toMatchObject({ code, message: expect.stringContaining(message) })
      expect(await readFile(target, "utf8")).toBe("alpha\nbeta\n")
    })
  })

  it("names a missing file and a host it cannot reach", async () => {
    await fixture(async (root) => {
      const missing = await run(Edit.run({ path: join(root, "absent.txt"), oldString: "a", newString: "b" }))
      expect(refusal(missing.result)).toMatchObject({
        code: "not_found",
        message: `File not found: ${join(root, "absent.txt")}`
      })
      const unreachable = await run(Edit.run({ path: join(root, "a.txt"), oldString: "a", newString: "b" }), {
        snapshot: failure("stat")
      })
      expect(refusal(unreachable.result).code).toBe("command_failed")
    })
  })
})

describe("write on a batched host", () => {
  it("snapshots without reading and commits once, creating parents", async () => {
    await fixture(async (root) => {
      const target = join(root, "new", "deeper", "b.txt")
      const { calls, result } = await run(Write.run({ path: target, content: "bee\n" }))
      expect(answer(result)).toMatchObject({ created: true, bytesWritten: 4 })
      expect(calls.snapshot).toEqual([{ paths: [target], read: [] }])
      expect(calls.commit).toHaveLength(1)
      expect(await readFile(target, "utf8")).toBe("bee\n")
      const again = await run(Write.run({ path: target, content: "bee bee\n" }))
      expect(answer(again.result)).toMatchObject({ created: false })
    })
  })

  it("refuses a directory, and writes over a path its snapshot could not describe as new", async () => {
    await fixture(async (root) => {
      const directory = await run(Write.run({ path: join(root, "dir"), content: "x" }))
      expect(refusal(directory.result)).toMatchObject({
        code: "command_failed",
        message: `Cannot write a file over directory ${join(root, "dir")}`
      })
      expect(directory.calls.commit).toEqual([])
      const undescribed = await run(Write.run({ path: join(root, "a.txt"), content: "x" }), {
        seen: (_path, taken) => ({ ...taken, info: Result.fail(failure("stat")) })
      })
      expect(answer(undescribed.result)).toMatchObject({ created: true })
    })
  })

  it.each(
    [
      ["makeDirectory", "Unknown", "command_failed", "Could not create the parent directory"],
      ["makeDirectory", "PermissionDenied", "permission_denied", "Permission denied"],
      ["chmod", "Unknown", "command_failed", "Could not preserve the mode"],
      ["writeFile", "Unknown", "command_failed", "Could not write"]
    ] as const
  )("reports a commit that failed in %s with %s", async (method, tag, code, message) => {
    await fixture(async (root) => {
      const { result } = await run(Write.run({ path: join(root, "new", "b.txt"), content: "x" }), {
        stop: { index: 0, method, tag, staged: true }
      })
      expect(refusal(result)).toMatchObject({ code, message: expect.stringContaining(message) })
      expect(await readdir(root)).not.toContain("new")
    })
  })

  it("names a host it cannot reach", async () => {
    await fixture(async (root) => {
      const { result } = await run(Write.run({ path: join(root, "a.txt"), content: "x" }), {
        snapshot: failure("stat")
      })
      expect(refusal(result)).toMatchObject({
        code: "command_failed",
        message: `Could not inspect ${join(root, "a.txt")} before writing`
      })
    })
  })
})

const patch = (root: string) =>
  [
    "*** Begin Patch",
    `*** Add File: ${join(root, "new", "added.txt")}`,
    "+added",
    `*** Update File: ${join(root, "a.txt")}`,
    "@@",
    "-beta",
    "+gamma",
    `*** Update File: ${join(root, "move.txt")}`,
    `*** Move to: ${join(root, "new", "moved.txt")}`,
    "@@",
    "-moving",
    "+moved",
    `*** Delete File: ${join(root, "gone.txt")}`,
    "*** End Patch"
  ].join("\n")

describe("apply_patch on a batched host", () => {
  it("resolves, reads and commits every file in two calls", async () => {
    await fixture(async (root) => {
      const { calls, result } = await run(ApplyPatch.run({ input: patch(root) }))
      expect(answer(result)).toMatchObject({
        added: [join(root, "new", "added.txt")],
        modified: [join(root, "a.txt"), join(root, "new", "moved.txt")],
        deleted: [join(root, "gone.txt")]
      })
      expect(calls.snapshot).toEqual([{
        paths: [
          join(root, "new", "added.txt"),
          join(root, "a.txt"),
          join(root, "move.txt"),
          join(root, "new", "moved.txt"),
          join(root, "gone.txt")
        ],
        read: [join(root, "a.txt"), join(root, "move.txt")]
      }])
      expect(
        calls.commit.map((changes) =>
          changes.map(({ content, metadataFrom, path }) => ({ path, metadataFrom, removed: content === null }))
        )
      ).toEqual([[
        { path: join(root, "new", "added.txt"), metadataFrom: undefined, removed: false },
        { path: join(root, "a.txt"), metadataFrom: undefined, removed: false },
        { path: join(root, "new", "moved.txt"), metadataFrom: join(root, "move.txt"), removed: false },
        { path: join(root, "move.txt"), metadataFrom: undefined, removed: true },
        { path: join(root, "gone.txt"), metadataFrom: undefined, removed: true }
      ]])
      expect((await readdir(root)).sort()).toEqual(["a.txt", "dir", "new"])
      expect(await readFile(join(root, "new", "moved.txt"), "utf8")).toBe("moved\n")
    })
  })

  it("costs nothing for an empty patch", async () => {
    const { calls, result } = await run(ApplyPatch.run({ input: "*** Begin Patch\n*** End Patch" }))
    expect(answer(result)).toMatchObject({ added: [], modified: [], deleted: [] })
    expect([calls.snapshot.length, calls.commit.length]).toEqual([0, 0])
  })

  it("refuses two sections naming one file through a link or two spellings of a new path", async () => {
    await fixture(async (root) => {
      await symlink(join(root, "a.txt"), join(root, "alias.txt"))
      const alias = await run(ApplyPatch.run({
        input: `*** Begin Patch\n*** Delete File: ${join(root, "a.txt")}\n*** Delete File: ${
          join(root, "alias.txt")
        }\n*** End Patch`
      }))
      expect(refusal(alias.result)).toMatchObject({ code: "invalid_input", path: join(root, "alias.txt") })
      expect(alias.calls.commit).toEqual([])
      // Neither path nor parent exists, so both resolve lexically, as the portable flow does.
      const spelled = await run(ApplyPatch.run({
        input: `*** Begin Patch\n*** Add File: ${root}/x/y.txt\n+1\n*** Add File: ${root}/x/./y.txt\n+2\n*** End Patch`
      }))
      expect(refusal(spelled.result)).toMatchObject({ code: "invalid_input", path: `${root}/x/./y.txt` })
    })
  })

  it("commits nothing when any file changed after the snapshot", async () => {
    await fixture(async (root) => {
      const { result } = await run(ApplyPatch.run({ input: patch(root) }), {
        beforeCommit: () => writeFile(join(root, "gone.txt"), "changed\n")
      })
      expect(refusal(result)).toMatchObject({ code: "no_match", path: join(root, "gone.txt") })
      expect((await readdir(root)).sort()).toEqual(["a.txt", "dir", "gone.txt", "move.txt"])
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha\nbeta\n")
    })
  })

  it.each(
    [
      [0, "makeDirectory", "Unknown", true, "command_failed", "Failed to create parent directories for"],
      [0, "writeFile", "PermissionDenied", true, "permission_denied", "Permission denied"],
      [1, "chmod", "Unknown", true, "command_failed", "Could not preserve the mode"],
      [2, "rename", "Unknown", false, "command_failed", "Failed to write file"],
      [3, "remove", "Unknown", false, "command_failed", "Failed to remove original"],
      [4, "remove", "NotFound", false, "not_found", "Failed to delete file"]
    ] as const
  )(
    "reports change %i failing in %s as the portable flow does, with what was applied",
    async (index, method, tag, staged, code, message) => {
      await fixture(async (root) => {
        const { result } = await run(ApplyPatch.run({ input: patch(root) }), {
          stop: { index, method, tag, staged }
        })
        const error = refusal(result)
        expect(error.code).toBe(code)
        expect(error.message).toContain(message)
        if (method === "makeDirectory") return
        const applied = staged ? 0 : index
        const added = applied > 0 ? [join(root, "new", "added.txt")] : []
        const modified = [join(root, "a.txt"), join(root, "new", "moved.txt")].slice(0, Math.max(0, applied - 1))
        expect(error.message).toContain(
          `applied before failure: added=${JSON.stringify(added)}, modified=${JSON.stringify(modified)}, deleted=[]`
        )
      })
    }
  )

  it("lists a removal the commit applied before it stopped", async () => {
    await fixture(async (root) => {
      const { result } = await run(
        ApplyPatch.run({
          input: `*** Begin Patch\n*** Delete File: ${join(root, "gone.txt")}\n*** Add File: ${
            join(root, "b.txt")
          }\n+b\n*** End Patch`
        }),
        { stop: { index: 1, method: "rename", tag: "Unknown", staged: false } }
      )
      expect(refusal(result).message).toContain(
        `Failed to write file ${join(root, "b.txt")}; applied before failure: added=[], modified=[], deleted=${
          JSON.stringify([join(root, "gone.txt")])
        }`
      )
      expect(await readdir(root)).not.toContain("gone.txt")
    })
  })

  it("names a host it cannot reach", async () => {
    await fixture(async (root) => {
      const { result } = await run(ApplyPatch.run({ input: patch(root) }), { snapshot: failure("stat") })
      expect(refusal(result)).toMatchObject({
        code: "command_failed",
        message: `Failed to resolve patch path ${join(root, "new", "added.txt")}`
      })
    })
  })
})

describe("ls on a batched host", () => {
  it("lists the directory and each entry's kind in one call", async () => {
    await fixture(async (root) => {
      const { calls, result } = await run(Ls.run({ path: root }))
      expect(answer(result)).toMatchObject({
        entries: [
          { name: "dir/", kind: "directory" },
          { name: "a.txt", kind: "file" },
          { name: "gone.txt", kind: "file" },
          { name: "move.txt", kind: "file" }
        ],
        total: 4
      })
      expect(calls.list).toBe(1)
    })
  })

  it.each(
    [
      ["a file", "a.txt", 1, "not_a_directory"],
      ["an absent path", "absent", 1, "not_found"],
      ["an offset past the end", "dir", 2, "offset_out_of_range"]
    ] as const
  )("refuses %s", async (_case, name, offset, code) => {
    await fixture(async (root) => {
      const { result } = await run(Ls.run({ path: join(root, name), offset }))
      expect(refusal(result).code).toBe(code)
    })
  })
})
