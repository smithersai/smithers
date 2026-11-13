import { Effect } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import * as Watch from "../src/Watch.ts"

const roots: Array<string> = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // A tree deeper than PATH_MAX is removed by rm, which walks it relative to each directory.
    await Fs.chmod(join(root, "locked"), 0o755).catch(() => undefined)
    await promisify(execFile)("rm", ["-rf", root])
  }
})

const temporaryRoot = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "smithers-watch-digest-")))
  roots.push(root)
  return root
}

const everything = () => true
const digest = (root: string, relevant: (path: string) => boolean = everything) =>
  Effect.runPromise(Watch.makeServices().digest(root, relevant))

describe("the workspace digest", () => {
  it("is stable for an unchanged tree and changes when a relevant file changes", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(join(root, "src"))
    await Fs.mkdir(join(root, "ignored"))
    for (const letter of "cab") await Fs.writeFile(join(root, "src", `${letter}.txt`), letter)
    await Fs.writeFile(join(root, "ignored/cache.bin"), "one")
    const relevant = (path: string) => path !== "ignored" && !path.startsWith("ignored/")
    const first = await digest(root, relevant)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await digest(root, relevant)).toBe(first)
    await Fs.writeFile(join(root, "ignored/cache.bin"), "a longer ignored body")
    expect(await digest(root, relevant)).toBe(first)
    await Fs.writeFile(join(root, "src/b.txt"), "a longer relevant body")
    expect(await digest(root, relevant)).not.toBe(first)
  })

  it("orders paths by UTF-16 code unit, not by the listing's byte order", async () => {
    const root = await temporaryRoot()
    // UTF-8 bytes list U+FF61 first; UTF-16 puts the astral character's high surrogate first.
    const halfwidth = "\uFF61"
    const astral = "\u{1F600}"
    for (const name of [halfwidth, astral]) await Fs.writeFile(join(root, name), name)
    expect(await Fs.readdir(root)).toEqual([halfwidth, astral])
    const expected = createHash("sha256")
    for (const name of [astral, halfwidth]) {
      const stat = await Fs.lstat(join(root, name), { bigint: true })
      expected.update(`${name}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ino}\n`)
    }
    expect(await digest(root)).toBe(expected.digest("hex"))
  })

  it("digests a missing root like an empty tree", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(join(root, "empty"))
    expect(await digest(join(root, "missing"))).toBe(await digest(join(root, "empty")))
  })

  it("skips entries inside a directory it can list but not search", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(join(root, "locked"))
    await Fs.writeFile(join(root, "locked/secret.txt"), "one")
    const searchable = await digest(root)
    await Fs.chmod(join(root, "locked"), 0o644)
    const listed = await digest(root)
    expect(listed).not.toBe(searchable)
    // The child is invisible while unsearchable: its edits do not move the digest.
    await Fs.chmod(join(root, "locked"), 0o755)
    await Fs.writeFile(join(root, "locked/secret.txt"), "a longer secret body")
    await Fs.chmod(join(root, "locked"), 0o644)
    expect(await digest(root)).toBe(listed)
  })

  it("refuses a tree whose paths exceed the host path limit", async () => {
    const root = await temporaryRoot()
    // Build a short chain, then lengthen it from the bottom so every path named here stays short.
    const depth = 25
    const short = (levels: number) => join(root, ...Array.from({ length: levels }, () => "d"))
    await Fs.mkdir(short(depth), { recursive: true })
    for (let level = depth; level > 0; level--) await Fs.rename(short(level), join(short(level - 1), "d".repeat(200)))
    await expect(digest(root)).rejects.toMatchObject({ code: "ENAMETOOLONG" })
  })
})

describe("the filesystem notifier", () => {
  it("fails with the platform error when the watched root cannot be named", async () => {
    const exit = await Effect.runPromiseExit(Watch.makeServices().notifier("/tmp/nul\0root", () => {}, () => {}))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const error = exit.cause.reasons[0]
      expect(error?._tag).toBe("Fail")
      expect(error?._tag === "Fail" ? error.error : undefined).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" })
    }
  })
})

describe("rescans", () => {
  /** Fake services: a notifier the test drives, a counted digest and a process that runs until interrupted. */
  const services = (scan: (call: number) => Effect.Effect<string, unknown>) => {
    const state = {
      digests: 0,
      launched: 0,
      changed: (_filename: string | null) => {},
      closing: () => {},
      services: undefined as unknown as Watch.Services["Service"]
    }
    state.services = {
      notifier: (_root, changed) =>
        Effect.sync(() => {
          state.changed = changed
          // A nameless notification while registering arrives before any cycle recorded a digest.
          changed(null)
          return () => state.closing()
        }),
      digest: () => Effect.suspend(() => scan(++state.digests)),
      processRunner: () =>
        Effect.suspend(() => {
          state.launched += 1
          return Effect.never
        })
    }
    return state
  }
  const until = async (ready: () => boolean) => {
    while (!ready()) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it("starts no scan for a nameless notification before the first cycle's digest", async () => {
    const state = services(() => Effect.succeed("tree"))
    const controller = new AbortController()
    const running = Watch.run({
      services: state.services,
      root: "/workspace",
      args: ["build"],
      ignored: [],
      signal: controller.signal,
      debounceMs: 1,
      rescanMs: 3_600_000,
      once: false,
      stdout: () => {},
      stderr: () => {}
    })
    await until(() => state.launched === 1)
    controller.abort()
    expect(await running).toEqual({ cycles: 1, exitCode: 1, stopped: true })
    // Only the cycle's own baseline digest ran.
    expect(state.digests).toBe(1)
  })

  it("drops a rescan failure that settles after the watch stopped", async () => {
    const state = services((call) =>
      call === 1
        ? Effect.succeed("tree")
        // The rescan fails while the notifier is being closed.
        : Effect.callback<string, unknown>((resume) => {
          state.closing = () => resume(Effect.fail("rescan failed"))
        })
    )
    const controller = new AbortController()
    const running = Watch.run({
      services: state.services,
      root: "/workspace",
      args: ["build"],
      ignored: [],
      signal: controller.signal,
      debounceMs: 1,
      rescanMs: 3_600_000,
      once: false,
      stdout: () => {},
      stderr: () => {}
    })
    await until(() => state.launched === 1)
    state.changed(null)
    await until(() => state.digests === 2)
    // A nameless notification during a scan queues one more scan, which never starts after close.
    state.changed(null)
    controller.abort()
    expect(await running).toEqual({ cycles: 1, exitCode: 1, stopped: true })
    expect(state.digests).toBe(2)
  })
})
