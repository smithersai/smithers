/**
 * The boundary declaration's own invariant: a path cannot be both promised and
 * disclaimed.
 *
 * `removes` exists because an absent declared write is a DEFECT — recording it
 * as valid evidence caches the claim "this file should not exist", which a
 * later replay acts on by deleting the path. Declaring the removal is what
 * makes the absence legitimate, and that only means anything while the two
 * sets stay disjoint.
 */
import { FileBoundary } from "@smthrs/flow/FileBoundary"
import { FileSet } from "@smthrs/plan"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

const decode = Schema.decodeUnknownResult(FileBoundary)

const expectSchemaFailure = (input: unknown) => {
  const result = decode(input)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure).toMatchObject({ _tag: "SchemaError" })
}

describe("FileBoundary", () => {
  it("accepts workspace-relative measured-file spellings alongside Pattern fields", () => {
    const measured = decode({
      readSet: [
        { path: "src\\windows.ts", digest: "c" },
        { path: "资料/输入.ts", digest: "d" },
        { path: "资料/输入.ts", digest: "d" }
      ],
      writeSet: ["dist\\windows.js", "资料/输出.js", "资料/输出.js"],
      removes: ["旧/输出.js"],
      boundaryMode: "hard"
    })

    expect(measured._tag).toBe("Success")
  })

  it("rejects empty measured fields and unsafe writable path spellings", () => {
    for (const readSet of [[{ path: "", digest: "x" }], [{ path: "a", digest: "" }]]) {
      expectSchemaFailure({ readSet, writeSet: [], boundaryMode: "hard" })
    }
    for (const path of ["", "/absolute", "C:\\absolute", ".", "..", "a/./b", "a/../b", "a//b"]) {
      // A measured read is a declared path like any other: the sandbox refuses
      // these spellings at prepare time, so the boundary refuses them up front.
      expectSchemaFailure({ readSet: [{ path, digest: "x" }], writeSet: [], boundaryMode: "hard" })
      expectSchemaFailure({ readSet: [], writeSet: [path], boundaryMode: "hard" })
      expectSchemaFailure({ readSet: [], writeSet: [], removes: [path], boundaryMode: "hard" })
      expectSchemaFailure({
        readSet: [{ _tag: "Glob", include: [path] }],
        writeSet: [],
        boundaryMode: "hard"
      })
      expectSchemaFailure({
        readSet: [],
        writeSet: [{ _tag: "TreeArtifact", path }],
        boundaryMode: "hard"
      })
    }
  })

  it("accepts a very large declaration set without truncating entries", () => {
    const writeSet = Array.from({ length: 10_000 }, (_, index) => `generated/${index}.js`)
    const decoded = decode({ readSet: [], writeSet, boundaryMode: "expected" })

    expect(decoded._tag).toBe("Success")
    if (decoded._tag === "Success") expect(decoded.success.writeSet).toHaveLength(writeSet.length)
  })

  // Backslash and slash spellings denote one workspace path, so overlap
  // compares them in FileSet's canonical separator form.
  it("normalizes Windows and POSIX separator spellings when comparing overlaps", () => {
    expect(FileSet.overlaps("dist\\same.js", "dist/same.js")).toBe(true)
  })

  it("rejects separator variants of the same written and removed path", () => {
    expectSchemaFailure({
      readSet: [],
      writeSet: ["dist\\same.js"],
      removes: ["dist/same.js"],
      boundaryMode: "hard"
    })
  })

  it("decodes a boundary that declares no removals, and defaults it to absent", () => {
    const decoded = decode({ readSet: [], writeSet: ["out.js"], boundaryMode: "hard" })
    expect(decoded._tag).toBe("Success")
    // Optional with no default value materialized: rows persisted before
    // `removes` existed decode unchanged, which is the whole point of it being
    // optional rather than required-with-`[]`.
    expect((decoded as { success: FileBoundary }).success.removes).toBeUndefined()
  })

  it("decodes disjoint writes and removals", () => {
    const decoded = decode({
      readSet: [{ path: "src/a.ts", digest: "a" }],
      writeSet: ["out.js"],
      removes: ["stale.js"],
      boundaryMode: "expected"
    })
    expect(decoded._tag).toBe("Success")
  })

  it("decodes read globs and tree outputs while rejecting upward traversal", () => {
    expect(
      decode({
        readSet: [{ _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/generated.ts"] }],
        writeSet: [{ _tag: "TreeArtifact", path: "dist" }],
        boundaryMode: "hard"
      })._tag
    ).toBe("Success")
    expect(
      decode({
        readSet: [{ _tag: "Glob", include: ["../secret"] }],
        writeSet: [],
        boundaryMode: "hard"
      })._tag
    ).toBe("Failure")
  })

  it("refuses a path that is both written and removed", () => {
    const decoded = decode({
      readSet: [],
      writeSet: ["out.js", "both.js"],
      removes: ["both.js"],
      boundaryMode: "hard"
    })
    expect(decoded._tag).toBe("Failure")
  })

  it("refuses removals covered by a write glob or tree artifact", () => {
    expect(
      decode({
        readSet: [],
        writeSet: [{ _tag: "Glob", include: ["dist/**"] }],
        removes: ["dist/a.js"],
        boundaryMode: "hard"
      })._tag
    ).toBe("Failure")
    expect(
      decode({
        readSet: [],
        writeSet: [{ _tag: "TreeArtifact", path: "dist" }],
        removes: ["dist/a.js"],
        boundaryMode: "hard"
      })._tag
    ).toBe("Failure")
  })
})
