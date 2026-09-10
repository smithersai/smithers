/**
 * The adapter is exercised two ways.
 *
 * Error mapping runs against stub backends, because the point is which thrown
 * value produces which `PlatformError` tag — a real backend cannot be made to
 * throw `EACCES` on demand. The operations run against **`node:fs/promises` in a
 * temp directory**: it satisfies `ZenFsPromisesLike` structurally, which is the
 * whole reason the seam is a structural slice, so the contract is checked
 * against a real filesystem rather than against a second in-memory
 * implementation we would then have to keep honest.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, PlatformError, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** A backend where every method rejects with the same value, to pin error mapping. */
const throwingFs = (cause: unknown): BrowserFileSystem.ZenFsPromisesLike => {
  const boom = async (): Promise<never> => {
    throw cause
  }
  return {
    open: boom,
    readFile: boom,
    writeFile: boom,
    mkdir: boom,
    readdir: boom,
    stat: boom,
    rm: boom
  }
}

const codeError = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code })

/** The root of every {@link nestedChain}. */
const chainRoot = "/root"

/** The stats a {@link nestedChain} reports for each of its levels. */
const chainDirectory: BrowserFileSystem.ZenFsStatsLike = {
  size: 0,
  mode: 0o755,
  mtimeMs: 0,
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false
}

/**
 * A backend holding one chain of `levels` nested directories under
 * {@link chainRoot}, every level named `d` and nothing linked. How deep a walk
 * over it gets is therefore the ceiling itself rather than a cycle.
 */
const nestedChain = (
  levels: number,
  helpers: {
    readonly lstat?: BrowserFileSystem.ZenFsPromisesLike["lstat"]
    readonly realpath?: BrowserFileSystem.ZenFsPromisesLike["realpath"]
  } = {}
): BrowserFileSystem.ZenFsPromisesLike => {
  const levelOf = (at: string): number | undefined => {
    if (at === chainRoot) return 0
    if (!at.startsWith(`${chainRoot}/`)) return undefined
    const segments = at.slice(chainRoot.length + 1).split("/")
    return segments.every((segment) => segment === "d") ? segments.length : undefined
  }
  return {
    ...throwingFs(codeError("ENOENT")),
    readdir: async (at: string) => {
      const level = levelOf(at)
      if (level === undefined || level > levels) throw codeError("ENOENT")
      return level < levels ? ["d"] : []
    },
    stat: async () => chainDirectory,
    ...helpers
  }
}

/** The pathname of the `level`th directory of a {@link nestedChain}. */
const chainPath = (level: number): string =>
  level === 0 ? chainRoot : `${chainRoot}/${Array.from({ length: level }, () => "d").join("/")}`

/** Every entry a fully walked {@link nestedChain} of `levels` reports, in order. */
const chainEntries = (levels: number): Array<string> =>
  Array.from({ length: levels }, (_, index) => Array.from({ length: index + 1 }, () => "d").join("/"))

describe("BrowserFileSystem error mapping", () => {
  /**
   * Every tag here is one `effect/PlatformError` already declares. Collapsing
   * them onto `Unknown` throws away the only thing a caller can branch on:
   * after `exists` stopped swallowing failures, "not there" and "could not
   * look" have to be distinguishable.
   */
  it.effect("normalizes each backend code onto the PlatformError tag that carries its meaning", () =>
    Effect.gen(function*() {
      const cases = [
        [codeError("ENOENT"), "NotFound"],
        [codeError("EEXIST"), "AlreadyExists"],
        [codeError("EACCES"), "PermissionDenied"],
        [codeError("EPERM"), "PermissionDenied"],
        [codeError("EISDIR"), "BadResource"],
        [codeError("ENOTDIR"), "BadResource"],
        [codeError("ELOOP"), "BadResource"],
        [codeError("EBUSY"), "Busy"],
        [codeError("EIO"), "Unknown"]
      ] as const

      for (const [cause, tag] of cases) {
        const fileSystem = BrowserFileSystem.make(throwingFs(cause))
        const error = yield* (Effect.flip(fileSystem.readFile("/denied")))

        expect(error.reason).toMatchObject({
          _tag: tag,
          method: "readFile",
          pathOrDescriptor: "/denied",
          description: `${(cause as Error & { code: string }).code}: boom`,
          cause
        })
      }
    }))

  it.effect("falls back to Unknown for a rejection carrying no usable code", () =>
    Effect.gen(function*() {
      const causes = [new Error("no code at all"), Object.assign(new Error("numeric code"), { code: 2 })]

      for (const cause of causes) {
        const fileSystem = BrowserFileSystem.make(throwingFs(cause))
        const error = yield* (Effect.flip(fileSystem.readFile("/p")))

        expect(error.reason._tag).toBe("Unknown")
      }
    }))

  it.effect("stringifies a non-Error rejection value into the description", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs("plain string failure"))

      const error = yield* (Effect.flip(fileSystem.stat("/x")))

      expect(error.reason._tag).toBe("Unknown")
      expect(error.reason.description).toBe("plain string failure")
    }))

  it.effect("names the failing method for every wired operation", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))
      const operations: ReadonlyArray<
        readonly [string, Effect.Effect<unknown, { readonly reason: { readonly method: string } }>]
      > = [
        ["readFile", fileSystem.readFile("/p")],
        ["writeFile", fileSystem.writeFile("/p", encoder.encode("x"))],
        ["makeDirectory", fileSystem.makeDirectory("/p")],
        ["readDirectory", fileSystem.readDirectory("/p")],
        ["stat", fileSystem.stat("/p")],
        ["realPath", fileSystem.realPath("/p")],
        ["remove", fileSystem.remove("/p")],
        ["access", fileSystem.access("/p")],
        ["stream", Stream.runCollect(fileSystem.stream("/p"))]
      ]

      for (const [method, effect] of operations) {
        const error = yield* (Effect.flip(effect))
        expect(error.reason.method).toBe(method)
      }
    }))

  it.effect("reports an undecodable encoding as a BadArgument rather than a system failure", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        readFile: async () => encoder.encode("alpha")
      })

      const error = yield* (
        Effect.flip(fileSystem.readFileString("/p", "not-a-real-encoding"))
      )

      expect(error.reason).toMatchObject({
        _tag: "BadArgument",
        method: "readFileString",
        description: "invalid encoding"
      })
    }))

  it.effect("reports an unencodable string as a BadArgument before touching the backend", () =>
    Effect.gen(function*() {
      const written: Array<unknown> = []
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        writeFile: async (_path, data) => {
          written.push(data)
        }
      })
      /** `TextEncoder.encode` coerces its argument, so a throwing `toString` is the only way in. */
      const hostile = {
        toString: (): string => {
          throw new Error("not stringifiable")
        }
      } as unknown as string

      const error = yield* (Effect.flip(fileSystem.writeFileString("/p", hostile)))

      expect(error.reason).toMatchObject({
        _tag: "BadArgument",
        method: "writeFileString",
        description: "could not encode string"
      })
      expect(written).toEqual([])
    }))

  it.effect("reports `exists` as false for a path that is absent", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))

      expect(yield* (fileSystem.exists("/missing"))).toBe(false)
    }))

  /**
   * `false` means "this path is not there". A backend that refused to look
   * answered a different question, and effect's own derivation propagates it
   * rather than reporting absence.
   */
  it.effect("propagates a non-NotFound failure from `exists` instead of reporting absence", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("EACCES")))

      const error = yield* (Effect.flip(fileSystem.exists("/denied")))

      expect(error.reason).toMatchObject({ _tag: "PermissionDenied", method: "exists", pathOrDescriptor: "/denied" })
    }))

  /**
   * A backend that reports more bytes than it was given a buffer for would
   * move the read position backwards and grow the remaining count, so the
   * unfold would loop without bound. It is refused instead.
   */
  it.effect("refuses a read length the backend cannot have produced", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        open: async () => ({
          read: async (buffer: Uint8Array) => ({ bytesRead: buffer.length + 1 }),
          close: async () => {}
        })
      })

      const error = yield* (Effect.flip(Stream.runCollect(fileSystem.stream("/p"))))

      expect(error.reason).toMatchObject({ _tag: "BadResource", method: "stream.read", pathOrDescriptor: "/p" })
    }))

  /**
   * A backend with `lstat` never descends into a symlinked directory, so a
   * cycle cannot form. One with only `stat` follows the link, which is why the
   * walk also refuses to visit a directory it has already canonicalized.
   */
  it.effect("terminates a recursive listing over a backend whose directories loop", () =>
    Effect.gen(function*() {
      const directory: BrowserFileSystem.ZenFsStatsLike = {
        size: 0,
        mode: 0o755,
        mtimeMs: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false
      }
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        readdir: async () => ["loop"],
        stat: async () => directory,
        realpath: async () => "/root"
      })

      expect(yield* (fileSystem.readDirectory("/root", { recursive: true }))).toEqual(["loop"])
    }))

  /**
   * The mount root is the only workspace root the isolation layer permits, and
   * it already ends in the separator. A backend keyed by exact pathname, like
   * this one, cannot find `//a`, so every child under `/` must be joined
   * without doubling it.
   */
  it.effect("walks the mount root without handing the backend a doubled separator", () =>
    Effect.gen(function*() {
      const tree: Record<string, Array<string>> = { "/": ["a"], "/a": ["b"], "/a/b": [] }
      const seen: Array<string> = []
      const exactKey = async (at: string): Promise<Array<string>> => {
        seen.push(at)
        const names = tree[at]
        if (names === undefined) throw codeError("ENOENT")
        return names
      }
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        readdir: exactKey,
        stat: async (at: string) => {
          await exactKey(at)
          return chainDirectory
        }
      })

      expect(yield* (fileSystem.readDirectory("/", { recursive: true }))).toEqual(["a", "a/b"])
      expect(seen.filter((at) => at.includes("//"))).toEqual([])
      expect(seen).toEqual(["/", "/a", "/a", "/a/b", "/a/b"])
    }))

  /**
   * The visited set only closes a loop for a backend that can canonicalize.
   * One with neither `lstat` nor `realpath` follows the link and reports a
   * fresh path at every level, so that walk, and only that walk, is bounded.
   * A finite tree over the same shape is still walked whole.
   */
  it.effect("bounds a walk over a backend with neither lstat nor realpath", () =>
    Effect.gen(function*() {
      const directory: BrowserFileSystem.ZenFsStatsLike = {
        size: 0,
        mode: 0o755,
        mtimeMs: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false
      }
      const helperless = (readdir: (at: string) => Promise<Array<string>>) =>
        BrowserFileSystem.make({ ...throwingFs(codeError("ENOENT")), readdir, stat: async () => directory })

      const finite = yield* (
        helperless(async (at) => (at === "/root/./child/.." ? ["only"] : [])).readDirectory("/root/./child/..", {
          recursive: true
        })
      )
      const error = yield* (
        Effect.flip(helperless(async () => ["loop"]).readDirectory("/root", { recursive: true }))
      )

      expect(finite).toEqual(["only"])
      expect(error.reason).toMatchObject({ _tag: "BadResource", method: "readDirectory" })
      expect(error.message).toContain("loops")
    }))

  /**
   * The ceiling is a documented number, so it is pinned as one. A chain of 128
   * nested directories is reported whole, and the 129th level is the one the
   * walk refuses and names. A limit of any other size, or a `>=` where the
   * check reads `>`, changes one of those answers.
   */
  it.effect("walks 128 nested levels over a helperless backend and refuses the 129th by name", () =>
    Effect.gen(function*() {
      const walk = (levels: number) =>
        BrowserFileSystem.make(nestedChain(levels)).readDirectory(chainRoot, { recursive: true })

      expect(yield* (walk(127))).toEqual(chainEntries(127))
      expect(yield* (walk(128))).toEqual(chainEntries(128))

      const refused = yield* (Effect.flip(walk(129)))

      expect(refused.reason).toMatchObject({
        _tag: "BadResource",
        method: "readDirectory",
        pathOrDescriptor: chainPath(129)
      })
    }))

  /**
   * The ceiling exists only for a backend that can neither avoid following a
   * directory symlink nor recognize one it has already visited. Either helper
   * on its own lifts it, so a legitimately deep tree is walked whole instead
   * of being rejected for its depth.
   */
  it.effect("lifts the ceiling for a backend with lstat alone and for one with realpath alone", () =>
    Effect.gen(function*() {
      const withLstat = BrowserFileSystem.make(nestedChain(200, { lstat: async () => chainDirectory }))
      const withRealpath = BrowserFileSystem.make(nestedChain(200, { realpath: async (at: string) => at }))

      expect(yield* (withLstat.readDirectory(chainRoot, { recursive: true }))).toEqual(chainEntries(200))
      expect(yield* (withRealpath.readDirectory(chainRoot, { recursive: true }))).toEqual(chainEntries(200))
    }))

  /**
   * `@zenfs/core` exposes its promises API as an object whose members read
   * `this`. Calling an optional member through a captured reference would drop
   * the receiver, so the optional members go through the backend object too.
   */
  it.effect("calls the optional backend members with the backend as their receiver", () =>
    Effect.gen(function*() {
      const directory: BrowserFileSystem.ZenFsStatsLike = {
        size: 0,
        mode: 0o755,
        mtimeMs: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false
      }
      const backend = {
        ...throwingFs(codeError("ENOENT")),
        root: "/canonical",
        readdir: async (): Promise<Array<string>> => ["child"],
        // Both members read `this`, so an unbound call throws rather than
        // quietly answering.
        lstat: function(this: { root: string }): Promise<BrowserFileSystem.ZenFsStatsLike> {
          return Promise.resolve(this.root === "/canonical" ? directory : { ...directory, isDirectory: () => false })
        },
        realpath: function(this: { root: string }): Promise<string> {
          return Promise.resolve(this.root)
        }
      }
      const fileSystem = BrowserFileSystem.make(backend)

      expect(yield* (fileSystem.realPath("/root"))).toBe("/canonical")
      // The one child canonicalizes onto the root, so the walk stops there.
      expect(yield* (fileSystem.readDirectory("/canonical", { recursive: true }))).toEqual(["child"])
    }))

  /**
   * A caller who names no mode leaves the permissions to the backend and the
   * process umask. Sending a mode anyway would decide them here, which a real
   * backend cannot be made to expose under every umask, so the call itself is
   * recorded.
   */
  it.effect("reaches mkdir with no mode at all when the caller names none", () =>
    Effect.gen(function*() {
      const options: Array<Parameters<BrowserFileSystem.ZenFsPromisesLike["mkdir"]>[1]> = []
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        mkdir: async (_path, given) => {
          options.push(given)
        }
      })

      yield* fileSystem.makeDirectory("/plain")
      yield* fileSystem.makeDirectory("/asked", { mode: 0o700, recursive: true })

      expect(options[0]).toEqual({ recursive: false })
      expect(options[0] !== undefined && "mode" in options[0]).toBe(false)
      expect(options[1]).toEqual({ recursive: true, mode: 0o700 })
    }))

  it.effect("dies rather than fails when closing a streamed handle throws", () =>
    Effect.gen(function*() {
      const backend: BrowserFileSystem.ZenFsPromisesLike = {
        ...throwingFs(codeError("ENOENT")),
        open: async () => ({
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            throw codeError("EIO")
          }
        })
      }
      const fileSystem = BrowserFileSystem.make(backend)

      const exit = yield* Effect.exit(Stream.runCollect(fileSystem.stream("/p")))

      expect(exit._tag).toBe("Failure")
      const defect = exit._tag === "Failure" ? Cause.findDefect(exit.cause) : undefined
      expect(defect).toMatchObject({
        _tag: "Success",
        success: { reason: { _tag: "Unknown", method: "stream.close" } }
      })
    }))

  it.effect("reports SymbolicLink and Unknown for stats that are neither file nor directory", () =>
    Effect.gen(function*() {
      const stats = (kind: "link" | "other"): BrowserFileSystem.ZenFsStatsLike => ({
        size: 0,
        mode: 0,
        mtimeMs: 0,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => kind === "link"
      })
      const make = (kind: "link" | "other") =>
        BrowserFileSystem.make({ ...throwingFs(codeError("ENOENT")), stat: async () => stats(kind) })

      expect(yield* (make("link").stat("/l"))).toMatchObject({ type: "SymbolicLink" })
      expect(yield* (make("other").stat("/o"))).toMatchObject({ type: "Unknown" })
    }))

  // Effect's makeNoop defects on makeTemp*, so BrowserFileSystem wires those four explicitly to PermissionDenied.
  it.effect("fails every deliberately unsupported operation with PermissionDenied", () =>
    Effect.gen(function*() {
      const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))
      const operations: ReadonlyArray<
        readonly [string, Effect.Effect<unknown, PlatformError.PlatformError>]
      > = [
        ["chmod", fileSystem.chmod("/p", 0o644)],
        ["chown", fileSystem.chown("/p", 1, 1)],
        ["copy", fileSystem.copy("/from", "/to")],
        ["copyFile", fileSystem.copyFile("/from", "/to")],
        ["glob", fileSystem.glob("**/*.txt")],
        ["link", fileSystem.link("/from", "/to")],
        ["symlink", fileSystem.symlink("/from", "/to")],
        ["readLink", fileSystem.readLink("/p")],
        ["open", Effect.scoped(fileSystem.open("/p"))],
        ["rename", fileSystem.rename("/from", "/to")],
        ["sink", Stream.run(Stream.make(encoder.encode("x")), fileSystem.sink("/p"))],
        ["truncate", fileSystem.truncate("/p", 0)],
        ["utimes", fileSystem.utimes("/p", 0, 0)],
        ["watch", Stream.runDrain(fileSystem.watch("/p"))],
        ["makeTempDirectory", fileSystem.makeTempDirectory()],
        ["makeTempDirectoryScoped", Effect.scoped(fileSystem.makeTempDirectoryScoped())],
        ["makeTempFile", fileSystem.makeTempFile()],
        ["makeTempFileScoped", Effect.scoped(fileSystem.makeTempFileScoped())]
      ]

      const observed = yield* Effect.forEach(operations, ([name, operation]) =>
        Effect.map(Effect.exit(operation), (exit) => {
          if (Exit.isSuccess(exit)) {
            return [name, "Success"] as const
          }
          const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          return [name, failure?.reason._tag ?? "Defect"] as const
        }), { concurrency: "unbounded" })

      expect(observed).toEqual(operations.map(([name]) => [name, "PermissionDenied"]))
    }))
})

/**
 * Bytes and names cross the backend boundary by value. Node's `readFile` and
 * `readdir` answer with fresh containers, so the aliasing these pin can only
 * be shown against a backend that keeps the containers it answers with and
 * the buffers it is handed; each probe here records what it saw.
 */
describe("BrowserFileSystem ownership across the backend boundary", () => {
  const backend = (): BrowserFileSystem.ZenFsPromisesLike => throwingFs(codeError("ENOENT"))

  /**
   * A backend may hold the buffer it was handed across its own commit, so it
   * must be handed one the caller can no longer reach.
   */
  it.effect("hands the backend bytes a later mutation of the caller's buffer cannot reach", () =>
    Effect.gen(function*() {
      const received: Array<Uint8Array> = []
      const fileSystem = BrowserFileSystem.make({
        ...backend(),
        writeFile: async (_path, data) => {
          received.push(data)
        }
      })
      const bytes = new Uint8Array([1, 2, 3])

      yield* fileSystem.writeFile("/p", bytes)
      bytes[0] = 9

      expect(received.map((data) => Array.from(data))).toEqual([[1, 2, 3]])
    }))

  /**
   * A backend that answers `readFile` from its own storage would let a caller
   * corrupt the volume by writing into its result, and would let a later
   * write change a result already returned.
   */
  it.effect("returns bytes the caller owns rather than the backend's storage", () =>
    Effect.gen(function*() {
      const store = new Uint8Array([1, 2, 3])
      const fileSystem = BrowserFileSystem.make({ ...backend(), readFile: async () => store })

      const first = yield* fileSystem.readFile("/p")
      first[0] = 9
      const second = yield* fileSystem.readFile("/p")
      store[1] = 8

      expect(Array.from(store)).toEqual([1, 8, 3])
      expect(Array.from(first)).toEqual([9, 2, 3])
      expect(Array.from(second)).toEqual([1, 2, 3])
    }))

  it.effect("returns a directory listing the caller owns rather than the backend's array", () =>
    Effect.gen(function*() {
      const names = ["a", "b"]
      const fileSystem = BrowserFileSystem.make({ ...backend(), readdir: async () => names })

      const first = yield* fileSystem.readDirectory("/d")
      first.push("c")
      const second = yield* fileSystem.readDirectory("/d")
      names.push("z")

      expect(names).toEqual(["a", "b", "z"])
      expect(second).toEqual(["a", "b"])
    }))
})

/** A manually released backend call, independent of Effect interruption. */
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("BrowserFileSystem settlement across interruption", () => {
  it.each(["writeFile", "writeFileString"] as const)("settles %s before a replacement write", async (method) => {
    const started = gate()
    const pending = gate()
    const events: Array<string> = []
    let stored = new Uint8Array()
    const fileSystem = BrowserFileSystem.make({
      ...throwingFs(codeError("ENOENT")),
      readFile: async () => stored,
      writeFile: async (_path, data) => {
        if (decoder.decode(data) === "old") {
          started.release()
          await pending.promise
        }
        stored = new Uint8Array(data)
        events.push(decoder.decode(data))
      }
    })
    const write = method === "writeFile"
      ? fileSystem.writeFile("/p", encoder.encode("old"))
      : fileSystem.writeFileString("/p", "old")
    const fiber = Effect.runFork(Effect.ensuring(
      write,
      Effect.sync(() => {
        events.push("cleanup")
      })
    ))
    await started.promise
    const replacement = Effect.runPromise(Effect.gen(function*() {
      yield* Fiber.interrupt(fiber)
      events.push("interrupted")
      yield* fileSystem.writeFileString("/p", "new")
    }))
    // Let interruption and any premature replacement finish while the old
    // backend call is still held open, then always drain it before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve))
    pending.release()
    await replacement
    expect(decoder.decode(await Effect.runPromise(fileSystem.readFile("/p")))).toBe("new")
    expect(events).toEqual(["old", "cleanup", "interrupted", "new"])
  })

  it.each(["rename", "remove", "makeDirectory", "utimes"] as const)(
    "settles %s before interruption cleanup",
    async (method) => {
      const started = gate()
      const pending = gate()
      const events: Array<string> = []
      const mutate = async () => {
        started.release()
        await pending.promise
        events.push("settled")
      }
      const fileSystem = BrowserFileSystem.make({
        ...throwingFs(codeError("ENOENT")),
        rename: mutate,
        rm: mutate,
        mkdir: mutate,
        utimes: mutate
      })
      const operation = method === "rename" ?
        fileSystem.rename("/from", "/to")
        : method === "utimes" ?
        fileSystem.utimes("/p", 0, 0)
        : fileSystem[method]("/p")
      const fiber = Effect.runFork(Effect.ensuring(
        operation,
        Effect.sync(() => {
          events.push("cleanup")
        })
      ))
      await started.promise
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
      await new Promise<void>((resolve) => setImmediate(resolve))
      pending.release()
      await interrupted
      expect(events).toEqual(["settled", "cleanup"])
    }
  )

  it.each([false, true])("settles a pending stream read before close (reject: %s)", async (reject) => {
    const started = gate()
    const pending = gate()
    const events: Array<string> = []
    const fileSystem = BrowserFileSystem.make({
      ...throwingFs(codeError("ENOENT")),
      open: async () => ({
        read: async () => {
          started.release()
          await pending.promise
          events.push("settled")
          if (reject) throw codeError("EIO")
          return { bytesRead: 0 }
        },
        close: async () => {
          events.push("close")
        }
      })
    })
    const fiber = Effect.runFork(Stream.runDrain(fileSystem.stream("/p")))
    await started.promise
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise<void>((resolve) => setImmediate(resolve))
    pending.release()
    await interrupted
    expect(events).toEqual(["settled", "close"])
  })
})

describe("BrowserFileSystem operations over node:fs/promises", () => {
  let root: string

  /**
   * `node:fs/promises` is a structural `ZenFsPromisesLike`: the slice was drawn
   * so that it is. Nothing here is cast — if the shapes drift, this line stops
   * compiling, which is the point.
   */
  const backend: BrowserFileSystem.ZenFsPromisesLike = NodeFsPromises
  const fileSystem = BrowserFileSystem.make(backend)
  const path = (...segments: ReadonlyArray<string>): string => join(root, ...segments)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "flows-platform-browser-fs-"))
    await NodeFsPromises.mkdir(join(root, "sub"), { recursive: true })
    await NodeFsPromises.writeFile(join(root, "a.txt"), encoder.encode("alpha"))
    await NodeFsPromises.writeFile(join(root, "sub", "b.txt"), encoder.encode("beta"))
    // A symlink, a read-only file, and a write-only file: the three shapes
    // `realPath` and `access` used to answer wrongly about.
    await NodeFsPromises.symlink(join(root, "a.txt"), join(root, "link.txt"))
    // The target's parent differs from the link's parent so `hop/..` exposes
    // whether `..` was applied before or after following the link.
    await NodeFsPromises.mkdir(join(root, "elsewhere", "target"), { recursive: true })
    await NodeFsPromises.symlink(join(root, "elsewhere", "target"), join(root, "hop"), "dir")
    await NodeFsPromises.writeFile(join(root, "ro.txt"), encoder.encode("ro"))
    await NodeFsPromises.chmod(join(root, "ro.txt"), 0o444)
    await NodeFsPromises.writeFile(join(root, "wo.txt"), encoder.encode("wo"))
    await NodeFsPromises.chmod(join(root, "wo.txt"), 0o222)
    // A tree nothing else in this file mutates, for recursive listing.
    await NodeFsPromises.mkdir(join(root, "tree", "nested"), { recursive: true })
    await NodeFsPromises.writeFile(join(root, "tree", "top.txt"), encoder.encode("top"))
    await NodeFsPromises.writeFile(join(root, "tree", "nested", "deep.txt"), encoder.encode("deep"))
    await NodeFsPromises.symlink(join(root, "tree", "nested"), join(root, "tree", "loop"), "dir")
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.effect("round-trips a written file and reports it as existing", () =>
    Effect.gen(function*() {
      const contents = yield* (
        Effect.gen(function*() {
          yield* fileSystem.writeFile(path("c.txt"), encoder.encode("gamma"))
          const bytes = yield* fileSystem.readFile(path("c.txt"))
          const exists = yield* fileSystem.exists(path("c.txt"))
          const missing = yield* fileSystem.exists(path("nope.txt"))
          return { text: decoder.decode(bytes), exists, missing }
        })
      )

      expect(contents).toEqual({ text: "gamma", exists: true, missing: false })
    }))

  /**
   * `makeNoop` hardcodes both string helpers to `NotFound` instead of deriving
   * them from `readFile`/`writeFile` the way `make` does, so these pin that the
   * adapter wires them up rather than inheriting the stub.
   */
  it.effect("round-trips a string through the derived string helpers", () =>
    Effect.gen(function*() {
      const text = yield* (
        Effect.gen(function*() {
          yield* fileSystem.writeFileString(path("s.txt"), "delta")
          return yield* fileSystem.readFileString(path("s.txt"))
        })
      )

      expect(text).toBe("delta")
    }))

  /**
   * Dropping `flag` would silently turn an append into a truncating write, so
   * it is forwarded to the backend rather than ignored.
   */
  it.effect("forwards `flag` so an append extends the file and `wx` refuses to clobber", () =>
    Effect.gen(function*() {
      const outcome = yield* (
        Effect.gen(function*() {
          yield* fileSystem.writeFileString(path("log.txt"), "one\n")
          yield* fileSystem.writeFileString(path("log.txt"), "two\n", { flag: "a" })
          yield* fileSystem.writeFile(path("log.txt"), encoder.encode("three\n"), { flag: "a", mode: 0o644 })
          const appended = yield* fileSystem.readFileString(path("log.txt"))
          const clobber = yield* Effect.flip(
            fileSystem.writeFile(path("log.txt"), encoder.encode("x"), { flag: "wx" })
          )
          return { appended, clobber }
        })
      )

      expect(outcome.appended).toBe("one\ntwo\nthree\n")
      expect(outcome.clobber.reason).toMatchObject({ _tag: "AlreadyExists", method: "writeFile" })
    }))

  /**
   * The effect `writeFile` returns describes one write. The bytes it describes
   * are fixed when it is called, so a caller that reuses its buffer before the
   * effect runs, or retries it afterwards, gets the write it asked for.
   * `Buffer` is what a Node caller hands over, and its `slice` is a view over
   * the same memory, which is why the copy is not made with `slice`.
   */
  it.effect("writes the bytes `writeFile` was called with, however the buffer changes afterwards", () =>
    Effect.gen(function*() {
      const bytes = Buffer.from([1, 2, 3])
      const write = fileSystem.writeFile(path("snapshot.bin"), bytes)
      bytes[0] = 9
      yield* write
      const first = yield* fileSystem.readFile(path("snapshot.bin"))
      bytes[1] = 8
      yield* write
      const retried = yield* fileSystem.readFile(path("snapshot.bin"))

      expect(Array.from(first)).toEqual([1, 2, 3])
      expect(Array.from(retried)).toEqual([1, 2, 3])
    }))

  /**
   * The options are part of the same description: a `flag` or `mode` changed
   * after the call must not turn an append into a truncating write or widen
   * the mode a file is created with.
   */
  it.effect("reads `flag` and `mode` when `writeFile` is called rather than when it runs", () =>
    Effect.gen(function*() {
      const options: { flag?: "a" | "w" } = { flag: "a" }
      const creation: { mode?: number } = { mode: 0o600 }
      yield* fileSystem.writeFileString(path("late.txt"), "one")
      const appendText = fileSystem.writeFileString(path("late.txt"), "two", options)
      const appendBytes = fileSystem.writeFile(path("late.txt"), encoder.encode("three"), options)
      const create = fileSystem.writeFile(path("late.bin"), encoder.encode("m"), creation)
      options.flag = "w"
      creation.mode = 0o644
      yield* appendText
      yield* appendBytes
      yield* create
      const created = yield* fileSystem.stat(path("late.bin"))

      expect(yield* fileSystem.readFileString(path("late.txt"))).toBe("onetwothree")
      expect(created.mode & 0o777).toBe(0o600)
    }))

  it.effect("stats files and directories with the corresponding type, size, and mtime", () =>
    Effect.gen(function*() {
      const [file, directory] = yield* (
        Effect.all([fileSystem.stat(path("a.txt")), fileSystem.stat(path("sub"))])
      )

      expect(file.type).toBe("File")
      expect(Number(file.size)).toBe(5)
      expect(Option.getOrThrow(file.mtime)).toBeInstanceOf(Date)
      expect(directory.type).toBe("Directory")
    }))

  it.effect("creates directories recursively and lists their entries", () =>
    Effect.gen(function*() {
      const entries = yield* (
        Effect.gen(function*() {
          yield* fileSystem.makeDirectory(path("deep", "nested"), { recursive: true })
          yield* fileSystem.writeFile(path("deep", "nested", "z.txt"), encoder.encode("z"))
          return yield* fileSystem.readDirectory(path("deep", "nested"))
        })
      )

      expect(entries).toEqual(["z.txt"])
    }))

  it.effect("fails a non-recursive makeDirectory whose parent is missing", () =>
    Effect.gen(function*() {
      const error = yield* (
        Effect.flip(fileSystem.makeDirectory(path("absent", "child")))
      )

      expect(error.reason).toMatchObject({ _tag: "NotFound", method: "makeDirectory" })
    }))

  it.effect("resolves realPath and access only for paths that exist", () =>
    Effect.gen(function*() {
      const canonical = yield* Effect.promise(() => NodeFsPromises.realpath(path("a.txt")))

      expect(yield* (fileSystem.realPath(path("a.txt")))).toBe(canonical)
      expect(yield* (fileSystem.access(path("a.txt")))).toBeUndefined()
      expect(yield* (Effect.flip(fileSystem.realPath(path("gone"))))).toMatchObject({
        reason: { _tag: "NotFound", method: "realPath" }
      })
      expect(yield* (Effect.flip(fileSystem.access(path("gone"))))).toMatchObject({
        reason: { _tag: "NotFound", method: "access" }
      })
    }))

  /**
   * `@smthrs/kernel` resolves every guarded path through `realPath` before it
   * checks the grant, so that a symlink cannot name a resource outside the
   * workspace. Returning the input verbatim would make that defense a no-op.
   */
  it.effect("canonicalizes a symlink and a relative path rather than echoing the input", () =>
    Effect.gen(function*() {
      const canonical = yield* Effect.promise(() => NodeFsPromises.realpath(path("a.txt")))

      const observed = {
        link: yield* fileSystem.realPath(path("link.txt")),
        dotted: yield* fileSystem.realPath(`${root}/sub/./../a.txt`),
        // A tab has no working directory, so a relative path resolves against
        // the volume root rather than an ambient cwd that does not exist.
        relative: yield* fileSystem.realPath(".")
      }

      expect(observed).toEqual({ link: canonical, dotted: canonical, relative: "/" })
    }))

  /**
   * Collapsing `hop/..` before following `hop` names the link's parent rather
   * than the target's parent, weakening the kernel's workspace boundary.
   */
  it.effect("resolves a symlink before applying a following parent segment", () =>
    Effect.gen(function*() {
      const composed = `${path("hop")}/..`
      const observed = yield* fileSystem.realPath(composed)
      const expected = yield* Effect.promise(() => NodeFsPromises.realpath(composed))

      expect(observed).toBe(expected)
      expect(observed).not.toBe(root)
    }))

  it.effect("refuses canonicalization when realpath is absent", () =>
    Effect.gen(function*() {
      const adapter = BrowserFileSystem.make({ ...NodeFsPromises, realpath: undefined })
      const error = yield* Effect.flip(adapter.realPath(path("a.txt")))
      expect(error.reason).toMatchObject({ _tag: "PermissionDenied", method: "realPath" })
    }))

  /**
   * Effect documents `recursive` as "recursively list the contents of nested
   * directories", and `NodeFileSystem` honours it, so a flow that lists a tree
   * must not quietly lose every nested entry under `BrowserHost`.
   */
  it.effect("lists nested entries for `recursive`, without descending into a symlinked directory", () =>
    Effect.gen(function*() {
      const flat = yield* fileSystem.readDirectory(path("tree"))
      const deep = yield* fileSystem.readDirectory(path("tree"), { recursive: true })

      expect([...flat].sort()).toEqual(["loop", "nested", "top.txt"])
      expect([...deep].sort()).toEqual(["loop", "nested", "nested/deep.txt", "top.txt"])
      // The canonicalization the walk needs must not rename the failure.
      expect(yield* (Effect.flip(fileSystem.readDirectory(path("gone"), { recursive: true })))).toMatchObject({
        reason: { _tag: "NotFound", method: "readDirectory" }
      })
    }))

  /**
   * A caller using `access` as a permission pre-check gets a false green when
   * the option is dropped: a read-only file answers "yes, writable".
   */
  it.effect("answers `readable` and `writable` from the mode rather than dropping them", () =>
    Effect.gen(function*() {
      const outcome = {
        existence: yield* Effect.exit(fileSystem.access(path("ro.txt"), { ok: true })),
        readableOnReadOnly: yield* Effect.exit(fileSystem.access(path("ro.txt"), { readable: true })),
        writableOnReadOnly: yield* Effect.exit(fileSystem.access(path("ro.txt"), { writable: true })),
        readableOnWriteOnly: yield* Effect.exit(fileSystem.access(path("wo.txt"), { readable: true })),
        writableOnWriteOnly: yield* Effect.exit(fileSystem.access(path("wo.txt"), { writable: true }))
      }

      expect(Exit.isSuccess(outcome.existence)).toBe(true)
      expect(Exit.isSuccess(outcome.readableOnReadOnly)).toBe(true)
      expect(Exit.isSuccess(outcome.writableOnWriteOnly)).toBe(true)
      expect(yield* (Effect.flip(fileSystem.access(path("ro.txt"), { writable: true })))).toMatchObject({
        reason: { _tag: "PermissionDenied", method: "access", pathOrDescriptor: path("ro.txt") }
      })
      expect(Exit.isFailure(outcome.writableOnReadOnly)).toBe(true)
      expect(Exit.isFailure(outcome.readableOnWriteOnly)).toBe(true)
    }))

  /**
   * `writeFile` forwards `mode`; creating a directory 0755 when the caller
   * asked for 0700 is the same silent permission widening. Omitting `mode`
   * has to leave the permissions where the backend and the process umask put
   * them, so the default is compared against a directory the same backend made
   * under the same umask rather than against fixed bits a umask of 077 would
   * clear.
   */
  it.effect("creates a directory with the requested mode and leaves the backend's default alone", () =>
    Effect.gen(function*() {
      yield* fileSystem.makeDirectory(path("moded"), { mode: 0o700 })
      yield* fileSystem.makeDirectory(path("default"))
      yield* Effect.promise(() => NodeFsPromises.mkdir(path("control")))
      const moded = yield* fileSystem.stat(path("moded"))
      const byDefault = yield* fileSystem.stat(path("default"))
      const control = yield* fileSystem.stat(path("control"))

      expect(moded.mode & 0o777).toBe(0o700)
      expect(byDefault.mode & 0o777).toBe(control.mode & 0o777)
    }))

  it.effect("round-trips text outside the basic plane and honours a byte-per-character encoding", () =>
    Effect.gen(function*() {
      const astral = "flag \u{1F1EF}\u{1F1F5} \u{1D11E} café"
      yield* fileSystem.writeFileString(path("unicode.txt"), astral)
      const roundTrip = yield* fileSystem.readFileString(path("unicode.txt"))
      const asLatin1 = yield* fileSystem.readFileString(path("unicode.txt"), "latin1")

      expect(roundTrip).toBe(astral)
      // The encoding argument is honoured: latin1 reads one character per
      // stored byte, so the multi-byte sequences stop collapsing.
      expect(asLatin1).toHaveLength(encoder.encode(astral).length)
      expect(asLatin1).not.toBe(astral)
    }))

  /**
   * The tree removed here is this test's own. Removing a fixture the rest of
   * the file reads would make those tests pass only while they run before this
   * one, so `sub` is checked afterwards and has to still be there.
   */
  it.effect("removes recursively, tolerates a forced removal of a missing path, and fails otherwise", () =>
    Effect.gen(function*() {
      const outcome = yield* (
        Effect.gen(function*() {
          yield* fileSystem.makeDirectory(path("doomed", "inner"), { recursive: true })
          yield* fileSystem.writeFileString(path("doomed", "inner", "leaf.txt"), "leaf")
          yield* fileSystem.remove(path("doomed"), { recursive: true })
          yield* fileSystem.remove(path("never"), { force: true })
          const failure = yield* Effect.flip(fileSystem.remove(path("never")))
          const exists = yield* fileSystem.exists(path("doomed"))
          const shared = yield* fileSystem.exists(path("sub", "b.txt"))
          return { failure, exists, shared }
        })
      )

      expect(outcome.exists).toBe(false)
      expect(outcome.shared).toBe(true)
      expect(outcome.failure).toMatchObject({ reason: { _tag: "NotFound", method: "remove" } })
    }))

  it.effect("streams a whole file when no bounds are given", () =>
    Effect.gen(function*() {
      const chunks = yield* (Stream.runCollect(fileSystem.stream(path("a.txt"))))

      expect(Array.from(chunks).map((chunk) => decoder.decode(chunk)).join("")).toBe("alpha")
    }))

  it.effect("emits nothing when `bytesToRead` is zero and chunks the file at the requested size", () =>
    Effect.gen(function*() {
      const empty = yield* (
        Stream.runCollect(fileSystem.stream(path("a.txt"), { bytesToRead: 0 }))
      )
      const chunked = yield* (
        Stream.runCollect(fileSystem.stream(path("a.txt"), { offset: 0, chunkSize: 2 }))
      )

      expect(Array.from(empty)).toEqual([])
      expect(Array.from(chunked).map((chunk) => decoder.decode(chunk))).toEqual(["al", "ph", "a"])
    }))

  /**
   * Clamping a negative offset to the start, or turning a non-integral or
   * non-finite chunk size into an empty stream, answers a question the caller
   * did not ask. Each of these is refused before the file is opened.
   */
  it.effect.each<[string, Parameters<typeof fileSystem.stream>[1], string]>([
    ["a negative offset", { offset: -10 }, "offset must be"],
    ["a fractional offset", { offset: 1.5 }, "offset must be"],
    ["a negative bytesToRead", { bytesToRead: -1 }, "bytesToRead must be"],
    ["a NaN chunkSize", { chunkSize: Number.NaN }, "chunkSize must be"],
    ["an infinite chunkSize", { chunkSize: Number.POSITIVE_INFINITY }, "chunkSize must be"],
    ["a fractional chunkSize", { chunkSize: 1.5 }, "chunkSize must be"],
    ["a zero chunkSize", { chunkSize: 0 }, "chunkSize must be"],
    ["an unallocatable chunkSize", { chunkSize: 64 * 1024 * 1024 + 1 }, "chunkSize must be"]
  ])("refuses %s rather than answering with something else", ([_name, options, message]) =>
    Effect.gen(function*() {
      const error = yield* (Effect.flip(Stream.runCollect(fileSystem.stream(path("a.txt"), options))))

      expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "FileSystem", method: "stream" })
      expect(error.message).toContain(message)
    }))

  it.effect("truncates the final chunk when fewer bytes remain than the chunk size", () =>
    Effect.gen(function*() {
      const chunks = yield* (
        Stream.runCollect(fileSystem.stream(path("a.txt"), { offset: 3, bytesToRead: 99, chunkSize: 4 }))
      )

      expect(Array.from(chunks).map((chunk) => chunk.length)).toEqual([2])
      expect(decoder.decode(Array.from(chunks)[0])).toBe("ha")
    }))
})
