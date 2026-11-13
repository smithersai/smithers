import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it } from "vitest"

it("does not credit native tsx copies with Vite-transformed coverage", () => {
  // Coverage filenames use real paths, including through macOS TMPDIR aliases.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vitest-native-coverage-")))
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

it("remaps a child's tsx-rewritten declaration module through Node's source map", () => {
  // `smithers-build`'s `src/main.js` evaluates `src/main.ts` through `importDeclarationModule`, so tsx rewrites it
  // in a child no worker imports it in. A child's hits must land on the file as written: alone for a file only the
  // child runs, and on Vite's counters, never beside them, for a file a worker imported too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vitest-loader-child-coverage-")))
  const require = createRequire(import.meta.url)
  const resolution = new URL("../../smithers/build/build-cli/src/effect-resolution.js", import.meta.url).href
  try {
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(join(root, "declaration.ts"), `type Label = { readonly text: string }

export const neverCalled = (label: Label): string => {
  return label.text.toUpperCase()
}

export const describe = (n: number): Label => {
  if (n > 0) return { text: "positive" }
  return { text: "other" }
}

if (process.env.CHILD === "1") console.log(describe(1).text)
`)
    writeFileSync(join(root, "only.ts"), `const twice = (n: number): number => n * 2
export const unused = (n: number): number => n + 1
console.log(twice(2))
`)
    writeFileSync(join(root, "entry.js"), `import { importDeclarationModule, installEffectResolution } from ${JSON.stringify(resolution)}
installEffectResolution()
await importDeclarationModule(new URL("./declaration.ts", import.meta.url).href, import.meta.url)
await importDeclarationModule(new URL("./only.ts", import.meta.url).href, import.meta.url)
`)
    writeFileSync(join(root, "vitest.config.mjs"), `export default {
  test: {
    include: ["probe.test.ts"],
    coverage: { enabled: true, provider: "v8", autoAttachSubprocess: true, include: ["declaration.ts", "only.ts"], reporter: ["json"] }
  }
}`)
    writeFileSync(join(root, "probe.test.ts"), `import { execFileSync } from "node:child_process"
import { expect, it } from "vitest"
import { describe } from "./declaration.ts"
it("takes one arm here and the other in a tsx child", () => {
  expect(describe(-1).text).toBe("other")
  const env = { ...process.env, CHILD: "1" }
  expect(execFileSync(process.execPath, ["entry.js"], { encoding: "utf8", env }).trim()).toBe("positive\\n4")
})
`)
    execFileSync(process.execPath, [join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", "--root", root, "--maxWorkers=1"], {
      cwd: root,
      timeout: 60_000,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" }
    })
    const coverage = JSON.parse(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"))
    let file = coverage[join(root, "declaration.ts")]
    const hits = (line: number) =>
      (Object.entries(file.statementMap) as Array<[string, { start: { line: number } }]>)
        .filter(([, location]) => location.start.line === line).map(([id]) => file.s[id])
    const calls = (line: number) =>
      (Object.entries(file.fnMap) as Array<[string, { loc: { start: { line: number } } }]>)
        .filter(([, fn]) => fn.loc.start.line === line).map(([id]) => file.f[id])
    const sorted = (counts: Array<number>) => counts.sort((left, right) => left - right)
    // Vite's counters only: eight statements, two functions and two two-arm branches.
    expect(Object.keys(file.s), "statements").toHaveLength(8)
    expect(Object.keys(file.f), "functions").toHaveLength(2)
    expect(sorted(Object.values(file.b).flat() as Array<number>), "branch arms").toEqual([1, 1, 1, 1])
    // Line 12's guard and line 8's test run in both processes; their arms run only in the child.
    expect(sorted(hits(12)), "child's log").toEqual([1, 2])
    expect(sorted(hits(8)), "child's return").toEqual([1, 2])
    expect(hits(9), "worker's return").toEqual([1])
    expect(calls(7), "called in both").toEqual([2])
    expect(calls(3), "uncalled function").toEqual([0])
    expect(hits(4), "uncalled body").toEqual([0])
    file = coverage[join(root, "only.ts")]
    expect(calls(1), "child-only call").toEqual([1])
    expect(calls(2), "child-only uncalled function").toEqual([0])
    expect(hits(3), "child-only statement").toEqual([1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

it("keeps a child's native script of a worker-imported file off Vite's transformed offsets", () => {
  // Vite's SSR transform rewrites `import` and every imported binding, so a worker's script of `shared.js` indexes
  // other offsets than a child's native script of the same file. Merging the two scripts read one through the
  // other's offsets: a function the child called stayed uncalled while blocks around it gained hits.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vitest-native-child-coverage-")))
  const require = createRequire(import.meta.url)
  try {
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(join(root, "shared.js"), `import { basename } from "node:path"

export const neverCalled = (name) => {
  return basename(name).toUpperCase()
}

export const inWorker = (n) => {
  if (n > 0) return basename("w" + n)
  return "none"
}

export const inChild = (n) => {
  if (n > 0) return basename("c" + n)
  return "none"
}
`)
    writeFileSync(join(root, "vitest.config.mjs"), `export default {
  test: {
    include: ["probe.test.ts"],
    coverage: { enabled: true, provider: "v8", autoAttachSubprocess: true, include: ["shared.js"], reporter: ["json"] }
  }
}`)
    writeFileSync(join(root, "probe.test.ts"), `import { execFileSync } from "node:child_process"
import { expect, it } from "vitest"
import { inWorker } from "./shared.js"
it("calls one function here and another in a native child", () => {
  expect(inWorker(1)).toBe("w1")
  const child = "import { inChild } from './shared.js'; console.log(inChild(1))"
  expect(execFileSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" }).trim()).toBe("c1")
})
`)
    execFileSync(process.execPath, [join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", "--root", root, "--maxWorkers=1"], {
      cwd: root,
      timeout: 60_000,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" }
    })
    const coverage = JSON.parse(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"))
    const file = coverage[join(root, "shared.js")]
    const hits = (line: number) =>
      (Object.entries(file.statementMap) as Array<[string, { start: { line: number } }]>)
        .filter(([, location]) => location.start.line === line).map(([id]) => file.s[id])
    const calls = (line: number) =>
      (Object.entries(file.fnMap) as Array<[string, { loc: { start: { line: number } } }]>)
        .filter(([, fn]) => fn.loc.start.line === line).map(([id]) => file.f[id])
    expect(Object.keys(file.f), "functions").toHaveLength(3)
    expect(calls(3), "uncalled function").toEqual([0])
    expect(hits(4), "uncalled body").toEqual([0])
    expect(calls(7), "worker's call").toEqual([1])
    expect(hits(8), "worker's test and return").toEqual([1, 1])
    expect(hits(9), "worker's fallback").toEqual([0])
    expect(calls(12), "child's call").toEqual([1])
    expect(hits(13), "child's test and return").toEqual([1, 1])
    expect(hits(14), "child's fallback").toEqual([0])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
