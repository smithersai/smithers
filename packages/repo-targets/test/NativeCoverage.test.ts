import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it } from "vitest"

it("does not credit native tsx copies with Vite-transformed coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "vitest-native-coverage-"))
  const require = createRequire(import.meta.url)
  const loaderRequire = createRequire(new URL("../../smithers/build/build-cli/package.json", import.meta.url))
  const tsx = pathToFileURL(loaderRequire.resolve("tsx/esm/api")).href
  const source = `export const neverCalled = (n: number): number => {
  if (n > 0) return n * 2
  return -n
}

export const called = (n: number): number => {
  if (n > 0) return n + 1
  return n - 1
}
`
  try {
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(join(root, "native.ts"), source)
    writeFileSync(join(root, "plain.cjs"), source.replaceAll(": number", "").replaceAll("export const ", "exports."))
    writeFileSync(join(root, "mixed.ts"), source)
    writeFileSync(join(root, "vitest.config.mjs"), `export default {
  test: {
    include: ["probe.test.ts"],
    coverage: { enabled: true, provider: "v8", include: ["native.ts", "mixed.ts", "plain.cjs"], reporter: ["json"] }
  }
}`)
    writeFileSync(join(root, "probe.test.ts"), `import { tsImport } from ${JSON.stringify(tsx)}
import { expect, it } from "vitest"
import { called } from "./mixed.ts"
import { createRequire } from "node:module"
it("executes native copies alongside one Vite copy", async () => {
  expect(called(1)).toBe(2)
  expect(createRequire(import.meta.url)("./plain.cjs").called(1)).toBe(2)
  for (const name of ["native", "mixed"]) {
    const native = await tsImport("./" + name + ".ts", import.meta.url)
    expect(native.called(1)).toBe(2)
  }
})
`)
    execFileSync(process.execPath, [join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", "--root", root, "--maxWorkers=1"], {
      cwd: root,
      timeout: 60_000,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" }
    })
    const coverage = JSON.parse(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"))
    for (const name of ["native", "mixed", "plain"]) {
      const file = coverage[join(root, name + (name === "plain" ? ".cjs" : ".ts"))]
      expect(file, name).toBeDefined()
      const functions = Object.entries(file.fnMap) as Array<[string, { loc: { start: { line: number } } }]>
      const never = functions.find(([, fn]) => fn.loc.start.line === 1)
      const called = functions.find(([, fn]) => fn.loc.start.line === 6)
      expect(never, name).toBeDefined()
      expect(called, name).toBeDefined()
      expect(file.f[never![0]], name + " uncalled function").toBe(0)
      if (name !== "mixed") {
        expect(Object.values(file.s), "native-only statements").toEqual(expect.arrayContaining([0]))
        expect(file.f[called![0]], "native-only calls are conservatively uncredited").toBe(0)
      } else {
        expect(file.f[called![0]], "Vite calls remain covered").toBeGreaterThan(0)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
