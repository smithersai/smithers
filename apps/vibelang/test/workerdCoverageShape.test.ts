// @vitest-environment node
// Stays .ts: it evaluates an instrumented bundle through a data: URL import and reads Istanbul's untyped
// globalThis.__coverage__, host code VibeLang rejects (EK4402, EK0107), like test/support/workerdCoverage.ts.
//
// workerd's counters must locate a statement where Vitest's V8 remap does, or the benchmark coverage merge drops real
// workerd execution of any file Node also loaded (0017).
import { expect, it } from "vitest"
import { build } from "esbuild"
import vibelang from "vibelang-unplugin/esbuild"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Arbitrary, Effect, Schema } from "effect"
import { instrumentModules, sourceCoverage } from "./support/workerdCoverage.ts"

const fixture = fileURLToPath(new URL("./support/coverageShape.vibe", import.meta.url))

it("workerd evidence locates a namespace call at its source column", async () => {
  const result = await build({
    entryPoints: [fixture], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    logLevel: "silent", plugins: [instrumentModules(vibelang(), (file) => file === fixture)],
  })
  const scope = globalThis as { __coverage__?: Record<string, unknown> }
  delete scope.__coverage__
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`) as { answer: (flag: boolean) => number }
  expect(module.answer(true)).toBe(1)
  const remapped = await sourceCoverage(scope.__coverage__!)
  delete scope.__coverage__
  // Only the selected module is instrumented, under the absolute path the merge gate filters on.
  expect(remapped.files()).toEqual([fixture])
  const source = remapped.fileCoverageFor(fixture).toJSON() as { statementMap: Record<string, { start: { line: number; column: number } }>; s: Record<string, number> }
  const line = "export const answer = (flag: boolean) => Effect.runSync(Effect.succeed(flag ? 1 : 2))"
  const body = Object.entries(source.statementMap).filter(([, loc]) => loc.start.line === 2)
  expect(body.map(([, loc]) => loc.start.column)).toContain(line.indexOf("Effect.runSync"))
  expect(body.every(([id]) => source.s[id]! > 0)).toBe(true)
}, 240_000)


it("workerd evidence preserves encoded and Unicode source filenames", async () => {
  const temporary = await mkdtemp(fileURLToPath(new URL("./support/coverage-shape-", import.meta.url)))
  const source = await readFile(fixture, "utf8")
  const project = join(temporary, "tsconfig.json")
  const scope = globalThis as { __coverage__?: Record<string, unknown> }
  let sequence = 0
  try {
    const filenames = Arbitrary.array(
      Arbitrary.schema(Schema.Literals(["plain", "with space", "100%", "encoded%2Fslash", "hash#mark", "café", "漢字"])),
      { minLength: 1, maxLength: 3 },
    )
    const report = await Effect.runPromise(Arbitrary.checkEffect(filenames, (parts) => Effect.promise(async () => {
        const selected = join(temporary, parts.join("-") + ".vibe")
        await writeFile(selected, source)
        await writeFile(project, JSON.stringify({
          compilerOptions: {
            module: "ESNext", moduleResolution: "Bundler", target: "ES2022", skipLibCheck: true,
            sourceMap: true, inlineSources: true, noEmit: true, types: [],
          },
          files: [basename(selected)],
        }))
        const result = await build({
          entryPoints: [selected], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
          logLevel: "silent", plugins: [instrumentModules(vibelang({ project }), (file) => file === selected)],
        })
        delete scope.__coverage__
        const module = await import(
          `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}#case-${sequence++}`
        ) as { answer: (flag: boolean) => number }
        expect(module.answer(true)).toBe(1)
        expect(module.answer(false)).toBe(2)
        const remapped = await sourceCoverage(scope.__coverage__!)
        expect(remapped.files()).toEqual([selected])
        const coverage = remapped.fileCoverageFor(selected).toJSON() as { s: Record<string, number> }
        expect(Object.values(coverage.s).some((hits) => hits > 0)).toBe(true)
        return true
      }), { runs: 16, seed: 73291 }))
    expect(Arbitrary.formatCheckFailure(report)).toBeUndefined()
  } finally {
    delete scope.__coverage__
    await rm(temporary, { recursive: true, force: true })
  }
}, 240_000)
