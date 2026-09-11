/**
 * The error vocabulary and the page that documents it.
 *
 * @since 1.0.0-rc.0
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { SyncError } from "../src/SyncError.ts"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

/** The literals in `errorCodes`, which is private to the module. */
const declared = (): ReadonlyArray<string> => {
  const list = read("../src/SyncError.ts").match(/const errorCodes = \[([^\]]*)\]/u)?.[1]
  expect(list, "src/SyncError.ts declares errorCodes").toBeDefined()
  return [...list!.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]!)
}

/**
 * Every code a `SyncError` in `src` is constructed with. The scan reads
 * literals only, and the one code that is computed comes from
 * `internal/JournalErrorCode.ts`, which produces `backpressure`, `closed`,
 * `decode_failed` and `unknown`, each of which another site also writes out.
 */
const produced = (): ReadonlySet<string> => {
  const dir = fileURLToPath(new URL("../src", import.meta.url))
  const codes = new Set<string>()
  for (const entry of readdirSync(dir, { recursive: true })) {
    const relative = String(entry)
    if (!relative.endsWith(".ts")) continue
    for (const match of readFileSync(join(dir, relative), "utf8").matchAll(/code: "([a-z_]+)"/gu)) {
      codes.add(match[1]!)
    }
  }
  return codes
}

/** The first column of the error table on the troubleshooting page. */
const documented = (): ReadonlyArray<string> => {
  const section = read("../docs/troubleshooting.md").split("\n## Error codes\n")[1]
  expect(section, "docs/troubleshooting.md has an error-code section").toBeDefined()
  const codes = section!.split("\n\n")[0]!.split("\n")
    .map((row) => row.match(/^\| `([a-z_]+)`/u)?.[1])
    .filter((code): code is string => code !== undefined)
  expect(codes.length, "the error-code table has rows").toBeGreaterThan(0)
  return codes
}

// The vocabulary carried `gap_detected` and `optimistic_timeout`, which no
// server, client or authority could send, and a gap already has its own shape
// in `SyncGapError`. A code on the wire that nothing raises is a branch every
// follower writes and never reaches.
describe("ErrorCode", () => {
  it("declares only codes this package raises", () => {
    expect([...declared()].sort()).toEqual([...produced()].sort())
  })

  it("rejects a retired code", () => {
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "gap_detected", message: "gap" })).toBe(false)
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "optimistic_timeout", message: "slow" })).toBe(false)
  })
})

// The page presents its table as every code the package raises, and said
// `not_found` was never raised while `Sync.Snapshot` raises it on three paths.
describe("docs/troubleshooting.md", () => {
  it("gives every declared code its own row", () => {
    expect([...documented()].sort()).toEqual([...declared()].sort())
  })
})
