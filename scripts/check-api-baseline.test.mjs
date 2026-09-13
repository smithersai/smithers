import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { apiSurface, assertApiBaseline } from "./check-api-baseline.mjs"

it("detects signature changes through private declarations even when export paths stay fixed", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-api-baseline-"))
  const write = (name, text) => { mkdirSync(join(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), text) }
  try {
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    write("packages/example/package.json", JSON.stringify({ name: "@smthrs/example", publishConfig: { exports: { ".": "./dist/esm/index.js" } } }))
    assert.throws(() => apiSurface(root), /ENOENT/)
    write("packages/example/dist/esm/index.d.ts", 'export type { Options } from "./internal/options.js"\n')
    write("packages/example/dist/esm/internal/options.d.ts", "export interface Options { retries?: number }\n")
    const baseline = apiSurface(root)
    assert.doesNotThrow(() => assertApiBaseline(baseline, apiSurface(root)))
    write("packages/example/dist/esm/internal/options.d.ts", "export interface Options { retries: number }\n")
    assert.throws(() => assertApiBaseline(baseline, apiSurface(root)), /@smthrs\/example/)
    assert.throws(() => assertApiBaseline(baseline, {}), /@smthrs\/example/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
