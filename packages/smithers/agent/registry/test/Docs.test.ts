import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Digest from "@smthrs/core/Digest"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"

// The package owns its own prose. Nothing generates these files, so this is
// the gate that keeps the scan's cost model honest: discovery reads and
// SHA-256 hashes an admitted entry whole, and 64 KiB bounds parsing rather
// than I/O. docs/api.md and docs/concepts/sources.md already say so; these
// five said the scan reads only a metadata prefix.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const flatten = (...parts: ReadonlyArray<string>): string =>
  readFileSync(join(packageRoot, ...parts), "utf8")
    .replace(/^\s*\*[ \t]?/gm, "")
    .replace(/\s+/g, " ")

const documents: ReadonlyArray<ReadonlyArray<string>> = [
  ["README.md"],
  ["docs", "README.md"],
  ["docs", "quickstart.md"],
  ["docs", "concepts", "descriptors.md"],
  ["src", "index.ts"]
]

describe("the documented scan cost model", () => {
  it.each(documents)("describes a whole-file read and hash in %s", (...parts) => {
    const document = flatten(...parts)
    expect(document).toMatch(/reads? and hash(?:es|ed) each entry file whole/)
    expect(document).toContain("64 KiB")
  })

  it.each(documents)("claims no prefix-only read in %s", (...parts) => {
    expect(flatten(...parts)).not.toContain("only far enough")
  })

  it("hashes the bytes past an entry's metadata, which is what the prose promises", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-registry-docs-"))
    try {
      const location = join(root, "review", "SKILL.md")
      const metadata = "---\ndescription: Reviews a change.\ncapabilities: []\n---\n"
      mkdirSync(dirname(location), { recursive: true })
      writeFileSync(location, `${metadata}Body past the closing fence.`)

      const scanned = await Effect.runPromise(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan({ source: "project", root, naming: "path" })
        }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))))
      )

      const digest = scanned.entries[0]?.body.contentDigest
      expect(digest).toBe(Digest.digest(readFileSync(location)))
      expect(digest).not.toBe(Digest.digest(Buffer.from(metadata)))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
