/**
 * The standard file flows on a Linux guest, counted in round trips.
 *
 * Every `FileSystem` call a Linux session serves is one script through its
 * transport, and a transport to a remote sandbox costs seconds per call, so
 * the number of calls a flow makes is its latency. These cases run the
 * unchanged `@smthrs/std` handlers over `ContainerSandbox.existing` and count
 * what reaches the transport.
 *
 * Two variants. The real one runs every script with this host's `sh` in a
 * temporary directory, the way a container would, and proves behavior as well
 * as counts; it needs GNU or BusyBox `stat -c`, so it is skipped on a host
 * with BSD `stat`. The recording one answers each script from a small
 * in-memory guest, runs everywhere, and pins the counts and that file content
 * travels on standard input, never in a command line.
 */
import { describe, expect, it } from "@effect/vitest"
import { ApplyPatch, Edit, Ls, Read, Write } from "@smthrs/std"
import { Context, Effect, Fiber, FileSystem, Path, Result, Stream } from "effect"
import * as Base64 from "effect/encoding/Base64"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import { Batched } from "../src/internal/linuxBatch.ts"
import { linuxFileSystem } from "../src/internal/linuxFileSystem.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import { rawPlatform } from "./helpers/containedPlatform.ts"

/** `stat -c` is GNU and BusyBox; the real variant runs where the guest scripts would. */
const linuxUserland = spawnSync("sh", ["-c", "stat -c %s . && mv -T --version"], { stdio: "ignore" }).status === 0

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-batched-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** One flow call and the scripts it sent, in order. */
interface Counted<A> {
  readonly result: A
  readonly scripts: ReadonlyArray<string>
}

/**
 * A transport that runs each request here, in its `cwd`, and records the
 * script; `before` runs ahead of the call with that index, as an outside
 * writer racing the flow would. `env` is set for the guest's script, as a
 * guest whose `PATH` holds other utilities would have it.
 */
const counting = (
  scripts: Array<string>,
  before?: Record<number, () => void>,
  env: ReadonlyArray<string> = []
): ContainerSandbox.Transport => ({
  exec: (request) =>
    Effect.sync(() => {
      before?.[scripts.length]?.()
      scripts.push(request.args.at(-1)!)
      return {
        file: "/bin/sh",
        args: [
          "-c",
          "cd \"$1\" || exit 125; shift; exec \"$@\"",
          "sh",
          request.cwd ?? root,
          ...env.length === 0 ? [] : ["env", ...env],
          request.file,
          ...request.args
        ]
      }
    })
})

/**
 * Runs `flow` with the std services of a real session rooted at `workdir`.
 * `ordinary` hands the flow a copy of the filesystem, which carries no
 * batched calls, so it takes the ordinary path over the same guest.
 */
const real = <A, E>(
  workdir: string,
  flow: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  before?: Record<number, () => void>,
  options: { readonly env?: ReadonlyArray<string>; readonly ordinary?: boolean } = {}
) =>
  Effect.gen(function*() {
    const scripts: Array<string> = []
    const spawner = yield* ChildProcessSpawner
    const session = ContainerSandbox.existing({
      container: "task",
      workdir,
      spawner,
      transport: counting(scripts, before, options.env)
    })
    const host = Context.pick(FileSystem.FileSystem, Path.Path)(yield* Sandbox.hostContext(session))
    const services = options.ordinary === true
      ? Context.add(host, FileSystem.FileSystem, { ...Context.get(host, FileSystem.FileSystem) })
      : host
    const result = yield* Effect.result(Effect.provide(flow, services))
    return { result, scripts } satisfies Counted<unknown>
  }).pipe(Effect.scoped, Effect.provide(rawPlatform))

/**
 * A directory of utilities that shadow the guest's own: `head` waits for
 * `gate` to exist, after touching `started`, so a commit stops part way
 * while it holds its locks; `chown` refuses as an unprivileged user's does,
 * with `words` as its message.
 */
const shims = (name: string, words = "Operation not permitted") => {
  const directory = join(root, `${name}-bin`)
  const gate = join(directory, "gate")
  const started = join(directory, "started")
  mkdirSync(directory)
  const head = spawnSync("sh", ["-c", "command -v head"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(
    join(directory, "head"),
    `#!/bin/sh\n: > '${started}'\nwhile [ ! -e '${gate}' ]; do sleep 0.02; done\nexec '${head}' "$@"\n`
  )
  writeFileSync(
    join(directory, "chown"),
    `#!/bin/sh\nprintf 'chown: changing ownership of %s: ${words}\\n' "$3" >&2\nexit 1\n`
  )
  chmodSync(join(directory, "head"), 0o755)
  chmodSync(join(directory, "chown"), 0o755)
  return { env: [`PATH=${directory}:${process.env["PATH"]}`], gate, started }
}

/** Waits, in real time, until `ready` holds. */
const until = (ready: () => boolean) =>
  Effect.promise(async () => {
    for (let tries = 0; !ready(); tries++) {
      if (tries === 500) throw new Error("timed out waiting for the guest")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })

/** The `.smithers-` entries left in `directory`. */
const leftovers = (directory: string) => readdirSync(directory).filter((name) => name.startsWith(".smithers-"))

/** A group this process may give a file that its new files do not get, if there is one. */
const foreignGroup = (() => {
  if (process.getuid?.() === 0) return 4242
  const primary = process.getgid?.()
  return spawnSync("id", ["-G"], { encoding: "utf8" }).stdout.trim().split(/\s+/).map(Number).find((gid) =>
    gid !== primary
  )
})()

/** A fresh guest tree under `name`. */
const tree = (name: string): string => {
  const workdir = join(root, name)
  mkdirSync(join(workdir, "src"), { recursive: true })
  writeFileSync(join(workdir, "src", "a.py"), "alpha = 1\nbeta = 2\n")
  writeFileSync(join(workdir, "src", "run.sh"), "echo one\n")
  chmodSync(join(workdir, "src", "run.sh"), 0o754)
  writeFileSync(join(workdir, "src", "move.py"), "moving\n")
  chmodSync(join(workdir, "src", "move.py"), 0o600)
  writeFileSync(join(workdir, "src", "gone.py"), "gone\n")
  return workdir
}

const patch = [
  "*** Begin Patch",
  "*** Add File: lib/deep/added.py",
  "+added = \"ü\"",
  "*** Update File: src/a.py",
  "@@",
  "-beta = 2",
  "+beta = 3",
  "*** Update File: src/move.py",
  "*** Move to: lib/moved.py",
  "@@",
  "-moving",
  "+moved",
  "*** Delete File: src/gone.py",
  "*** End Patch"
].join("\n")

describe.skipIf(!linuxUserland)("the std file flows on a real Linux userland", () => {
  it.effect("read is one round trip, edit two, and edit replaces the file with its mode", () =>
    Effect.gen(function*() {
      const workdir = tree("edit")
      const before = statSync(join(workdir, "src", "run.sh"))
      const read = yield* real(workdir, Read.run({ path: "src/a.py" }))
      expect(read.result).toMatchObject({ _tag: "Success", success: { content: "alpha = 1\nbeta = 2", totalLines: 2 } })
      expect(read.scripts).toHaveLength(1)
      const edit = yield* real(workdir, Edit.run({ path: "src/run.sh", oldString: "one", newString: "two" }))
      expect(edit.result).toMatchObject({ _tag: "Success", success: { replacements: 1 } })
      expect(edit.scripts).toHaveLength(2)
      expect(readFileSync(join(workdir, "src", "run.sh"), "utf8")).toBe("echo two\n")
      const after = statSync(join(workdir, "src", "run.sh"))
      expect(after.mode & 0o7777).toBe(0o754)
      // A new inode: the bytes were renamed into place, never truncated and rewritten.
      expect(after.ino).not.toBe(before.ino)
      expect(readdirSync(join(workdir, "src")).filter((name) => name.startsWith(".smithers-"))).toEqual([])
    }))

  it.effect("edit through a symbolic link replaces the file it names and keeps the link", () =>
    Effect.gen(function*() {
      const workdir = tree("link")
      symlinkSync("a.py", join(workdir, "src", "alias.py"))
      const edit = yield* real(workdir, Edit.run({ path: "src/alias.py", oldString: "alpha", newString: "omega" }))
      expect(edit.result._tag).toBe("Success")
      expect(lstatSync(join(workdir, "src", "alias.py")).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(workdir, "src", "a.py"), "utf8")).toBe("omega = 1\nbeta = 2\n")
    }))

  it.effect("write is two round trips, creates parents, and gives a new file the umask's mode", () =>
    Effect.gen(function*() {
      const workdir = tree("write")
      const made = yield* real(workdir, Write.run({ path: "new/deeper/made.txt", content: "fait à la main\n" }))
      expect(made.result).toMatchObject({ _tag: "Success", success: { created: true } })
      expect(made.scripts).toHaveLength(2)
      expect(readFileSync(join(workdir, "new", "deeper", "made.txt"), "utf8")).toBe("fait à la main\n")
      const mask = Number.parseInt(spawnSync("sh", ["-c", "umask"], { encoding: "utf8" }).stdout.trim(), 8)
      expect(statSync(join(workdir, "new", "deeper", "made.txt")).mode & 0o7777).toBe(0o666 & ~mask)
      const replaced = yield* real(workdir, Write.run({ path: "src/run.sh", content: "echo three\n" }))
      expect(replaced.result).toMatchObject({ _tag: "Success", success: { created: false } })
      expect(replaced.scripts).toHaveLength(2)
      expect(statSync(join(workdir, "src", "run.sh")).mode & 0o7777).toBe(0o754)
    }))

  it.effect("apply_patch is two round trips for any number of files and commits them all", () =>
    Effect.gen(function*() {
      const workdir = tree("patch")
      const patched = yield* real(workdir, ApplyPatch.run({ input: patch }))
      expect(patched.result).toMatchObject({
        _tag: "Success",
        success: { added: ["lib/deep/added.py"], modified: ["src/a.py", "lib/moved.py"], deleted: ["src/gone.py"] }
      })
      expect(patched.scripts).toHaveLength(2)
      expect(readFileSync(join(workdir, "lib", "deep", "added.py"), "utf8")).toBe("added = \"ü\"\n")
      expect(readFileSync(join(workdir, "src", "a.py"), "utf8")).toBe("alpha = 1\nbeta = 3\n")
      expect(readFileSync(join(workdir, "lib", "moved.py"), "utf8")).toBe("moved\n")
      // A moved file keeps its source's mode.
      expect(statSync(join(workdir, "lib", "moved.py")).mode & 0o7777).toBe(0o600)
      expect(readdirSync(join(workdir, "src")).sort()).toEqual(["a.py", "run.sh"])
    }))

  it.effect("commits every file of a patch on a guest whose head reads past the bytes it keeps", () =>
    Effect.gen(function*() {
      const workdir = tree("greedy-head")
      // BusyBox's `head -c` buffers its input: what it read and did not keep is gone for the next reader.
      const directory = join(root, "greedy-head-bin")
      mkdirSync(directory)
      const head = spawnSync("sh", ["-c", "command -v head"], { encoding: "utf8" }).stdout.trim()
      writeFileSync(join(directory, "head"), `#!/bin/sh\ncat | '${head}' "$@"\n`)
      chmodSync(join(directory, "head"), 0o755)
      const env = [`PATH=${directory}:${process.env["PATH"]}`]
      const patched = yield* real(workdir, ApplyPatch.run({ input: patch }), undefined, { env })
      expect(patched.result).toMatchObject({
        _tag: "Success",
        success: { added: ["lib/deep/added.py"], modified: ["src/a.py", "lib/moved.py"], deleted: ["src/gone.py"] }
      })
      expect(readFileSync(join(workdir, "lib", "deep", "added.py"), "utf8")).toBe("added = \"ü\"\n")
      expect(readFileSync(join(workdir, "src", "a.py"), "utf8")).toBe("alpha = 1\nbeta = 3\n")
      expect(readFileSync(join(workdir, "lib", "moved.py"), "utf8")).toBe("moved\n")
      // The spooled input is removed with the staged files.
      for (const folder of ["src", "lib", join("lib", "deep")]) {
        expect(readdirSync(join(workdir, folder)).filter((name) => name.startsWith(".smithers-"))).toEqual([])
      }
      // One write still reads standard input directly, and survives the same guest.
      const written = yield* real(workdir, Write.run({ path: "src/one.txt", content: "seul\n" }), undefined, { env })
      expect(written.result).toMatchObject({ _tag: "Success", success: { created: true } })
      expect(readFileSync(join(workdir, "src", "one.txt"), "utf8")).toBe("seul\n")
    }))

  it.effect("ls is one round trip and follows links to directories", () =>
    Effect.gen(function*() {
      const workdir = tree("ls")
      symlinkSync("src", join(workdir, "linked"))
      symlinkSync("nowhere", join(workdir, "dangling"))
      writeFileSync(join(workdir, "top.txt"), "top\n")
      const listed = yield* real(workdir, Ls.run({ path: "." }))
      expect(listed.result).toMatchObject({
        _tag: "Success",
        success: {
          entries: [
            { name: "linked/", kind: "directory" },
            { name: "src/", kind: "directory" },
            { name: "dangling", kind: "file" },
            { name: "top.txt", kind: "file" }
          ]
        }
      })
      expect(listed.scripts).toHaveLength(1)
    }))

  it.effect("refuses an edit whose file changed between its two round trips and leaves the other write", () =>
    Effect.gen(function*() {
      const workdir = tree("race-edit")
      const target = join(workdir, "src", "a.py")
      const raced = yield* real(workdir, Edit.run({ path: "src/a.py", oldString: "beta", newString: "gamma" }), {
        // Same size, same second: only the inode or the checksum can tell.
        1: () => writeFileSync(target, "alpha = 1\nbeta = 9\n")
      })
      expect(raced.result).toMatchObject({ _tag: "Failure", failure: { code: "no_match", path: "src/a.py" } })
      expect(readFileSync(target, "utf8")).toBe("alpha = 1\nbeta = 9\n")
      expect(readdirSync(join(workdir, "src")).filter((name) => name.startsWith(".smithers-"))).toEqual([])
    }))

  it.effect("refuses a whole patch when one of its files changed, creating and changing nothing", () =>
    Effect.gen(function*() {
      const workdir = tree("race-patch")
      const raced = yield* real(workdir, ApplyPatch.run({ input: patch }), {
        1: () => writeFileSync(join(workdir, "src", "gone.py"), "still here\n")
      })
      expect(raced.result).toMatchObject({ _tag: "Failure", failure: { code: "no_match", path: "src/gone.py" } })
      expect(readdirSync(workdir).sort()).toEqual(["src"])
      expect(readdirSync(join(workdir, "src")).sort()).toEqual(["a.py", "gone.py", "move.py", "run.sh"])
      expect(readFileSync(join(workdir, "src", "a.py"), "utf8")).toBe("alpha = 1\nbeta = 2\n")
    }))

  it.effect("refuses what the portable flows refuse, with the same codes", () =>
    Effect.gen(function*() {
      const workdir = tree("refusals")
      symlinkSync("nowhere.py", join(workdir, "src", "dangling.py"))
      const outcomes = yield* Effect.forEach(
        [
          Edit.run({ path: "src/absent.py", oldString: "a", newString: "b" }),
          Write.run({ path: "src", content: "x" }),
          Write.run({ path: "src/dangling.py", content: "x" }),
          Write.run({ path: "src/a.py/inside.txt", content: "x" }),
          Read.run({ path: "src" }),
          Read.run({ path: "src/absent.py" }),
          Ls.run({ path: "src/a.py" }),
          Ls.run({ path: "absent" }),
          ApplyPatch.run({
            input: "*** Begin Patch\n*** Add File: lib/x.py\n+x\n*** Delete File: src/absent.py\n*** End Patch"
          })
        ] as ReadonlyArray<Effect.Effect<unknown, { readonly code: string }, FileSystem.FileSystem | Path.Path>>,
        (flow) =>
          Effect.map(real(workdir, flow), ({ result }) => result._tag === "Failure" ? result.failure.code : "success")
      )
      expect(outcomes).toEqual([
        "not_found",
        "command_failed",
        "command_failed",
        "command_failed",
        "is_directory",
        "not_found",
        "not_a_directory",
        "not_found",
        "not_found"
      ])
      // The refused patch added nothing, and the dangling link still dangles.
      expect(readdirSync(workdir)).toEqual(["src"])
      expect(lstatSync(join(workdir, "src", "dangling.py")).isSymbolicLink()).toBe(true)
    }))

  it.effect("moves any bytes, at any size, through standard input and base64", () =>
    Effect.gen(function*() {
      const workdir = tree("bytes")
      const bytes = new Uint8Array(1024 * 1024 + 7).map((_, index) => (index * 7) % 256)
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const scripts: Array<string> = []
        const session = ContainerSandbox.existing({ container: "task", workdir, spawner, transport: counting(scripts) })
        // Typed by std's contract, so the two packages cannot drift apart unnoticed.
        const files: NonNullable<Read.BatchedFileSystem[typeof Read.Batched]> =
          linuxFileSystem(session, "container")[Batched]
        const [absent] = yield* files.snapshot(["bin/blob"])
        // `bin` is missing too, and stat says so: the path is absent, not unreadable.
        expect(Result.isFailure(absent!.info) && absent!.info.failure.reason._tag).toBe("NotFound")
        const committed = yield* files.commit([{ path: "bin/blob", content: bytes, version: absent!.version }])
        const [written] = yield* files.snapshot(["bin/blob"], { read: ["bin/blob"] })
        return { committed, written, scripts }
      }).pipe(Effect.provide(rawPlatform))
      expect(outcome.committed).toEqual({ applied: 1 })
      expect(outcome.written!.content).toMatchObject({ _tag: "Success", success: bytes })
      expect(readFileSync(join(workdir, "bin", "blob"))).toEqual(Buffer.from(bytes))
      expect(outcome.scripts.every((script) => script.length < 8192)).toBe(true)
    }))

  it.live("lands exactly one of two concurrent edits and refuses the other as stale", () =>
    Effect.gen(function*() {
      for (let round = 0; round < 12; round++) {
        const workdir = tree(`race-two-${round}`)
        const target = join(workdir, "src", "a.py")
        const outcomes = yield* Effect.all(
          ["left", "right"].map((side) =>
            Effect.map(
              real(workdir, Edit.run({ path: "src/a.py", oldString: "beta = 2", newString: `beta = "${side}"` })),
              ({ result }) => ({ side, result })
            )
          ),
          { concurrency: "unbounded" }
        )
        const won = outcomes.filter(({ result }) => result._tag === "Success")
        const lost = outcomes.filter(({ result }) => result._tag === "Failure")
        expect(won).toHaveLength(1)
        expect(lost[0]!.result).toMatchObject({ _tag: "Failure", failure: { code: "no_match", path: "src/a.py" } })
        expect(readFileSync(target, "utf8")).toBe(`alpha = 1\nbeta = "${won[0]!.side}"\n`)
        expect(leftovers(join(workdir, "src"))).toEqual([])
      }
    }))

  it.live("holds the ordinary path's lock while it commits, so either path refuses the other", () =>
    Effect.gen(function*() {
      const workdir = tree("lock")
      const target = join(workdir, "src", "a.py")
      const { env, gate, started } = shims("lock")
      // The batched edit stops while staging, holding the file's lock.
      const holder = yield* Effect.forkChild(
        real(workdir, Edit.run({ path: "src/a.py", oldString: "beta = 2", newString: "beta = 3" }), undefined, { env })
      )
      yield* until(() => existsSync(started))
      const [lock] = leftovers(join(workdir, "src")).filter((name) => name.endsWith(".lock"))
      expect(lock).toBeDefined()
      const edit = Edit.run({ path: "src/a.py", oldString: "alpha", newString: "omega" })
      for (const ordinary of [true, false]) {
        const refused = yield* real(workdir, edit, undefined, { ordinary })
        expect(refused.result).toMatchObject({
          _tag: "Failure",
          failure: { code: "no_match", path: "src/a.py", message: expect.stringContaining(`${lock} is held`) }
        })
      }
      writeFileSync(gate, "")
      expect((yield* Fiber.join(holder)).result._tag).toBe("Success")
      expect(readFileSync(target, "utf8")).toBe("alpha = 1\nbeta = 3\n")
      expect(leftovers(join(workdir, "src"))).toEqual([])
      // A lock left by a stopped writer is never stolen: the edit refuses
      // until someone removes it, then lands.
      mkdirSync(join(workdir, "src", lock!))
      const stale = yield* real(workdir, edit)
      expect(stale.result).toMatchObject({ _tag: "Failure", failure: { code: "no_match" } })
      expect(existsSync(join(workdir, "src", lock!))).toBe(true)
      rmSync(join(workdir, "src", lock!), { recursive: true })
      expect((yield* real(workdir, edit)).result._tag).toBe("Success")
      expect(readFileSync(target, "utf8")).toBe("omega = 1\nbeta = 3\n")
    }))

  it.live("releases its locks and temporary files when the commit is killed part way", () =>
    Effect.gen(function*() {
      const workdir = tree("killed")
      const { env, gate, started } = shims("killed")
      const holder = yield* Effect.forkChild(
        real(workdir, Edit.run({ path: "src/a.py", oldString: "beta = 2", newString: "beta = 3" }), undefined, { env })
      )
      yield* until(() => existsSync(started))
      expect(leftovers(join(workdir, "src")).some((name) => name.endsWith(".lock"))).toBe(true)
      yield* Fiber.interrupt(holder)
      yield* until(() => leftovers(join(workdir, "src")).length === 0)
      expect(readFileSync(join(workdir, "src", "a.py"), "utf8")).toBe("alpha = 1\nbeta = 2\n")
      // Lets a `head` the kill did not reach finish.
      writeFileSync(gate, "")
    }))

  it.effect("keeps every byte of a path that ends in a newline", () =>
    Effect.gen(function*() {
      const workdir = tree("newline")
      writeFileSync(join(workdir, "src", "a"), "plain\n")
      writeFileSync(join(workdir, "src", "a\n"), "newline\n")
      mkdirSync(join(workdir, "src", "d"))
      const edit = yield* real(workdir, Edit.run({ path: "src/a\n", oldString: "newline", newString: "edited" }))
      expect(edit.result._tag).toBe("Success")
      expect(readFileSync(join(workdir, "src", "a\n"), "utf8")).toBe("edited\n")
      expect(readFileSync(join(workdir, "src", "a"), "utf8")).toBe("plain\n")
      const made = yield* real(workdir, Write.run({ path: "src/d\n/new.txt", content: "made\n" }))
      expect(made.result._tag).toBe("Success")
      expect(readFileSync(join(workdir, "src", "d\n", "new.txt"), "utf8")).toBe("made\n")
      expect(readdirSync(join(workdir, "src", "d"))).toEqual([])
      const taken = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const session = ContainerSandbox.existing({ container: "task", workdir, spawner, transport: counting([]) })
        return yield* linuxFileSystem(session, "container")[Batched].snapshot(["src/a\n", "src/e\n/f/g.txt"])
      }).pipe(Effect.provide(rawPlatform))
      expect(taken.map(({ canonical }) => canonical)).toEqual([
        join(workdir, "src", "a\n"),
        join(workdir, "src", "e\n", "f", "g.txt")
      ])
      // The ordinary probes look at the parent the path names, not its newline-less twin.
      writeFileSync(join(workdir, "src", "f"), "a file\n")
      const probed = yield* real(
        workdir,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            exists: yield* fs.exists("src/f\n/x"),
            made: yield* Effect.flip(fs.makeDirectory("src/d\n/x/y"))
          }
        })
      )
      expect(probed.result).toMatchObject({
        _tag: "Success",
        success: { exists: false, made: { reason: { _tag: "NotFound" } } }
      })
    }))

  it.effect.skipIf(foreignGroup === undefined)(
    "rewrites in place a file whose owner it cannot assign, as Preserve does",
    () =>
      Effect.gen(function*() {
        const workdir = tree("owner")
        const target = join(workdir, "src", "run.sh")
        chownSync(target, statSync(target).uid, foreignGroup!)
        chownSync(join(workdir, "src", "move.py"), statSync(target).uid, foreignGroup!)
        const before = statSync(target)
        const { env, gate } = shims("owner")
        writeFileSync(gate, "")
        const edit = yield* real(workdir, Edit.run({ path: "src/run.sh", oldString: "one", newString: "two" }), {}, {
          env
        })
        expect(edit.result._tag).toBe("Success")
        const after = statSync(target)
        expect(readFileSync(target, "utf8")).toBe("echo two\n")
        // The same inode, so the same owner and mode.
        expect([after.ino, after.gid, after.mode]).toEqual([before.ino, foreignGroup, before.mode])
        // A moved file whose owner cannot be given keeps its own, and takes the mode.
        const moved = yield* real(
          workdir,
          ApplyPatch.run({
            input:
              "*** Begin Patch\n*** Update File: src/move.py\n*** Move to: lib/moved.py\n@@\n-moving\n+moved\n*** End Patch"
          }),
          {},
          { env }
        )
        expect(moved.result._tag).toBe("Success")
        const landed = statSync(join(workdir, "lib", "moved.py"))
        expect([landed.mode & 0o7777, landed.gid === foreignGroup]).toEqual([0o600, false])
        expect(leftovers(join(workdir, "src"))).toEqual([])
        // The ordinary path over the same guest falls back the same way.
        const ordinary = yield* real(
          workdir,
          Edit.run({ path: "src/run.sh", oldString: "two", newString: "two!" }),
          {},
          { env, ordinary: true }
        )
        expect(ordinary.result._tag).toBe("Success")
        expect([statSync(target).ino, statSync(target).gid]).toEqual([before.ino, foreignGroup])
        // Any other ownership failure still stops the write.
        const broken = shims("owner-broken", "invalid group")
        writeFileSync(broken.gate, "")
        const refused = yield* real(
          workdir,
          Edit.run({ path: "src/run.sh", oldString: "two!", newString: "six" }),
          {},
          {
            env: broken.env
          }
        )
        expect(refused.result._tag).toBe("Failure")
        expect(readFileSync(target, "utf8")).toBe("echo two!\n")
      })
  )
})

describe.skipIf(linuxUserland)("the std file flows on a real Linux userland", () => {
  it("is skipped because this host's stat has no -c (BSD userland)", () => {
    expect(linuxUserland).toBe(false)
  })
})

/**
 * A recording guest: answers the batched scripts from an in-memory tree and
 * records each script and its standard input.
 */
const recording = (files: Record<string, string>) => {
  const sent: Array<{ readonly script: string; readonly stdin: Uint8Array | undefined }> = []
  const encoder = new TextEncoder()
  const answer = (script: string): string => {
    if (script.startsWith("d=")) return "/work/src\0\0/work/src\0"
    if (script.includes("\nk() {")) {
      return script.split("\n").filter((line) => line.endsWith("echo +")).map(() => "+\n").join("")
    }
    return script.split("\n").filter((line) => line.startsWith("q ")).map((line) => {
      const [, path, read] = line.split(" ")
      const content = files[path!]
      if (content === undefined) return `p/work\0a\0N\0-\0`
      const bytes = encoder.encode(content)
      return `e${path}\0f 1 2 ${bytes.length}\0S81a4 ${bytes.length}\0${
        read === "1" ? `B${Base64.encode(bytes)}` : "-"
      }\0`
    }).join("")
  }
  const session: Session = {
    id: "recorded",
    remoteId: "recorded",
    workdir: "/work",
    spawn: (script, options) =>
      Effect.sync(() => {
        sent.push({ script, stdin: options.stdin })
        return {
          stdout: Stream.make(encoder.encode(answer(script))),
          stderr: Stream.empty,
          exitCode: Effect.succeed(0)
        }
      }),
    readFile: () => Effect.die("the flows read through the batched calls"),
    writeFile: () => Effect.die("the flows write through the batched calls")
  }
  const machine = { ...session, files: linuxFileSystem(session, "container") }
  return { sent, fileSystem: Sandbox.fileSystem(machine) }
}

describe("the std file flows on a recording Linux guest", () => {
  const content = { "/work/src/a.py": "alpha = 1\nbeta = 2\n" }

  it.effect.each(
    [
      ["read", 1, Read.run({ path: "/work/src/a.py" }), []],
      ["edit", 2, Edit.run({ path: "/work/src/a.py", oldString: "beta = 2", newString: "beta = 'secret-edit'" }), [
        "secret-edit"
      ]],
      ["write", 2, Write.run({ path: "/work/new/b.py", content: "secret-write\n" }), ["secret-write"]],
      [
        "apply_patch",
        2,
        ApplyPatch.run({
          input: [
            "*** Begin Patch",
            "*** Add File: /work/x.py",
            "+secret-added",
            "*** Add File: /work/y.py",
            "+secret-again",
            "*** Update File: /work/src/a.py",
            "@@",
            "-beta = 2",
            "+secret-patched",
            "*** End Patch"
          ].join("\n")
        }),
        ["secret-added", "secret-again", "secret-patched"]
      ],
      ["ls", 1, Ls.run({ path: "/work" }), []]
    ] as const
  )(
    "%s takes %i round trips and sends file content only on standard input",
    ([, trips, flow, secrets]) =>
      Effect.gen(function*() {
        const guest = recording(content)
        yield* (flow as Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>).pipe(
          Effect.provideService(FileSystem.FileSystem, guest.fileSystem),
          Effect.provide(Path.layer)
        )
        expect(guest.sent).toHaveLength(trips)
        const decoder = new TextDecoder()
        for (const secret of secrets) {
          expect(guest.sent.some(({ script }) => script.includes(secret))).toBe(false)
          expect(guest.sent.some(({ stdin }) => stdin !== undefined && decoder.decode(stdin).includes(secret))).toBe(
            true
          )
        }
      })
  )
})
