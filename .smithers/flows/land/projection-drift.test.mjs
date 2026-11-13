import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"

const repo = resolve(import.meta.dirname, "../../..")
const projection = join(repo, ".smithers/flows/land/index-projection.mjs")
const baseline = ".smithers/flows/release/fixtures/public-api-baseline.json"
const api = ".smithers/flows/release/check-api-baseline.mjs"
const docs = "apps/site/scripts/sync-api-docs.mjs"

// The real CLI, generators and release compiler run over a tiny published
// package. No replacement runner or fabricated success receipt is involved.
test("landing projection refuses stale docs and API declarations before issuing its receipt", (t) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-landing-drift-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir")
  // The Cloud pnpm launcher addresses this source entry relative to cwd.
  // Link the real entry so this fixture exercises the same CLI on either host.
  mkdirSync(join(root, "packages/smithers/bin"), { recursive: true })
  symlinkSync(join(repo, "packages/smithers/bin/smithers.mjs"), join(root, "packages/smithers/bin/smithers.mjs"))
  for (const path of [api, docs,
    "apps/site/scripts/docs-text.mjs",
    "packages/repo-targets/scripts/workspace-packages.mjs",
    "packages/repo-targets/scripts/build-library.mjs",
    "packages/repo-targets/scripts/private-effect-adapters.mjs"
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(join(repo, path), join(root, path))
  }
  symlinkSync(join(repo, "apps/site/node_modules"), join(root, "apps/site/node_modules"), "dir")
  write("package.json", JSON.stringify({ name: "landing-drift-fixture", private: true, type: "module", packageManager: "pnpm@11.25.0" }))
  write("pnpm-workspace.yaml", 'verifyDepsBeforeRun: false\npackages:\n  - "packages/example"\n')
  write("packages/example/package.json", JSON.stringify({ name: "@smthrs/example", version: "1.0.0", type: "module", publishConfig: { access: "public", exports: { ".": "./dist/esm/index.js" } } }))
  write("packages/example/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: true, types: [] }, include: ["src/**/*.ts"] }))
  write("packages/example/src/index.ts", "export interface Options { retries?: number }\n")
  write("packages/example/docs/api.md", "# Example\n\nOriginal package documentation.\n")
  write(".smithers/WORKSPACE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("landing-drift", {
  repository: "git+https://example.invalid/landing.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime: S.Runtime.Node({ version: ">=26.4.0" }) }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
})
`)
  write("PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { targetIndex: S.TargetIndex({}) } })
`)
  mkdirSync(join(root, dirname(baseline)), { recursive: true })
  const run = (script, args = []) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(repo, "node_modules/.bin")}:${process.env.PATH}` }, maxBuffer: 16 * 1024 * 1024 })
  const succeeds = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  succeeds(run(api, ["--build-declarations", "--update"]))
  succeeds(run(docs))
  const reviewed = readFileSync(join(root, baseline))
  const generated = "apps/site/src/content/docs/docs/reference/api/example.mdx"
  const original = readFileSync(join(root, generated))

  write("packages/example/docs/api.md", "# Example\n\nRevised package documentation.\n")
  const staleDocs = run(projection)
  assert.notEqual(staleDocs.status, 0, "stale docs must refuse publication")
  assert.match(staleDocs.stdout + staleDocs.stderr, /sync-api-docs/)
  assert.doesNotMatch(staleDocs.stdout, /^SMITHERS_TARGET_INDEX /m)
  assert.deepEqual(readFileSync(join(root, generated)), original, "checking must preserve the stale projection")
  succeeds(run(docs))

  write("packages/example/src/index.ts", "export interface Options { retries: number }\n")
  const staleApi = run(projection)
  assert.notEqual(staleApi.status, 0, "a required-field API change must refuse publication")
  assert.match(staleApi.stdout + staleApi.stderr, /check-api-baseline/)
  assert.doesNotMatch(staleApi.stdout, /^SMITHERS_TARGET_INDEX /m)
  assert.deepEqual(readFileSync(join(root, baseline)), reviewed, "the gate must never accept declarations by updating their baseline")

  write("packages/example/src/index.ts", "export interface Options { retries?: number }\n")
  const clean = run(projection)
  succeeds(clean)
  assert.equal([...clean.stdout.matchAll(/^SMITHERS_TARGET_INDEX /gm)].length, 1)
  assert.deepEqual(readFileSync(join(root, baseline)), reviewed)
})
