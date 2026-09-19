/**
 * The publish half of `materializeManifest` in isolation.
 *
 * The swap is two renames with nothing between them. A failure of the second
 * used to remove the temp tree, leave the declared output absent, and strand
 * the previous tree beside it as `.smthrs-old-<destination>-<stamp>`, worse than
 * either the old state or the new one. Injecting the failure needs the module boundary,
 * so this file mocks `node:fs/promises` and therefore stands apart from the
 * rest of the artifact-store suite.
 */
import { createHash } from "node:crypto"
import * as RealFs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** One-shot filesystem failures and parent-sync observations for the publish boundary. */
const failure: {
  renameTo: string | undefined
  remove: string | undefined
  removeCode: string | undefined
  rmdirCode: string | undefined
  syncCode: string | undefined
  syncedDirectories: Array<string>
  code: string
} = {
  renameTo: undefined,
  remove: undefined,
  removeCode: undefined,
  rmdirCode: undefined,
  syncCode: undefined,
  syncedDirectories: [],
  code: "ENOSPC"
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    default: original,
    rename: async (from: string, to: string): Promise<void> => {
      if (failure.renameTo !== undefined && String(to).includes(failure.renameTo)) {
        // One shot: the rollback rename that follows must be allowed to run.
        const code = failure.code
        failure.renameTo = undefined
        throw Object.assign(new Error(`${code}: injected`), { code })
      }
      return original.rename(from, to)
    },
    rm: async (...args: Parameters<typeof original.rm>): Promise<void> => {
      if (failure.remove !== undefined && String(args[0]).includes(failure.remove)) {
        const code = failure.removeCode ?? failure.code
        failure.remove = undefined
        failure.removeCode = undefined
        throw Object.assign(new Error(`${code}: injected`), { code })
      }
      return original.rm(...args)
    },
    rmdir: async (...args: Parameters<typeof original.rmdir>): Promise<void> => {
      if (failure.rmdirCode !== undefined && String(args[0]).includes(".smthrs-lock-")) {
        const code = failure.rmdirCode
        failure.rmdirCode = undefined
        throw Object.assign(new Error(`${code}: injected`), { code })
      }
      return original.rmdir(...args)
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      const directory = String(args[0])
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async (): Promise<void> => {
              failure.syncedDirectories.push(directory)
              if (failure.syncCode !== undefined) {
                const code = failure.syncCode
                failure.syncCode = undefined
                throw Object.assign(new Error(`${code}: injected`), { code })
              }
              await target.sync()
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    }
  }
})

const PackageTree = await import("../src/PackageTree.ts")

let root: string

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")

beforeEach(async () => {
  root = await RealFs.realpath(await RealFs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-mat-")))
  failure.renameTo = undefined
  failure.remove = undefined
  failure.removeCode = undefined
  failure.rmdirCode = undefined
  failure.syncCode = undefined
  failure.syncedDirectories = []
  failure.code = "ENOSPC"
})

afterEach(async () => {
  failure.renameTo = undefined
  failure.remove = undefined
  failure.removeCode = undefined
  failure.rmdirCode = undefined
  failure.syncCode = undefined
  failure.syncedDirectories = []
  failure.code = "ENOSPC"
  await RealFs.rm(root, { recursive: true, force: true }).catch(() => {})
})

const seedBlob = async (): Promise<string> => {
  const cas = NodePath.join(root, ".flows", "cas")
  await RealFs.mkdir(cas, { recursive: true })
  const digest = sha256("next")
  await RealFs.writeFile(NodePath.join(cas, digest), "next")
  return digest
}

const seed = async (): Promise<string> => {
  const digest = await seedBlob()
  await RealFs.mkdir(NodePath.join(root, "dist"), { recursive: true })
  await RealFs.writeFile(NodePath.join(root, "dist", "previous.txt"), "previous")
  return digest
}

describe("materializeManifest publishes or restores, never neither", () => {
  it("recovers one crash-stranded old tree before a successful publish", async () => {
    const digest = await seedBlob()
    const stranded = NodePath.join(root, `.smthrs-old-${sha256(NodePath.join(root, "dist"))}-crashed`)
    await RealFs.mkdir(stranded)
    await RealFs.writeFile(NodePath.join(stranded, "previous.txt"), "previous")

    await PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })

    expect(await RealFs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("next")
    expect((await RealFs.readdir(root)).filter((name) => name.startsWith(".smthrs-old-"))).toEqual([])
  })

  it("restores the previous tree when the publish rename fails", async () => {
    const digest = await seed()
    failure.renameTo = `${NodePath.sep}dist`
    await expect(PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })).rejects.toThrow(/ENOSPC/)

    expect(await RealFs.readFile(NodePath.join(root, "dist", "previous.txt"), "utf8")).toBe("previous")
    expect((await RealFs.readdir(root)).filter((name) => name.startsWith(".smthrs-old-"))).toEqual([])
    expect((await RealFs.readdir(root)).filter((name) => name.startsWith(".smthrs-mat-"))).toEqual([])
  })

  it("keeps the published tree when removing the set-aside tree fails", async () => {
    const digest = await seed()
    failure.remove = ".smthrs-old-"
    failure.code = "EIO"
    await expect(PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })).rejects.toThrow(/EIO/)

    expect(await RealFs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("next")
    expect(await RealFs.lstat(NodePath.join(root, "dist", "previous.txt")).then(() => true, () => false)).toBe(false)
  })

  it("preserves the publication error and previous tree when both cleanup steps fail", async () => {
    const digest = await seed()
    failure.renameTo = `${NodePath.sep}dist`
    failure.remove = ".smthrs-mat-"
    failure.removeCode = "EIO"
    failure.rmdirCode = "EBUSY"

    await expect(PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })).rejects.toThrow("ENOSPC: injected")

    expect(await RealFs.readFile(NodePath.join(root, "dist", "previous.txt"), "utf8")).toBe("previous")
    const remaining = await RealFs.readdir(root)
    expect(remaining.filter((name) => name.startsWith(".smthrs-old-"))).toEqual([])
    expect(remaining.filter((name) => name.startsWith(".smthrs-mat-"))).toHaveLength(1)
    expect(remaining.filter((name) => name.startsWith(".smthrs-lock-"))).toHaveLength(1)
  })

  it("fsyncs the parent directory after publishing", async () => {
    const digest = await seed()
    await PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })
    expect(failure.syncedDirectories).toContain(root)
  })

  it("accepts an unsupported directory fsync errno after publishing", async () => {
    const digest = await seed()
    failure.syncCode = "EINVAL"
    await expect(PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })).resolves.toBeUndefined()
    expect(await RealFs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("next")
  })

  /**
   * The first rename moves the previous tree aside. Treating every error as
   * "it was not there" set `hadOld` false on a permission or I/O failure, and
   * the publish rename then failed against a directory that was still present,
   * with the real reason long since swallowed.
   */
  it("propagates a non-ENOENT failure of the set-aside rename", async () => {
    const digest = await seed()
    failure.renameTo = ".smthrs-old-"
    failure.code = "EACCES"
    try {
      await expect(PackageTree.materializeManifest(root, ".flows", {
        outDir: "dist",
        entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
      })).rejects.toThrow(/EACCES/)
    } finally {
      failure.code = "ENOSPC"
    }
    expect(await RealFs.readFile(NodePath.join(root, "dist", "previous.txt"), "utf8")).toBe("previous")
  })
})
