import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
let outside: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const canonical = (): Promise<string> => SafeFs.canonicalRoot(root)

const at = (relative: string): string => NodePath.join(root, relative)

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Root can read anything, so the permission cases prove nothing under it. */
// Windows chmod cannot deny reads. Keep real IO except the refused open.
const deniedRead = (denied: string): SafeFs.Io =>
  process.platform === "win32" ?
    {
      ...SafeFs.defaultIo,
      open: async (path) => {
        if (path === denied) throw Object.assign(new Error("read denied"), { code: "EACCES" })
        return SafeFs.defaultIo.open(path)
      }
    } :
    SafeFs.defaultIo

const unprivileged = process.getuid?.() !== 0

const posixOnly = process.platform !== "win32"

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-safefs-")))
  outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("SafeFs.errorCode", () => {
  it("reads only an own data property without invoking user code", () => {
    let calls = 0
    const getter = Object.defineProperty({}, "code", {
      get: () => {
        calls += 1
        return "ENOENT"
      }
    })
    const proxy = new Proxy({ code: "ENOENT" }, {
      getOwnPropertyDescriptor: (target, property) => {
        calls += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })

    expect(SafeFs.errorCode({ code: "ENOENT" })).toBe("ENOENT")
    expect(SafeFs.errorCode({ code: 7 })).toBeUndefined()
    expect(SafeFs.errorCode("ENOENT")).toBeUndefined()
    expect(SafeFs.errorCode(null)).toBeUndefined()
    expect(SafeFs.errorCode(getter)).toBeUndefined()
    expect(SafeFs.errorCode(proxy)).toBeUndefined()
    expect(calls).toBe(0)
  })
})

describe("SafeFs.digestFile", () => {
  it("digests a regular file and reports a missing one as undefined", async () => {
    await write("a.ts", "content\n")
    const options = { root: await canonical(), what: "declared input" }
    expect(await SafeFs.digestFile(at("a.ts"), options)).toBe(sha256("content\n"))
    expect(await SafeFs.digestFile(at("gone.ts"), options)).toBeUndefined()
    expect(await SafeFs.digestFile(at("no/such/dir/a.ts"), options)).toBeUndefined()
  })

  it("enforces an optional digest byte ceiling before streaming", async () => {
    await write("large.ts", "a".repeat(64))
    await expect(SafeFs.digestFile(at("large.ts"), {
      root: await canonical(),
      maximumBytes: 8,
      what: "implementation source"
    })).rejects.toThrow(/larger than 8 bytes/)
  })

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses the invalid digest byte limit %s before reading",
    async (maximumBytes) => {
      await expect(SafeFs.digestFile(at("absent"), {
        root: await canonical(),
        maximumBytes,
        what: "implementation source"
      })).rejects.toThrow(/digest byte limit must be a non-negative safe integer/)
    }
  )

  /**
   * The regression: an unbounded `readFile` followed every symbolic link and
   * digested whatever it landed on. A link inside a workspace therefore chose
   * what the workspace's own key material was computed from, and the file it
   * chose could be any file the user could read.
   */
  it("refuses a symbolic link that leaves the workspace", async () => {
    const target = NodePath.join(outside, "secret")
    await Fs.writeFile(target, "not ours\n", "utf8")
    await Fs.symlink(target, at("link.ts"))
    await expect(SafeFs.digestFile(at("link.ts"), { root: await canonical(), what: "declared input" }))
      .rejects.toThrow(/symbolic link leaving the workspace/)
  })

  it("follows a symbolic link that stays inside the workspace", async () => {
    await write("src/real.ts", "inside\n")
    await Fs.symlink(at("src/real.ts"), at("link.ts"))
    expect(await SafeFs.digestFile(at("link.ts"), { root: await canonical(), what: "declared input" }))
      .toBe(sha256("inside\n"))
  })

  /**
   * The final component is not the only one that can be retargeted. A link
   * standing in for a parent directory used to be followed silently, because
   * only the leaf was ever inspected.
   */
  it("refuses a file reached through a parent directory that leaves the workspace", async () => {
    await Fs.mkdir(NodePath.join(outside, "src"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "src", "a.ts"), "not ours\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "src"), at("src"))
    await expect(SafeFs.digestFile(at("src/a.ts"), { root: await canonical(), what: "declared input" }))
      .rejects.toThrow(/resolves outside the workspace/)
  })

  it("refuses a dangling link's target once it appears outside", async () => {
    const target = NodePath.join(outside, "later")
    await Fs.symlink(target, at("link.ts"))
    const options = { root: await canonical(), what: "declared input" }
    expect(await SafeFs.digestFile(at("link.ts"), options)).toBeUndefined()
    await Fs.writeFile(target, "appeared\n", "utf8")
    await expect(SafeFs.digestFile(at("link.ts"), options)).rejects.toThrow(/symbolic link leaving/)
  })

  it.runIf(posixOnly)("refuses a FIFO instead of blocking on it", async () => {
    execFileSync("mkfifo", [at("pipe")])
    // Nothing ever writes to this FIFO. An `open` without `O_NONBLOCK`, or a
    // `readFile`, would wait for a writer that never comes and hang planning
    // forever; the `lstat` refuses it before the open is even attempted.
    await expect(SafeFs.digestFile(at("pipe"), { root: await canonical(), what: "declared input" }))
      .rejects.toThrow(/not a regular file/)
  })

  it("refuses a directory named like a file", async () => {
    await Fs.mkdir(at("a.ts"), { recursive: true })
    await expect(SafeFs.digestFile(at("a.ts"), { root: await canonical(), what: "declared input" }))
      .rejects.toThrow(/not a regular file/)
  })

  it.runIf(unprivileged)("reports a permission error instead of digesting absence", async () => {
    await write("secret.ts", "content\n")
    await Fs.chmod(at("secret.ts"), 0o000)
    try {
      await expect(
        SafeFs.digestFile(at("secret.ts"), {
          root: await canonical(),
          what: "declared input",
          io: deniedRead(at("secret.ts"))
        })
      )
        .rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await Fs.chmod(at("secret.ts"), 0o600).catch(() => undefined)
    }
  })

  /**
   * A digest is only meaningful for a file that held one set of bytes for the
   * whole read. The descriptor's size before the first read, its size after
   * the last one, and the number of bytes that arrived all have to agree.
   */
  it("refuses a file that changed while it was being digested", async () => {
    await write("large.ts", "x".repeat(2 * SafeFs.chunkBytes))
    let reads = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        const handle = await SafeFs.defaultIo.open(path)
        return {
          ...handle,
          read: async (into) => {
            const bytes = await handle.read(into)
            reads += 1
            // A writer truncates the file after the first chunk has been read.
            // The seam is what makes the moment a choice rather than a race.
            if (reads === 1) await Fs.writeFile(at("large.ts"), "tiny\n", "utf8")
            return bytes
          }
        }
      }
    }
    await expect(SafeFs.digestFile(at("large.ts"), { root: await canonical(), io, what: "declared input" }))
      .rejects.toThrow(/changed while it was being digested/)
  })

  /**
   * The whole file is never resident. A one-gigabyte input has to cost a fixed
   * amount of heap, so the read loop is what proves the fix, not the digest.
   */
  it("streams a large file through a bounded buffer", async () => {
    const large = "y".repeat(4 * 1024 * 1024 + 17)
    await write("large.ts", large)
    const sizes: Array<number> = []
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        const handle = await SafeFs.defaultIo.open(path)
        return {
          ...handle,
          read: async (into) => {
            sizes.push(into.byteLength)
            return handle.read(into)
          }
        }
      }
    }
    expect(await SafeFs.digestFile(at("large.ts"), { root: await canonical(), io, what: "input" }))
      .toBe(sha256(large))
    expect(sizes.length).toBeGreaterThan(1)
    expect(Math.max(...sizes)).toBe(SafeFs.chunkBytes)
  })

  /**
   * A plan digests tens of thousands of small files. A chunk-sized buffer for
   * each one allocated 68 GB on one 57,000-file workspace, a tenth of the
   * plan's time in garbage collection.
   */
  it("reads a small file through a buffer one byte larger than the file", async () => {
    const sizes: Array<number> = []
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        const handle = await SafeFs.defaultIo.open(path)
        return {
          ...handle,
          read: async (into) => {
            sizes.push(into.byteLength)
            return handle.read(into)
          }
        }
      }
    }
    await write("small.ts", "small\n")
    await write("empty.ts", "")
    expect(await SafeFs.digestFile(at("small.ts"), { root: await canonical(), io })).toBe(sha256("small\n"))
    expect(await SafeFs.digestFile(at("empty.ts"), { root: await canonical(), io })).toBe(sha256(""))
    expect(sizes).toEqual([7, 7, 1])
  })

  it("accepts ordinary numeric stat metadata without losing precision", async () => {
    await write("numeric.ts", "numeric stats\n")
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      lstat: (path) => Fs.lstat(path),
      open: async (path) => {
        const handle = await Fs.open(path, "r")
        return {
          stat: () => handle.stat(),
          read: async (into) => (await handle.read(into, 0, into.byteLength, null)).bytesRead,
          close: () => handle.close()
        }
      }
    }
    expect(await SafeFs.digestFile(at("numeric.ts"), { root: await canonical(), io })).toBe(sha256("numeric stats\n"))
  })

  it("refuses an invalid numeric size reported by the open descriptor", async () => {
    await write("invalid-size.ts", "content\n")
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        const handle = await SafeFs.defaultIo.open(path)
        return {
          ...handle,
          stat: async () => ({ ...await handle.stat(), size: -1, isFile: () => true }) as never
        }
      }
    }
    await expect(SafeFs.digestFile(at("invalid-size.ts"), { root: await canonical(), io }))
      .rejects.toThrow(/invalid file size/)
  })

  it.each(
    [
      [new Error("close failed"), "close failed"],
      [new Error(""), "unknown failure"],
      ["string close failure", "string close failure"],
      ["", "unknown failure"],
      [new Proxy(new Error("hidden close failure"), {}), "unknown failure"]
    ] as const
  )("reports a descriptor close failure after a successful read", async (closeFailure, message) => {
    await write("close.ts", "content\n")
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        const handle = await SafeFs.defaultIo.open(path)
        return {
          ...handle,
          close: async () => {
            await handle.close()
            throw closeFailure
          }
        }
      }
    }
    await expect(SafeFs.digestFile(at("close.ts"), { root: await canonical(), io, what: "close probe" }))
      .rejects.toThrow(message)
  })

  it.each([Number.NaN, -1, 1.5, SafeFs.chunkBytes + 1])(
    "refuses an invalid descriptor read length %s",
    async (bytesRead) => {
      await write("a.ts", "content\n")
      const io: SafeFs.Io = {
        ...SafeFs.defaultIo,
        open: async (path) => {
          const handle = await SafeFs.defaultIo.open(path)
          return { ...handle, read: async () => bytesRead }
        }
      }

      await expect(SafeFs.digestFile(at("a.ts"), { root: await canonical(), io, what: "declared input" }))
        .rejects.toThrow(/invalid read length/)
    }
  )

  /**
   * The swap seam. Between the `lstat` that admits a path and the `open` that
   * reads it, the name can be pointed at another file. The descriptor's own
   * `fstat` is what catches it, and the seam makes the race a choice rather
   * than a coincidence.
   */
  it("refuses a file swapped between the check and the open", async () => {
    await write("a.ts", "original\n")
    await write("decoy.ts", "swapped\n")
    let seen = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      lstat: async (path) => {
        const stats = await SafeFs.defaultIo.lstat(path)
        if (path.endsWith("a.ts")) {
          seen += 1
          if (seen === 1) await Fs.rename(at("decoy.ts"), at("a.ts"))
        }
        return stats
      }
    }
    await expect(SafeFs.digestFile(at("a.ts"), { root: await canonical(), io, what: "declared input" }))
      .rejects.toThrow(/was replaced while it was being opened/)
  })

  it("re-confines the opened file when its parent is replaced after open", async () => {
    await write("src/a.ts", "inside\n")
    await Fs.writeFile(NodePath.join(outside, "a.ts"), "outside\n", "utf8")
    let swapped = false
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      open: async (path) => {
        if (swapped) return SafeFs.defaultIo.open(path)
        swapped = true
        // Windows cannot rename a directory containing an open handle. Move
        // the original first, then publish the outside link after opening it.
        await Fs.rename(at("src"), at("parked"))
        const handle = await SafeFs.defaultIo.open(at("parked/a.ts"))
        try {
          await Fs.symlink(outside, at("src"))
          return handle
        } catch (cause) {
          await handle.close()
          throw cause
        }
      }
    }

    await expect(SafeFs.digestFile(at("src/a.ts"), { root: await canonical(), io, what: "declared input" }))
      .rejects.toThrow(/left the workspace while it was being opened/)
  })
})

describe("SafeFs.readText", () => {
  it("reads a bounded regular file and reports a missing one as undefined", async () => {
    await write("ignore", "dist/\n")
    const options = { root: await canonical(), what: ".gitignore" }
    expect(await SafeFs.readText(at("ignore"), options)).toBe("dist/\n")
    expect(await SafeFs.readText(at("absent"), options)).toBeUndefined()
  })

  it("refuses a file over the limit rather than truncating it", async () => {
    await write("ignore", "a".repeat(64))
    await expect(SafeFs.readText(at("ignore"), { root: await canonical(), limit: 8, what: ".gitignore" }))
      .rejects.toThrow(/larger than 8 bytes/)
  })

  it("refuses content that is not valid UTF-8", async () => {
    await Fs.writeFile(at("ignore"), Buffer.from([0x64, 0xff, 0xfe, 0x0a]))
    await expect(SafeFs.readText(at("ignore"), { root: await canonical(), what: ".gitignore" }))
      .rejects.toThrow(/not valid UTF-8/)
  })

  it.each([Number.NaN, -1, 1.5, SafeFs.maximumTextBytes + 1])(
    "refuses the invalid text limit %s before reading",
    async (limit) => {
      await expect(SafeFs.readText(at("absent"), { root: await canonical(), limit, what: ".gitignore" }))
        .rejects.toThrow(/text read limit must be an integer/)
    }
  )

  it.runIf(posixOnly)("refuses a FIFO", async () => {
    execFileSync("mkfifo", [at("ignore")])
    await expect(SafeFs.readText(at("ignore"), { root: await canonical(), what: ".gitignore" }))
      .rejects.toThrow(/not a regular file/)
  })

  it.runIf(unprivileged)("reports a permission error instead of reading absence", async () => {
    await write("ignore", "dist/\n")
    await Fs.chmod(at("ignore"), 0o000)
    try {
      await expect(
        SafeFs.readText(at("ignore"), { root: await canonical(), what: ".gitignore", io: deniedRead(at("ignore")) })
      )
        .rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await Fs.chmod(at("ignore"), 0o600).catch(() => undefined)
    }
  })

  it.skipIf(process.platform === "win32")("rejects a final symlink when the caller requires no-follow", async () => {
    await write("actual.txt", "inside\n")
    await Fs.symlink("actual.txt", at("link.txt"))

    await expect(SafeFs.readText(at("link.txt"), {
      root: await canonical(),
      symlinks: "reject",
      what: "configuration"
    })).rejects.toThrow(`configuration is a symbolic link: ${at("link.txt")}`)
  })

  it.skipIf(process.platform === "win32")(
    "reports a symlink or its target disappearing during resolution",
    async () => {
      await write("target.txt", "content\n")
      await Fs.symlink("target.txt", at("link.txt"))
      const confinedRoot = await canonical()
      const link = NodePath.join(confinedRoot, "link.txt")
      const target = NodePath.join(confinedRoot, "target.txt")
      const gone = Object.assign(new Error("gone"), { code: "ENOENT" })
      const linkGone: SafeFs.Io = {
        ...SafeFs.defaultIo,
        realpath: (path) => path === link ? Promise.reject(gone) : SafeFs.defaultIo.realpath(path)
      }
      expect(await SafeFs.readText(at("link.txt"), { root: confinedRoot, io: linkGone })).toBeUndefined()

      const targetGone: SafeFs.Io = {
        ...SafeFs.defaultIo,
        lstat: (path) => path === target ? Promise.reject(gone) : SafeFs.defaultIo.lstat(path)
      }
      expect(await SafeFs.readText(at("link.txt"), { root: confinedRoot, io: targetGone })).toBeUndefined()
    }
  )

  it("refuses a direct path whose real parent is outside the confined root", async () => {
    const path = NodePath.join(outside, "outside.txt")
    await Fs.writeFile(path, "outside\n", "utf8")

    await expect(SafeFs.readText(path, { root: await canonical(), what: "configuration" }))
      .rejects.toThrow(`configuration resolves outside the workspace: ${path}`)
  })

  it("propagates a non-absence failure while resolving a confined parent", async () => {
    await write("config.txt", "content\n")
    const denied = Object.assign(new Error("parent denied"), { code: "EACCES" })
    const io: SafeFs.Io = { ...SafeFs.defaultIo, realpath: () => Promise.reject(denied) }

    await expect(SafeFs.readText(at("config.txt"), { root: await canonical(), io, what: "configuration" }))
      .rejects.toBe(denied)
  })

  it.skipIf(process.platform === "win32")("refuses a symlink whose in-workspace target is a directory", async () => {
    await Fs.mkdir(at("actual"))
    await Fs.symlink("actual", at("link"))

    await expect(SafeFs.readText(at("link"), { root: await canonical(), what: "configuration" }))
      .rejects.toThrow(`configuration is not a regular file: ${at("link")}`)
  })
})

describe("SafeFs.resolveDirectory", () => {
  it("never reports a symbolic link as a directory", async () => {
    await Fs.mkdir(NodePath.join(outside, "elsewhere"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "elsewhere"), at("link"))
    await Fs.mkdir(at("real"), { recursive: true })
    const options = { root: await canonical(), what: "directory" }
    expect(await SafeFs.resolveDirectory(at("link"), options)).toBeUndefined()
    expect(await SafeFs.resolveDirectory(at("real"), options)).toMatchObject({ path: at("real") })
    expect(await SafeFs.resolveDirectory(at("real"))).toMatchObject({ path: at("real") })
    expect(await SafeFs.resolveDirectory(at("missing"))).toBeUndefined()
  })

  it("propagates a directory stat failure that is not absence", async () => {
    const denied = Object.assign(new Error("directory denied"), { code: "EACCES" })
    const io: SafeFs.Io = { ...SafeFs.defaultIo, lstat: () => Promise.reject(denied) }
    await expect(SafeFs.resolveDirectory(at("denied"), { io })).rejects.toBe(denied)
  })

  it("refuses a directory reached through a link out of the workspace", async () => {
    await Fs.mkdir(NodePath.join(outside, "src", "deep"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "src"), at("src"))
    await expect(SafeFs.resolveDirectory(at("src/deep"), { root: await canonical(), what: "directory" }))
      .rejects.toThrow(/resolves outside the workspace/)
  })

  it("bounds a directory listing before materializing every entry", async () => {
    await write("wide/a", "a")
    await write("wide/b", "b")
    await expect(SafeFs.defaultIo.readdir(at("wide"), 1)).rejects.toThrow(/more than 1 entries/)
  })

  /** The swap seam again, one level up: a directory replaced mid-listing. */
  it("refuses an outside symlink swapped in immediately before enumeration", async () => {
    await write("src/a.ts", "inside\n")
    await Fs.writeFile(NodePath.join(outside, "outside-private-filename"), "outside\n")
    const target = at("src")
    const options = { root: await canonical(), what: "directory" }
    const entry = await SafeFs.resolveDirectory(target, options)
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        await Fs.rename(target, at("parked"))
        await Fs.symlink(outside, target)
        const entries = await SafeFs.defaultIo.readdir(path, limit)
        expect(entries.map((entry) => entry.name)).toEqual(["outside-private-filename"])
        return entries
      }
    }

    await expect(SafeFs.listDirectory(target, entry!, { ...options, io }))
      .rejects.toThrow(/was replaced while it was being read/)
  })

  it("refuses another directory swapped in immediately before enumeration", async () => {
    await write("src/a.ts", "inside\n")
    await write("other/b.ts", "replacement\n")
    const target = at("src")
    const options = { root: await canonical(), what: "directory" }
    const entry = await SafeFs.resolveDirectory(target, options)
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        await Fs.rename(target, at("parked"))
        await Fs.rename(at("other"), target)
        return SafeFs.defaultIo.readdir(path, limit)
      }
    }

    await expect(SafeFs.listDirectory(target, entry!, { ...options, io }))
      .rejects.toThrow(/was replaced while it was being read/)
  })

  it("re-confines a directory when its parent is swapped immediately before enumeration", async () => {
    await write("src/deep/a.ts", "inside\n")
    await Fs.mkdir(NodePath.join(outside, "deep"))
    await Fs.writeFile(NodePath.join(outside, "deep", "outside-private-filename"), "outside\n")
    const target = at("src/deep")
    const options = { root: await canonical(), what: "directory" }
    const entry = await SafeFs.resolveDirectory(target, options)
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        await Fs.rename(at("src"), at("parked"))
        await Fs.symlink(outside, at("src"))
        return SafeFs.defaultIo.readdir(path, limit)
      }
    }

    await expect(SafeFs.listDirectory(target, entry!, { ...options, io }))
      .rejects.toThrow(/resolves outside the workspace/)
  })

  it("lists an unchanged confined directory", async () => {
    await write("src/a.ts", "inside\n")
    const target = at("src")
    const options = { root: await canonical(), what: "directory" }
    const entry = await SafeFs.resolveDirectory(target, options)

    expect((await SafeFs.listDirectory(target, entry!, options)).map((entry) => entry.name))
      .toEqual(["a.ts"])
  })

  it("refuses a directory replaced between its check and its listing", async () => {
    await write("src/a.ts", "a\n")
    await write("other/b.ts", "b\n")
    const target = at("src")
    let seen = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      lstat: async (path) => {
        const stats = await SafeFs.defaultIo.lstat(path)
        if (path === target) {
          seen += 1
          if (seen === 1) {
            await Fs.rm(target, { recursive: true, force: true })
            await Fs.rename(at("other"), target)
          }
        }
        return stats
      }
    }
    const options = { root: await canonical(), io, what: "directory" }
    const entry = await SafeFs.resolveDirectory(target, options)
    await expect(SafeFs.listDirectory(target, entry!, options))
      .rejects.toThrow(/was replaced while it was being read/)
  })
})

describe("SafeFs.inside", () => {
  it("accepts the root itself and refuses a sibling with a shared prefix", () => {
    expect(SafeFs.inside("/a/b", "/a/b")).toBe(true)
    expect(SafeFs.inside("/a/b", "/a/b/c")).toBe(true)
    expect(SafeFs.inside("/a/b", "/a/bc")).toBe(false)
    expect(SafeFs.inside("/a/b", "/a")).toBe(false)
    expect(SafeFs.inside("/a/b", "/")).toBe(false)
  })
})
