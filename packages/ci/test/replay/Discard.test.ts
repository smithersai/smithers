/**
 * `discard`: what a replay that could not end by itself is owed. It removes a work directory whole, also where a step
 * left a directory it took the write permission from.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { discard, fresh, removeTree, renew } from "../../src/replay/Confine.vibe"
import { keptRemoving } from "./Dying.vibe"
import { placeIn } from "./place.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

it("removes a work directory whole, with a directory a step left read-only in it", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-discard-"))
  roots.push(root)
  const work = join(root, "work")
  const locked = join(work, "step", "locked")
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, "left"), "a step's file\n")
  chmodSync(locked, 0o500)
  await Effect.runPromise(discard(work).pipe(Effect.provide(NodeServices.layer)))
  expect(existsSync(work)).toBe(false)
})

it("preserves the result and reports a failed cleanup once when progress is available", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-discard-"))
  roots.push(root)
  const work = join(root, "work")
  const lines: Array<string> = []
  const run = (say?: (line: string) => Effect.Effect<void>) =>
    Effect.runPromise(
      discard(work, say).pipe(Effect.provide(keptRemoving), Effect.provide(NodeServices.layer))
    )
  mkdirSync(work)
  await run((line) => Effect.sync(() => void lines.push(line)))
  mkdirSync(work)
  await run()
  expect(lines).toEqual([`smithers-ci: replay left a directory it could not remove: ${work}`])
})

it("says nothing and fails nothing where the directory is gone already", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-discard-"))
  roots.push(root)
  await Effect.runPromise(discard(join(root, "never-made")).pipe(Effect.provide(NodeServices.layer)))
  expect(existsSync(join(root, "never-made"))).toBe(false)
})

it.each([fresh, removeTree])("refuses a linked machine ancestor and preserves the sentinel", async (clean) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-cleanup-"))
  roots.push(root)
  const work = join(root, "work")
  const machines = join(work, "machines")
  const sentinel = join(root, "sentinel")
  const home = join(sentinel, "home")
  mkdirSync(machines, { recursive: true })
  mkdirSync(home, { recursive: true })
  const file = join(home, "keep")
  writeFileSync(file, "intact", { mode: 0o400 })
  const link = join(machines, "job")
  symlinkSync(sentinel, link)
  const mode = lstatSync(home).mode
  await expect(
    Effect.runPromise(clean(join(link, "home"), work).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  )
    .rejects.toThrow("replay cleanup refused a symlink")
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  expect(lstatSync(home).mode).toBe(mode)
  expect(lstatSync(file).mode & 0o777).toBe(0o400)
  expect(readFileSync(file, "utf8")).toBe("intact")
})

it("refuses a dangling link before creating a directory and an operand outside the cleanup root", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-cleanup-"))
  roots.push(root)
  const work = join(root, "work")
  mkdirSync(work)
  const link = join(work, "leaf")
  const missing = join(root, "absent")
  symlinkSync(missing, link)
  const clean = (dir: string) =>
    Effect.runPromise(fresh(dir, work).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  await expect(clean(link)).rejects.toThrow("replay cleanup refused a symlink")
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  await expect(clean(missing)).rejects.toThrow("outside its work directory")
  await expect(clean(`${work}/absent/../leaf`)).rejects.toThrow("outside its work directory")
  expect(existsSync(missing)).toBe(false)
})

it("propagates a failed path inspection before cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-cleanup-"))
  roots.push(root)
  const file = join(root, "file")
  writeFileSync(file, "keep")
  await expect(Effect.runPromise(removeTree(join(file, "child"), root).pipe(Effect.provide(NodeServices.layer))))
    .rejects.toMatchObject({ _tag: "PlatformError" })
  expect(readFileSync(file, "utf8")).toBe("keep")
})

it("scopes a fresh root and renews a place whose old temporary directory is already gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-cleanup-"))
  roots.push(root)
  const work = join(root, "work")
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      yield* fresh(work)
      const place = placeIn(work)
      rmSync(place.tmp, { recursive: true })
      yield* renew(place)
      expect(lstatSync(place.tmp).isDirectory()).toBe(true)
      expect(existsSync(join(place.home, ".gitconfig"))).toBe(true)
    })).pipe(Effect.provide(NodeServices.layer))
  )
  expect(existsSync(work)).toBe(false)
})

it("completes cleanup when another removal finishes before the recursive fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-cleanup-"))
  roots.push(root)
  const work = join(root, "work")
  mkdirSync(work)
  const busy = PlatformError.systemError({
    _tag: "Busy",
    module: "FileSystem",
    method: "remove",
    pathOrDescriptor: work
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* removeTree(work).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          remove: (path, options) => fs.remove(path, options).pipe(Effect.andThen(Effect.fail(busy)))
        }),
        Effect.provideService(ChildProcessSpawner, makeSpawner(() => Effect.die("unexpected rm fallback")))
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )
  expect(existsSync(work)).toBe(false)
})
