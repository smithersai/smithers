import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const repoRoot = join(packageRoot, "../..")

const sources = ["src", "test"].flatMap((dir) =>
  readdirSync(join(packageRoot, dir))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ path: `${dir}/${file}`, source: readFileSync(join(packageRoot, dir, file), "utf8") }))
)

/*
 * Comment blocks, each unwrapped to one line. Comments are read line by line
 * so a path inside a string literal is never read as a citation, and a line
 * ending in "/" joins the next without a space, which is how a long path
 * wraps.
 */
const commentBlocks = (source: string): ReadonlyArray<string> => {
  const blocks: Array<string> = []
  let block: string | null = null
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      const text = trimmed.replace(/^\/\*+|^\*+\/?|^\/\//, "").replace(/\*\/$/, "").trim()
      block = block === null ? text : block.endsWith("/") ? block + text : `${block} ${text}`
    } else if (block !== null) {
      blocks.push(block.trim())
      block = null
    }
  }
  if (block !== null) blocks.push(block.trim())
  return blocks
}

/** A cited document: at least one path segment, so a bare shorthand like `DESIGN.md` is not one. */
const citation = /[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.md/g

describe("the comments in this package", () => {
  test("cite only documents that exist, at the path they name", () => {
    const dead = sources.flatMap(({ path, source }) =>
      commentBlocks(source).flatMap((block) =>
        (block.match(citation) ?? [])
          .filter((cited) => !existsSync(join(repoRoot, cited)))
          .map((cited) => `${path}: ${cited}`)
      )
    )
    expect(dead).toEqual([])
  })

  test("summarise what an export does, never its identifier re-spelled as a sentence", () => {
    const generated = sources.flatMap(({ path, source }) =>
      source
        .split("\n")
        .filter((line) => /^\s*\*\s+(?:Converts|Validates)\s+(?:is|has)\b/.test(line))
        .map((line) => `${path}: ${line.trim()}`)
    )
    expect(generated).toEqual([])
  })

  test("spell this package and the services it names as they are spelled", () => {
    const stale = sources.flatMap(({ path, source }) =>
      commentBlocks(source)
        .filter((block) => /\bsrc\/shared\b/.test(block) || /\bgit hub\b/i.test(block))
        .map((block) => `${path}: ${block}`)
    )
    expect(stale).toEqual([])
  })
})
