import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Logger, Metric, Path, Stream, Tracer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import type * as Scope from "effect/Scope"
import { describe, expect, it } from "vitest"
import * as Repo from "../src/internal/memory/repo.vibe"
import * as Wiki from "../src/internal/memory/wiki.vibe"
import * as Memory from "../src/Memory.ts"
import * as MemoryCalibration from "../src/MemoryCalibration.vibe"

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path | ChildProcessSpawner>) =>
  Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

const fixture = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped()
    for (const [name, value] of Object.entries(files)) {
      const file = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, value)
    }
    return root
  })

const commandFailure = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "ChildProcess",
  method: "spawn"
})

const catalog = (pages: ReadonlyArray<unknown>) => JSON.stringify({ pages })
const page = { id: "guide", document: "docs/guide.md" }

describe("memory reader regressions", () => {
  it("returns no tree or head when the repository disappears during resolution", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({ "local.ts": "local" })
      const fs = yield* FileSystem.FileSystem
      const missing = FileSystem.make({
        ...fs,
        realPath: (file) =>
          file === root
            ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "realPath" }))
            : fs.realPath(file)
      })
      const tree = yield* Repo.tree(root).pipe(
        Effect.provideService(FileSystem.FileSystem, missing),
        Effect.provideService(ChildProcessSpawner, makeSpawner(() => Effect.fail(commandFailure)))
      )
      expect([...tree]).toEqual([["", { dirs: [], files: [] }]])
      expect(
        yield* Repo.head(root, "local.ts", 100).pipe(
          Effect.provideService(FileSystem.FileSystem, missing)
        )
      ).toBeUndefined()
    })))

  it("uses initial thresholds when the resolved thresholds file disappears before reading", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({ [MemoryCalibration.file]: JSON.stringify(MemoryCalibration.initial) })
      const fs = yield* FileSystem.FileSystem
      let reads = 0
      const missing = FileSystem.make({
        ...fs,
        readFile: () =>
          Effect.suspend(() => {
            reads++
            return Effect.fail(PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFile"
            }))
          })
      })
      expect(
        yield* Memory.thresholds(root).pipe(
          Effect.provideService(FileSystem.FileSystem, missing)
        )
      ).toEqual(MemoryCalibration.initial)
      expect(reads).toBe(1)
    })))

  it("keeps threshold containment failures distinct from filesystem read failures", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({ [MemoryCalibration.file]: JSON.stringify(MemoryCalibration.initial) })
      const outside = yield* fixture({ "thresholds.json": JSON.stringify(MemoryCalibration.initial) })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(root, MemoryCalibration.file)
      yield* fs.remove(file)
      yield* fs.symlink(path.join(outside, "thresholds.json"), file)
      const escaped = yield* Effect.flip(Memory.thresholds(root))
      expect(escaped.code).toBe("thresholds_invalid")
      expect(escaped.message).toContain("outside the repository root")
      yield* fs.remove(file)
      yield* fs.writeFileString(file, JSON.stringify(MemoryCalibration.initial))
      const denied = FileSystem.make({
        ...fs,
        realPath: (file) =>
          file === root
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "realPath"
            }))
            : fs.realPath(file)
      })
      const failed = yield* Effect.flip(
        Memory.thresholds(root).pipe(
          Effect.provideService(FileSystem.FileSystem, denied)
        )
      )
      expect(failed.code).toBe("read_failed")
      expect(failed.message).toContain("PermissionDenied")
    })))

  it("flushes incomplete command bytes and isolates the next command's UTF-8 state", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({})
      const first = yield* Repo.run(process.execPath, ["-e", "process.stdout.write(new Uint8Array([0xe2]))"], root)
      const second = yield* Repo.run(
        process.execPath,
        ["-e", "process.stdout.write(new Uint8Array([0x82, 0xac]))"],
        root
      )
      expect([first, second]).toEqual(["�", "��"])
    })))

  it("decodes split UTF-8 from real concurrent commands", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({})
      const spawner = yield* ChildProcessSpawner
      // Fragment real process output at every byte, including multibyte code points.
      const fragmented = makeSpawner((command) =>
        spawner.spawn(command).pipe(Effect.map((handle) => ({
          ...handle,
          stdout: handle.stdout.pipe(Stream.flatMap((chunk) =>
            Stream.fromIterable(chunk).pipe(
              Stream.map((byte) => new Uint8Array([byte]))
            )
          ))
        })))
      )
      const output = yield* Effect.all(
        ["€", "雪"].map((value) =>
          Repo.run(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(value)})`], root)
        ),
        { concurrency: 2 }
      ).pipe(Effect.provideService(ChildProcessSpawner, fragmented))
      expect(output).toEqual(["€", "雪"])
    })))

  it("skips file heads behind an outward parent symlink, including sibling-prefix paths", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({ "repo/local.ts": "local", "repo-outside/secret.ts": "private" })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = path.join(root, "repo")
      yield* fs.symlink(path.join(root, "repo-outside"), path.join(repo, "linked"))
      for (const denied of ["skip", "fail"] as const) {
        expect(yield* Repo.head(repo, "linked/secret.ts", 100, { denied })).toBeUndefined()
      }
      expect(yield* Repo.head(repo, "local.ts", 100)).toBe("local")
    })))

  it.each([".git", ".jj"])(
    "does not walk untracked or ignored files after command failures in a %s repository",
    (marker) =>
      run(Effect.gen(function*() {
        const root = yield* fixture({
          [`${marker}/marker`]: "repository metadata",
          ".gitignore": "sub/ignored.json\n",
          "sub/ignored.json": "private",
          "sub/untracked.ts": "draft"
        })
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const aliasRoot = yield* fixture({})
        const alias = path.join(aliasRoot, "sub")
        yield* fs.symlink(path.join(root, "sub"), alias)
        const refused = makeSpawner(() => Effect.fail(commandFailure))
        const logs: Array<unknown> = []
        const spans: Array<string> = []
        const counter = Metric.counter("memory.repo.listing_unavailable")
        const before = yield* Metric.value(counter)
        for (const location of [root, path.join(root, "sub"), alias]) {
          const tree = yield* Repo.tree(location).pipe(
            Effect.provideService(ChildProcessSpawner, refused),
            Effect.provide(
              Logger.layer([Logger.make((entry) => logs.push(entry.message))], { mergeWithExisting: false })
            ),
            Effect.updateService(Tracer.Tracer, (inner) =>
              Tracer.make({
                ...inner,
                span(options) {
                  spans.push(options.name)
                  return inner.span(options)
                }
              }))
          )
          expect([...tree]).toEqual([["", { dirs: [], files: [] }]])
        }
        expect(logs).toEqual(Array.from({ length: 3 }, () => ["memory.repo.listing_unavailable"]))
        expect(spans).toEqual(Array.from({ length: 3 }, () => "memory.repo.listing_unavailable"))
        expect((yield* Metric.value(counter)).count).toBe(before.count + 3)
      }))
  )

  it("recognizes a git worktree marker file after command failures", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({ ".git": "gitdir: elsewhere", "untracked.ts": "private" })
      const tree = yield* Repo.tree(root).pipe(
        Effect.provideService(ChildProcessSpawner, makeSpawner(() => Effect.fail(commandFailure)))
      )
      expect([...tree]).toEqual([["", { dirs: [], files: [] }]])
    })))

  it("skips null and other malformed catalog entries while loading valid pages", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({
        ".smithers/coding-project.json": catalog([null, 7, false, "bad", [], page]),
        "docs/guide.md": "Guide"
      })
      expect(yield* Wiki.catalog(root)).toEqual([{
        kind: "page",
        id: "guide",
        title: "guide",
        text: "Guide",
        inputs: []
      }])
    })))

  it("parses a complete catalog larger than the page byte budget", () =>
    run(Effect.gen(function*() {
      const specs = Array.from({ length: 800 }, (_, index) => ({ ...page, id: `guide-${index}` }))
      expect(new TextEncoder().encode(catalog(specs)).length).toBeGreaterThan(Wiki.pageBytes)
      const root = yield* fixture({ ".smithers/coding-project.json": catalog(specs), "docs/guide.md": "Guide" })
      const pages = yield* Wiki.catalog(root)
      expect(pages.map((page) => page.id)).toEqual(specs.map((spec) => spec.id))
    })))

  it("bounds actual page I/O before decoding or truncation", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture({
        ".smithers/coding-project.json": catalog([page]),
        "docs/guide.md": `${"a".repeat(Wiki.pageBytes - 1)}€${"z".repeat(1024 * 1024)}`
      })
      const fs = yield* FileSystem.FileSystem
      let readBytes = 0
      const measured = FileSystem.make({
        ...fs,
        readFile: (file) =>
          fs.readFile(file).pipe(Effect.tap((bytes) =>
            Effect.sync(() => {
              if (file.endsWith("guide.md")) readBytes += bytes.byteLength
            })
          )),
        open: (file, options) =>
          fs.open(file, options).pipe(Effect.map((handle) => ({
            ...handle,
            readAlloc: (size) =>
              handle.readAlloc(size).pipe(Effect.tap((bytes) =>
                Effect.sync(() => {
                  if (file.endsWith("guide.md") && bytes._tag === "Some") readBytes += bytes.value.byteLength
                })
              ))
          })))
      })
      const pages = yield* Wiki.catalog(root).pipe(Effect.provideService(FileSystem.FileSystem, measured))
      expect(pages[0]?.text).toBe("a".repeat(Wiki.pageBytes - 1))
      expect(readBytes).toBeLessThanOrEqual(Wiki.pageBytes)
      expect(readBytes).toBeGreaterThan(0)
    })))
})
