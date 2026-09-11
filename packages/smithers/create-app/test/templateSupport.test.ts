/**
 * A template's `test/support/` holds the helpers its suites share, and a
 * scaffolded app inherits every file there. A support module no file imports is
 * dead code that still reads as a contract: the Aomi template once carried a
 * `preparedRequest.ts` whose comment said changing it changed every recorded
 * step key, while no run ever read it and `@smthrs/create-app/testing` exported
 * the value the replay helper actually used.
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const templateRoot = fileURLToPath(new URL("../template", import.meta.url))

/** Every `.ts` and `.tsx` file under a template, skipping `node_modules`. */
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })

/**
 * The absolute paths a file's relative static and dynamic imports name, plus
 * each relative `new URL("./…", import.meta.url)`: that is how a Vite alias
 * points at a support module, as the Aomi `vitest.config.ts` stubs
 * `cloudflare:workers` with `test/support/cloudflareWorkers.ts`.
 */
const referencedPaths = (file: string): ReadonlyArray<string> => {
  const text = readFileSync(file, "utf8")
  const urls = Array.from(
    text.matchAll(/new URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g),
    (match) => match[1] ?? ""
  )
  return [...ts.preProcessFile(text, true, true).importedFiles.map((imported) => imported.fileName), ...urls]
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier))
}

describe("template test/support", () => {
  for (const template of readdirSync(templateRoot)) {
    const support = join(templateRoot, template, "test", "support")
    if (!existsSync(support)) continue
    it(`${template}: every support module is referenced by another file`, () => {
      const imported = new Set(sources(join(templateRoot, template)).flatMap(referencedPaths))
      const unused = readdirSync(support)
        .filter((name) => name.endsWith(".ts"))
        .filter((name) => !imported.has(join(support, name)))
      expect(unused).toEqual([])
    })
  }
})
