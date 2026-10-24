import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
let path: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-confined-reads-")))
  path = join(root, "file")
  await Fs.writeFile(path, "x")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const base = SafeFs.defaultIo
const fault = () => Object.assign(new Error("injected I/O failure"), { code: "EIO" })

it.each(["parent", "entry", "link", "target"] as const)(
  "propagates a non-absence %s resolution failure",
  async (step) => {
    await Fs.symlink(path, join(root, "link"))
    const io: SafeFs.Io = {
      ...base,
      realpath: (candidate) => {
        if (
          step === "parent" && candidate === root || step === "link" && candidate === join(root, "link")
        ) return Promise.reject(fault())
        return base.realpath(candidate)
      },
      lstat: (candidate) => {
        if (step === "entry" && candidate === path || step === "target" && candidate === path) {
          return Promise.reject(
            fault()
          )
        }
        return base.lstat(candidate)
      }
    }
    await expect(SafeFs.resolveFile(step === "link" || step === "target" ? join(root, "link") : path, { root, io }))
      .rejects.toThrow("injected I/O failure")
  }
)

it("does not read a symlink that resolves to a directory", async () => {
  await Fs.symlink(root, join(root, "link"))
  await expect(SafeFs.readText(join(root, "link"), { root })).rejects.toThrow(/not a regular file/)
})

it("rejects a directory listing that exceeds its requested bound", async () => {
  await Fs.writeFile(join(root, "second"), "y")
  const entry = await SafeFs.resolveDirectory(root, { root })
  expect(entry).toBeDefined()
  await expect(SafeFs.listDirectory(root, entry!, {
    root,
    directoryEntries: 1,
    io: { ...base, readdir: (p) => base.readdir(p) }
  })).rejects.toThrow(/more than 1 entries/)
})

it("rejects a file changed between admission and descriptor open", async () => {
  const entry = await SafeFs.resolveFile(path, { root })
  await Fs.appendFile(path, "changed")
  await expect(SafeFs.digestEntry(entry!, { root })).rejects.toThrow(/changed while it was being opened/)
})

it.each(["read", "close", "both", "negative-count", "fractional-count", "oversized-count", "undefined"] as const)(
  "reports a descriptor %s failure and closes it once",
  async (failure) => {
    let closed = 0
    const io: SafeFs.Io = {
      ...base,
      open: async (candidate) => {
        const file = await base.open(candidate)
        return {
          stat: file.stat,
          read: async (buffer) => {
            if (failure === "undefined") throw undefined
            if (failure === "read" || failure === "both") throw new Error("read refused")
            if (failure === "negative-count") return -1
            if (failure === "fractional-count") return 0.5
            if (failure === "oversized-count") return buffer.length + 1
            return file.read(buffer)
          },
          close: async () => {
            closed++
            await file.close()
            if (failure === "close" || failure === "both") throw new Error("close refused")
          }
        }
      }
    }
    const operation = SafeFs.readText(path, { root, io })
    await expect(operation).rejects.toThrow(
      failure === "both" || failure === "read" ? /read refused/ : failure === "close" ? /could not be closed/ : /read/
    )
    expect(closed).toBe(1)
  }
)

it("rejects a digest whose stream grows beyond the byte ceiling", async () => {
  const io: SafeFs.Io = {
    ...base,
    open: async (candidate) => {
      const file = await base.open(candidate)
      let first = true
      return {
        ...file,
        read: async (buffer) => {
          if (first) {
            first = false
            await Fs.appendFile(path, "longer")
          }
          return file.read(buffer)
        }
      }
    }
  }
  const entry = await SafeFs.resolveFile(path, { root })
  await expect(SafeFs.digestEntry(entry!, { root, io, maximumBytes: 2 })).rejects.toThrow(/larger than 2 bytes/)
})

it.each([null, "bad", -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid digest limits before reading",
  async (maximumBytes) => {
    const entry = await SafeFs.resolveFile(path)
    await expect(SafeFs.digestEntry(entry!, { maximumBytes: maximumBytes as never })).rejects.toThrow(
      /non-negative safe integer/
    )
  }
)

it.each(["bad", -1, 0.5, SafeFs.maximumDirectoryEntries + 1])(
  "rejects an invalid directory entry ceiling",
  async (directoryEntries) => {
    const entry = await SafeFs.resolveDirectory(root)
    await expect(SafeFs.listDirectory(root, entry!, { directoryEntries: directoryEntries as never })).rejects.toThrow(
      /directory entry limit/
    )
  }
)

it("reports a non-absence failure while rechecking a directory", async () => {
  const entry = await SafeFs.resolveDirectory(root)
  await expect(SafeFs.listDirectory(root, entry!, {
    io: {
      ...base,
      lstat: async () => {
        throw fault()
      }
    }
  })).rejects.toThrow("injected I/O failure")
})

it("refuses a symlink target replaced by another symlink during resolution", async () => {
  const link = join(root, "link")
  await Fs.symlink(path, link)
  const io: SafeFs.Io = {
    ...base,
    realpath: async (candidate) => {
      const resolved = await base.realpath(candidate)
      if (candidate === link) {
        await Fs.rename(path, path + ".original")
        await Fs.symlink(path + ".original", path)
      }
      return resolved
    }
  }
  await expect(SafeFs.readText(link, { root, io })).rejects.toThrow(
    /changed while its symbolic link was being resolved/
  )
})

it("refuses a directory descriptor returned for an admitted regular file", async () => {
  const entry = await SafeFs.resolveFile(path)
  await expect(SafeFs.digestEntry(entry!, { io: { ...base, open: () => base.open(root) } })).rejects.toThrow(
    /not a regular file|EISDIR/
  )
})

it("reconfines an open descriptor after its name is replaced", async () => {
  const io: SafeFs.Io = {
    ...base,
    realpath: async (candidate) => {
      const resolved = await base.realpath(candidate)
      if (candidate === path) {
        await Fs.rename(path, path + ".original")
        await Fs.writeFile(path, "replacement")
      }
      return resolved
    }
  }
  await expect(SafeFs.readText(path, { root, io })).rejects.toThrow(/open descriptor was being confined/)
  expect(await Fs.readFile(path + ".original", "utf8")).toBe("x")
  expect(await Fs.readFile(path, "utf8")).toBe("replacement")
})

it("refuses text that grows while its descriptor is being read", async () => {
  const io: SafeFs.Io = {
    ...base,
    open: async (candidate) => {
      const file = await base.open(candidate)
      let first = true
      return {
        ...file,
        read: async (into) => {
          const count = await file.read(into)
          if (first) {
            first = false
            await Fs.appendFile(path, "grown")
          }
          return count
        }
      }
    }
  }
  await expect(SafeFs.readText(path, { root, io })).rejects.toThrow(/changed while it was being read/)
})

it.each(["text", "digest"] as const)("rechecks the %s byte ceiling after descriptor confinement", async (kind) => {
  let cached: Awaited<ReturnType<SafeFs.Io["lstat"]>> | undefined
  let reads = 0
  const io: SafeFs.Io = {
    ...base,
    open: async (candidate) => {
      const file = await base.open(candidate)
      return {
        ...file,
        stat: async () => {
          cached = await file.stat()
          return cached
        },
        read: async (into) => {
          reads++
          return file.read(into)
        }
      }
    },
    realpath: async (candidate) => {
      const real = await base.realpath(candidate)
      if (candidate === path && cached !== undefined) {
        await Fs.appendFile(path, "grown")
        Object.assign(cached, { size: (await Fs.stat(path)).size })
      }
      return real
    }
  }
  const operation = kind === "text" ?
    SafeFs.readText(path, { root, io, limit: 2 })
    : SafeFs.digestFile(path, { root, io, maximumBytes: 2 })
  await expect(operation).rejects.toThrow(/larger than 2 bytes/)
  expect(reads).toBe(0)
})

it("refuses a file changed into a symbolic link immediately before open", async () => {
  const entry = await SafeFs.resolveFile(path, { root })
  const io: SafeFs.Io = {
    ...base,
    open: async (candidate) => {
      await Fs.rename(path, path + ".original")
      await Fs.symlink(path + ".original", path)
      return base.open(candidate)
    }
  }
  await expect(SafeFs.digestEntry(entry!, { root, io })).rejects.toThrow(/became a symbolic link/)
})

it("hashes one real input consistently with or without a workspace confinement", async () => {
  const { digestFile } = await import("../src/Input.ts")
  const confined = await digestFile(path, { workspaceRoot: root })
  expect(await digestFile(path)).toBe(confined)
  expect(confined).toMatch(/^[a-f0-9]{64}$/)
})
