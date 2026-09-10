import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const productionComponents = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  const glob = new Bun.Glob("**/*.tsx")
  for await (const path of glob.scan({ cwd: import.meta.dir, absolute: true })) {
    if (path.endsWith(".test.tsx")) continue
    files.push({ path, source: await readFile(path, "utf8") })
  }
  return files
}

describe("React architecture boundaries", () => {
  test("components do not acquire domain effects", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) =>
        /React\.useEffect\s*\(/.test(source) ||
        /import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/.test(source)
      )
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })

  test("components mutate through controllers, never the store dispatcher", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) => /\b(?:controller\.)?store\.dispatch\s*\(/.test(source))
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })

  test("components do not depend on the concrete AppStore module", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) => /from\s+["'][^"']*state\/AppStore["']/.test(source))
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })
})

/*
 * Review finding ui-cards-tabs/maintainability/4: Timestamps.ts opens with
 * "One timestamp vocabulary for the whole app", but the cards had hand-rolled
 * five duration formatters, four `shortId` copies and three ISO slicers, two
 * of which rounded differently from the rest. A card that needs one of these
 * words imports it; it does not write its own.
 */
const productionSources = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  for (const pattern of ["**/*.ts", "**/*.tsx"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: import.meta.dir, absolute: true })) {
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx") || path.endsWith("/Timestamps.ts") || path.endsWith("/state/ids.ts")) continue
      files.push({ path, source: await readFile(path, "utf8") })
    }
  }
  return files
}

const writing = async (rule: RegExp): Promise<ReadonlyArray<string>> =>
  (await productionSources())
    .filter(({ source }) => rule.test(source))
    .map(({ path }) => path.slice(import.meta.dir.length + 1))

describe("one timestamp and id vocabulary", () => {
  test("nobody hand-rolls a duration formatter", async () => {
    expect(await writing(/const\s+(?:duration|elapsed)Label\s*=/)).toEqual([])
  })

  test("nobody hand-rolls the short-id rule", async () => {
    expect(await writing(/\.length\s*>\s*12\s*\?[^\n]*\.slice\(0,\s*8\)/)).toEqual([])
  })

  test("nobody hand-rolls the recorded-stamp slice", async () => {
    expect(await writing(/\.replace\("T",\s*" "\)\s*\.?\s*\n?\s*\.slice\(0,\s*16\)/)).toEqual([])
  })
})
