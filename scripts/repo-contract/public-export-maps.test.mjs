import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { auditPublicExports, explicitMap, exportTarget, sourceSubpaths } from "../public-export-map.mjs"
import { libraryPackages, repoRoot } from "../workspace-packages.mjs"

const baseline = JSON.parse(readFileSync(new URL("../fixtures/public-export-surface.json", import.meta.url), "utf8"))
const current = new Map(
  libraryPackages().filter((entry) => !entry.manifest.private).map((entry) => [entry.name, entry])
)
const denied = (name) => baseline.removed.filter((entry) => entry.name === name).map((entry) => entry.subpath)
// The reviewed runtime targets stay fixed; each declaration now follows its
// runtime branch so Node16 CommonJS consumers do not resolve an ESM declaration.
const moduleDeclarations = (value) => {
  if (value === null || typeof value !== "object") return value
  if (["types", "import", "require"].every((key) => typeof value[key] === "string")) {
    return {
      import: { types: value.types, default: value.import },
      require: { types: value.types.replace("/dist/esm/", "/dist/cjs/"), default: value.require }
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, moduleDeclarations(entry)]))
}
const reviewed = (value, mode) => mode === "published" ? moduleDeclarations(value) : value
const additions = (name, mode) => Object.fromEntries(
  baseline.added.filter((entry) => entry.name === name).map((entry) => [entry.subpath, reviewed(entry[mode], mode)])
)

describe("explicit public entrypoints", () => {
  it("keeps every public package on matching explicit development and publication allowlists", () => {
    const rows = auditPublicExports()
    assert.equal(rows.length, current.size)
    assert.deepEqual(rows.filter((row) => row.errors.length > 0), [])
  })

  it("preserves every reviewed runtime contract except the confirmed implementation paths", () => {
    assert.equal(baseline.packages.length, 48)
    assert.deepEqual(baseline.removed.map(({ name, subpath }) => `${name}${subpath.slice(1)}`), [
      "@smthrs/integrations/core/migrations/0001_integration_cursors",
      "@smthrs/build-cli/effect-resolution.d",
      "@smthrs/plan/Migrations",
      "@smthrs/plan/PlanStore"
    ])
    let retained = 0
    for (const previous of baseline.packages) {
      const manifest = current.get(previous.name)?.manifest
      assert.ok(manifest, previous.name)
      const removed = denied(previous.name)
      for (const [label, map] of [["development", manifest.exports], ["published", manifest.publishConfig.exports]]) {
        assert.deepEqual(map, { ...explicitMap(reviewed(previous[label], label), previous.subpaths, removed), ...additions(previous.name, label) }, `${previous.name} ${label}`)
        for (const subpath of previous.subpaths) {
          if (removed.includes(subpath)) {
            assert.equal(exportTarget(map, subpath), null)
          } else {
            assert.deepEqual(
              exportTarget(map, subpath),
              exportTarget(reviewed(previous[label], label), subpath),
              `${previous.name}${subpath} ${label}`
            )
          }
        }
      }
      retained += previous.subpaths.length - removed.length
    }
    assert.equal(retained, 774)
  })

  it("admits only explicitly reviewed additions without rewriting the original surface", () => {
    assert.deepEqual(baseline.added.map(({ name, subpath }) => `${name}${subpath.slice(1)}`).sort(), [
      "@smthrs/build-cli/TargetIndex", "@smthrs/canonical/BoundedJson", "@smthrs/canonical/IssuePath", "@smthrs/canonical/ReadonlyMap", "@smthrs/canonical/Record", "@smthrs/canonical/Serializer", "@smthrs/control/ApprovalAuthority", "@smthrs/control/DispatchReader", "@smthrs/control/Health", "@smthrs/database/bun/BunDatabase", "@smthrs/engine-store/EventTypes", "@smthrs/engine-store/ExecutionSnapshot", "@smthrs/engine-store/PlanInputStore", "@smthrs/engine-store/PlanMergeStore", "@smthrs/engine-store/RunChangeFeed", "@smthrs/flows/BunRuntime", "@smthrs/flows/Runtime", "@smthrs/gateway/bun/BunGateway", "@smthrs/journal/EngineEvent", "@smthrs/journal/JournalGeneration", "@smthrs/kernel/ChildProcessEnvironment", "@smthrs/memory/Migrations", "@smthrs/model/Classifier", "@smthrs/model/Evaluator", "@smthrs/model/ModelCatalog", "@smthrs/plan/CachePolicy", "@smthrs/plan/Effects", "@smthrs/plan/Placement", "@smthrs/plan/Repetition", "@smthrs/plan/Scheduling", "@smthrs/plan/test/PlanFixtures", "@smthrs/platform-node/EgressHttpClient", "@smthrs/platform-node/ScopedProcess", "@smthrs/scorers/ScoreGate", "@smthrs/std/Classifiers", "@smthrs/std/Classify", "@smthrs/std/Relocate", "@smthrs/testing/ProcessTable", "@smthrs/triggers/DispatchReader"
    ])
    for (const entry of baseline.added) {
      const manifest = current.get(entry.name).manifest
      assert.ok(entry.reason.length > 0)
      assert.deepEqual(exportTarget(manifest.exports, entry.subpath), entry.development)
      assert.deepEqual(exportTarget(manifest.publishConfig.exports, entry.subpath), moduleDeclarations(entry.published))
      assert.ok(sourceSubpaths(join(repoRoot, current.get(entry.name).dir)).includes(entry.subpath))
      const original = baseline.packages.find(({ name }) => name === entry.name)
      assert.ok(!original.subpaths.includes(entry.subpath), "an addition must not rewrite a prior entry")
    }
  })

  it("does not mistake declaration-only files for runtime modules", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-declaration-exports-"))
    try {
      const directory = join(root, "packages/fixture")
      mkdirSync(join(directory, "src/nested"), { recursive: true })
      for (const file of ["index.ts", "valid.ts", "ambient.d.ts", "nested/ambient.d.ts"]) {
        writeFileSync(join(directory, "src", file), "")
      }
      assert.deepEqual(sourceSubpaths(directory), ["./index", "./valid"])
      writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "@smthrs/fixture",
          smthrs: { group: "engine" },
          exports: { ".": "./src/index.ts", "./ambient": "./src/ambient.d.ts" },
          publishConfig: { exports: { ".": "./dist/index.js", "./ambient": "./dist/ambient.d.js" } }
        })
      )
      assert.deepEqual(auditPublicExports(root)[0].errors, [
        "declaration-only runtime target ./ambient: ./src/ambient.d.ts"
      ])
      const entry = current.get("@smthrs/build-cli")
      for (const map of [entry.manifest.exports, entry.manifest.publishConfig.exports]) {
        assert.equal(exportTarget(map, "./effect-resolution.d"), null)
        assert.notEqual(exportTarget(map, "./effect-resolution"), null)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resolves exact entries before patterns and does not confuse root index with a nested index", () => {
    const map = {
      "./*": { types: "./types/*.d.ts", import: "./esm/*.js", require: "./cjs/*.js" },
      "./internal/*": null,
      "./*/index": null,
      "./test/contract": "./src/test/HostContract.ts",
      "./testing": { import: "./src/testing.ts" }
    }
    assert.deepEqual(exportTarget(map, "./index"), {
      types: "./types/index.d.ts",
      import: "./esm/index.js",
      require: "./cjs/index.js"
    })
    assert.equal(exportTarget(map, "./internal/Secret"), null)
    assert.equal(exportTarget(map, "./provider/index"), null)
    assert.equal(exportTarget(map, "./test/contract"), "./src/test/HostContract.ts")
    assert.deepEqual(exportTarget(map, "./testing"), { import: "./src/testing.ts" })
    assert.deepEqual(exportTarget(map, "./node/NodeDatabase"), {
      types: "./types/node/NodeDatabase.d.ts",
      import: "./esm/node/NodeDatabase.js",
      require: "./cjs/node/NodeDatabase.js"
    })
  })

  it("proves ESM and CommonJS resolution equivalence with Node, including denied imports and real future files", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-public-exports-")))
    try {
      const jobs = []
      const files = new Set()
      const targets = (target) =>
        typeof target === "string" ? [target] : target == null ? [] : Object.values(target).flatMap(targets)
      const probes = ["./future/Unreviewed", "./internal/Unreviewed", "./future/index"]
      for (const [index, previous] of baseline.packages.entries()) {
        const manifest = current.get(previous.name).manifest
        for (const [mode, map] of [["development", manifest.exports], ["published", manifest.publishConfig.exports]]) {
          for (const [phase, exports] of [["before", previous[mode]], ["after", map]]) {
            const directory = join(root, String(index), mode, phase)
            mkdirSync(directory, { recursive: true })
            const paths = [...previous.subpaths, ...probes]
            // Both packages contain the same bytes, including the now-private
            // migration and an unreviewed future module. Only their maps differ.
            for (const subpath of paths) {
              for (const target of targets(exportTarget(previous[mode], subpath))) {
                if (target === "./package.json") continue
                files.add(target)
              }
            }
            writeFileSync(
              join(directory, "package.json"),
              JSON.stringify({ name: previous.name, type: "module", exports })
            )
            jobs.push({ directory, name: previous.name, mode, phase, paths })
          }
        }
      }
      // Resolution does not execute module bodies. Share one inert file tree
      // across packages rather than writing thousands of identical fixtures.
      const content = join(root, "content")
      const directories = new Set()
      for (const target of files) {
        const file = join(content, target)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, "")
        directories.add(target.slice(2).split("/")[0])
      }
      for (const job of jobs) {
        for (const directory of directories) {
          symlinkSync(join(content, directory), join(job.directory, directory), "junction")
        }
      }
      const child = spawnSync(process.execPath, [
        "--experimental-import-meta-resolve",
        "--input-type=module",
        "-e",
        `
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const jobs=JSON.parse(readFileSync(0,'utf8'));
const output=jobs.map(job=>{
  const parent=join(job.directory,'package.json');
  const require=createRequire(parent);
  return job.paths.map(path=>{
    const specifier=job.name+(path==='.'?'':path.slice(1));
    const run=resolve=>{try{return {target:relative(job.directory,resolve())}}catch(error){return {error:error.code}}};
    return {esm:run(()=>fileURLToPath(import.meta.resolve(specifier,pathToFileURL(parent).href))),require:run(()=>require.resolve(specifier))};
  });
});
process.stdout.write(JSON.stringify(output));
`
      ], { input: JSON.stringify(jobs), encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
      assert.equal(child.status, 0, `${child.error?.code ?? ""} ${child.signal ?? ""} ${child.stderr}`)
      const results = JSON.parse(child.stdout)
      for (let index = 0; index < jobs.length; index += 2) {
        const before = jobs[index]
        const removed = denied(before.name)
        for (const [pathIndex, subpath] of before.paths.entries()) {
          const actual = results[index + 1][pathIndex]
          const label = `${before.name}${subpath.slice(1)} ${before.mode}`
          if (removed.includes(subpath) || probes.includes(subpath)) {
            assert.deepEqual(actual, {
              esm: { error: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
              require: { error: "ERR_PACKAGE_PATH_NOT_EXPORTED" }
            }, label)
            if (removed.includes(subpath) || subpath === "./future/Unreviewed") {
              assert.ok(results[index][pathIndex].esm.target, `${label} was addressable before the change`)
            }
          } else {
            assert.deepEqual(actual, results[index][pathIndex], label)
            assert.ok(actual.esm.target, `${label} retains an ESM target`)
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps the migrated integration schema implementation outside public paths", () => {
    const entry = current.get("@smthrs/integrations")
    const parent = join(repoRoot, entry.dir, "src/core/Migrations.ts")
    const source = readFileSync(parent, "utf8")
    assert.match(source, /\.\/IntegrationCursorMigration\.ts/)
    assert.match(source, /"0001_integration_cursors": integrationCursors/)
    for (const map of [entry.manifest.exports, entry.manifest.publishConfig.exports]) {
      assert.equal(exportTarget(map, "./core/migrations/0001_integration_cursors"), null)
      assert.equal(exportTarget(map, "./core/migrations/index"), null)
      assert.equal(exportTarget(map, "./internal/IntegrationCursorMigration"), null)
    }
    // The implementation left `src/internal/`, so the manifest allowlist, not
    // a blocked directory, is what keeps its new path off the public surface.
    assert.equal(exportTarget(entry.manifest.exports, "./core/IntegrationCursorMigration"), undefined)
    assert.equal(exportTarget(entry.manifest.publishConfig.exports, "./core/IntegrationCursorMigration"), undefined)
  })
})
