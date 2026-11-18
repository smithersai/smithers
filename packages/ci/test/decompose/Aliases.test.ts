import { describe, expect, it } from "vitest"
import { withoutAliases } from "../../src/decompose/Aliases.ts"

const names = new Set(["@acme/core", "@acme/ui", "web"])

/** The text left, with runs of blanks shortened. */
const left = (file: string, text: string): string => withoutAliases(file, text, names).replace(/[ \t]+/g, " ").trim()

describe("withoutAliases", () => {
  it("removes tsconfig paths keyed by a package's name, and keeps every other entry", () => {
    const text = `{
  // shared
  "extends": "@acme/core/tsconfig.json",
  "compilerOptions": {
    "paths": {
      "@acme/core": ["../core/src/index.ts"],
      "@acme/ui/*": ["../ui/src/*"],
      "web": ["../../apps/web/src"],
      "~shared/*": ["../shared/src/*"],
      "@other/thing": ["../thing/src"],
    }
  },
  "references": [{ "path": "../core" }]
}`
    const result = withoutAliases("packages/config/tsconfig.base.json", text, names)
    // The same length and the same lines, so a position in the text still means the same.
    expect(result.length).toBe(text.length)
    expect(result.split("\n").length).toBe(text.split("\n").length)
    expect(result).not.toContain("../core/src/index.ts")
    expect(result).not.toContain("../ui/src/*")
    expect(result).not.toContain("../../apps/web/src")
    // An alias that is not a package's name is followed: the importer writes the alias, not the package.
    expect(result).toContain(`"~shared/*": ["../shared/src/*"]`)
    expect(result).toContain(`"@other/thing": ["../thing/src"]`)
    expect(result).toContain(`"extends": "@acme/core/tsconfig.json"`)
    expect(result).toContain(`"references": [{ "path": "../core" }]`)
  })

  it("reads tsconfig and jsconfig files by name, in any directory", () => {
    const text = `{ "compilerOptions": { "paths": { "@acme/ui": ["../ui/src"] } } }`
    for (const file of ["tsconfig.json", "packages/a/tsconfig.lib.json", "jsconfig.json", "a/tsconfig.base.json"]) {
      expect(left(file, text), file).toBe(`{ "compilerOptions": { "paths": { } } }`)
    }
    for (const file of ["packages/a/tsconfig.json.bak", "packages/a/not-tsconfig.json", "packages/a/data.json"]) {
      expect(withoutAliases(file, text, names), file).toBe(text)
    }
  })

  it("leaves a tsconfig with no paths, or one that does not parse, as it was", () => {
    for (
      const text of [
        `{ "extends": "@acme/core/tsconfig.json" }`,
        `{ "compilerOptions": { "paths": [] } }`,
        ``,
        `{ "compilerOptions": `
      ]
    ) {
      expect(withoutAliases("tsconfig.json", text, names), text).toBe(text)
    }
  })

  it("removes alias entries in code whose value only builds a path", () => {
    const text = `export default defineConfig({
  resolve: {
    alias: {
      ...(config.resolve?.alias ?? {}),
      '@acme/core': path.resolve(basePath, 'packages/core/src'),
      "@acme/ui/styles": fileURLToPath(new URL("../ui/src/styles", import.meta.url)),
      \`web\`: join(
        root,
        'apps/web/src',
      ),
      '@acme/ui': '../ui/src',
      '@other/lib': path.resolve(basePath, 'packages/lib/src'),
      plain: path.resolve('../plain'),
    },
  },
})`
    const result = withoutAliases("packages/config/vite.config.mts", text, names)
    expect(result.length).toBe(text.length)
    expect(result).not.toContain("packages/core/src")
    expect(result).not.toContain("../ui/src")
    expect(result).not.toContain("apps/web/src")
    expect(result).toContain(`'@other/lib': path.resolve(basePath, 'packages/lib/src')`)
    expect(result).toContain(`plain: path.resolve('../plain')`)
    expect(result).toContain("...(config.resolve?.alias ?? {})")
  })

  it("keeps an entry whose value could read a file", () => {
    for (
      const value of [
        `require('../ui/theme.js')`,
        `require.resolve('@acme/ui')`,
        `readFileSync('../ui/a.json')`,
        `await import('../ui/a.js')`,
        `{ find: '../ui' }`,
        `['../ui/src']`,
        `condition ? '../ui/a' : '../ui/b'`,
        `'../ui/' + name`
      ]
    ) {
      const text = `const config = { alias: { '@acme/ui': ${value} } }`
      expect(withoutAliases("vite.config.ts", text, names), value).toBe(text)
    }
  })

  it("reads past an escaped quote in a string", () => {
    const text = `const c = { alias: { note: 'it\\'s } here', '@acme/ui': resolve('../ui') } }`
    expect(left("vite.config.ts", text)).toBe(`const c = { alias: { note: 'it\\'s } here', } }`)
  })

  it("removes only entries inside an alias map", () => {
    const text =
      `const entries = { '@acme/ui': path.resolve('../ui/src/index.ts') }\nbuild({ entryPoints: Object.values(entries) })`
    expect(withoutAliases("build.mjs", text, names)).toBe(text)
    const two = `a({ alias: { '@acme/ui': resolve('../ui') } }); b({ alias: { 'web': \`\${root}/apps/web\`, } })`
    expect(left("x.cjs", two)).toBe("a({ alias: { } }); b({ alias: { , } })")
  })

  it("leaves code it cannot read to the end as it was", () => {
    for (
      const text of [
        `const c = { alias: { '@acme/ui': resolve('../ui')`,
        `const c = { alias: { '@acme/ui': resolve('../ui), } }`,
        `const c = { alias: { '@acme/ui`
      ]
    ) expect(withoutAliases("vite.config.js", text, names), text).toBe(text)
  })

  it("reads only code and TypeScript configuration", () => {
    const text = `alias: { '@acme/ui': resolve('../ui') }`
    for (const file of ["notes.yaml", "README", "config.json", "a.vue"]) {
      expect(withoutAliases(file, text, names), file).toBe(text)
    }
    for (const file of ["a.js", "a.jsx", "a.ts", "a.tsx", "a.mjs", "a.cjs", "a.mts", "a.cts"]) {
      expect(left(file, text), file).toBe("alias: { }")
    }
  })
})
