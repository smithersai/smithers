/**
 * The root graph project selects TypeScript package declarations.
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import test from "node:test"
import { repoRoot } from "../scripts/workspace-packages.mjs"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const fc = require("fast-check")
const config = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8"))
const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-root-tsconfig.json", import.meta.url), "utf8"))

test("the root project selects package declarations without collecting Vibe-only siblings", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom(...corpus.directories), { minLength: 1, maxLength: 8 }),
    fc.integer({ min: 0, max: 10000 }),
    (directories, salt) => {
      const root = mkdtempSync(join(tmpdir(), "root-project-membership-"))
      try {
        const expected = new Set(["PACKAGE.ts"])
        const put = (path) => {
          mkdirSync(join(root, path, ".."), { recursive: true })
          writeFileSync(join(root, path), "export const value = 1\n")
        }
        put("PACKAGE.ts")
        for (const [index, directory] of directories.entries()) {
          const stem = directory.replace("NAME", "pkg" + salt + "x" + index)
          put(stem + "/PACKAGE.ts")
          expected.add(stem + "/PACKAGE.ts")
          // A different directory avoids TypeScript's same-basename precedence.
          put(stem.replace("pkg", "vibe") + "/PACKAGE.vibe")
          put(stem + "/Unrelated.ts")
          put(stem + "/dist/PACKAGE.ts")
        }
        const parsed = ts.parseJsonConfigFileContent(
          { ...config, extends: undefined },
          ts.sys,
          root,
          { allowNonTsExtensions: true },
          join(root, "tsconfig.json"),
          undefined,
          [{ extension: ".vibe", isMixedContent: false, scriptKind: ts.ScriptKind.Deferred }]
        )
        assert.deepEqual(parsed.errors, [])
        const selected = parsed.fileNames.map(path => relative(root, path).replaceAll("\\", "/")).sort()
        assert.deepEqual(selected, [...expected].sort())
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  ), { numRuns: 64, examples: [[corpus.directories, 0]] })
})
