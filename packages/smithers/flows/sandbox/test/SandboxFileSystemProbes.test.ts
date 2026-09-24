import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

// The suite pins the probe dialect to its reference: every operation runs
// twice on the same real directory tree — once through `Sandbox.fileSystem`'s
// sh probes over a real host shell, once through the platform NodeFileSystem —
// and must come back with the same `PlatformError` reason (or the same
// success). A probe that drifts from the platform implementation fails here
// against the implementation itself, not against a transcript of it.

// The resolved root keeps macOS's symlinked temp tree from making the shell
// and the reference disagree about what a path names.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-fs-probes-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const services = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return { fs, spawner }
}).pipe(Effect.provide(platform))

/** The outcome under comparison: `success`, or the failure's reason tag. */
const outcomeOf = <A>(operation: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<string> =>
  Effect.match(operation, {
    onSuccess: () => "success",
    onFailure: (error) => error.reason._tag
  })

/**
 * Runs the same operation through the probe surface and the reference
 * filesystem and requires the identical, pinned outcome from both, so the
 * expectation cannot drift from what NodeFileSystem actually reports.
 */
const agreement = (
  expected: string,
  probed: Effect.Effect<unknown, PlatformError.PlatformError>,
  reference: Effect.Effect<unknown, PlatformError.PlatformError>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const outcome = { probe: yield* outcomeOf(probed), node: yield* outcomeOf(reference) }
    expect(outcome).toEqual({ probe: expected, node: expected })
  })

const withProbes = <A, E>(
  session: string,
  body: (tree: {
    probed: FileSystem.FileSystem
    fs: FileSystem.FileSystem
    workdir: string
  }) => Effect.Effect<A, E>,
  prelude = ""
) =>
  Effect.gen(function*() {
    const { fs, spawner } = yield* services
    const provider = DirectorySandbox.make({ fs, spawner, root })
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const acquired = yield* provider.acquire(session)
        // Stripping the native overrides forces every derived operation
        // through the sh probes, over the same tree the reference reads.
        const probed = Sandbox.fileSystem({
          ...acquired,
          files: undefined,
          spawn: (command, options) => acquired.spawn(`${prelude}${command}`, options)
        })
        return yield* body({ probed, fs, workdir: acquired.workdir })
      })
    )
  })

// Each check spawns a handful of real shells; a loaded machine still fits.
const budget = 30_000

const isRoot = globalThis.process.getuid?.() === 0
/**
 * Whether the machine's `mv` knows `-T` (GNU and busybox do; BSD answers
 * `EX_USAGE`, 64, without touching anything), which decides whether the
 * derived rename can replace an empty directory or must refuse.
 */
const mvReplacesDirectories = spawnSync("mv", ["-T"], { stdio: "ignore" }).status !== 64

describe("Sandbox.fileSystem write options", () => {
  const unsupported: ReadonlyArray<NonNullable<Parameters<FileSystem.FileSystem["writeFile"]>[2]>> = [
    { flag: "a" },
    { flag: "wx" },
    { flag: "r" },
    { flag: "r+" },
    { flag: "w+" },
    { flag: "wx+" },
    { flag: "ax" },
    { flag: "a+" },
    { flag: "ax+" },
    { mode: 0o600 },
    { mode: 0o666 },
    { mode: 0 },
    { flag: "w", mode: 0o600 },
    { flag: "wx", mode: 0o600 }
  ]

  for (const method of ["writeFile", "writeFileString"] as const) {
    for (const options of unsupported) {
      it.effect(`${method} refuses ${JSON.stringify(options)} before touching the memory session`, () =>
        Effect.scoped(Effect.gen(function*() {
          const provider = Sandbox.TestSession.make({ files: { "/sandbox/held": "old" } })
          const session = yield* provider.acquire("write-options")
          const calls: Array<string> = []
          const files = Sandbox.fileSystem({
            ...session,
            readFile: (path) => {
              calls.push("readFile")
              return session.readFile(path)
            },
            writeFile: (path, data) => {
              calls.push("writeFile")
              return session.writeFile(path, data)
            }
          })
          for (const path of ["held", "missing"]) {
            const result = yield* Effect.match(
              method === "writeFile"
                ? files.writeFile(path, new TextEncoder().encode("new"), options)
                : files.writeFileString(path, "new", options),
              {
                onSuccess: () => "success",
                onFailure: (error) => {
                  expect(error).toBeInstanceOf(PlatformError.PlatformError)
                  expect(error.reason.method).toBe(method)
                  expect(error.reason.description).toContain("unsupported")
                  return error.reason._tag
                }
              }
            )
            expect({ result, content: yield* files.readFileString("held") }).toEqual({
              result: "BadArgument",
              content: "old"
            })
          }
          expect(provider.state.files.has("/sandbox/missing")).toBe(false)
          // Only the two assertion reads above may reach the session.
          expect(calls).toEqual(["readFile", "readFile"])
          expect(provider.state.commands).toEqual([])
        })))
    }

    it.effect(`${method} supports replacement with default options or flag w`, () =>
      Effect.scoped(Effect.gen(function*() {
        const provider = Sandbox.TestSession.make()
        const session = yield* provider.acquire("write-defaults")
        const files = Sandbox.fileSystem(session)
        for (const options of [undefined, {}, { flag: "w" as const }, { flag: undefined, mode: undefined }]) {
          yield* session.writeFile("/sandbox/held", new TextEncoder().encode("old"))
          if (method === "writeFile") {
            yield* files.writeFile("held", new Uint8Array([0, 255, 128]), options)
            expect(yield* files.readFile("held")).toEqual(new Uint8Array([0, 255, 128]))
          } else {
            yield* files.writeFileString("held", "new", options)
            expect(yield* files.readFileString("held")).toBe("new")
          }
        }
        yield* files.writeFileString("missing", "created")
        expect(yield* files.readFileString("missing")).toBe("created")
      })))
  }

  it.effect("forwards write options and rooted paths to native overrides", () =>
    Effect.scoped(Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const session = yield* provider.acquire("native-write-options")
      const options = { flag: "wx", mode: 0o600 } as const
      const bytes = new Uint8Array([0, 255])
      const calls: Array<ReadonlyArray<unknown>> = []
      const files = Sandbox.fileSystem({
        ...session,
        files: {
          writeFile: (...args) =>
            Effect.sync(() => {
              calls.push(args)
            }),
          writeFileString: (...args) =>
            Effect.sync(() => {
              calls.push(args)
            })
        }
      })
      yield* files.writeFile("held", bytes, options)
      yield* files.writeFileString("./held", "new", options)
      expect(calls).toEqual([
        ["/sandbox/held", bytes, options],
        ["/sandbox/held", "new", options]
      ])
      expect(provider.state.files.size).toBe(0)
      expect(provider.state.commands).toEqual([])
    })))
})

describe("Sandbox.fileSystem probes against the reference filesystem", () => {
  it.effect.skipIf(isRoot)(
    "stats a mode-000 file without reporting a false zero size",
    () =>
      withProbes("stat-unreadable", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          const path = `${workdir}/sealed`
          yield* fs.writeFileString(path, "seven!!")
          yield* fs.chmod(path, 0o000)
          yield* Effect.gen(function*() {
            const reference = yield* fs.stat(path)
            const actual = yield* probed.stat(path)
            expect(actual.type).toBe(reference.type)
            expect(actual.size).toBe(reference.size)
            expect(actual.size).toBe(7n)
          }).pipe(Effect.ensuring(Effect.orDie(fs.chmod(path, 0o600))))
        })),
    budget
  )

  it.effect(
    "propagates a failed size command when native stat is unavailable",
    () =>
      withProbes("stat-failed-size", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/file`, "seven!!")
          expect(yield* outcomeOf(probed.stat("file"))).toBe("Unknown")
        }), "stat() { return 127; }; wc() { return 1; }; "),
    budget
  )

  it.effect.skipIf(isRoot)(
    "propagates wc input redirection failure when native stat is unavailable",
    () =>
      withProbes("stat-unreadable-fallback", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          const path = `${workdir}/sealed`
          yield* fs.writeFileString(path, "seven!!")
          yield* fs.chmod(path, 0o000)
          yield* Effect.gen(function*() {
            expect(yield* outcomeOf(probed.stat(path))).toBe("Unknown")
          }).pipe(Effect.ensuring(Effect.orDie(fs.chmod(path, 0o600))))
        }), "stat() { return 127; }; "),
    budget
  )

  it.effect(
    "falls back to wc when native stat is unavailable",
    () =>
      withProbes("stat-wc", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/file`, "seven!!")
          expect((yield* probed.stat("file")).size).toBe(7n)
        }), "stat() { return 127; }; "),
    budget
  )

  for (const stdout of ["", "File", "File nope", "File -1", "File 1.5"]) {
    it.effect(`rejects invalid stat metadata ${JSON.stringify(stdout)} with a typed error`, () =>
      Effect.scoped(Effect.gen(function*() {
        const provider = Sandbox.TestSession.make({ script: () => ({ stdout }) })
        const session = yield* provider.acquire("stat-invalid")
        expect(yield* outcomeOf(Sandbox.fileSystem(session).stat("file"))).toBe("Unknown")
      })))
  }

  it.effect.skipIf(!mvReplacesDirectories)(
    "renames a directory onto an empty directory without nesting it",
    () =>
      withProbes("rename-dir-onto-empty", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          for (const prefix of ["probe", "node"]) {
            yield* fs.makeDirectory(`${workdir}/${prefix}-source`)
            yield* fs.writeFileString(`${workdir}/${prefix}-source/child`, "payload")
            yield* fs.makeDirectory(`${workdir}/${prefix}-dest`)
          }
          yield* agreement(
            "success",
            probed.rename("probe-source", "probe-dest"),
            fs.rename(`${workdir}/node-source`, `${workdir}/node-dest`)
          )
          for (const prefix of ["probe", "node"]) {
            expect(yield* fs.exists(`${workdir}/${prefix}-source`)).toBe(false)
            expect(yield* fs.readDirectory(`${workdir}/${prefix}-dest`)).toEqual(["child"])
            expect(yield* fs.readFileString(`${workdir}/${prefix}-dest/child`)).toBe("payload")
          }
        })),
    budget
  )

  it.effect.skipIf(mvReplacesDirectories)(
    "refuses a directory onto an empty directory where mv lacks -T, touching neither tree",
    () =>
      withProbes("rename-dir-onto-empty-unsupported", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/source`)
          yield* fs.writeFileString(`${workdir}/source/child`, "payload")
          yield* fs.makeDirectory(`${workdir}/dest`)
          const error = yield* Effect.flip(probed.rename("source", "dest"))
          expect(error.reason._tag).toBe("BadResource")
          expect(error.reason.description).toContain("cannot replace one")
          expect(yield* fs.readDirectory(`${workdir}/source`)).toEqual(["child"])
          expect(yield* fs.readDirectory(`${workdir}/dest`)).toEqual([])
        })),
    budget
  )

  it.effect("reports a mv without -T as a typed BadResource naming the destination", () =>
    Effect.scoped(Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ script: () => ({ exitCode: 13 }) })
      const session = yield* provider.acquire("rename-unsupported")
      const error = yield* Effect.flip(Sandbox.fileSystem(session).rename("source", "dest"))
      expect(error.reason._tag).toBe("BadResource")
      expect(error.reason.description).toContain("`/sandbox/dest`")
      expect(error.reason.description).toContain("no `-T`")
    })))

  it.effect(
    "renames a directory to itself including equivalent paths",
    () =>
      withProbes("rename-dir-self", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/source`)
          yield* fs.writeFileString(`${workdir}/source/child`, "payload")
          for (const destination of ["source", "source/../source"]) {
            yield* agreement(
              "success",
              probed.rename("source", destination),
              fs.rename(`${workdir}/source`, `${workdir}/${destination}`)
            )
          }
          expect(yield* fs.readDirectory(`${workdir}/source`)).toEqual(["child"])
        })),
    budget
  )

  it.effect(
    "refuses to replace a nonempty directory without changing either tree",
    () =>
      withProbes("rename-dir-onto-nonempty", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/source`)
          yield* fs.writeFileString(`${workdir}/source/child`, "source payload")
          yield* fs.makeDirectory(`${workdir}/dest`)
          yield* fs.writeFileString(`${workdir}/dest/held`, "destination payload")
          expect(yield* outcomeOf(probed.rename("source", "dest"))).not.toBe("success")
          expect(yield* fs.readDirectory(`${workdir}/source`)).toEqual(["child"])
          expect(yield* fs.readDirectory(`${workdir}/dest`)).toEqual(["held"])
          expect(yield* fs.readFileString(`${workdir}/source/child`)).toBe("source payload")
          expect(yield* fs.readFileString(`${workdir}/dest/held`)).toBe("destination payload")
        })),
    budget
  )

  it.effect(
    "refuses a rename onto an existing directory instead of moving into it",
    () =>
      withProbes("rename-onto-dir", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/f.txt`, "payload")
          yield* fs.makeDirectory(`${workdir}/dest`)
          // Bare `mv` would land the file at `dest/f.txt`; `rename(2)` refuses
          // with EISDIR.
          yield* agreement(
            "BadResource",
            probed.rename(`${workdir}/f.txt`, `${workdir}/dest`),
            fs.rename(`${workdir}/f.txt`, `${workdir}/dest`)
          )
          // The refusal really came before `mv` ran: nothing moved.
          expect(yield* fs.exists(`${workdir}/f.txt`)).toBe(true)
          expect(yield* fs.exists(`${workdir}/dest/f.txt`)).toBe(false)
        })),
    budget
  )

  it.effect(
    "reports a rename's missing source as NotFound",
    () =>
      withProbes("rename-missing-source", ({ fs, probed, workdir }) =>
        agreement(
          "NotFound",
          probed.rename(`${workdir}/ghost`, `${workdir}/target`),
          fs.rename(`${workdir}/ghost`, `${workdir}/target`)
        )),
    budget
  )

  it.effect(
    "reports an occupied makeDirectory target as AlreadyExists, in both modes",
    () =>
      withProbes("mkdir-occupied", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/held`)
          yield* fs.writeFileString(`${workdir}/f.txt`, "occupant")
          yield* agreement(
            "AlreadyExists",
            probed.makeDirectory(`${workdir}/held`),
            fs.makeDirectory(`${workdir}/held`)
          )
          yield* agreement(
            "AlreadyExists",
            probed.makeDirectory(`${workdir}/f.txt`),
            fs.makeDirectory(`${workdir}/f.txt`)
          )
          // Recursive creation of an existing directory is a success, and only
          // a non-directory occupant still refuses.
          yield* agreement(
            "success",
            probed.makeDirectory(`${workdir}/held`, { recursive: true }),
            fs.makeDirectory(`${workdir}/held`, { recursive: true })
          )
          yield* agreement(
            "AlreadyExists",
            probed.makeDirectory(`${workdir}/f.txt`, { recursive: true }),
            fs.makeDirectory(`${workdir}/f.txt`, { recursive: true })
          )
        })),
    budget
  )

  it.effect(
    "reports a makeDirectory with a missing parent as NotFound",
    () =>
      withProbes("mkdir-orphan", ({ fs, probed, workdir }) =>
        agreement(
          "NotFound",
          probed.makeDirectory(`${workdir}/no/deep`),
          fs.makeDirectory(`${workdir}/no/deep`)
        )),
    budget
  )

  it.effect(
    "reports a missing or dangling realPath as NotFound",
    () =>
      withProbes("realpath-absent", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* agreement(
            "NotFound",
            probed.realPath(`${workdir}/ghost`),
            fs.realPath(`${workdir}/ghost`)
          )
          // `readlink -f` alone would exit 0 and print the missing path; a
          // dangling symlink is equally absent to the reference `realpath`.
          yield* fs.symlink(`${workdir}/ghost`, `${workdir}/dangling`)
          yield* agreement(
            "NotFound",
            probed.realPath(`${workdir}/dangling`),
            fs.realPath(`${workdir}/dangling`)
          )
        })),
    budget
  )

  it.effect(
    "reports a missing readLink as NotFound and keeps BadArgument for a non-link",
    () =>
      withProbes("readlink-shapes", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* agreement(
            "NotFound",
            probed.readLink(`${workdir}/ghost`),
            fs.readLink(`${workdir}/ghost`)
          )
          // The one pinned divergence on the whole surface: a present non-link
          // is the caller's misuse, which the probe names `BadArgument` where
          // the reference lets the unmapped `EINVAL` fall through as `Unknown`.
          // `fileSystem`'s docs declare exactly this.
          yield* fs.writeFileString(`${workdir}/plain.txt`, "not a link")
          const nonLink = {
            probe: yield* outcomeOf(probed.readLink(`${workdir}/plain.txt`)),
            node: yield* outcomeOf(fs.readLink(`${workdir}/plain.txt`))
          }
          expect(nonLink).toEqual({ probe: "BadArgument", node: "Unknown" })
        })),
    budget
  )

  it.effect(
    "lists an entry whose name holds a newline as one entry, flat and recursive",
    () =>
      withProbes("readdir-newline", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/a\nb`)
          yield* fs.writeFileString(`${workdir}/a\nb/c\nd.txt`, "x")
          expect(yield* probed.readDirectory(workdir)).toEqual(
            [...(yield* fs.readDirectory(workdir))].sort()
          )
          expect(yield* probed.readDirectory(workdir, { recursive: true })).toEqual(
            [...(yield* fs.readDirectory(workdir, { recursive: true }))].sort()
          )
          expect(yield* probed.readDirectory(workdir, { recursive: true })).toContain("a\nb/c\nd.txt")
        })),
    budget
  )

  it.effect(
    "reports a readDirectory of a regular file as BadResource",
    () =>
      withProbes("readdir-of-file", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/f.txt`, "not a directory")
          yield* agreement(
            "BadResource",
            probed.readDirectory(`${workdir}/f.txt`),
            fs.readDirectory(`${workdir}/f.txt`)
          )
          yield* agreement(
            "BadResource",
            probed.readDirectory(`${workdir}/f.txt`, { recursive: true }),
            fs.readDirectory(`${workdir}/f.txt`, { recursive: true })
          )
        })),
    budget
  )

  it.effect(
    "fails exists under a non-directory ancestor the way the reference access does",
    () =>
      withProbes("exists-under-file", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.writeFileString(`${workdir}/f.txt`, "in the way")
          // The platform `exists` converts only NotFound into `false`; the
          // ENOTDIR from `access(2)` propagates as BadResource.
          yield* agreement(
            "BadResource",
            probed.exists(`${workdir}/f.txt/under`),
            fs.exists(`${workdir}/f.txt/under`)
          )
        })),
    budget
  )

  // Root sees through a 000-mode directory, so the denial only exists for an
  // unprivileged run — where it must match the reference's PermissionDenied.
  it.effect.skipIf(isRoot)(
    "fails exists behind an unsearchable directory with PermissionDenied",
    () =>
      withProbes("exists-denied", ({ fs, probed, workdir }) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(`${workdir}/vault`)
          yield* fs.writeFileString(`${workdir}/vault/inside.txt`, "sealed")
          yield* fs.chmod(`${workdir}/vault`, 0o000)
          yield* agreement(
            "PermissionDenied",
            probed.exists(`${workdir}/vault/inside.txt`),
            fs.exists(`${workdir}/vault/inside.txt`)
          ).pipe(
            // Reopen the vault whatever happened, or teardown cannot remove it.
            Effect.ensuring(Effect.orDie(fs.chmod(`${workdir}/vault`, 0o755)))
          )
        })),
    budget
  )
})
