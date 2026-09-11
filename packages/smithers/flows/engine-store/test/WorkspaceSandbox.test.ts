import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { spawn } from "node:child_process"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const descriptor = (input: Partial<FileBoundary> = {}): FileBoundary => ({
  readSet: input.readSet ?? [],
  writeSet: input.writeSet ?? [],
  ...(input.removes === undefined ? {} : { removes: input.removes }),
  boundaryMode: input.boundaryMode ?? "hard"
})

const read = (path: string, content: string) => ({ path, digest: sha256(content) })

const text = (files: ReadonlyArray<WorkspaceSandbox.HostFile>, path: string): string | undefined => {
  const file = files.find((candidate) => candidate.path === path)
  return file === undefined ? undefined : decoder.decode(file.content)
}

const injected = (path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "writeFile",
    pathOrDescriptor: path,
    description: "injected device failure"
  })

/**
 * The eight behaviors the `agent` proof of concept documented, ported
 * onto this side's declaration vocabulary (`FileBoundary` rather than
 * `Effects.Declaration`) and its identity surfaces (`@smthrs/crypto` rather
 * than the deleted `@smthrs/keys` digest module).
 */
describe("WorkspaceSandbox conformance", () => {
  it.effect("uses an immutable declaration even when the workflow mutates every nested field", () =>
    Effect.gen(function*() {
      const test = yield* withCrypto(WorkspaceSandbox.makeMemory({
        "src/input.txt": "input",
        "secret/value.txt": "secret",
        "protected.txt": "keep"
      }))
      const readGlob = {
        _tag: "Glob" as const,
        include: ["src/**"] as [string, ...Array<string>],
        exclude: ["src/ignored/**"]
      }
      const declaration = descriptor({
        readSet: [readGlob],
        writeSet: ["out/declared.txt"],
        removes: [],
        boundaryMode: "hard"
      })
      const result = yield* withCrypto(test.service.execute({
        descriptor: declaration,
        workflow: Effect.gen(function*() {
          ;(readGlob.include as Array<string>).push("secret/**")
          ;(readGlob.exclude as Array<string>).splice(0)
          ;(declaration.readSet as Array<never>).push(read("secret/value.txt", "secret") as never)
          ;(declaration.writeSet as Array<string>).push("out/surprise.txt")
          ;(declaration.removes as Array<string>).push("protected.txt")
          ;(declaration as { boundaryMode: string }).boundaryMode = "expected"
          const fs = yield* FileSystem.FileSystem
          yield* fs.readFileString("secret/value.txt")
          yield* fs.writeFileString("out/surprise.txt", "surprise")
          yield* fs.remove("protected.txt")
          return null
        })
      }))

      expect(result._tag).toBe("Invalidated")
      if (result._tag !== "Invalidated") return
      expect(result.violations.map((violation) => [violation.kind, violation.resource.id])).toEqual([
        ["undeclared-read", "secret/value.txt"],
        ["undeclared-write", "out/surprise.txt"],
        ["undeclared-write", "protected.txt"]
      ])
      expect(text(yield* test.files, "protected.txt")).toBe("keep")
      expect(text(yield* test.files, "out/surprise.txt")).toBeUndefined()
    }))

  it.effect("copies host snapshot buffers before an asynchronous workflow can observe mutation", () =>
    withCrypto(Effect.scoped(Effect.gen(function*() {
      const shared = encoder.encode("original")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const service = WorkspaceSandbox.makeHosted({
        root: "",
        snapshot: () => Effect.succeed(new Map([["input.txt", shared]])),
        baseline: () => Effect.succeed(undefined),
        retain: (bytes) => Effect.succeed(bytes.slice()),
        commit: () => Effect.void
      })
      const running = yield* service.execute({
        descriptor: descriptor({ readSet: [read("input.txt", "original")] }),
        workflow: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("input.txt")))
        )
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      shared.set(encoder.encode("mutated!"))
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(running)

      expect(result._tag).toBe("Accepted")
      if (result._tag !== "Accepted") return
      expect(result.result.output).toBe("original")
      expect(result.result.provenance.inputs).toEqual([
        { resource: { kind: "file", id: "input.txt" }, digest: sha256("original") }
      ])
    }))))

  it.effect("returns functional files and queued effects without changing the host before materialization", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/input.txt": "hello" })
        const accepted = yield* test.service.execute({
          descriptor: descriptor({ readSet: [read("src/input.txt", "hello")], writeSet: ["out/result.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            const input = decoder.decode(yield* workspace.readFile("src/input.txt"))
            yield* workspace.writeFile("out/result.txt", encoder.encode(`${input} world`))
            yield* workspace.queueEffect({
              protocol: "chat/v1",
              idempotencyKey: "reply-1",
              payload: { message: "finished" }
            })
            return { rendered: true, count: 1 }
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        const before = yield* test.files
        yield* test.service.materialize(accepted)
        return { accepted, before, after: yield* test.files }
      })

      const { accepted, after, before } = yield* withCrypto(program)
      expect(text(before, "out/result.txt")).toBeUndefined()
      expect(accepted.result.output).toEqual({ rendered: true, count: 1 })
      expect(accepted.result.provenance.inputs).toHaveLength(1)
      expect(accepted.result.provenance.outputs).toEqual([
        { resource: { kind: "file", id: "out/result.txt" }, operation: "write", digest: sha256("hello world") }
      ])
      expect(accepted.result.effects).toEqual([{
        protocol: "chat/v1",
        idempotencyKey: "reply-1",
        payload: { message: "finished" }
      }])
      expect(decoder.decode(accepted.result.files[0]?.after)).toBe("hello world")
      expect(text(after, "out/result.txt")).toBe("hello world")
    }))

  it.effect("accepts writes covered by tree-artifact and glob declarations", () =>
    Effect.gen(function*() {
      const test = yield* withCrypto(WorkspaceSandbox.makeMemory())
      const accepted = yield* withCrypto(test.service.execute({
        descriptor: descriptor({
          writeSet: [
            { _tag: "TreeArtifact", path: "tree" },
            { _tag: "Glob", include: ["generated/**/*.js"], exclude: ["generated/skip/**"] },
            { _tag: "Glob", include: ["assets/**"] }
          ]
        }),
        workflow: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("tree/a.txt", "a")
          yield* fs.writeFileString("generated/nested/a.js", "a")
        })
      }))
      expect(accepted._tag).toBe("Accepted")
    }))

  it.effect("invalidates and discards undeclared reads and writes", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({
          "src/declared.txt": "declared",
          "src/secret.txt": "secret"
        })
        const invalidated = yield* test.service.execute({
          descriptor: descriptor({ readSet: [read("src/declared.txt", "declared")], writeSet: ["out/declared.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            const secret = yield* workspace.readFile("src/secret.txt")
            yield* workspace.writeFile("out/surprise.txt", secret)
            yield* workspace.queueEffect({
              protocol: "chat/v1",
              idempotencyKey: "must-not-dispatch",
              payload: { leaked: true }
            })
            return { leaked: true }
          })
        })
        return { invalidated, files: yield* test.files }
      })

      const { files, invalidated } = yield* withCrypto(program)
      expect(invalidated).toMatchObject({
        _tag: "Invalidated",
        violations: [
          { kind: "undeclared-read", resource: { kind: "file", id: "src/secret.txt" } },
          { kind: "undeclared-write", resource: { kind: "file", id: "out/surprise.txt" } }
        ]
      })
      // The candidate output, files, and queued effects have no accessor at all
      // on the `Invalidated` shape: nothing leaks, by construction.
      expect(Object.keys(invalidated).sort()).toEqual(["_tag", "provenance", "violations"])
      expect(text(files, "out/surprise.txt")).toBeUndefined()
    }))

  it.effect("replays memoized results by content identity without rerunning the body", () =>
    Effect.gen(function*() {
      let runs = 0
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/input.txt": "same input" })
        const execution = {
          descriptor: descriptor({ readSet: [read("src/input.txt", "same input")], writeSet: ["out/result.txt"] }),
          cacheKey: "step-key",
          workflow: Effect.gen(function*() {
            runs = runs + 1
            const workspace = yield* WorkspaceSandbox.Workspace
            const input = yield* workspace.readFile("src/input.txt")
            yield* workspace.writeFile("out/result.txt", input)
            return { value: decoder.decode(input) }
          })
        }
        return [yield* test.service.execute(execution), yield* test.service.execute(execution)]
      })

      const [first, replay] = yield* withCrypto(program)
      expect(first).toMatchObject({ _tag: "Accepted", cache: { status: "miss", key: "step-key" } })
      expect(replay).toMatchObject({ _tag: "Accepted", cache: { status: "hit", key: "step-key" } })
      expect(runs).toBe(1)
    }))

  it.effect("refuses to materialize over a changed output base", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "out/result.txt": "base" })
        const execute = (value: string) =>
          test.service.execute({
            descriptor: descriptor({ writeSet: ["out/result.txt"] }),
            workflow: Effect.gen(function*() {
              const workspace = yield* WorkspaceSandbox.Workspace
              yield* workspace.writeFile("out/result.txt", encoder.encode(value))
              return { value }
            })
          })
        const stale = yield* execute("stale")
        const current = yield* execute("current")
        if (stale._tag !== "Accepted" || current._tag !== "Accepted") throw new Error("expected accepted executions")
        yield* test.service.materialize(current)
        const conflict = yield* Effect.flip(test.service.materialize(stale))
        return { conflict, files: yield* test.files }
      })

      const { conflict, files } = yield* withCrypto(program)
      expect(conflict).toMatchObject({
        _tag: "@smthrs/engine-store/MaterializationConflict",
        paths: ["out/result.txt"]
      })
      expect(text(files, "out/result.txt")).toBe("current")
    }))

  it.effect("supports removals and replays their functional result", () =>
    Effect.gen(function*() {
      let runs = 0
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "out/old.txt": "old" })
        const execution = {
          descriptor: descriptor({ removes: ["out/old.txt"] }),
          cacheKey: "removal",
          workflow: Effect.gen(function*() {
            runs = runs + 1
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.removeFile("out/old.txt")
            return ["removed"]
          })
        }
        const first = yield* test.service.execute(execution)
        const replay = yield* test.service.execute(execution)
        if (first._tag !== "Accepted" || replay._tag !== "Accepted") throw new Error("expected accepted executions")
        yield* test.service.materialize(replay)
        return { first, replay, files: yield* test.files }
      })

      const { files, first, replay } = yield* withCrypto(program)
      expect(first.result.files).toMatchObject([{
        path: "out/old.txt",
        beforeDigest: sha256("old"),
        afterDigest: undefined
      }])
      expect(first.result.provenance.outputs[0]?.operation).toBe("remove")
      expect(replay.cache.status).toBe("hit")
      expect(runs).toBe(1)
      expect(text(files, "out/old.txt")).toBeUndefined()
    }))

  it.effect("disables memoization when the caller supplies no cache key", () =>
    Effect.gen(function*() {
      let runs = 0
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        const execution = {
          descriptor: descriptor(),
          workflow: Effect.sync(() => {
            runs = runs + 1
            return { run: runs }
          })
        }
        return [yield* test.service.execute(execution), yield* test.service.execute(execution)]
      })

      const [first, second] = yield* withCrypto(program)
      expect(first).toMatchObject({ _tag: "Accepted", cache: { status: "disabled" } })
      expect(second).toMatchObject({ _tag: "Accepted", cache: { status: "disabled" } })
      expect(runs).toBe(2)
    }))

  it.effect("rejects invalid paths and missing files", () =>
    Effect.gen(function*() {
      for (const path of ["", "/absolute.txt", "nested/../escape.txt", "."]) {
        const invalid = yield* withCrypto(Effect.flip(WorkspaceSandbox.makeMemory({ [path]: "invalid" })))
        expect(invalid).toMatchObject({ _tag: "@smthrs/engine-store/WorkspaceError", code: "invalid_path" })
      }

      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "bytes.bin": encoder.encode("bytes") })
        const missing = yield* Effect.flip(test.service.execute({
          descriptor: descriptor({ readSet: [read("missing.txt", "")] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.readFile("missing.txt")
            return null
          })
        }))
        const escaping = yield* Effect.flip(test.service.execute({
          descriptor: descriptor({ writeSet: ["out/**"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("../escape.txt", encoder.encode("no"))
            return null
          })
        }))
        const removing = yield* Effect.flip(test.service.execute({
          descriptor: descriptor(),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.removeFile("/absolute.txt")
            return null
          })
        }))
        return { escaping, files: yield* test.files, missing, removing }
      })

      const { escaping, files, missing, removing } = yield* withCrypto(program)
      expect(missing).toMatchObject({ code: "not_found" })
      expect(escaping).toMatchObject({ code: "invalid_path" })
      expect(removing).toMatchObject({ code: "invalid_path" })
      expect(text(files, "bytes.bin")).toBe("bytes")
    }))

  it.effect("normalizes relative paths and omits unchanged writes from the file diff", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/b.txt": "b", "src/a.txt": "a" })
        return yield* test.service.execute({
          descriptor: descriptor({ readSet: [read("src/a.txt", "a")], writeSet: ["src/*.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            const input = yield* workspace.readFile("./src//a.txt")
            yield* workspace.writeFile("src\\a.txt", input)
            return { unchanged: true }
          })
        })
      })

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.files).toEqual([])
      expect(accepted.result.provenance.inputs[0]?.resource.id).toBe("src/a.txt")
      // A read of a declared file never counts against the declaration, and an
      // unchanged rewrite produces no output observation at all.
      expect(accepted.result.provenance.outputs).toEqual([])
    }))

  it.effect("derives workspace revisions canonically across object insertion order", () =>
    Effect.gen(function*() {
      const revision = (initialFiles: Readonly<Record<string, string>>) =>
        Effect.gen(function*() {
          const test = yield* WorkspaceSandbox.makeMemory(initialFiles)
          const accepted = yield* test.service.execute({
            descriptor: descriptor(),
            workflow: Effect.succeed(null)
          })
          if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
          return accepted.result.provenance.baseRevision
        })
      const forward = { "a.txt": "a", "b.txt": "b" }
      const reverse: Record<string, string> = {}
      reverse["b.txt"] = "b"
      reverse["a.txt"] = "a"

      const first = yield* withCrypto(revision(forward))
      const reordered = yield* withCrypto(revision(reverse))
      const changed = yield* withCrypto(revision({ "a.txt": "a", "b.txt": "changed" }))

      expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(reordered).toBe(first)
      expect(changed).not.toBe(first)
    }))

  it.effect("honors glob declarations without rewriting the characters inside them", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        return yield* test.service.execute({
          descriptor: descriptor({
            // `**` crosses directories, `*` does not, and a pattern containing a
            // literal space must survive translation intact — the placeholder the
            // translation uses is NUL precisely because a path cannot hold one.
            writeSet: ["deep/**", "flat/*.txt", "with space/*.txt"]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            for (
              const path of [
                "deep/a/b/c.txt",
                "flat/ok.txt",
                "with space/ok.txt",
                "flat/nested/too-deep.txt"
              ]
            ) {
              yield* workspace.writeFile(path, encoder.encode("x"))
            }
            return null
          })
        })
      })

      // Only the `*`-under-`flat/` write escapes coverage: `*` stops at a
      // separator, while `deep/**` and the space-bearing pattern both match.
      expect(yield* withCrypto(program)).toMatchObject({
        _tag: "Invalidated",
        violations: [{ kind: "undeclared-write", resource: { id: "flat/nested/too-deep.txt" } }]
      })
    }))

  it.effect("lets a declaration that names a path outside the workspace cover nothing", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        return yield* test.service.execute({
          // Neither entry can be named inside the workspace, so neither covers
          // the write the body actually performs.
          descriptor: descriptor({ writeSet: ["/outside.txt", "../escape.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("inside.txt", encoder.encode("x"))
            return null
          })
        })
      })

      expect(yield* withCrypto(program)).toMatchObject({
        _tag: "Invalidated",
        violations: [{ kind: "undeclared-write", resource: { id: "inside.txt" } }]
      })
    }))

  it.effect("provides the implementation as an Effect layer", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        const resolved = yield* WorkspaceSandbox.WorkspaceSandbox.pipe(
          Effect.provide(WorkspaceSandbox.layer(test.service))
        )
        return resolved === test.service
      })
      expect(yield* withCrypto(program)).toBe(true)
    }))
})

describe("WorkspaceSandbox expected mode", () => {
  it.effect("admits a deviating execution and leaves the deviation for the engine to journal", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/a.txt": "a" })
        const accepted = yield* test.service.execute({
          descriptor: descriptor({
            readSet: [read("src/a.txt", "a")],
            writeSet: ["out/declared.txt"],
            boundaryMode: "expected"
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("out/surprise.txt", encoder.encode("deviation"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return accepted
      })

      const accepted = yield* withCrypto(program)
      expect(
        WorkspaceSandbox.violations(
          descriptor({ writeSet: ["out/declared.txt"], boundaryMode: "expected" }),
          new Map(),
          accepted.result.provenance
        )
      ).toEqual([{ kind: "undeclared-write", resource: { kind: "file", id: "out/surprise.txt" } }])
    }))
})

/**
 * The transaction also seeds Effect's own `FileSystem` tag, which is how an
 * ordinary action body — one that never heard of `WorkspaceSandbox` — runs
 * isolated.
 */
describe("WorkspaceSandbox transaction filesystem", () => {
  for (const host of ["memory", "filesystem"] as const) {
    for (const probe of ["root listing", "directory presence", "empty root", "invalid paths"] as const) {
      it.effect(`${host}: supports ${probe}`, () =>
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const hostFs = yield* FileSystem.FileSystem
            const root = yield* hostFs.makeTempDirectoryScoped({ prefix: "wsx-directories-" })
            yield* hostFs.makeDirectory(`${root}/dir/nested`, { recursive: true })
            const initial = { "a.txt": "A", "dir/b.txt": "B", "dir/nested/c.txt": "C" }
            for (const [path, content] of Object.entries(initial)) {
              yield* hostFs.writeFileString(`${root}/${path}`, content)
            }
            const sandbox = host === "memory"
              ? (yield* WorkspaceSandbox.makeMemory(probe === "empty root" ? {} : initial)).service
              : WorkspaceSandbox.makeFileSystem(hostFs, yield* ArtifactStore.ArtifactStore, root)
            const roots = host === "memory" ? [".", ""] : [".", "", root, `${root}/`]
            const result = yield* sandbox.execute({
              descriptor: descriptor({
                readSet: probe === "empty root"
                  ? []
                  : Object.entries(initial).map(([path, content]) => read(path, content)),
                writeSet: ["new/**"]
              }),
              workflow: Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                if (probe === "root listing" || probe === "empty root") {
                  for (const path of roots) {
                    expect(yield* fs.readDirectory(path)).toEqual(probe === "empty root" ? [] : ["a.txt", "dir"])
                    expect(yield* fs.exists(path)).toBe(true)
                  }
                } else if (probe === "directory presence") {
                  for (
                    const path of [
                      "dir",
                      "dir/nested",
                      "dir/",
                      "./dir",
                      ...(host === "filesystem" ? [`${root}/dir`] : [])
                    ]
                  ) {
                    expect(yield* fs.exists(path)).toBe(true)
                  }
                  expect(yield* fs.readDirectory("dir")).toEqual(["b.txt", "nested"])
                  expect(yield* fs.exists("a.txt")).toBe(true)
                  expect(yield* fs.exists("di")).toBe(false)
                  expect(yield* fs.exists("missing")).toBe(false)
                  yield* fs.writeFileString("new/file.txt", "new")
                  expect(yield* fs.exists("new")).toBe(true)
                  yield* fs.remove("new/file.txt")
                  expect(yield* fs.exists("new")).toBe(false)
                } else {
                  for (const path of [...roots, "..", "dir/../a.txt", `${root}/../escape.txt`]) {
                    expect((yield* Effect.flip(fs.writeFileString(path, "bad")))._tag).toBe("PlatformError")
                    expect((yield* Effect.flip(fs.remove(path)))._tag).toBe("PlatformError")
                    expect((yield* Effect.flip(fs.readFile(path)))._tag).toBe("PlatformError")
                  }
                  expect(yield* fs.exists("..")).toBe(false)
                  expect((yield* Effect.flip(fs.readDirectory("..")))._tag).toBe("PlatformError")
                }
              })
            })
            expect(result._tag).toBe("Accepted")
            expect(result.violations).toEqual([])
          })).pipe(Effect.provide(ArtifactStore.layerMemory.pipe(Layer.provideMerge(NodeFileSystem.layer))))
        ))
    }
  }

  it.effect("traces the files whose presence establishes an implicit directory", () =>
    withCrypto(Effect.gen(function*() {
      const test = yield* WorkspaceSandbox.makeMemory({ "secret/value.txt": "secret" })
      const result = yield* test.service.execute({
        descriptor: descriptor(),
        workflow: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          expect(yield* fs.exists("secret")).toBe(true)
        })
      })
      expect(result._tag).toBe("Invalidated")
      expect(result.violations).toMatchObject([
        { kind: "undeclared-read", resource: { kind: "file", id: "secret/value.txt" } }
      ])
    })))

  it.effect("serves an ordinary FileSystem body over the transaction", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/in.txt": "seed", "src/nested/deep.txt": "deep" })
        const accepted = yield* test.service.execute({
          descriptor: descriptor({
            readSet: [
              read("src/in.txt", "seed"),
              read("src/nested/deep.txt", "deep"),
              read("out/nope.txt", "absent")
            ],
            writeSet: ["out/**", "src/in.txt"]
          }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const present = yield* fs.exists("src/in.txt")
            const absent = yield* fs.exists("/escape.txt")
            const bytes = yield* fs.readFile("src/in.txt")
            const string = yield* fs.readFileString("src/nested/deep.txt")
            yield* fs.makeDirectory("out", { recursive: true })
            yield* fs.writeFile("out/bytes.bin", bytes)
            yield* fs.writeFileString("out/text.txt", `${string}!`)
            const entries = yield* fs.readDirectory("src")
            yield* fs.remove("src/in.txt")
            const missing = yield* Effect.flip(fs.readFile("out/nope.txt"))
            const bad = yield* Effect.flip(fs.writeFileString("../escape.txt", "no"))
            const badDirectory = yield* Effect.flip(fs.readDirectory("/nope"))
            const badRemove = yield* Effect.flip(fs.remove("/nope"))
            const badRead = yield* Effect.flip(fs.readFileString("/nope"))
            return { absent, bad, badDirectory, badRead, badRemove, entries, missing, present }
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        yield* test.service.materialize(accepted)
        return { accepted, files: yield* test.files }
      })

      const { accepted, files } = yield* withCrypto(program)
      const observed = accepted.result.output
      expect(observed.present).toBe(true)
      expect(observed.absent).toBe(false)
      expect(observed.entries).toEqual(["in.txt", "nested"])
      expect(observed.missing._tag).toBe("PlatformError")
      expect(observed.bad._tag).toBe("PlatformError")
      expect(observed.badDirectory._tag).toBe("PlatformError")
      expect(observed.badRead._tag).toBe("PlatformError")
      expect(observed.badRemove._tag).toBe("PlatformError")
      expect(text(files, "out/text.txt")).toBe("deep!")
      expect(text(files, "out/bytes.bin")).toBe("seed")
      expect(text(files, "src/in.txt")).toBeUndefined()
    }))
})

/**
 * The filesystem host is the one that makes this real: copy-in of the declared
 * read set, whole-tree diff of the transaction, artifact-store retention of
 * oversized products, and a compare-and-set copy-back onto the host tree.
 */
describe("WorkspaceSandbox filesystem host", () => {
  const hostLayer = (files: Map<string, Uint8Array>) => {
    const fs = FileSystem.makeNoop({
      exists: (path) =>
        Effect.succeed(
          files.has(String(path)) || [...files.keys()].some((candidate) => candidate.startsWith(`${String(path)}/`))
        ),
      readFile: (path) => Effect.succeed(files.get(String(path))!),
      writeFile: (path, data) => Effect.sync(() => void files.set(String(path), data)),
      remove: (path) => Effect.sync(() => void files.delete(String(path))),
      makeDirectory: () => Effect.void,
      readDirectory: ((directory: string, options?: { readonly recursive?: boolean }) => {
        const prefix = directory === "." ? "" : `${directory}/`
        const names = new Set<string>()
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length)
          names.add(options?.recursive === true ? rest : rest.split("/")[0]!)
        }
        return Effect.succeed([...names].sort())
      }) as never,
      stat: ((path: string) =>
        files.has(path)
          ? Effect.succeed({ type: "File" })
          : Effect.succeed({ type: "Directory" })) as never
    })
    return ArtifactStore.layerMemory.pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(fs)))
  }

  it.effect("seeds only the declared read set, so an undeclared file is simply not there", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/src/in.txt", encoder.encode("seed")],
        ["/w/src/secret.txt", encoder.encode("secret")]
      ])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* sandbox.execute({
          descriptor: descriptor({ readSet: [read("src/in.txt", "seed")], writeSet: ["out/copy.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return {
              declared: yield* fs.exists("src/in.txt"),
              undeclared: yield* fs.exists("src/secret.txt")
            }
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.output).toEqual({ declared: true, undeclared: false })
    }))

  it.effect("expands declared read globs once and seeds declared removals", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/src/a.ts", encoder.encode("a")],
        ["/w/src/nested/b.ts", encoder.encode("b")],
        ["/w/src/skip.js", encoder.encode("skip")],
        ["/w/notes.md", encoder.encode("root-level")],
        ["/w/stale.txt", encoder.encode("stale")]
      ])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* sandbox.execute({
          descriptor: descriptor({
            readSet: [
              { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/skip.ts"] },
              { _tag: "Glob", include: ["src/a.ts"] },
              // A root-level pattern walks the workspace root itself.
              { _tag: "Glob", include: ["*.md"] }
            ],
            removes: ["stale.txt", "absent.txt"]
          }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const visible: Array<string> = []
            for (const path of ["src/a.ts", "src/nested/b.ts", "notes.md", "src/skip.js"]) {
              if (yield* fs.exists(path)) visible.push(path)
            }
            yield* fs.readFileString("src/a.ts")
            yield* fs.remove("stale.txt")
            return visible
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))
      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.output).toEqual(["src/a.ts", "src/nested/b.ts", "notes.md"])
      expect(accepted.result.files.map((change) => change.path)).toEqual(["stale.txt"])
    }))

  it.effect("expands a root-level read glob on a host rooted at the current directory", () =>
    Effect.gen(function*() {
      // `root === ""` is the current-directory host: the workspace root's own
      // spelling is `"."`, the other arm of the enumeration's resolve.
      const files = new Map<string, Uint8Array>([
        ["top.ts", encoder.encode("top")],
        ["src/deep.ts", encoder.encode("deep")]
      ])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          ""
        )
        return yield* sandbox.execute({
          descriptor: descriptor({ readSet: [{ _tag: "Glob", include: ["*.ts"] }] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return {
              top: yield* fs.exists("top.ts"),
              deep: yield* fs.exists("src/deep.ts")
            }
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))
      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.output).toEqual({ top: true, deep: false })
    }))

  it.effect("copies back through a beforeDigest compare-and-set, retaining oversized products by digest", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([["/w/src/in.txt", encoder.encode("seed")]])
      const large = "x".repeat(64)
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w/",
          { maxInlineBytes: 8 }
        )
        const execution = {
          descriptor: descriptor({
            readSet: [read("src/in.txt", "seed"), read("src/absent.txt", "nothing")],
            writeSet: ["out/**", "src/in.txt"]
          }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/large.txt", large)
            yield* fs.writeFileString("out/small.txt", "ok")
            yield* fs.remove("src/in.txt")
            return { done: true }
          })
        }
        const accepted = yield* sandbox.execute(execution)
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        const untouched = new Map(files)
        yield* sandbox.materialize(accepted)
        // A second copy-back of the same bundle now conflicts: the host moved.
        const conflict = yield* Effect.flip(sandbox.materialize(accepted))
        return { accepted, conflict, untouched }
      }).pipe(Effect.provide(hostLayer(files)))

      const { accepted, conflict, untouched } = yield* withCrypto(program)
      expect([...untouched.keys()]).toEqual(["/w/src/in.txt"])
      const large_ = accepted.result.files.find((change) => change.path === "out/large.txt")
      const small = accepted.result.files.find((change) => change.path === "out/small.txt")
      expect(large_?.after).toBeUndefined()
      expect(large_?.afterDigest).toBe(sha256(large))
      expect(small?.after).toBeDefined()
      expect(decoder.decode(files.get("/w/out/large.txt"))).toBe(large)
      expect(decoder.decode(files.get("/w/out/small.txt"))).toBe("ok")
      expect(files.has("/w/src/in.txt")).toBe(false)
      expect(conflict._tag).toBe("@smthrs/engine-store/MaterializationConflict")
    }))

  it.effect("refuses a declared read path that escapes the workspace", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.execute({
          descriptor: descriptor({ readSet: [read("../outside.txt", "x")] }),
          workflow: Effect.succeed(null)
        }))
      }).pipe(Effect.provide(hostLayer(new Map())))

      expect(yield* withCrypto(program)).toMatchObject({ code: "invalid_path" })
    }))

  it.effect("reports a refusing host honestly rather than as an empty read set", () =>
    Effect.gen(function*() {
      const fs = FileSystem.makeNoop({
        // The refusal rides on the call the sandbox actually makes. A
        // declared read is measured with one `readFile`, never an `exists`
        // probe and then a read, and the refusal has to be one the sandbox
        // cannot read as an answer: `NotFound` IS the answer "not there".
        readFile: ((path: string) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: path,
              description: "EIO"
            })
          )) as never
      })
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.execute({
          descriptor: descriptor({ readSet: [read("src/in.txt", "seed")] }),
          workflow: Effect.succeed(null)
        }))
      }).pipe(
        Effect.provide(ArtifactStore.layerMemory.pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(fs))))
      )

      expect(yield* withCrypto(program)).toMatchObject({ code: "host_unavailable" })
    }))

  it.effect("reports an artifact store that refuses retention or resolution as a host failure", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>()
      const fs = FileSystem.makeNoop({
        exists: (path) => Effect.succeed(files.has(String(path))),
        readFile: (path) => Effect.succeed(files.get(String(path))!),
        writeFile: (path, data) => Effect.sync(() => void files.set(String(path), data)),
        makeDirectory: () => Effect.void
      })
      const program = Effect.gen(function*() {
        // An unrooted host: a workspace root of "" leaves boundary paths as the
        // host paths they already are.
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, ArtifactStore.makeNoop(), "", { maxInlineBytes: 0 })
        const refused = yield* Effect.flip(sandbox.execute({
          descriptor: descriptor({ writeSet: ["root.txt"] }),
          workflow: Effect.gen(function*() {
            const inner = yield* FileSystem.FileSystem
            yield* inner.writeFileString("root.txt", "spilled")
            return null
          })
        }))
        const unresolvable = yield* Effect.flip(sandbox.materialize({
          _tag: "Accepted",
          cache: { status: "disabled" },
          violations: [],
          result: {
            output: null,
            effects: [],
            provenance: { baseRevision: "r", inputs: [], outputs: [] },
            files: [{ path: "root.txt", beforeDigest: undefined, afterDigest: sha256("spilled") }]
          }
        }))
        return { refused, unresolvable }
      })

      const { refused, unresolvable } = yield* withCrypto(program)
      expect(refused.message).toContain("artifact store")
      expect(unresolvable.message).toContain("artifact store")
    }))

  it.effect("copies a workspace-root file back without inventing a parent directory", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>()
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          ""
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({ writeSet: ["root.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("root.txt", "top level")
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        yield* sandbox.materialize(accepted)
      }).pipe(Effect.provide(hostLayer(files)))

      yield* withCrypto(program)
      expect(decoder.decode(files.get("root.txt"))).toBe("top level")
    }))

  it.effect("overwrites a declared output that already exists but was never declared as a read", () =>
    Effect.gen(function*() {
      // The seed is the declared READ set, so a write-only output is absent from
      // it while being very much present on the host — the ordinary shape of a
      // second run. Reading "absent from the seed" as "absent from the host"
      // made every such copy-back a conflict the engine could only rebase into
      // the same refusal.
      const files = new Map<string, Uint8Array>([["/w/out/result.txt", encoder.encode("previous")]])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({ writeSet: ["out/result.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/result.txt", "next")
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        yield* sandbox.materialize(accepted)
        return accepted
      }).pipe(Effect.provide(hostLayer(files)))

      const accepted = yield* withCrypto(program)
      expect(accepted.result.files).toMatchObject([
        { path: "out/result.txt", beforeDigest: sha256("previous"), afterDigest: sha256("next") }
      ])
      expect(decoder.decode(files.get("/w/out/result.txt"))).toBe("next")
    }))

  it.effect("omits an unobserved output the body rewrote with the bytes already there", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([["/w/out/result.txt", encoder.encode("same")]])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* sandbox.execute({
          descriptor: descriptor({ writeSet: ["out/result.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/result.txt", "same")
            return null
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.files).toEqual([])
      expect(accepted.result.provenance.outputs).toEqual([])
    }))

  it.effect("refuses copy-back of a bundle whose retained bytes the artifact store cannot serve", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.materialize({
          _tag: "Accepted",
          cache: { status: "disabled" },
          violations: [],
          result: {
            output: null,
            effects: [],
            provenance: { baseRevision: "r", inputs: [], outputs: [] },
            files: [{ path: "out/gone.txt", beforeDigest: undefined, afterDigest: sha256("gone") }]
          }
        }))
      }).pipe(Effect.provide(hostLayer(new Map())))

      expect(yield* withCrypto(program)).toMatchObject({ code: "not_found" })
    }))

  it.effect("resolves the workspace root through the kernel Workspace service", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([["/w/src/in.txt", encoder.encode("seed")]])
      const program = Effect.gen(function*() {
        const sandbox = yield* WorkspaceSandbox.WorkspaceSandbox
        return yield* sandbox.execute({
          descriptor: descriptor({ readSet: [read("src/in.txt", "seed")], writeSet: ["out/copy.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            // An absolute path a body resolved against the real workspace root
            // still lands inside the transaction.
            yield* fs.writeFile("/w/out/copy.txt", yield* fs.readFile("/w/src/in.txt"))
            return null
          })
        })
      }).pipe(
        Effect.provide(
          WorkspaceSandbox.layerFileSystem().pipe(
            Layer.provide(KernelWorkspace.layer("/w")),
            Layer.provide(hostLayer(files))
          )
        )
      )

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.files.map((change) => change.path)).toEqual(["out/copy.txt"])
    }))
})

/**
 * Copy-back checks preconditions before file changes and journals pre-images
 * for in-process rollback. Competing commits wait through rollback, including
 * failures that leave partial changes for the caller to reconcile.
 */
describe("WorkspaceSandbox filesystem host atomicity", () => {
  for (const failRollback of [false, true]) {
    it.effect(`serializes separate sandboxes through ${failRollback ? "a failed rollback" : "apply"}`, () =>
      withCrypto(Effect.gen(function*() {
        let content = encoder.encode("base")
        let writes = 0
        let preflightReads = 0
        let committing = false
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const fs = FileSystem.makeNoop({
          readFile: () =>
            Effect.sync(() => {
              if (committing) preflightReads++
              return content.slice()
            }),
          exists: () => Effect.die("copy-back must not probe directories"),
          makeDirectory: () => Effect.void,
          writeFile: (path, value) =>
            Effect.gen(function*() {
              writes++
              if (writes === 1) {
                if (failRollback) {
                  content = value.slice()
                  return yield* Effect.fail(injected(path))
                }
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              } else if (writes === 2 && failRollback) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* Effect.fail(injected(path))
              }
              content = value.slice()
            })
        })
        const a = WorkspaceSandbox.makeFileSystem(fs, ArtifactStore.makeNoop(), "")
        const b = WorkspaceSandbox.makeFileSystem(fs, ArtifactStore.makeNoop(), "")
        const execute = (sandbox: WorkspaceSandbox.Service, value: string) =>
          sandbox.execute({
            descriptor: descriptor({ readSet: [read("nested/file", "base")], writeSet: ["nested/file"] }),
            workflow: Effect.flatMap(WorkspaceSandbox.Workspace, (ws) =>
              ws.writeFile("nested/file", encoder.encode(value)))
          })
        const first = yield* execute(a, "A")
        const second = yield* execute(b, "B")
        if (first._tag !== "Accepted" || second._tag !== "Accepted") throw new Error("expected accepted executions")
        committing = true
        const running = yield* Effect.forkChild(Effect.exit(a.materialize(first)))
        yield* Deferred.await(entered)
        const competing = yield* Effect.forkChild(Effect.exit(b.materialize(second)))
        // Give the competing fiber a turn while the first host call is held.
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        const readsWhileHeld = preflightReads
        yield* Deferred.succeed(release, undefined)
        const results = [yield* Fiber.join(running), yield* Fiber.join(competing)] as const
        expect(readsWhileHeld).toBe(1)
        expect(results[0]._tag).toBe(failRollback ? "Failure" : "Success")
        if (failRollback && results[0]._tag === "Failure") {
          expect(results[0].cause.reasons.filter(Cause.isFailReason)).toHaveLength(2)
        }
        expect(results[1]._tag).toBe("Failure")
        if (results[1]._tag === "Failure") {
          expect(results[1].cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
            .toMatchObject([{ _tag: "@smthrs/engine-store/MaterializationConflict", paths: ["nested/file"] }])
        }
        expect(decoder.decode(content)).toBe("A")
        expect(writes).toBe(failRollback ? 2 : 1)
      })))
  }

  const faultLayer = (files: Map<string, Uint8Array>, failOn: (call: number) => boolean) => {
    let calls = 0
    const fs = FileSystem.makeNoop({
      exists: (path) => Effect.succeed(files.has(String(path))),
      readFile: (path) => Effect.succeed(files.get(String(path))!),
      writeFile: (path, data) => {
        calls = calls + 1
        return failOn(calls)
          ? Effect.fail(injected(String(path)))
          : Effect.sync(() => void files.set(String(path), data))
      },
      remove: (path) => Effect.sync(() => void files.delete(String(path))),
      makeDirectory: () => Effect.void
    })
    return ArtifactStore.layerMemory.pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(fs)))
  }

  it.effect("restores every applied change when the host refuses the Nth write", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/0del.txt", encoder.encode("DEL-OLD")],
        ["/w/a.txt", encoder.encode("A-OLD")]
      ])
      // Apply order is path-sorted: remove 0del.txt, overwrite a.txt (write 1),
      // create b.txt (write 2, refused). Rollback then re-creates b.txt's
      // absence, restores a.txt's pre-image, and re-writes the removed file.
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({
            readSet: [read("a.txt", "A-OLD"), read("0del.txt", "DEL-OLD")],
            writeSet: ["a.txt", "b.txt", "0del.txt"]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.removeFile("0del.txt")
            yield* workspace.writeFile("a.txt", encoder.encode("A-NEW"))
            yield* workspace.writeFile("b.txt", encoder.encode("B-NEW"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return yield* Effect.flip(sandbox.materialize(accepted))
      }).pipe(Effect.provide(faultLayer(files, (call) => call === 2)))

      const refused = yield* withCrypto(program)
      expect(refused).toMatchObject({ _tag: "@smthrs/engine-store/WorkspaceError", code: "host_unavailable" })
      // The refusing host failure travels whole in `cause`, never flattened
      // into the message.
      expect(String((refused.cause as PlatformError.PlatformError).message)).toContain("injected")
      expect([...files.keys()].sort()).toEqual(["/w/0del.txt", "/w/a.txt"])
      expect(decoder.decode(files.get("/w/0del.txt"))).toBe("DEL-OLD")
      expect(decoder.decode(files.get("/w/a.txt"))).toBe("A-OLD")
    }))

  it.effect("keeps the host untouched when a later change's retained bytes cannot be resolved", () =>
    Effect.gen(function*() {
      // The first change carries its bytes inline and would have landed under a
      // fetch-as-you-apply loop; resolution happens before any byte does.
      const files = new Map<string, Uint8Array>()
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.materialize({
          _tag: "Accepted",
          cache: { status: "disabled" },
          violations: [],
          result: {
            output: null,
            effects: [],
            provenance: { baseRevision: "r", inputs: [], outputs: [] },
            files: [
              {
                path: "aa.txt",
                beforeDigest: undefined,
                afterDigest: sha256("landed"),
                after: encoder.encode("landed")
              },
              { path: "bb.txt", beforeDigest: undefined, afterDigest: sha256("gone") }
            ]
          }
        }))
      }).pipe(Effect.provide(faultLayer(files, () => false)))

      expect(yield* withCrypto(program)).toMatchObject({ code: "not_found" })
      expect(files.size).toBe(0)
    }))

  it.effect("reports both refusals when rollback itself fails", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/a.txt", encoder.encode("A-OLD")],
        ["/w/b.txt", encoder.encode("B-OLD")]
      ])
      // Write 2 (b.txt) is refused, and so is write 3 — the rollback's attempt
      // to restore b.txt's pre-image.
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({
            readSet: [read("a.txt", "A-OLD"), read("b.txt", "B-OLD")],
            writeSet: ["a.txt", "b.txt"]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("a.txt", encoder.encode("A-NEW"))
            yield* workspace.writeFile("b.txt", encoder.encode("B-NEW"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return yield* Effect.exit(sandbox.materialize(accepted))
      }).pipe(Effect.provide(faultLayer(files, (call) => call === 2 || call === 3)))

      const exit = yield* withCrypto(program)
      if (exit._tag !== "Failure") throw new Error("expected the materialize to fail")
      const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
      // Both failures travel: the refused apply write that opened the window,
      // then the rollback that could not close it.
      expect(errors).toHaveLength(2)
      expect(errors[0]).toMatchObject({ code: "host_unavailable" })
      const compound = errors[1]
      expect(compound).toMatchObject({ code: "host_unavailable" })
      expect(compound!.message).toContain("rollback could not restore")
      // The compound rollback cause carries each refusal whole; the injected
      // device failure is reachable through the nested causes rather than
      // stringified away.
      const rollback = compound!.cause as Cause.Cause<WorkspaceSandbox.WorkspaceError>
      const inner = rollback.reasons.filter(Cause.isFailReason).map((reason) => reason.error.cause)
      expect(
        inner.some((cause) => String((cause as PlatformError.PlatformError).message).includes("injected"))
      ).toBe(true)
    }))
})

/**
 * Confinement and the rollback journal against a real filesystem: symlinks
 * only exist here, and so does the directory tree the journal must restore.
 */
describe("WorkspaceSandbox filesystem host confinement", () => {
  const nodeLayer = ArtifactStore.layerMemory.pipe(Layer.provideMerge(NodeFileSystem.layer))

  const temp = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "wsx-root-" })
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "wsx-out-" })
    return { fs, root, outside }
  })

  const write = (
    sandbox: WorkspaceSandbox.Service,
    writes: ReadonlyArray<readonly [path: string, content: string]>,
    writeSet: ReadonlyArray<string>
  ) =>
    Effect.gen(function*() {
      const accepted = yield* sandbox.execute({
        descriptor: descriptor({ writeSet: [...writeSet] }),
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          for (const [path, content] of writes) {
            yield* workspace.writeFile(path, encoder.encode(content))
          }
          return null
        })
      })
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      return accepted
    })

  it.effect("interrupts a lock wait without removing another owner's lock or leaking a permit", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        const lock = `${root}/.smithers-workspace-lock`
        yield* fs.makeDirectory(lock)
        const attempted = yield* Deferred.make<void>()
        const waitingFs: FileSystem.FileSystem = {
          ...fs,
          makeDirectory: (path, options) =>
            fs.makeDirectory(path, options).pipe(
              Effect.tapError(() => Deferred.succeed(attempted, undefined))
            )
        }
        const sandbox = WorkspaceSandbox.makeFileSystem(waitingFs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["file", "new"]], ["file"])
        const waiting = yield* Effect.forkChild(sandbox.materialize(accepted))
        yield* Deferred.await(attempted)
        yield* Fiber.interrupt(waiting)
        expect(yield* fs.exists(lock)).toBe(true)
        expect(yield* fs.exists(`${root}/file`)).toBe(false)
        yield* fs.remove(lock, { recursive: true })
        yield* sandbox.materialize(accepted)
        expect(yield* fs.readFileString(`${root}/file`)).toBe("new")
        expect(yield* fs.exists(lock)).toBe(false)
      })).pipe(Effect.provide(nodeLayer))
    ))

  for (const path of [".smithers-workspace-lock", "alias", "alias/nested"]) {
    it.effect(`reserves the coordination directory through ${path}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          const lock = `${root}/.smithers-workspace-lock`
          yield* fs.symlink(lock, `${root}/alias`)
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
          const accepted = yield* write(sandbox, [[path, "new"]], [path])
          expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({ code: "host_unavailable" })
          expect(yield* fs.exists(lock)).toBe(false)
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  const engineState = (
    sandbox: WorkspaceSandbox.Service,
    path: string,
    boundary: Partial<FileBoundary>
  ) =>
    sandbox.execute({
      descriptor: descriptor(boundary),
      workflow: Effect.gen(function*() {
        const workspace = yield* WorkspaceSandbox.Workspace
        yield* workspace.writeFile("src/app.ts", encoder.encode("export const x = 2\n"))
        yield* workspace.writeFile(path, encoder.encode("REPLACED BY A SEALED STEP BODY"))
        return null
      })
    })

  for (
    const [label, boundary] of [
      ["a broad ** hard write set", { writeSet: [{ _tag: "Glob", include: ["**"] }] }],
      ["an undeclared expected-mode write", { writeSet: ["src/app.ts"], boundaryMode: "expected" }]
    ] as const
  ) {
    it.effect(`reserves the .flows engine state directory under ${label}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          yield* fs.makeDirectory(`${root}/.flows/objects`, { recursive: true })
          yield* fs.makeDirectory(`${root}/src`)
          yield* fs.writeFileString(`${root}/.flows/state.sqlite`, "LIVE ENGINE DATABASE")
          yield* fs.writeFileString(`${root}/src/app.ts`, "export const x = 1\n")
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
          const result = yield* engineState(sandbox, ".flows/state.sqlite", boundary as Partial<FileBoundary>)
          expect(result._tag).toBe("Accepted")
          if (result._tag !== "Accepted") return
          expect(yield* Effect.flip(sandbox.materialize(result))).toMatchObject({
            code: "host_unavailable",
            cause: "the workspace path .flows is reserved"
          })
          expect(yield* fs.readFileString(`${root}/.flows/state.sqlite`)).toBe("LIVE ENGINE DATABASE")
          expect(yield* fs.readFileString(`${root}/src/app.ts`)).toBe("export const x = 1\n")
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.effect("invalidates an undeclared hard-mode engine state write before copy-back", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.makeDirectory(`${root}/.flows`)
        yield* fs.writeFileString(`${root}/.flows/state.sqlite`, "LIVE ENGINE DATABASE")
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const result = yield* engineState(sandbox, ".flows/state.sqlite", { writeSet: ["src/app.ts"] })
        expect(result._tag).toBe("Invalidated")
        expect(yield* fs.readFileString(`${root}/.flows/state.sqlite`)).toBe("LIVE ENGINE DATABASE")
      })).pipe(Effect.provide(nodeLayer))
    ))

  for (const path of ["engine.db", "engine.db-wal", "objects/blob", "alias/blob"]) {
    it.effect(`reserves configured engine state paths through ${path}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          yield* fs.makeDirectory(`${root}/objects`)
          yield* fs.writeFileString(`${root}/engine.db`, "LIVE")
          yield* fs.symlink(`${root}/objects`, `${root}/alias`)
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root, {
            reservedPaths: ["./engine.db", "engine.db-wal", "engine.db-shm", "objects/"]
          })
          const accepted = yield* write(sandbox, [[path, "new"]], [path])
          expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({ code: "host_unavailable" })
          expect(yield* fs.readFileString(`${root}/engine.db`)).toBe("LIVE")
          expect(yield* fs.exists(`${root}/objects/blob`)).toBe(false)
          expect(yield* fs.exists(`${root}/engine.db-wal`)).toBe(false)
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.effect("keeps an unreserved sibling of a reserved name writable", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [[".flowsheet", "ok"]], [".flowsheet"])
        yield* sandbox.materialize(accepted)
        expect(yield* fs.readFileString(`${root}/.flowsheet`)).toBe("ok")
      })).pipe(Effect.provide(nodeLayer))
    ))

  it.effect("reserves lock aliases on unrooted hosts without confining their other symlinks", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        const target = (path: string) => path.startsWith("/") ? path : `${root}/${path}`
        const unrooted: FileSystem.FileSystem = {
          ...fs,
          realPath: (path) => fs.realPath(target(path)),
          readFile: (path) => fs.readFile(target(path)),
          readLink: (path) => fs.readLink(target(path)),
          makeDirectory: (path, options) => fs.makeDirectory(target(path), options),
          remove: (path, options) => fs.remove(target(path), options),
          writeFile: (path, data, options) => fs.writeFile(target(path), data, options)
        }
        yield* fs.symlink(`${root}/.smithers-workspace-lock/nested`, `${root}/alias`)
        yield* fs.symlink(`${outside}/file`, `${root}/external`)
        const sandbox = WorkspaceSandbox.makeFileSystem(unrooted, yield* ArtifactStore.ArtifactStore, "")
        const accepted = yield* write(sandbox, [["alias", "new"]], ["alias"])
        expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({ code: "host_unavailable" })
        const external = yield* write(sandbox, [["external", "allowed"]], ["external"])
        yield* sandbox.materialize(external)
        expect(yield* fs.readFileString(`${outside}/file`)).toBe("allowed")
        expect(yield* fs.exists(`${root}/.smithers-workspace-lock`)).toBe(false)
      })).pipe(Effect.provide(nodeLayer))
    ))

  it.live("serializes copy-back with a separate process and a root alias", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.writeFileString(`${root}/file`, "base")
        const alias = `${outside}/alias`
        yield* fs.symlink(root, alias)
        const contended = yield* Deferred.make<void>()
        const waitingFs: FileSystem.FileSystem = {
          ...fs,
          makeDirectory: (path, options) =>
            fs.makeDirectory(path, options).pipe(
              Effect.tapError(() => Deferred.succeed(contended, undefined))
            )
        }
        const sandbox = WorkspaceSandbox.makeFileSystem(waitingFs, yield* ArtifactStore.ArtifactStore, alias)
        const accepted = yield* write(sandbox, [["file", "B"]], ["file"])
        // The child holds its first data write after acquiring the advisory lock.
        const script = `
        import * as Effect from "effect/Effect";
        import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
        import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
        import * as FileSystem from "effect/FileSystem";
        import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore";
        import * as Sandbox from "./src/WorkspaceSandbox.ts";
        import { createHash } from "node:crypto";
        const root = process.argv[1];
        const bytes = new TextEncoder().encode("A");
        await Effect.runPromise(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const sandbox = Sandbox.makeFileSystem({ ...fs, writeFile: (path, data, options) =>
            Effect.promise(() => new Promise(resolve => {
              process.stdin.once("data", resolve);
              process.stdout.write("applying\\n");
            })).pipe(Effect.andThen(fs.writeFile(path, data, options)))
          }, ArtifactStore.makeNoop(), root);
          yield* sandbox.materialize({ _tag: "Accepted", cache: { status: "disabled" }, violations: [], result: {
            output: null, effects: [], provenance: { baseRevision: "base", inputs: [], outputs: [] },
            files: [{ path: "file", beforeDigest: createHash("sha256").update("base").digest("hex"),
              afterDigest: createHash("sha256").update(bytes).digest("hex"), after: bytes }]
          }});
        }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodeCrypto.layer)));
        process.stdin.destroy();
      `
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script, root], {
              cwd: new URL("..", import.meta.url),
              stdio: ["pipe", "pipe", "pipe"]
            })
          ),
          (child) =>
            Effect.sync(() => {
              child.kill()
            })
        )
        let stderr = ""
        child.stderr.on("data", (data) => {
          stderr += String(data)
        })
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
        yield* Effect.promise(() =>
          new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve())
            child.once("error", reject)
            child.once("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)))
          })
        )
        const running = yield* Effect.forkChild(Effect.exit(sandbox.materialize(accepted)))
        yield* Deferred.await(contended)
        expect(yield* fs.readFileString(`${root}/file`)).toBe("base")
        child.stdin.write("release")
        expect(yield* Effect.promise(() => exited)).toBe(0)
        const result = yield* Fiber.join(running)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
            .toMatchObject([{ _tag: "@smthrs/engine-store/MaterializationConflict", paths: ["file"] }])
        }
        expect(yield* fs.readFileString(`${root}/file`)).toBe("A")
        expect(yield* fs.exists(`${root}/.smithers-workspace-lock`)).toBe(false)
      })).pipe(Effect.provide(nodeLayer))
    ))

  it.effect("refuses to write through a file symlink whose target escapes the root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.writeFileString(`${outside}/notes.txt`, "OUTSIDE-ORIGINAL")
        yield* fs.symlink(`${outside}/notes.txt`, `${root}/notes.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["notes.txt", "PWNED"]], ["notes.txt"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return {
          refused,
          outsideContent: yield* fs.readFileString(`${outside}/notes.txt`),
          stillLink: (yield* fs.readLink(`${root}/notes.txt`)) === `${outside}/notes.txt`
        }
      })).pipe(Effect.provide(nodeLayer))

      const { outsideContent, refused, stillLink } = yield* withCrypto(program)
      expect(refused).toMatchObject({
        _tag: "@smthrs/engine-store/WorkspaceError",
        code: "path_escapes_workspace"
      })
      expect(outsideContent).toBe("OUTSIDE-ORIGINAL")
      expect(stillLink).toBe(true)
    }))

  it.effect("refuses a write redirected by a directory symlink and creates nothing outside", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.makeDirectory(`${outside}/dir`)
        yield* fs.symlink(`${outside}/dir`, `${root}/out`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["out/planted.txt", "PWNED"]], ["out/**"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return { refused, outsideEntries: yield* fs.readDirectory(`${outside}/dir`) }
      })).pipe(Effect.provide(nodeLayer))

      const { outsideEntries, refused } = yield* withCrypto(program)
      expect(refused).toMatchObject({ code: "path_escapes_workspace" })
      expect(outsideEntries).toEqual([])
    }))

  it.effect("refuses a dangling symlink whose referent would land outside the root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.symlink(`${outside}/newfile.txt`, `${root}/dangle.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["dangle.txt", "PWNED"]], ["dangle.txt"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return { refused, created: yield* fs.exists(`${outside}/newfile.txt`) }
      })).pipe(Effect.provide(nodeLayer))

      const { created, refused } = yield* withCrypto(program)
      expect(refused).toMatchObject({ code: "path_escapes_workspace" })
      expect(created).toBe(false)
    }))

  it.effect("refuses a dangling symlink that climbs above the filesystem root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.symlink(`${"../".repeat(40)}escape.txt`, `${root}/up.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["up.txt", "PWNED"]], ["up.txt"])
        return yield* Effect.flip(sandbox.materialize(accepted))
      })).pipe(Effect.provide(nodeLayer))

      expect(yield* withCrypto(program)).toMatchObject({ code: "path_escapes_workspace" })
    }))

  it.effect("refuses an unresolvable chain of dangling symlinks", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        for (let index = 1; index <= 10; index++) {
          yield* fs.symlink(`link${index + 1}.txt`, `${root}/link${index}.txt`)
        }
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["link1.txt", "PWNED"]], ["link1.txt"])
        return yield* Effect.flip(sandbox.materialize(accepted))
      })).pipe(Effect.provide(nodeLayer))

      expect(yield* withCrypto(program)).toMatchObject({ code: "path_escapes_workspace" })
    }))

  it.effect("materializes through symlinks that stay inside the root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.writeFileString(`${root}/real.txt`, "old")
        yield* fs.symlink("real.txt", `${root}/link.txt`)
        // A dangling link whose referent normalizes to a path inside the root:
        // writing through it creates the referent, still inside the tree.
        yield* fs.makeDirectory(`${root}/sub`)
        yield* fs.symlink("./sub/../fresh.txt", `${root}/l2.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(
          sandbox,
          [
            ["link.txt", "via-link"],
            ["l2.txt", "via-dangle"],
            ["sub/inside.txt", "inside"],
            ["plain/new.txt", "plain"]
          ],
          ["link.txt", "l2.txt", "sub/**", "plain/**"]
        )
        yield* sandbox.materialize(accepted)
        return {
          real: yield* fs.readFileString(`${root}/real.txt`),
          stillLink: yield* fs.readLink(`${root}/link.txt`),
          fresh: yield* fs.readFileString(`${root}/fresh.txt`),
          inside: yield* fs.readFileString(`${root}/sub/inside.txt`),
          plain: yield* fs.readFileString(`${root}/plain/new.txt`)
        }
      })).pipe(Effect.provide(nodeLayer))

      const { fresh, inside, plain, real, stillLink } = yield* withCrypto(program)
      expect(real).toBe("via-link")
      expect(stillLink).toBe("real.txt")
      expect(fresh).toBe("via-dangle")
      expect(inside).toBe("inside")
      expect(plain).toBe("plain")
    }))

  it.effect("rolls back files without recursively deleting directories a concurrent writer may own", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.writeFileString(`${root}/a.txt`, "old-a")
        yield* fs.makeDirectory(`${root}/sub`)
        yield* fs.writeFileString(`${root}/sub/keep.txt`, "keep")
        const failing: FileSystem.FileSystem = {
          ...fs,
          writeFile: (path, data, options) =>
            path.endsWith("poison.txt")
              ? fs.writeFileString(`${root}/q/concurrent.txt`, "concurrent").pipe(
                Effect.andThen(Effect.fail(injected(path)))
              )
              : fs.writeFile(path, data, options)
        }
        const sandbox = WorkspaceSandbox.makeFileSystem(failing, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(
          sandbox,
          [
            ["a.txt", "new-a"],
            ["b.txt", "new-b"],
            ["q/deep/poison.txt", "never"],
            ["sub/inside.txt", "never"]
          ],
          ["a.txt", "b.txt", "q/**", "sub/**"]
        )
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return {
          refused,
          a: yield* fs.readFileString(`${root}/a.txt`),
          bExists: yield* fs.exists(`${root}/b.txt`),
          qExists: yield* fs.exists(`${root}/q`),
          concurrent: yield* fs.readFileString(`${root}/q/concurrent.txt`),
          keep: yield* fs.readFileString(`${root}/sub/keep.txt`),
          insideExists: yield* fs.exists(`${root}/sub/inside.txt`)
        }
      })).pipe(Effect.provide(nodeLayer))

      const { a, bExists, concurrent, insideExists, keep, qExists, refused } = yield* withCrypto(program)
      expect(refused).toMatchObject({ code: "host_unavailable" })
      expect(String((refused.cause as PlatformError.PlatformError).message)).toContain("injected")
      expect(a).toBe("old-a")
      expect(bExists).toBe(false)
      expect(qExists).toBe(true)
      expect(concurrent).toBe("concurrent")
      expect(keep).toBe("keep")
      expect(insideExists).toBe(false)
    }))
})
