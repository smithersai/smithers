import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const config = ts.readConfigFile(join(packageRoot, "tsconfig.json"), ts.sys.readFile)
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot).options

const resolveTypeOwner = (name: string, declaration: string) => {
  const mode = ts.getImpliedNodeFormatForFile(declaration, undefined, ts.sys, options)
  return ts.resolveModuleName(name, declaration, options, ts.sys, undefined, undefined, mode).resolvedModule
}

test("generated workflow APIs resolve the plugin types they expose", () => {
  const declaration = join(packageRoot, "repository", "jobs.d.ts")
  const owner = resolveTypeOwner("@smthrs/plugin", declaration)
  assert.ok(owner, "the workflow declaration cannot resolve its plugin type owner")
  assert.ok(existsSync(owner.resolvedFileName), "the plugin type target must exist")
})

test("generated declaration locations retain package type resolution", () => {
  for (let depth = 0; depth < 12; depth++) {
    for (const suffix of [".d.ts", ".d.mts", ".d.cts"]) {
      const declaration = join(packageRoot, ...Array.from({ length: depth }, () => "nested"), "workflow" + suffix)
      assert.ok(resolveTypeOwner("effect", declaration), "existing type dependencies must resolve")
      const owner = resolveTypeOwner("@smthrs/plugin", declaration)
      assert.ok(owner, "nested workflow declarations must resolve their plugin type owner")
      assert.ok(existsSync(owner.resolvedFileName))
      assert.equal(resolveTypeOwner("@smthrs/missing-declaration-owner-control", declaration), undefined)
    }
  }
})
