/**
 * How the implementation fingerprint walks a source tree.
 *
 * The walk refuses trees past its work limits, skips dependency and build
 * directories, treats a missing or non-directory root as absent, and fails
 * rather than fingerprinting a tree that changed between listing and reading.
 */
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fingerprintSources } from "../src/Planner.ts"

const temporaries: Array<string> = []

const scratch = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-planner-walk-"))
  temporaries.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await Fs.rm(directory, { recursive: true, force: true })
  }
})

/**
 * A real cancellation signal that changes the tree at one named step.
 *
 * Every walk and read step polls `signal.throwIfAborted()` before it touches
 * the filesystem. This signal never aborts; the first time it is polled from a
 * call stack whose frames match every pattern in `at`, it runs `change` once. That reproduces a tree
 * edited between two specific steps on every host, without racing a timer.
 */
const changeAt = (at: ReadonlyArray<RegExp>, change: () => void): AbortSignal => {
  const signal = new AbortController().signal
  let changed = false
  Object.defineProperty(signal, "throwIfAborted", {
    value: () => {
      const stack = new Error().stack ?? ""
      if (changed || !at.every((frame) => frame.test(stack))) return
      changed = true
      change()
    }
  })
  return signal
}

const nest = async (directory: string, depth: number): Promise<string> => {
  const deepest = NodePath.join(directory, ...Array.from({ length: depth }, () => "d"))
  await Fs.mkdir(deepest, { recursive: true })
  return deepest
}

describe("fingerprintSources root resolution", () => {
  it("treats a root that names a regular file as an absent tree", async () => {
    const directory = await scratch()
    const file = NodePath.join(directory, "index.ts")
    await Fs.writeFile(file, "export const value = 1\n", "utf8")
    const absent = await fingerprintSources([{ name: "x", directory: NodePath.join(directory, "missing") }])
    expect(await fingerprintSources([{ name: "x", directory: file }])).toBe(absent)
  })

  it("treats a root below a regular file as an absent tree", async () => {
    const directory = await scratch()
    const file = NodePath.join(directory, "index.ts")
    await Fs.writeFile(file, "export const value = 1\n", "utf8")
    const absent = await fingerprintSources([{ name: "x", directory: NodePath.join(directory, "missing") }])
    expect(await fingerprintSources([{ name: "x", directory: NodePath.join(file, "src") }])).toBe(absent)
  })

  it.skipIf(process.platform === "win32")("reports a root that cannot be resolved for another reason", async () => {
    const directory = await scratch()
    const loop = NodePath.join(directory, "loop")
    await Fs.symlink(loop, loop)
    await expect(fingerprintSources([{ name: "x", directory: loop }])).rejects.toMatchObject({ code: "ELOOP" })
  })
})

describe("fingerprintSources tree contents", () => {
  it("ignores node_modules, dist, and .git directories", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(directory, "index.ts"), "export const value = 1\n", "utf8")
    const before = await fingerprintSources([{ name: "x", directory }])
    for (const skipped of ["node_modules", "dist", ".git"]) {
      await Fs.mkdir(NodePath.join(directory, skipped, "nested"), { recursive: true })
      await Fs.writeFile(NodePath.join(directory, skipped, "nested", "index.ts"), "export const x = 2\n", "utf8")
    }
    expect(await fingerprintSources([{ name: "x", directory }])).toBe(before)
    await Fs.mkdir(NodePath.join(directory, "lib"))
    await Fs.writeFile(NodePath.join(directory, "lib", "index.ts"), "export const x = 2\n", "utf8")
    expect(await fingerprintSources([{ name: "x", directory }])).not.toBe(before)
  })

  it("walks a tree exactly at its maximum depth", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(await nest(directory, 128), "deep.ts"), "export const deep = 1\n", "utf8")
    const fingerprint = await fingerprintSources([{ name: "x", directory }])
    expect(fingerprint).not.toBe(await fingerprintSources([{ name: "x", directory: await scratch() }]))
  })

  it("refuses a tree one directory deeper than its maximum depth", async () => {
    const directory = await scratch()
    await nest(directory, 129)
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow("implementation source tree exceeds its maximum depth of 128")
  })
})

describe("fingerprintSources work limits", () => {
  it("refuses a tree with more than 100000 source files before reading any of them", async () => {
    const directory = await scratch()
    // Two directories, because one directory listing is itself capped at 100000 entries.
    for (const [half, count] of [["a", 50_001], ["b", 50_000]] as const) {
      const parent = NodePath.join(directory, half)
      NodeFs.mkdirSync(parent)
      for (let index = 0; index < count; index += 1) NodeFs.writeFileSync(NodePath.join(parent, `${index}.ts`), "")
    }
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow("implementation source tree contains more than 100000 source files")
  })

  it("refuses a tree with more than 50000 directories", async () => {
    const directory = await scratch()
    // The root is the first directory, so 50000 children make 50001.
    for (let index = 0; index < 50_000; index += 1) NodeFs.mkdirSync(NodePath.join(directory, `d${index}`))
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow("implementation source tree contains more than 50000 directories")
  })
})

describe("fingerprintSources refuses a tree that changes while it is walked", () => {
  it("refuses a source directory removed after its parent was listed", async () => {
    const directory = await scratch()
    const nested = NodePath.join(directory, "lib")
    await Fs.mkdir(nested)
    await Fs.writeFile(NodePath.join(nested, "index.ts"), "export const value = 1\n", "utf8")
    // `visit` resolves each child directory after listing its parent.
    const signal = changeAt(
      [/at (?:\S+\.)?resolveDirectory /, /at (?:async )?visit /],
      () => NodeFs.rmSync(nested, { recursive: true })
    )
    await expect(fingerprintSources([{ name: "x", directory }], { signal }))
      .rejects.toThrow(/^implementation source directory changed while it was being fingerprinted: .*[/\\]lib$/)
  })

  it("refuses a source file removed after the walk listed it", async () => {
    const directory = await scratch()
    const source = NodePath.join(directory, "index.ts")
    await Fs.writeFile(source, "export const value = 1\n", "utf8")
    // `inspectSource` measures each listed file once the whole walk is done.
    const signal = changeAt([/at (?:async )?inspectSource /], () => NodeFs.unlinkSync(source))
    await expect(fingerprintSources([{ name: "x", directory }], { signal }))
      .rejects.toThrow(/^implementation source file changed while it was being fingerprinted: .*[/\\]index\.ts$/)
  })

  it("fingerprints the same tree normally when nothing changes", async () => {
    const directory = await scratch()
    await Fs.mkdir(NodePath.join(directory, "lib"))
    await Fs.writeFile(NodePath.join(directory, "lib", "index.ts"), "export const value = 1\n", "utf8")
    const signal = changeAt([/at (?:async )?never-a-frame /], () => undefined)
    expect(await fingerprintSources([{ name: "x", directory }], { signal }))
      .toBe(await fingerprintSources([{ name: "x", directory }]))
  })
})
