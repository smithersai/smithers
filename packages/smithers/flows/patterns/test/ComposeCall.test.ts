import { describe, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"

const sourceDirectory = join(fileURLToPath(new URL("../", import.meta.url)), "src")

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })

const adapter = /\(flow as unknown as \(input: unknown\) => Node\.Node<unknown, unknown>\)\(input\)/

// `internal/Compose.ts` owns the one cast from the public `Flow.Any` type to its
// callable representation. A pattern module that repeats the cast locally forks
// that unsafe boundary, so ownership is pinned here rather than in prose.
describe("Flow.Any call adapter", () => {
  it("is cast in internal/Compose.ts alone", () => {
    const owners = sourceFiles(sourceDirectory)
      .filter((path) => adapter.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(sourceDirectory.length + 1))
      .sort()

    expect(owners).toEqual([join("internal", "Compose.ts")])
  })
})
