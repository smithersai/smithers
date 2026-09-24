/**
 * Descriptor identity failures and host faults need a module-boundary fault,
 * so this suite stands apart from the ordinary redaction cases and delegates
 * every filesystem operation to the real host except the one answer each
 * case selects.
 */
import type { Dir } from "node:fs"
import type * as FsPromises from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

/** One selected host answer to corrupt; everything else reaches the real filesystem. */
const { fault, initialFault } = vi.hoisted(() => {
  const initialFault = () => ({
    /** Corrupts the `failOn`th bigint `lstat` of `target`: a different inode, or not a file. */
    lstat: { target: undefined as string | undefined, failOn: 0, calls: 0, kind: "ino" as "ino" | "kind" },
    /** Answers the `failOn`th `realpath` of `target` with `result`, or rejects it with `rejection`. */
    realpath: {
      target: undefined as string | undefined,
      failOn: 0,
      calls: 0,
      result: undefined as string | undefined,
      rejection: undefined as unknown
    },
    /** Which operation on the read handle for `target` misbehaves. */
    read: { target: undefined as string | undefined, kind: undefined as "length" | "changed" | "close" | undefined },
    /** How many exclusive creates collide, the code an exclusive create is refused with, and which operation on the temporary handle fails. */
    write: { collisions: 0, refused: undefined as string | undefined, kind: undefined as "write" | "close" | undefined },
    /** Runs `during` once, after the last identity check, while `target` is being renamed over. */
    rename: { target: undefined as string | undefined, during: undefined as (() => Promise<void>) | undefined },
    /** Refuses to remove `target`. */
    remove: { target: undefined as string | undefined },
    /** How the directory handle for `target` misbehaves during the sync. */
    directorySync: {
      target: undefined as string | undefined,
      code: undefined as string | undefined,
      withoutCode: false,
      closeFails: false
    },
    /** Synthetic entries `opendir` yields for `target` instead of reading it. */
    entries: { target: undefined as string | undefined, count: 0 }
  })
  return { fault: initialFault(), initialFault }
})

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  const overridden = <T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T =>
    new Proxy(target, {
      get(inner, property) {
        if (property in overrides) return overrides[property]
        const value: unknown = Reflect.get(inner, property, inner)
        return typeof value === "function" ? value.bind(inner) : value
      }
    })
  const failing = (message: string, code?: string) => async () => {
    throw code === undefined ? new Error(message) : Object.assign(new Error(message), { code })
  }
  return {
    ...original,
    default: original,
    lstat: async (
      path: Parameters<typeof original.lstat>[0],
      options?: { readonly bigint?: boolean }
    ) => {
      const stat = options?.bigint === true
        ? await original.lstat(path, { bigint: true })
        : await original.lstat(path)
      if (fault.lstat.target === undefined || String(path) !== fault.lstat.target || options?.bigint !== true) {
        return stat
      }
      fault.lstat.calls += 1
      if (fault.lstat.calls !== fault.lstat.failOn || typeof stat.ino !== "bigint") return stat
      return fault.lstat.kind === "ino"
        ? overridden(stat, { ino: stat.ino + 1n })
        : overridden(stat, { isFile: () => false })
    },
    realpath: async (path: Parameters<typeof original.realpath>[0]) => {
      if (fault.realpath.target !== undefined && String(path) === fault.realpath.target) {
        fault.realpath.calls += 1
        if (fault.realpath.calls === fault.realpath.failOn) {
          if (fault.realpath.rejection !== undefined) throw fault.realpath.rejection
          if (fault.realpath.result !== undefined) return fault.realpath.result
        }
      }
      return original.realpath(path)
    },
    opendir: async (
      path: Parameters<typeof original.opendir>[0],
      options?: Parameters<typeof original.opendir>[1]
    ) => {
      if (fault.entries.target === undefined || String(path) !== fault.entries.target) {
        return original.opendir(path, options)
      }
      const count = fault.entries.count
      const entries = async function*() {
        for (let index = 0; index < count; index += 1) {
          yield { name: `entry-${index}`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }
        }
      }
      return entries() as unknown as Dir
    },
    open: async (
      path: Parameters<typeof original.open>[0],
      flags: Parameters<typeof original.open>[1],
      mode?: Parameters<typeof original.open>[2]
    ) => {
      if (flags === "wx" && fault.write.collisions > 0) {
        fault.write.collisions -= 1
        throw Object.assign(new Error("temporary collision"), { code: "EEXIST" })
      }
      if (flags === "wx" && fault.write.refused !== undefined) {
        throw Object.assign(new Error(`${fault.write.refused}: temporary file refused`), { code: fault.write.refused })
      }
      const handle = await original.open(path, flags, mode)
      if (flags === "wx" && fault.write.kind !== undefined) {
        return fault.write.kind === "write"
          ? overridden(handle, { writeFile: failing("temporary write failed") })
          : overridden(handle, { close: failing("temporary close failed") })
      }
      if (flags === "r" && String(path) === fault.directorySync.target) {
        const overrides: Record<PropertyKey, unknown> = {}
        if (fault.directorySync.code !== undefined) {
          overrides["sync"] = failing("directory sync unavailable", fault.directorySync.code)
        }
        if (fault.directorySync.withoutCode) overrides["sync"] = failing("directory sync failed")
        if (fault.directorySync.closeFails) overrides["close"] = failing("directory close failed")
        return overridden(handle, overrides)
      }
      if (String(path) === fault.read.target && fault.read.kind !== undefined) {
        if (fault.read.kind === "length") {
          return overridden(handle, { read: async () => ({ bytesRead: -1, buffer: Buffer.alloc(0) }) })
        }
        if (fault.read.kind === "close") return overridden(handle, { close: failing("read close failed") })
        let stats = 0
        return overridden(handle, {
          stat: async () => {
            const stat = await handle.stat({ bigint: true })
            stats += 1
            // The second stat is the one taken after the bytes were read.
            return stats === 2 ? overridden(stat, { ino: stat.ino + 1n }) : stat
          }
        })
      }
      return handle
    },
    rename: async (from: Parameters<typeof original.rename>[0], to: Parameters<typeof original.rename>[1]) => {
      const during = fault.rename.during
      if (during !== undefined && String(to) === fault.rename.target) {
        fault.rename.during = undefined
        await during()
      }
      return original.rename(from, to)
    },
    rm: async (path: Parameters<typeof original.rm>[0], options?: Parameters<typeof original.rm>[1]) => {
      if (String(path) === fault.remove.target) {
        throw Object.assign(new Error("removal refused"), { code: "EACCES" })
      }
      return original.rm(path, options)
    }
  }
})

const RealFs = await vi.importActual<typeof FsPromises>("node:fs/promises")
const { redactAlchemyState } = await import("./redact-state.ts")

const rawState = JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw" } } } })
const sentinel = "__SMITHERS_CACHE_TOKEN_REDACTED__"

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await RealFs.realpath(await RealFs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-identity-")))
  try {
    return await use(root)
  } finally {
    await RealFs.rm(root, { recursive: true, force: true })
  }
}

const temporaryFilesIn = async (root: string): Promise<ReadonlyArray<string>> =>
  (await RealFs.readdir(root)).filter((name) => name.endsWith(".tmp"))

beforeEach(() => {
  Object.assign(fault, initialFault())
})

describe("Alchemy state file identity", () => {
  it("refuses an identity change between discovery and the opened descriptor", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, "{}")
      fault.lstat.target = file
      fault.lstat.failOn = 1

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /changed before it could be read safely/
      )
      expect(fault.lstat.calls).toBe(1)
    })
  })

  it("refuses a path that stopped being a regular file before it was read", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, "{}")
      fault.lstat.target = file
      fault.lstat.failOn = 1
      fault.lstat.kind = "kind"

      // Discovery saw a file; what the read found is not one, so it is
      // refused rather than opened.
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /not a singly linked regular file/
      )
    })
  })

  it.each(
    [
      ["an invalid read length", "length", /invalid read length/],
      ["a file that changed while it was being read", "changed", /changed while it was being read/],
      ["a close that fails after the read", "close", /read close failed/]
    ] as const
  )("refuses %s", async (_case, kind, expected) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.read.target = file
      fault.read.kind = kind

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(expected)
      expect(await RealFs.readFile(file, "utf8")).toBe(rawState)
    })
  })

  it("removes its temporary file when identity changes before publication", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const original = rawState
      await RealFs.writeFile(file, original)
      fault.lstat.target = file
      // The first call records the read identity, the second precedes the
      // temporary write, and the third is the publish-time comparison.
      fault.lstat.failOn = 3

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /changed before redaction could be published/
      )
      expect(fault.lstat.calls).toBe(3)
      expect(await RealFs.readFile(file, "utf8")).toBe(original)
      expect(await temporaryFilesIn(root)).toEqual([])
    })
  })

  it("writes no temporary file when identity changes before the write begins", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.lstat.target = file
      fault.lstat.failOn = 2

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /changed before redaction could be published/
      )
      expect(fault.lstat.calls).toBe(2)
      expect(await RealFs.readFile(file, "utf8")).toBe(rawState)
      expect(await temporaryFilesIn(root)).toEqual([])
    })
  })

  it.each(
    [
      ["the temporary write fails", "write", /temporary write failed/],
      ["the temporary file will not close", "close", /temporary close failed/]
    ] as const
  )("removes its temporary file and keeps the state when %s", async (_case, kind, expected) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.write.kind = kind

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(expected)
      expect(await RealFs.readFile(file, "utf8")).toBe(rawState)
      expect(await temporaryFilesIn(root)).toEqual([])
    })
  })

  it("refuses a competing redaction that arrives after the last identity check", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      let competitor: Promise<number> | undefined
      fault.rename.target = file
      // Ownership is what fences this window: the identity checks are all
      // behind us, and only the rename of the redacted snapshot remains.
      fault.rename.during = async () => {
        competitor = redactAlchemyState({ directory: root, bearerToken: "token" })
        await competitor.catch(() => undefined)
      }

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).resolves.toBe(1)
      await expect(competitor).rejects.toThrow(/owned by another deployment \(pid \d+\)/)
      expect(JSON.parse(await RealFs.readFile(file, "utf8")).props.env.CACHE_TOKEN.__redacted__).toBe(sentinel)
      expect(await temporaryFilesIn(root)).toEqual([])
      expect((await RealFs.readdir(root)).filter((name) => !name.startsWith(".smithers-state-owner.sqlite"))).toEqual(["CacheWorker.json"])
    })
  })

  it("reports a temporary file the host refuses to create and releases the state", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.write.refused = "EACCES"

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(/EACCES/)
      expect(await RealFs.readFile(file, "utf8")).toBe(rawState)
      expect((await RealFs.readdir(root)).filter((name) => !name.startsWith(".smithers-state-owner.sqlite"))).toEqual(["CacheWorker.json"])
    })
  })

  it("keeps the redaction failure when releasing the state also fails", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const lock = NodePath.join(root, ".smithers-state-owner.lock")
      await RealFs.writeFile(file, rawState)
      fault.write.kind = "write"
      fault.remove.target = lock

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /temporary write failed/
      )
      expect(await RealFs.readFile(file, "utf8")).toBe(rawState)
      // The lock a dead process leaves behind is reclaimed by the next owner.
      expect(await RealFs.readFile(lock, "utf8")).toBe(`${process.pid}\n`)
    })
  })

  it("retries exclusive temporary-name collisions", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.write.collisions = 2

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).resolves.toBe(1)
      expect(JSON.parse(await RealFs.readFile(file, "utf8")).props.env.CACHE_TOKEN.__redacted__).toBe(sentinel)
      expect(fault.write.collisions).toBe(0)
      expect(await temporaryFilesIn(root)).toEqual([])
    })
  })

  it("refuses exhausted temporary-name collisions without replacing state", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const original = rawState
      await RealFs.writeFile(file, original)
      fault.write.collisions = 4

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /could not create a unique temporary state file/
      )
      expect(await RealFs.readFile(file, "utf8")).toBe(original)
      expect((await RealFs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  })

  it.skipIf(process.platform === "win32")("tolerates filesystems without directory sync", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.directorySync.target = root
      fault.directorySync.code = "ENOTSUP"

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).resolves.toBe(1)
      expect(JSON.parse(await RealFs.readFile(file, "utf8")).props.env.CACHE_TOKEN.__redacted__).toBe(sentinel)
    })
  })

  it.skipIf(process.platform === "win32").each(
    [
      ["a directory sync that fails outright", { code: "EIO" }, /directory sync unavailable/],
      ["a directory sync failure that carries no code", { withoutCode: true }, /directory sync failed/],
      ["a directory handle that will not close", { closeFails: true }, /directory close failed/]
    ] as const
  )("reports %s after the redacted file is in place", async (_case, how, expected) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, rawState)
      fault.directorySync.target = root
      Object.assign(fault.directorySync, how)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(expected)
      // The rename already happened: the scrubbed file stays, and only its
      // durability is in doubt, which is what the failure reports.
      expect(JSON.parse(await RealFs.readFile(file, "utf8")).props.env.CACHE_TOKEN.__redacted__).toBe(sentinel)
      expect(await temporaryFilesIn(root)).toEqual([])
    })
  })

  it("refuses a directory that moved between discovery and publication", async () => {
    await withFixture(async (root) => {
      const nested = NodePath.join(root, "nested")
      const file = NodePath.join(nested, "CacheWorker.json")
      await RealFs.mkdir(nested)
      await RealFs.writeFile(file, rawState)
      fault.realpath.target = nested
      // Discovery resolves the directory twice: as an entry of the root and
      // as the directory it walks. The third resolution is the publish-time
      // check, which no longer sees the canonical path.
      fault.realpath.failOn = 3
      fault.realpath.result = `${nested}-moved`

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /escaped its canonical root/
      )
      expect(await RealFs.readFile(file, "utf8")).toBe(rawState)
      expect(await temporaryFilesIn(nested)).toEqual([])
    })
  })

  it.each([
    ["a subdirectory", "nested", /state directory escapes its root/],
    ["Worker state", "CacheWorker.json", /Worker state escapes its root/]
  ])("refuses %s whose real path leaves the root", async (_case, name, expected) => {
    await withFixture(async (root) => {
      const candidate = NodePath.join(root, name)
      if (name === "nested") await RealFs.mkdir(candidate)
      else await RealFs.writeFile(candidate, rawState)
      fault.realpath.target = candidate
      fault.realpath.failOn = 1
      fault.realpath.result = NodePath.join(NodePath.dirname(root), name)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(expected)
    })
  })

  /**
   * Only `ENOENT` means an absent deployment. A failure without a readable
   * code, or one that is not even an object, is not a reason to report
   * success over state that was never inspected.
   */
  it("refuses Windows ENOENT beneath an existing file", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "state.json")
      await RealFs.writeFile(file, "{}")
      const directory = NodePath.join(file, "child")
      fault.realpath.target = directory
      fault.realpath.failOn = 1
      fault.realpath.rejection = Object.assign(new Error("missing path"), { code: "ENOENT" })
      await expect(redactAlchemyState({ directory })).rejects.toThrow("Alchemy state root is not a directory")
      expect(await RealFs.readFile(file, "utf8")).toBe("{}")
    })
  })

  it("accepts multiple missing state directories beneath a real directory", async () => {
    await withFixture(async (root) => {
      expect(await redactAlchemyState({ directory: NodePath.join(root, "missing", "state") })).toBe(0)
    })
  })

  it("does not treat an unavailable filesystem root as an empty deployment", async () => {
    const directory = NodePath.parse(Os.tmpdir()).root
    const rejection = Object.assign(new Error("missing filesystem"), { code: "ENOENT" })
    fault.realpath.target = directory
    fault.realpath.failOn = 1
    fault.realpath.rejection = rejection
    await expect(redactAlchemyState({ directory })).rejects.toBe(rejection)
  })

  it.each([
    ["a failure that is not an object", "not an error"],
    [
      "a failure that traps inspection",
      new Proxy(new Error("host failure"), {
        getOwnPropertyDescriptor: () => {
          throw new Error("descriptor trap")
        }
      })
    ]
  ])("rethrows %s from discovery unchanged", async (_case, rejection) => {
    await withFixture(async (root) => {
      fault.realpath.target = root
      fault.realpath.failOn = 1
      fault.realpath.rejection = rejection

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toBe(rejection)
    })
  })

  it("bounds the directory entries it walks", async () => {
    await withFixture(async (root) => {
      fault.entries.target = root
      fault.entries.count = 100_001

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /exceeds 100000 directory entries/
      )
    })
  })
})
