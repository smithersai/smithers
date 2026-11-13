import { Cause, Effect } from "effect"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Evaluation from "../src/evaluation/Evaluation.ts"

const collision = "00000000-0000-4000-8000-000000000000"
const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-evaluation-publication-"))
  roots.push(root)
  return root
}

const withFiles = <A>(
  decorate: (files: Evaluation.ArtifactFilesService) => Evaluation.ArtifactFilesService,
  operation: Effect.Effect<A, unknown>
) =>
  Effect.runPromise(
    Effect.flatMap(Evaluation.ArtifactFiles, (files) =>
      operation.pipe(Effect.provideService(Evaluation.ArtifactFiles, decorate(files))))
  )

describe("evaluation artifact publication ownership", () => {
  it.each(["write", "close"] as const)("closes its handle and never publishes after a %s failure", async (phase) => {
    const root = await fixture()
    const destination = join(root, "result.json")
    let closed = 0
    await expect(withFiles((files) => ({
      ...files,
      open: (file) =>
        Effect.map(files.open(file), (handle) => ({
          write: (source) =>
            phase === "write"
              ? Effect.andThen(
                handle.write("partial JSON"),
                Effect.fail(Object.assign(new Error("disk full"), { code: "ENOSPC" }))
              )
              : handle.write(source),
          close: Effect.andThen(
            handle.close,
            Effect.suspend(() => {
              closed++
              return phase === "close"
                ? Effect.fail(Object.assign(new Error("close failed"), { code: "EIO" }))
                : Effect.void
            })
          )
        }))
    }), Evaluation.publishJson(destination, "{\"complete\":true}"))).rejects.toMatchObject({
      code: phase === "write" ? "ENOSPC" : "EIO"
    })
    expect(closed).toBe(1)
    expect(await readdir(root)).toEqual([])
  })

  it("preserves an existing cancellation reason without creating an artifact directory", async () => {
    const root = await fixture()
    const controller = new AbortController()
    const reason = new Error("cancelled before publication")
    controller.abort(reason)
    await expect(Evaluation.writeJson(join(root, "new", "result.json"), "complete", false, controller.signal))
      .rejects.toBe(reason)
    expect(await readdir(root)).toEqual([])
  })

  it("checks cancellation after writing and closes and removes its unpublished temporary file", async () => {
    const root = await fixture()
    const controller = new AbortController()
    let closed = 0
    await expect(withFiles((files) => ({
      ...files,
      open: (file) =>
        Effect.map(files.open(file), (handle) => ({
          ...handle,
          close: Effect.andThen(
            handle.close,
            Effect.sync(() => {
              closed++
              controller.abort()
            })
          )
        }))
    }), Evaluation.publishJson(join(root, "result.json"), "complete", false, controller.signal))).rejects.toBeDefined()
    expect(closed).toBe(1)
    expect(await readdir(root)).toEqual([])
  })

  it("reports cleanup failure without damaging the completely published artifact", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    const source = "{\"complete\":true}"
    let temporary = ""
    await expect(withFiles((files) => ({
      ...files,
      remove: (file) => {
        temporary = file
        return Effect.fail(Object.assign(new Error("cleanup denied"), { code: "EACCES" }))
      }
    }), Evaluation.publishJson(destination, source))).rejects.toMatchObject({ code: "EACCES" })
    expect(await readFile(destination, "utf8")).toBe(source)
    expect(await readFile(temporary, "utf8")).toBe(source)
  })

  it("never removes a pre-existing temporary file after exclusive creation fails", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    const temporary = `${destination}.${collision}.tmp`
    await writeFile(temporary, "another writer owns these bytes")
    await expect(
      withFiles(
        (files) => ({ ...files, temporaryId: Effect.succeed(collision) }),
        Evaluation.publishJson(destination, "new result")
      )
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(temporary, "utf8")).toBe("another writer owns these bytes")
    expect(await readdir(root)).toEqual([`result.json.${collision}.tmp`])
  })

  it("does not unlink a pre-existing symbolic temporary path or alter its target", async () => {
    const root = await fixture()
    const original = join(root, "original.json")
    const destination = join(root, "result.json")
    const temporary = `${destination}.${collision}.tmp`
    await writeFile(original, "original")
    await symlink(original, temporary)
    await expect(
      withFiles(
        (files) => ({ ...files, temporaryId: Effect.succeed(collision) }),
        Evaluation.publishJson(destination, "replacement", true)
      )
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(temporary, "utf8")).toBe("original")
    expect(await readFile(original, "utf8")).toBe("original")
  })

  it("cleans its own temporary file when publication fails", async () => {
    const root = await fixture()
    const destination = join(root, "result.json")
    await mkdir(destination)
    await expect(Evaluation.writeJson(destination, "new result", true)).rejects.toBeDefined()
    expect(await readdir(root)).toEqual(["result.json"])
    expect(await readdir(destination)).toEqual([])
  })

  it.each([0, 65_536])("keeps a complete winner when both writers reach publication (payload=%s)", async (size) => {
    const root = await fixture()
    const destination = join(root, "result.json")
    const sources = [JSON.stringify({ writer: 1, data: "a".repeat(size) }), JSON.stringify({ writer: 2 })]
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const publications: string[] = []
    const running = withFiles(
      (files) => ({
        ...files,
        publish: (temporary, file, overwrite) =>
          Effect.gen(function*() {
            publications.push(temporary)
            if (publications.length === 2) ready.resolve()
            yield* Effect.promise(() => release.promise)
            yield* files.publish(temporary, file, overwrite)
          })
      }),
      Effect.all(
        sources.map((source) =>
          Effect.exit(Evaluation.publishJson(destination, source)).pipe(
            Effect.tap(() => Effect.sync(() => stopped.resolve()))
          )
        ),
        {
          concurrency: "unbounded"
        }
      )
    )
    try {
      // Both complete, independently owned temporary files must exist before
      // either writer may attempt the destination's atomic no-replace operation.
      await Promise.race([
        ready.promise,
        stopped.promise.then(() => {
          throw new Error("a writer stopped before publication")
        })
      ])
      expect(new Set(publications).size).toBe(2)
      expect(await Promise.all(publications.map((file) => readFile(file, "utf8")))).toEqual(
        expect.arrayContaining(sources)
      )
      expect(await readdir(root)).toHaveLength(2)
    } finally {
      release.resolve()
      await running
    }
    const results = await running
    const successes = results.flatMap((result, index) => result._tag === "Success" ? [index] : [])
    expect(successes).toHaveLength(1)
    const failure = results.find((result) => result._tag === "Failure")
    expect(failure).toBeDefined()
    if (failure?._tag === "Failure") {
      expect(Cause.squash(failure.cause)).toMatchObject({ code: "EEXIST" })
    }
    expect(await readFile(destination, "utf8")).toBe(sources[successes[0]!])
    expect(await readdir(root)).toEqual(["result.json"])
  })

  it("refuses symlink replacement by default and replaces only the link when explicitly forced", async () => {
    const root = await fixture()
    const original = join(root, "original.json")
    const destination = join(root, "result.json")
    await writeFile(original, "original")
    await symlink(original, destination)
    await expect(Evaluation.writeJson(destination, "new result")).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(original, "utf8")).toBe("original")
    await Evaluation.writeJson(destination, "new result", true)
    expect(await readFile(destination, "utf8")).toBe("new result")
    expect(await readFile(original, "utf8")).toBe("original")
    expect((await readdir(root)).sort()).toEqual(["original.json", "result.json"])
  })
})
