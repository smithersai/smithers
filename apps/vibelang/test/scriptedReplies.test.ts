// @vitest-environment node
// Compile the actual fenced examples, including every branch and the fallback (decision 0004).
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { scriptedReplies } from "../src/core/mockReplies.ts"

const compiler = fileURLToPath(new URL("../node_modules/vibelang/bin/vibelang", import.meta.url))
const cache = resolve("node_modules/.cache")
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, "scripted-replies-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const examples = scriptedReplies.flatMap((reply, script) =>
  Array.from(reply.matchAll(/```vibe\s*\n([\s\S]*?)```/g), (match, block) => ({
    name: `script-${script + 1}-block-${block + 1}.vibe`,
    source: match[1]!,
  })),
)

describe("scripted VibeLang examples", () => {
  it("contains examples to compile", () => expect(examples.length).toBeGreaterThan(0))
  for (const { name, source } of examples) {
    it(`compiles ${name} without diagnostics`, () => {
      // The projection CLI can exit zero even with diagnostics: check the payload as well as the process.
      const result = spawnSync(compiler, ["--ts-projection", name], { input: source, encoding: "utf8" })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      const projected = JSON.parse(result.stdout)
      expect(projected.diagnostics ?? []).toEqual([])
      const file = join(directory, name)
      writeFileSync(file, source)
      const checked = spawnSync(compiler, ["--ignoreConfig", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", file], { encoding: "utf8" })
      expect(checked.error).toBeUndefined()
      expect(checked.stdout + checked.stderr).toBe("")
      expect(checked.status).toBe(0)
    })
  }
})
