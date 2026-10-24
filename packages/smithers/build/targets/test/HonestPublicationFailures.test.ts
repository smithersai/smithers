import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { writeGeneratedFile } from "../src/GeneratedFile.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-publication-failures-")))
  await Fs.writeFile(join(root, "output"), "original")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

it.each(["sync", "close", "both", "short-write", "cleanup"] as const)(
  "preserves the original on a temporary-file %s failure",
  async (fault) => {
    const io: typeof Fs = {
      ...Fs,
      open: async (...args) => {
        const handle = await Fs.open(...args)
        return Object.assign(Object.create(handle), {
          stat: handle.stat.bind(handle),
          chmod: handle.chmod.bind(handle),
          writeFile: async (data: string, encoding: BufferEncoding) => {
            await handle.writeFile(fault === "short-write" ? data.slice(0, -1) : data, encoding)
          },
          sync: async () => {
            if (fault === "sync" || fault === "both" || fault === "cleanup") throw new Error("sync refused")
            await handle.sync()
          },
          close: async () => {
            await handle.close()
            if (fault === "close" || fault === "both") throw new Error("close refused")
          }
        })
      },
      rm: async (...args) => {
        if (fault === "cleanup") throw new Error("cleanup refused")
        return Fs.rm(...args)
      }
    }
    const error = await Effect.runPromise(
      Effect.flip(writeGeneratedFile(root, { path: "output", contents: "replacement" })).pipe(
        Effect.provideService(PublicationFileSystem, io)
      )
    )
    expect(error.path).toBe("output")
    expect(error.message).toContain(
      fault === "short-write" ? "complete output" : fault === "close" ? "close refused" : "sync refused"
    )
    if (fault === "both") expect(error.message).toContain("close also failed")
    if (fault === "cleanup") expect(error.message).toContain("cleanup also failed")
    expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
    expect((await Fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toHaveLength(fault === "cleanup" ? 1 : 0)
  }
)

it("bounds collisions without overwriting another temporary file", async () => {
  let attempts = 0
  const io: typeof Fs = {
    ...Fs,
    open: async () => {
      attempts++
      throw Object.assign(new Error("collision"), { code: "EEXIST" })
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "output", contents: "replacement" })).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(attempts).toBe(4)
  expect(error.message).toContain("could not create a unique")
  expect(await Fs.readdir(root)).toEqual(["output"])
})

it("reports publication rename failure and cleans the unpublished file", async () => {
  const io: typeof Fs = {
    ...Fs,
    rename: async () => {
      throw new Error("rename refused")
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "output", contents: "replacement" })).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(error.message).toBe("rename refused")
  expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
  expect(await Fs.readdir(root)).toEqual(["output"])
})

it("reports parent creation failure without publishing a partial tree", async () => {
  const io: typeof Fs = {
    ...Fs,
    mkdir: async () => {
      throw new Error("mkdir refused")
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "new/output", contents: "replacement" })).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(error.message).toBe("mkdir refused")
  expect(await Fs.readdir(root)).toEqual(["output"])
})

it("rejects an unreadable existing output instead of treating it as absent", async () => {
  const io: typeof Fs = {
    ...Fs,
    lstat: async (...args) => {
      if (args[0] === join(root, "output")) throw Object.assign(new Error("stat refused"), { code: "EIO" })
      return Fs.lstat(...args)
    }
  } as typeof Fs
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "output", contents: "new" })).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(error.message).toBe("stat refused")
  expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
})

it("refuses a temporary file that acquired a second name before publication", async () => {
  const io: typeof Fs = {
    ...Fs,
    open: async (...args) => {
      const handle = await Fs.open(...args)
      await Fs.link(String(args[0]), String(args[0]) + ".alias")
      return handle
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "output", contents: "new" })).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(error.message).toContain("private workspace file")
  expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
})

it("rechecks the publication parent after writing the temporary file", async () => {
  const io: typeof Fs = {
    ...Fs,
    realpath: async (...args) => args[0] === root ? tmpdir() : Fs.realpath(String(args[0]))
  } as typeof Fs
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "output", contents: "new" })).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(error.message).toContain("parent changed")
  expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
  expect(await Fs.readdir(root)).toEqual(["output"])
})

it("accepts a parent created by a competing publisher", async () => {
  const io: typeof Fs = {
    ...Fs,
    mkdir: async (...args) => {
      await Fs.mkdir(String(args[0]))
      throw Object.assign(new Error("created by peer"), { code: "EEXIST" })
    }
  } as typeof Fs
  await Effect.runPromise(
    writeGeneratedFile(root, { path: "nested/value", contents: "complete" }).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect(await Fs.readFile(join(root, "nested/value"), "utf8")).toBe("complete")
})

it("keeps the prior output when a host write rejects with undefined", async () => {
  const io: typeof Fs = {
    ...Fs,
    open: async (...args) => {
      const handle = await Fs.open(...args)
      return Object.assign(Object.create(handle), {
        stat: handle.stat.bind(handle),
        chmod: handle.chmod.bind(handle),
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
        writeFile: async (data: string, encoding: BufferEncoding) => {
          await handle.writeFile(data.slice(0, 1), encoding)
          throw undefined
        }
      })
    }
  }
  const exit = await Effect.runPromiseExit(
    writeGeneratedFile(root, { path: "output", contents: "replacement" }).pipe(
      Effect.provideService(PublicationFileSystem, io)
    )
  )
  expect({ failed: Exit.isFailure(exit), contents: await Fs.readFile(join(root, "output"), "utf8") }).toEqual({
    failed: true,
    contents: "original"
  })
})

it.each(
  [
    "root-file",
    "parent-stat",
    "parent-file",
    "resolved-parent-file",
    "temp-outside",
    "parent-outside",
    "temp-open"
  ] as const
)(
  "refuses unsafe filesystem state during publication: %s",
  async (fault) => {
    await Fs.mkdir(join(root, "parent"))
    let parentReads = 0
    const io: typeof Fs = {
      ...Fs,
      lstat: async (...args) => {
        if (fault === "root-file" && args[0] === root) return Fs.lstat(join(root, "output"), args[1] as never)
        if (args[0] === join(root, "parent")) {
          parentReads++
          if (fault === "parent-stat") throw new Error("parent stat refused")
          if (fault === "parent-file" || fault === "resolved-parent-file" && parentReads > 1) {
            return Fs.lstat(join(root, "output"), args[1] as never)
          }
        }
        return Fs.lstat(...args)
      },
      realpath: async (...args) =>
        (fault === "temp-outside" && String(args[0]).endsWith(".tmp") ||
            fault === "parent-outside" && args[0] === join(root, "parent"))
          ? tmpdir()
          : Fs.realpath(String(args[0])),
      open: async (...args) => {
        if (fault === "temp-open") throw new Error("temporary open refused")
        return Fs.open(...args)
      }
    } as typeof Fs
    const error = await Effect.runPromise(
      Effect.flip(writeGeneratedFile(root, { path: "parent/value", contents: "new" }))
        .pipe(Effect.provideService(PublicationFileSystem, io))
    )
    expect(error.message).toMatch(
      /root is not|stat refused|not a directory|parent changed|private workspace|leaves the workspace|open refused/
    )
    expect(await Fs.readdir(join(root, "parent"))).toEqual([])
    expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
  }
)

it.each(["close", "rename"] as const)("fails safely when %s rejects with undefined", async (fault) => {
  const io: typeof Fs = {
    ...Fs,
    open: async (...args) => {
      const handle = await Fs.open(...args)
      return Object.assign(Object.create(handle), {
        stat: handle.stat.bind(handle),
        chmod: handle.chmod.bind(handle),
        writeFile: handle.writeFile.bind(handle),
        sync: handle.sync.bind(handle),
        close: async () => {
          await handle.close()
          if (fault === "close") throw undefined
        }
      })
    },
    rename: async (...args) => {
      if (fault === "rename") throw undefined
      return Fs.rename(...args)
    }
  }
  const error = await Effect.runPromise(
    Effect.flip(writeGeneratedFile(root, { path: "output", contents: "new" }))
      .pipe(Effect.provideService(PublicationFileSystem, io))
  )
  expect(error.message).toBe("unknown failure")
  expect(await Fs.readFile(join(root, "output"), "utf8")).toBe("original")
  expect(await Fs.readdir(root)).toEqual(["output"])
})
