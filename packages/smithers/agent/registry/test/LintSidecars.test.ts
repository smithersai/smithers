// `Bundled.vibe` is this package's one VibeLang source. Whatever loads it through `vibelang/register` writes
// `Bundled.d.vibe.ts` beside it, an untracked compiler output, and the lint target globs `src/**/*.ts`. The package's
// ESLint config must leave every such sidecar alone, or `lint` fails on any tree a test or typecheck ran in first.
// VibeLang 0.0.13 also writes `Bundled.d.ts`, which re-exports the sidecar for stock TypeScript. Only a `.d.ts` beside
// a VibeLang source is generated: a hand-written declaration is still linted.
import { ESLint } from "eslint"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))

it.each([
  "src/Bundled.d.ts",
  "src/Bundled.d.vibe.ts",
  "src/Bundled.d.vibex.ts",
  "src/Bundled.vibe.text.d.ts",
  "src/Bundled.vibex.text.d.ts"
])("ignores the generated declaration %s", async (path) => {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: "eslint.config.js" })
  expect(await eslint.isPathIgnored(path)).toBe(true)
})

it("still lints the package's own sources", async () => {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: "eslint.config.js" })
  expect(await eslint.isPathIgnored("src/Registry.ts")).toBe(false)
  expect(await eslint.isPathIgnored("src/Registry.d.ts")).toBe(false)
})
