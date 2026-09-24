/**
 * Lock-file races need a module-boundary fault: every filesystem call reaches
 * the real host except the one collision or read each case injects.
 */
import { spawnSync } from "node:child_process"
import type * as FsPromises from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { fault } = vi.hoisted(() => ({
  fault: {
    /** How many exclusive lock creates report a collision that is not there. */
    collisions: 0,
    /** The code every read of the lock file fails with. */
    readCode: undefined as string | undefined
  }
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    default: original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      if (fault.collisions > 0) {
        fault.collisions -= 1
        throw Object.assign(new Error("lock collision"), { code: "EEXIST" })
      }
      return original.writeFile(...args)
    },
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (fault.readCode !== undefined) throw Object.assign(new Error("lock unreadable"), { code: fault.readCode })
      return original.readFile(...args)
    }
  }
})

const RealFs = await vi.importActual<typeof FsPromises>("node:fs/promises")
const { acquireStateOwnership } = await import("./state-ownership.ts")

const withFixture = async <A>(use: (root: string, lock: string) => Promise<A>): Promise<A> => {
  const root = await RealFs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-state-ownership-"))
  try {
    return await use(root, NodePath.join(root, ".smithers-state-owner.lock"))
  } finally {
    await RealFs.rm(root, { recursive: true, force: true })
  }
}

/** A process id that was live and is now certainly gone. */
const deadPid = (): number => {
  const exited = spawnSync(process.execPath, ["-e", "0"])
  if (exited.pid === 0) throw new Error("could not spawn a process to retire")
  return exited.pid
}

beforeEach(() => {
  fault.collisions = 0
  fault.readCode = undefined
})

describe("acquireStateOwnership", () => {
  it("holds the directory until released and refuses a second owner meanwhile", async () => {
    await withFixture(async (root, lock) => {
      const ownership = await acquireStateOwnership(root)
      expect(ownership.directory).toBe(root)
      expect(await RealFs.readFile(lock, "utf8")).toBe(`${process.pid}\n`)
      await expect(acquireStateOwnership(root)).rejects.toThrow(
        `Alchemy state is owned by another deployment (pid ${process.pid}); remove ${lock} only once that process is gone`
      )
      await ownership.release()
      expect(await RealFs.readdir(root)).toEqual([])
      // Releasing twice is harmless, and the directory can be owned again.
      await ownership.release()
      await (await acquireStateOwnership(root)).release()
    })
  })

  it("reclaims a lock whose owner no longer exists", async () => {
    await withFixture(async (root, lock) => {
      await RealFs.writeFile(lock, `${deadPid()}\n`)
      const ownership = await acquireStateOwnership(root)
      expect(await RealFs.readFile(lock, "utf8")).toBe(`${process.pid}\n`)
      await ownership.release()
    })
  })

  it.each([
    ["it cannot read", "not a pid"],
    ["it cannot read as a live process", "0"],
    ["it cannot read from an empty file", ""]
  ])("refuses a lock holding an owner %s", async (_case, contents) => {
    await withFixture(async (root, lock) => {
      await RealFs.writeFile(lock, contents)
      await expect(acquireStateOwnership(root)).rejects.toThrow(
        `Alchemy state is owned by another deployment; remove ${lock} only once that process is gone`
      )
      expect(await RealFs.readFile(lock, "utf8")).toBe(contents)
    })
  })

  it("treats an owner it may not signal as alive", async () => {
    await withFixture(async (root, lock) => {
      await RealFs.writeFile(lock, `${process.pid}\n`)
      // PID 1 is not a live protected process on every host (notably Windows).
      // Refuse only the liveness probe; the ownership file remains real.
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("process probe denied"), { code: "EPERM" })
      })
      try {
        await expect(acquireStateOwnership(root)).rejects.toThrow(`owned by another deployment (pid ${process.pid})`)
        expect(kill).toHaveBeenCalledWith(process.pid, 0)
        expect(await RealFs.readFile(lock, "utf8")).toBe(`${process.pid}\n`)
      } finally {
        kill.mockRestore()
      }
    })
  })

  it("reports a directory it cannot create the lock in", async () => {
    await withFixture(async (root) => {
      await expect(acquireStateOwnership(NodePath.join(root, "absent"))).rejects.toThrow(/ENOENT/)
    })
  })

  it("retries when the colliding owner released before the lock could be read", async () => {
    await withFixture(async (root, lock) => {
      fault.collisions = 1
      const ownership = await acquireStateOwnership(root)
      expect(fault.collisions).toBe(0)
      expect(await RealFs.readFile(lock, "utf8")).toBe(`${process.pid}\n`)
      await ownership.release()
    })
  })

  it("reports a lock it can neither take nor read", async () => {
    await withFixture(async (root, lock) => {
      await RealFs.writeFile(lock, `${deadPid()}\n`)
      fault.readCode = "EACCES"
      await expect(acquireStateOwnership(root)).rejects.toThrow(/lock unreadable/)
    })
  })

  it("gives up when the lock keeps being retaken while a stale one is reclaimed", async () => {
    await withFixture(async (root, lock) => {
      await RealFs.writeFile(lock, `${deadPid()}\n`)
      fault.collisions = 2
      await expect(acquireStateOwnership(root)).rejects.toThrow(
        `Alchemy state ownership was taken by another deployment while a stale lock was reclaimed: ${lock}`
      )
      expect(await RealFs.readdir(root)).toEqual([])
    })
  })
})
