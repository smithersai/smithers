import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Smithers } from "@smthrs/targets"
import { readWorkspaceManifests } from "./pack-release.mjs"

test("packing reuses graph builds only after every published library has settled", async () => {
  const { Package } = await import("../PACKAGE.ts")
  assert.deepEqual(Smithers.Target.metadata(Package.releasePack).attrs.args, ["dist/release-packs", "--built"])
  const plan = JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "build", "//.smithers/flows:releasePack", "--plan", "--json"
  ], { cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }))
  const pack = plan.targets.find((target) => target.label === "//.smithers/flows:releasePack")
  assert.ok(pack, "the release pack must be selected")
  for (const directory of readWorkspaceManifests().keys()) {
    assert.ok(pack.dependencies.includes(`//${directory}:lib`), `${directory} must build before packing`)
  }
  assert.ok(pack.dependencies.includes("//.smithers/flows:apiBaseline"))
})

test("the shipping-links gate depends on the site build even when selected alone", () => {
  // Query the evaluated declarations: an earlier workflow step cannot supply
  // the route oracle when this target runs on its own or through //apps/site/....
  const graph = JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "query",
    "deps(//apps/site:smithersLinks)",
    "--json"
  ], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    timeout: 300_000
  }))

  assert.ok(graph.dependencies.includes("//apps/site:build"), "shipping links require the built site routes")
})

test("the cached site build measures every external release URL input", () => {
  const explain = (label) => JSON.parse(execFileSync(process.execPath, [
    "packages/smithers/build/build-cli/src/main.js",
    "explain", label, "--json"
  ], { cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }))
  const site = explain("//apps/site:build")
  assert.ok(site.cache.cacheable, "this checks the production cached build")
  assert.ok(site.dependencies.includes("//packages/smithers:docsSources"), "the CLI removal table must affect the site key")
  const cli = explain("//packages/smithers:docsSources")
  const files = new Map([site, cli].flatMap((target) => target.inputs.flatMap((input) => input.files))
    .map((file) => [file.path, file.digest]))
  for (const path of [
    "CHANGELOG.md",
    "packages/smithers/src/Unsupported.ts",
    "packages/smithers/src/CliError.ts",
    "packages/smithers/src/cli/Compatibility.ts",
    "apps/site/public/_redirects",
    "apps/site/src/data/removed-commands.json",
    "apps/site/public/llms.txt",
    "apps/site/public/llms-full.txt",
    "apps/site/scripts/check-built-site.mjs"
  ]) {
    assert.ok(files.get(path), `${path} must contribute content to the site build key`)
  }
})

test("the ordinary PR CLI entrypoint plans a package's example typecheck and suite", () => {
  const cliRoot = new URL("../../../packages/smithers/", import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL("package.json", cliRoot), "utf8"))
  // CI invokes the public smthrs bin, which must compose the graph commands.
  // Read the manifest so a stale checkout .bin alias cannot satisfy this gate.
  const entry = fileURLToPath(new URL(manifest.bin.smthrs, cliRoot))
  const plan = JSON.parse(execFileSync(process.execPath, [
    entry, "ci", "//packages/smithers/agent:check", "//packages/smithers/agent:test", "--plan", "--json"
  ], { cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 300_000 }))
  // A package's examples are type-checked by its `check` and run by its `test`.
  assert.ok(plan.roots.includes("//packages/smithers/agent:check"), "package CI must typecheck the executable examples")
  assert.ok(plan.roots.includes("//packages/smithers/agent:test"), "package CI must execute the example suite")
})

