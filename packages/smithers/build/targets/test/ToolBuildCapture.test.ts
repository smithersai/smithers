/**
 * Output capture under concurrent mutation, hostile file types, and metadata
 * pressure.
 *
 * Every race here is driven through the injected {@link CaptureIo} seam rather
 * than by sleeping and hoping: the swap happens at a named call, so the test
 * asserts the same thing on a fast host and a loaded one. The cases that need
 * a real kernel behaviour — a FIFO that would block an unguarded `open`, a
 * symbolic link that an unguarded `open` would follow, a character device that
 * only `fstat` can identify — use real files and swap only what capture is
 * told to look at, so the guard being tested is the real one.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import type * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Target from "../src/Target.ts"
import type { CaptureFile, CaptureIo, CaptureLimits } from "../src/ToolBuild.ts"
import { defaultCaptureIo, defaultCaptureLimits, measureOutput, measureOutputs, OutputError } from "../src/ToolBuild.ts"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})

let root: string
let outside: string

/** FIFOs, character devices and the executable bit are POSIX kernel objects. */
const posixOnly = process.platform !== "win32"

const at = (...parts: ReadonlyArray<string>): string => NodePath.join(root, ...parts)

const write = async (relative: string, text: string | Uint8Array): Promise<void> => {
  const path = at(relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text)
}

const mkfifo = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("mkfifo", [path], (error) => error === null ? resolve() : reject(error))
  })

/** A seam that delegates everything it is not asked to intercept. */
const seam = (overrides: Partial<CaptureIo>): CaptureIo => ({ ...defaultCaptureIo, ...overrides })

const limits = (overrides: Partial<CaptureLimits>): CaptureLimits => ({ ...defaultCaptureLimits, ...overrides })

// Capture canonicalizes the workspace root before it resolves anything under
// it, and the system temporary directory is a symbolic link on macOS. The
// seams below match on absolute paths, so the roots have to be canonical too.
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-capture-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-capture-outside-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("directory capture failures", () => {
  it.each(["read", "close", "both"] as const)(
    "closes its directory and preserves the first %s failure",
    async (failure) => {
      const readError = new Error("directory read failed")
      const closeError = new Error("directory close failed")
      const read = vi.fn(async () => {
        if (failure !== "close") throw readError
        return null
      })
      const close = vi.fn(async () => {
        if (failure !== "read") throw closeError
      })
      vi.mocked(Fs.opendir).mockResolvedValueOnce({ read, close } as unknown as NodeFs.Dir)
      await expect(defaultCaptureIo.readdir(at("out"))).rejects.toBe(failure === "close" ? closeError : readError)
      expect(read).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(1)
    }
  )

  it("refuses a directory that disappears before recursive capture", async () => {
    await write("out/nested/file.txt", "content")
    let observations = 0
    const io = seam({
      lstat: async (path) => {
        if (path === at("out/nested") && ++observations === 2) throw new Error("directory vanished")
        return defaultCaptureIo.lstat(path)
      }
    })
    await expect(measureOutput(root, ".", "out", { io })).rejects.toMatchObject({
      message: expect.stringContaining("declared output directory could not be read")
    })
    expect(observations).toBe(2)
  })
})

describe("streaming file contents", () => {
  /**
   * The regression: capture hashed each file with one `Fs.readFile`, so the
   * whole artifact had to fit in one allocation. Contents now stream through a
   * fixed buffer, and an artifact many buffers long still digests to the same
   * value a one-shot hash of the same bytes produces.
   */
  it("digests a file many read buffers long", async () => {
    const block = Buffer.alloc(1024 * 1024)
    for (let index = 0; index < block.length; index += 1) block[index] = index % 251
    const contents = Buffer.concat([block, block, block, block, block, block.subarray(0, 12345)])
    expect(contents.byteLength).toBeGreaterThan(20 * 256 * 1024)
    await write("out/big.bin", contents)

    const measured = await measureOutput(root, ".", "out/big.bin")

    const expected = createHash("sha256")
      .update(JSON.stringify([["file", "big.bin", false, createHash("sha256").update(contents).digest("hex")]]))
      .digest("hex")
    expect(measured).toEqual({ path: "out/big.bin", fileCount: 1, contentDigest: expected })
  })

  it("digests an empty file", async () => {
    await write("out/empty.bin", new Uint8Array())
    expect(await measureOutput(root, ".", "out/empty.bin")).toMatchObject({ fileCount: 1 })
  })

  it("captures through ordinary number-valued filesystem metadata", async () => {
    await write("out/file.bin", "number stats\n")
    const io = seam({
      lstat: (path) => Fs.lstat(path),
      openFile: async (path) => {
        const handle = await Fs.open(path, "r")
        return {
          stat: () => handle.stat(),
          read: async (into) => (await handle.read(into, 0, into.byteLength, null)).bytesRead,
          close: () => handle.close()
        }
      }
    })

    expect(await measureOutput(root, ".", "out", { io })).toEqual(await measureOutput(root, ".", "out"))
  })

  it("sorts a reversed directory listing by code unit before digesting it", async () => {
    await write("out/a.txt", "a")
    await write("out/b.txt", "b")
    const io = seam({
      readdir: async (path, remaining) => [...await defaultCaptureIo.readdir(path, remaining)].reverse()
    })

    expect(await measureOutput(root, ".", "out", { io })).toEqual(await measureOutput(root, ".", "out"))
  })

  it.each([Number.NaN, -1, 1.5, 256 * 1024 + 1])(
    "refuses the invalid descriptor read length %s",
    async (bytesRead) => {
      await write("out/file.bin", "content")
      const io = seam({
        openFile: async (path) => {
          const handle = await defaultCaptureIo.openFile(path)
          return { ...handle, read: async () => bytesRead }
        }
      })

      await expect(measureOutput(root, ".", "out/file.bin", { io }))
        .rejects.toMatchObject({ message: expect.stringContaining("invalid read length") })
    }
  )

  it.runIf(posixOnly)("changes the digest when a produced file becomes executable", async () => {
    await write("out/tool", "#!/bin/sh\n")
    await Fs.chmod(at("out/tool"), 0o644)
    const inert = await measureOutput(root, ".", "out/tool")
    await Fs.chmod(at("out/tool"), 0o755)
    const executable = await measureOutput(root, ".", "out/tool")

    expect(executable.contentDigest).not.toBe(inert.contentDigest)
  })

  it("refuses a hard-linked output file", async () => {
    await write("original", "content")
    await Fs.link(at("original"), at("out"))
    await expect(measureOutput(root, ".", "out"))
      .rejects.toMatchObject({ message: expect.stringContaining("hard-linked file") })
  })

  it("refuses unusable metadata reported by the opened descriptor", async () => {
    await write("out/file.bin", "content")
    const io = seam({
      openFile: async (path) => {
        const handle = await defaultCaptureIo.openFile(path)
        return {
          ...handle,
          stat: async () => {
            const stats = await handle.stat()
            return { ...stats, size: -1, isFile: () => true } as unknown as NodeFs.Stats
          }
        }
      }
    })

    await expect(measureOutput(root, ".", "out/file.bin", { io }))
      .rejects.toMatchObject({ message: expect.stringContaining("reports unusable metadata") })
  })

  it("refuses a file that disappears after its bytes were read", async () => {
    await write("out/file.bin", "content")
    let observations = 0
    const io = seam({
      lstat: (path) => {
        if (path === at("out", "file.bin")) {
          observations += 1
          if (observations === 3) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
        }
        return defaultCaptureIo.lstat(path)
      }
    })

    await expect(measureOutput(root, ".", "out", { io }))
      .rejects.toMatchObject({ message: expect.stringContaining("changed while it was being read") })
  })

  it("reports the earliest traversal failure when concurrent file opens fail", async () => {
    await write("out/a.txt", "a")
    await write("out/b.txt", "b")
    const io = seam({
      openFile: async (path) => {
        if (path.endsWith("b.txt")) await new Promise((resolve) => setTimeout(resolve, 10))
        throw new Error(path.endsWith("a.txt") ? "first open failure" : "later open failure")
      }
    })

    await expect(measureOutput(root, ".", "out", { io })).rejects.toMatchObject({
      message: expect.stringMatching(/a\.txt: first open failure/)
    })
  })

  it("closes the descriptor when cancellation arrives during a read", async () => {
    await write("out/file.bin", "content")
    const controller = new AbortController()
    let closed = false
    const io = seam({
      openFile: async (path) => {
        const handle = await defaultCaptureIo.openFile(path)
        return {
          ...handle,
          read: async (into) => {
            const count = await handle.read(into)
            controller.abort()
            return count
          },
          close: async () => {
            closed = true
            await handle.close()
          }
        }
      }
    })

    await expect(measureOutput(root, ".", "out/file.bin", { io, signal: controller.signal }))
      .rejects.toMatchObject({ message: expect.stringContaining("cancelled") })
    expect(closed).toBe(true)
  })
})

describe("a final-component swap", () => {
  /**
   * The regression: `lstat` said the entry was a plain file and `Fs.readFile`
   * then opened whatever the name pointed at by the time it ran. A FIFO
   * swapped into that window blocked the open forever, because a reader on a
   * FIFO with no writer waits. The open now carries `O_NONBLOCK`, so it
   * returns, and the descriptor's own `fstat` refuses it.
   *
   * The seam reports the decoy's stats for the declared name; the name itself
   * is a real FIFO, which is exactly the state the race would produce.
   */
  it.runIf(posixOnly)("refuses a FIFO swapped in after the listing, without blocking", async () => {
    await write("decoy.txt", "decoy")
    await Fs.mkdir(at("out"), { recursive: true })
    await mkfifo(at("out", "a.txt"))
    const decoy = await Fs.lstat(at("decoy.txt"))

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        lstat: (path) => path === at("out", "a.txt") ? Promise.resolve(decoy) : defaultCaptureIo.lstat(path)
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("is not a file or a directory")
    })
  })

  /**
   * The regression: the same window let a symbolic link replace a plain file,
   * and `Fs.readFile` followed it out of the workspace. The open now carries
   * `O_NOFOLLOW`, so the kernel refuses the final component itself.
   */
  it("refuses a symbolic link swapped in after the listing", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "not ours", "utf8")
    await write("decoy.txt", "decoy")
    await Fs.mkdir(at("out"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "secret.txt"), at("out", "a.txt"))
    const decoy = await Fs.lstat(at("decoy.txt"))

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        // Both the listing and the fresh stat are told it is a plain file, so
        // nothing but the open itself can refuse it.
        lstat: (path) => path === at("out", "a.txt") ? Promise.resolve(decoy) : defaultCaptureIo.lstat(path),
        readdir: async (path) =>
          (await defaultCaptureIo.readdir(path)).map((entry) =>
            entry.name === "a.txt"
              ? ({
                ...entry,
                isSymbolicLink: () => false,
                isFile: () => true,
                isDirectory: () => false
              } as NodeFs.Dirent)
              : entry
          )
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("could not be opened")
    })
  })

  /** A character device reaches capture only through a descriptor's `fstat`. */
  it.runIf(posixOnly)("refuses a character device behind a regular-looking name", async () => {
    await write("out/a.txt", "real")

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        openFile: (path) => defaultCaptureIo.openFile(path === at("out", "a.txt") ? "/dev/null" : path)
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("is not a file or a directory")
    })
  })

  /** A regular file replaced by another regular file is caught by identity. */
  it("refuses a file whose identity changed between the listing and the open", async () => {
    await write("out/a.txt", "first")
    await write("other.txt", "second")
    const other = await Fs.lstat(at("other.txt"))

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        lstat: (path) => path === at("out", "a.txt") ? Promise.resolve(other) : defaultCaptureIo.lstat(path)
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("was replaced while it was being captured")
    })
  })

  it("refuses a file name that disappears immediately after it is opened", async () => {
    await write("out/a.txt", "content")
    let opened = false

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        openFile: async (path) => {
          const handle = await defaultCaptureIo.openFile(path)
          opened = true
          return handle
        },
        lstat: (path) =>
          opened && path === at("out", "a.txt")
            ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
            : defaultCaptureIo.lstat(path)
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("was replaced while it was being captured")
    })
  })

  it("refuses a file that grew while it was being read", async () => {
    await write("out/a.txt", "x".repeat(4096))

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        openFile: async (path) => {
          const handle = await defaultCaptureIo.openFile(path)
          let first = true
          return {
            ...handle,
            read: async (into) => {
              const bytes = await handle.read(into)
              if (first) {
                first = false
                await Fs.appendFile(path, "appended by the tool that was supposed to be done")
              }
              return bytes
            }
          } satisfies CaptureFile
        }
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("changed while it was being read")
    })
  })
})

describe("close precedence", () => {
  it("fails the capture when a file that read cleanly cannot be closed", async () => {
    await write("out/a.txt", "fine")

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        openFile: async (path) => {
          const handle = await defaultCaptureIo.openFile(path)
          return {
            ...handle,
            close: async () => {
              await handle.close()
              throw new Error("EIO on close")
            }
          } satisfies CaptureFile
        }
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("could not be closed")
    })
  })

  it("reports the read failure, not the close failure, when both happen", async () => {
    await write("out/a.txt", "fine")
    await write("other.txt", "second")
    const other = await Fs.lstat(at("other.txt"))

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        lstat: (path) => path === at("out", "a.txt") ? Promise.resolve(other) : defaultCaptureIo.lstat(path),
        openFile: async (path) => {
          const handle = await defaultCaptureIo.openFile(path)
          return {
            ...handle,
            close: async () => {
              await handle.close()
              throw new Error("EIO on close")
            }
          } satisfies CaptureFile
        }
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("was replaced while it was being captured")
    })
  })
})

describe("a traversed directory swap", () => {
  /**
   * The regression: only the declared root was checked, once, with `realpath`.
   * A directory renamed after its parent listed it was then walked as if it
   * were the one that had been checked, and its files joined a manifest
   * describing a tree that never existed. Every traversed directory is now
   * re-checked against the identity its parent observed.
   */
  it("refuses a directory renamed between the parent listing and the descent", async () => {
    await write("out/nested/a.txt", "a")
    await Fs.mkdir(at("replacement"), { recursive: true })
    await Fs.writeFile(at("replacement", "b.txt"), "b", "utf8")

    // The window is between the parent's stat of the child, which is what
    // records the identity, and the child's own stat when the walk descends
    // into it. The swap is performed exactly once, right after the first.
    let swapped = false
    await expect(measureOutput(root, ".", "out", {
      io: seam({
        lstat: async (path) => {
          const stats = await defaultCaptureIo.lstat(path)
          if (path === at("out", "nested") && !swapped) {
            swapped = true
            await Fs.rename(at("out", "nested"), at("moved"))
            await Fs.rename(at("replacement"), at("out", "nested"))
          }
          return stats
        }
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("was replaced while it was being captured")
    })
  })

  it("refuses a directory that disappeared after its entries were read", async () => {
    await write("out/nested/a.txt", "a")

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        openFile: async (path) => {
          const handle = await defaultCaptureIo.openFile(path)
          await Fs.rename(at("out", "nested"), at("moved"))
          return handle
        }
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("was replaced while it was being captured")
    })
  })

  /**
   * The regression: the listing was the one I/O step between the two identity
   * checks that no wrapper caught. A directory replaced by a file in that
   * window fails the listing itself with ENOTDIR, and the raw error escaped
   * `measureOutput` untyped, so the layer reported it under an empty path.
   */
  it("reports a listing that failed mid-swap as a typed error naming the declaration", async () => {
    await write("out/nested/a.txt", "a")

    const rejection = measureOutput(root, ".", "out", {
      io: seam({
        readdir: (path) =>
          path === at("out", "nested")
            ? Promise.reject(Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" }))
            : defaultCaptureIo.readdir(path)
      })
    })

    await expect(rejection).rejects.toBeInstanceOf(OutputError)
    await expect(rejection).rejects.toMatchObject({
      path: "out",
      message: expect.stringContaining("could not be listed")
    })
  })

  it("refuses a traversed directory that came to resolve outside the workspace", async () => {
    await write("out/nested/a.txt", "a")
    await Fs.mkdir(NodePath.join(outside, "elsewhere"), { recursive: true })

    await expect(measureOutput(root, ".", "out", {
      io: seam({
        realpath: (path) =>
          path === at("out", "nested")
            ? Promise.resolve(NodePath.join(outside, "elsewhere"))
            : defaultCaptureIo.realpath(path)
      })
    })).rejects.toMatchObject({
      message: expect.stringContaining("resolves outside the workspace")
    })
  })
})

describe("output tree limits", () => {
  it("counts empty directories against the entry limit", async () => {
    for (const name of ["a", "b", "c"]) await Fs.mkdir(at("out", name), { recursive: true })

    await expect(measureOutput(root, ".", "out", { limits: limits({ entries: 2 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("more than 2 entries") })
  })

  it("counts a nested entry before later siblings against the same limit", async () => {
    await write("out/a/inside.txt", "inside")
    await write("out/b.txt", "sibling")

    await expect(measureOutput(root, ".", "out", { limits: limits({ entries: 2 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("more than 2 entries") })
  })

  it("refuses two manifest names that normalize to the same Unicode form", async () => {
    await write("out/source.txt", "content")
    const source = at("out", "source.txt")
    const virtual = new Set([at("out", "\u00e9.txt"), at("out", "e\u0301.txt")])
    const io = seam({
      readdir: async (path, remaining) => {
        if (path !== at("out")) return defaultCaptureIo.readdir(path, remaining)
        const [entry] = await defaultCaptureIo.readdir(path, remaining)
        const named = (name: string): NodeFs.Dirent =>
          Object.create(
            Object.getPrototypeOf(entry),
            {
              ...Object.getOwnPropertyDescriptors(entry),
              name: { configurable: true, enumerable: true, value: name, writable: true }
            }
          ) as NodeFs.Dirent
        return [named("\u00e9.txt"), named("e\u0301.txt")]
      },
      lstat: (path) => virtual.has(path) ? defaultCaptureIo.lstat(source) : defaultCaptureIo.lstat(path)
    })

    await expect(measureOutput(root, ".", "out", { io }))
      .rejects.toMatchObject({ message: expect.stringContaining("normalize alike") })
  })

  it("refuses two manifest names that differ only in case", async () => {
    await write("out/source.txt", "content")
    const source = at("out", "source.txt")
    const virtual = new Set([at("out", "Index.js"), at("out", "index.js")])
    const io = seam({
      readdir: async (path, remaining) => {
        if (path !== at("out")) return defaultCaptureIo.readdir(path, remaining)
        const [entry] = await defaultCaptureIo.readdir(path, remaining)
        const named = (name: string): NodeFs.Dirent =>
          Object.create(
            Object.getPrototypeOf(entry),
            {
              ...Object.getOwnPropertyDescriptors(entry),
              name: { configurable: true, enumerable: true, value: name, writable: true }
            }
          ) as NodeFs.Dirent
        return [named("Index.js"), named("index.js")]
      },
      lstat: (path) => virtual.has(path) ? defaultCaptureIo.lstat(source) : defaultCaptureIo.lstat(path)
    })

    await expect(measureOutput(root, ".", "out", { io }))
      .rejects.toMatchObject({ message: expect.stringContaining("normalize alike") })
  })

  it("refuses a tree with more files than the limit allows", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(`out/${name}.txt`, name)

    await expect(measureOutput(root, ".", "out", { limits: limits({ files: 3 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("more than 3 files") })
  })

  it("refuses a tree that nests deeper than the limit allows", async () => {
    await write("out/a/b/c/d/deep.txt", "deep")

    await expect(measureOutput(root, ".", "out", { limits: limits({ depth: 2 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("nests more than 2 directories deep") })
  })

  it("refuses one path longer than the limit allows", async () => {
    await write("out/aaaaaaaaaaaaaaaaaaaa.txt", "long")

    await expect(measureOutput(root, ".", "out", { limits: limits({ pathBytes: 8 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("longer than 8 bytes") })
  })

  it("refuses path names totalling more than the limit allows", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(`out/${name}.txt`, name)

    await expect(measureOutput(root, ".", "out", { limits: limits({ treeBytes: 10 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("total more than 10 bytes") })
  })

  it("fails the whole output rather than returning a truncated manifest", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(`out/${name}.txt`, name)

    // No partial success: the limit is a failure, never a shorter manifest.
    await expect(measureOutput(root, ".", "out", { limits: limits({ files: 2 }) })).rejects.toBeTruthy()
    expect(await measureOutput(root, ".", "out")).toMatchObject({ fileCount: 4 })
  })

  it("keeps an empty directory valid at any limit", async () => {
    await Fs.mkdir(at("out"), { recursive: true })
    expect(await measureOutput(root, ".", "out", { limits: limits({ files: 0 }) })).toMatchObject({ fileCount: 0 })
  })

  it.each([Number.NaN, -1, 1.5])("refuses the invalid custom entry limit %s", async (entries) => {
    await Fs.mkdir(at("out"), { recursive: true })
    await expect(measureOutput(root, ".", "out", { limits: limits({ entries }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("limit entries is not usable") })
  })

  it("refuses a custom limit above the hard ceiling", async () => {
    await Fs.mkdir(at("out"), { recursive: true })
    await expect(measureOutput(root, ".", "out", { limits: limits({ entries: 1_000_001 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining("exceeds 1000000") })
  })

  it("refuses an accessor-backed limit without invoking it", async () => {
    await Fs.mkdir(at("out"), { recursive: true })
    let invoked = false
    const declared = limits({})
    Object.defineProperty(declared, "entries", {
      get: () => {
        invoked = true
        return 1
      },
      enumerable: true
    })
    await expect(measureOutput(root, ".", "out", { limits: declared }))
      .rejects.toMatchObject({ message: expect.stringContaining("limit entries is not usable") })
    expect(invoked).toBe(false)
  })

  it("rejects capture limits whose property descriptors cannot be inspected", async () => {
    await Fs.mkdir(at("out"), { recursive: true })
    const revoked = Proxy.revocable(limits({}), {})
    revoked.revoke()

    await expect(measureOutput(root, ".", "out", { limits: revoked.proxy }))
      .rejects.toMatchObject({ message: expect.stringContaining("limits could not be read") })
  })
})

describe("capture confinement", () => {
  it("fails closed when the workspace root cannot be canonicalized", async () => {
    await write("out/file", "content")
    const io = seam({
      realpath: (path) =>
        path === root ? Promise.reject(new Error("root unavailable")) : defaultCaptureIo.realpath(path)
    })
    await expect(measureOutput(root, ".", "out", { io }))
      .rejects.toMatchObject({ message: expect.stringContaining("workspace root could not be resolved") })
  })

  it("refuses lexical overlap with the configured cache directory", async () => {
    await write("cache/out/file", "content")
    await expect(measureOutput(root, ".", "cache/out", { cacheDirectory: "cache" }))
      .rejects.toMatchObject({ message: expect.stringContaining("overlaps the configured cache directory") })
  })

  it("refuses canonical overlap through a cache-directory link", async () => {
    await write("real-cache/out/file", "content")
    await Fs.symlink(at("real-cache"), at("cache-alias"))
    await expect(measureOutput(root, ".", "real-cache/out", { cacheDirectory: "cache-alias" }))
      .rejects.toMatchObject({ message: expect.stringContaining("overlaps the configured cache directory") })
  })

  it("refuses empty, absolute, root, and escaping cache directories", async () => {
    await write("out/file", "content")
    for (const value of ["", NodePath.join(root, "cache")]) {
      await expect(measureOutput(root, ".", "out", { cacheDirectory: value }))
        .rejects.toMatchObject({ message: expect.stringContaining("not workspace-relative") })
    }
    for (const value of [".", ".."]) {
      await expect(measureOutput(root, ".", "out", { cacheDirectory: value }))
        .rejects.toMatchObject({ message: expect.stringContaining("leaves the workspace") })
    }
  })

  it("refuses a replacement-character filename", async () => {
    await write("out/�.txt", "content")
    await expect(measureOutput(root, ".", "out"))
      .rejects.toMatchObject({ message: expect.stringContaining("invalid UTF-8 byte sequence") })
  })

  it.each([
    ["..", "reserved name"],
    ["nested/name", "path separator"],
    ["back\\slash", "backslash"],
    ["null\0byte", "null byte"],
    ["surrogate\ud800", "unpaired UTF-16 surrogate"]
  ])("refuses the non-portable manifest name %j", async (name, reason) => {
    await write("out/source.txt", "content")
    const io = seam({
      readdir: async (path, remaining) => {
        const [entry] = await defaultCaptureIo.readdir(path, remaining)
        return [
          Object.create(
            Object.getPrototypeOf(entry),
            {
              ...Object.getOwnPropertyDescriptors(entry),
              name: { configurable: true, enumerable: true, value: name, writable: true }
            }
          ) as NodeFs.Dirent
        ]
      }
    })

    await expect(measureOutput(root, ".", "out", { io }))
      .rejects.toMatchObject({ message: expect.stringContaining(reason) })
  })
})

describe("declared output paths", () => {
  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a traversal", "../escaped"],
    ["a traversal in the middle", "dist/../../escaped"],
    ["the declaring directory itself", "."],
    ["a trailing-slash form of the declaring directory", "./"],
    ["an empty path", ""],
    ["the cache and result store", ".flows/cache"],
    ["the cache root itself", ".flows"],
    ["the git directory", ".git/objects"]
  ])("refuses %s", (_name, path) => {
    expect(Target.declaredOutputFailure(".", path)).toBeTypeOf("string")
    expect(() => Target.declaredOutputs("Example", { cwd: ".", paths: [path] })).toThrow()
  })

  it("refuses the workspace root reached through cwd", () => {
    expect(Target.declaredOutputFailure("packages/alpha", "..")).toBeTypeOf("string")
  })

  it("refuses a cwd that is absolute, empty, or a traversal", () => {
    for (const cwd of ["/tmp", "", "../elsewhere"]) {
      expect(Target.declaredOutputsFailure({ cwd, paths: ["dist"] })).toBeTypeOf("string")
    }
  })

  it("accepts the ordinary shapes a target declares", () => {
    expect(Target.declaredOutputFailure(".", "dist")).toBeUndefined()
    expect(Target.declaredOutputFailure("packages/alpha", "dist/esm")).toBeUndefined()
    expect(Target.declaredOutputFailure(".", "build/artifact.tar.gz")).toBeUndefined()
  })

  it("refuses two declarations that resolve to the same output", () => {
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "./dist"] }))
      .toMatch(/name the same output/)
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist/"] }))
      .toMatch(/name the same output/)
    // One file on the default macOS and Windows filesystems.
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist/A.js", "dist/a.js"] }))
      .toMatch(/name the same output/)
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["Dist", "dist/index.js"] }))
      .toMatch(/already covered by/)
  })

  /**
   * `dist` and `dist/index.js` would each contribute `index.js` to the
   * manifest, under two digests that no longer have to agree, and a cache
   * admission would then have to decide which one it trusted.
   */
  it("refuses a declaration already covered by another", () => {
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist/index.js"] }))
      .toMatch(/already covered by/)
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist/index.js", "dist"] }))
      .toMatch(/already covered by/)
  })

  it("accepts sibling declarations that only share a prefix in their names", () => {
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist-types"] })).toBeUndefined()
  })

  it("refuses the same set again at execution, not only at declaration", async () => {
    await write("dist/index.js", "export {}")

    await expect(measureOutputs(root, ".", ["dist", "dist/index.js"]))
      .rejects.toMatchObject({ message: expect.stringContaining("already covered by") })
    await expect(measureOutputs(root, ".", ["dist", "./dist"]))
      .rejects.toMatchObject({ message: expect.stringContaining("name the same output") })
    await expect(measureOutputs(root, ".", [".flows/cache"]))
      .rejects.toMatchObject({ message: expect.stringContaining("reserved directory") })
  })
})

describe("manifest shapes", () => {
  it("keeps a file output at its own basename and a directory output relative to itself", async () => {
    await write("dist/nested/index.js", "export {}")
    await write("artifact.tar", "tar")

    const [directory, file] = (await measureOutputs(root, ".", ["dist", "artifact.tar"])).outputs
    expect(directory).toMatchObject({ path: "dist", fileCount: 1 })
    expect(file).toMatchObject({ path: "artifact.tar", fileCount: 1 })

    // The directory manifest names `nested/index.js`, the file manifest names
    // `artifact.tar`; a change to either shape changes these digests.
    const sha = (value: string): string => createHash("sha256").update(value).digest("hex")
    expect(directory?.contentDigest).toBe(sha(JSON.stringify([
      ["directory", "nested"],
      ["file", "nested/index.js", false, sha("export {}")]
    ])))
    expect(file?.contentDigest).toBe(sha(JSON.stringify([["file", "artifact.tar", false, sha("tar")]])))
  })
})
