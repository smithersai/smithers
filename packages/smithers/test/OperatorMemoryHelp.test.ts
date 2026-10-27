import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import { createMemoryCli } from "../src/operator/Memory.ts"

const help = async (verb: string) => {
  let output = ""
  await createMemoryCli().serve([verb, "--help"], {
    stdout: (text) => {
      output += text
    }
  })
  return output
}

it("documents the cli identifier default for a bare namespace kind", async () => {
  expect(await help("set")).toContain("defaults to cli")
  const docs = await readFile(new URL("../docs/reference/cli/README.md", import.meta.url), "utf8")
  expect(docs).toContain("defaults to `cli`")
})

it("describes tag constraints, positive millisecond TTLs and strict JSON values", async () => {
  const set = await help("set")
  expect(set).toContain("positive integer milliseconds")
  for (const prefix of ["branch:", "stream:", "source:", "scope:"]) expect(set).toContain(prefix)
  expect(set).toContain("unique")
  expect(set).toContain("16")
  expect(set).toContain("Require valid JSON")
})

it("describes the required exclusive epoch millisecond compaction cutoff", async () => {
  const compact = await help("compact")
  expect(compact).toContain("Required exclusive cutoff in Unix epoch milliseconds")
  const docs = await readFile(new URL("../docs/reference/cli/README.md", import.meta.url), "utf8")
  expect(docs).toContain("Unix epoch milliseconds")
})
