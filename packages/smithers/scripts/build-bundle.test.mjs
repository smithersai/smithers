/**
 * The one file a published `smthrs` runs: the rules that keep it behaving as
 * the separate modules do, each on a small real tree, and the real bundle.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { builtinModules, registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { originFile, packageRoot, resolveFrom, resolveHooks } from "../bin/bundle-origin.mjs"
import {
  buildBundle,
  dependencyChains,
  externalPackages,
  optionalProbes,
  ownedModules,
  ownedPackages,
  packageName,
  packageOf,
  publicSpecifiers,
  publishedPath,
  rewriteLocation
} from "./build-bundle.mjs"

const cliRoot = fileURLToPath(new URL("../", import.meta.url))

/** Writes a tree of files under a new temporary directory and removes it afterwards. */
const withTree = async (files, body) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-bundle-")))
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), typeof text === "string" ? text : JSON.stringify(text))
    }
    return await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** `@smthrs/cli` installed with a dependency `outer`, which brings its own `inner`. */
const installation = {
  "package.json": { name: "@smthrs/cli", version: "1.0.0" },
  "dist/bundle/bin.js": "",
  "src/a.js": "",
  "node_modules/outer/package.json": { name: "outer", version: "1.2.3", type: "module" },
  "node_modules/outer/index.js": "export default \"outer\"\n",
  "node_modules/outer/node_modules/inner/package.json": { name: "inner", version: "4.5.6", type: "module", exports: "./index.js" },
  "node_modules/outer/node_modules/inner/index.js": "export default \"inner of outer\"\n"
}

test("a specifier names its package, scoped or not", () => {
  assert.equal(packageName("effect"), "effect")
  assert.equal(packageName("effect/Schema"), "effect")
  assert.equal(packageName("@smthrs/targets"), "@smthrs/targets")
  assert.equal(packageName("@smthrs/targets/Shell"), "@smthrs/targets")
})

test("a module is published where its package publishes it", () =>
  withTree({
    "packages/first/package.json": { name: "@smthrs/first", version: "1.0.0" },
    "packages/first/dist/esm/package.json": { type: "module" },
    "packages/first/src/deep/Thing.ts": "",
    "packages/first/src/View.tsx": "",
    "packages/first/src/Flow.vibe": "",
    "packages/first/scripts/tool.mjs": "",
    "node_modules/third/package.json": { name: "third", version: "2.0.0" },
    "node_modules/third/src/index.ts": ""
  }, (root) => {
    const first = packageOf(join(root, "packages/first/src/deep/Thing.ts"))
    assert.equal(first.manifest.name, "@smthrs/first")
    // `dist/esm/package.json` names no package, so the search goes on above it.
    assert.equal(packageOf(join(root, "packages/first/dist/esm/x.js")).root, first.root)
    assert.equal(publishedPath(first, join(root, "packages/first/src/deep/Thing.ts")), "dist/esm/deep/Thing.js")
    assert.equal(publishedPath(first, join(root, "packages/first/src/View.tsx")), "dist/esm/View.js")
    assert.equal(publishedPath(first, join(root, "packages/first/src/Flow.vibe")), "dist/esm/Flow.js")
    assert.equal(publishedPath(first, join(root, "packages/first/scripts/tool.mjs")), "scripts/tool.mjs")
    // Another publisher's `src` is published as it is.
    const third = packageOf(join(root, "node_modules/third/src/index.ts"))
    assert.equal(publishedPath(third, join(root, "node_modules/third/src/index.ts")), "src/index.ts")
    assert.throws(() => packageOf("/nowhere/at/all.js"), /is in no package/)
  }))

test("a private adapter's modules are published inside the CLI's own vendor file", () => {
  const adapter = { root: "/x/node_modules/@effect/platform-node", manifest: { name: "@effect/platform-node", version: "4.0.0" } }
  assert.equal(publishedPath(adapter, "/x/node_modules/@effect/platform-node/dist/NodeServices.js"), "dist/vendor/platform-node.js")
})

test("a module that asks where it is gets the address it is published at", async () => {
  const rewritten = await rewriteLocation("export const here = import.meta.url\nexport const beside = import.meta.dirname\n", "pkg@1.0.0", "dist/a.js", "js")
  assert.ok(rewritten.startsWith("const __smthrsMeta = __smthrsOriginMeta(\"pkg@1.0.0\", \"dist/a.js\");\n"))
  assert.match(rewritten, /here = __smthrsMeta\.url/)
  assert.match(rewritten, /beside = __smthrsMeta\.directory/)

  const commonjs = await rewriteLocation("module.exports = [__dirname, __filename, import.meta.filename, import.meta.resolve(\"x\")]\n", "pkg@1.0.0", "lib/b.cjs", "js")
  assert.match(commonjs, /\[__smthrsMeta\.directory, __smthrsMeta\.file, __smthrsMeta\.file, __smthrsMeta\.resolve\("x"\)\]/)

  const typed = await rewriteLocation("export const here: string = import.meta.url\n", "@smthrs/first", "dist/esm/a.js", "ts")
  assert.match(typed, /here = __smthrsMeta\.url/)
  assert.doesNotMatch(typed, /: string/)

  const script = await rewriteLocation("#!/usr/bin/env node\nconsole.log(import.meta.url)\n", "pkg@1.0.0", "bin.js", "js")
  assert.ok(script.startsWith("#!/usr/bin/env node\nconst __smthrsMeta = "))
})

test("the same words in a string, a comment or a module's own declaration are left alone", async () => {
  assert.equal(await rewriteLocation("export const one = 1\n", "pkg@1.0.0", "a.js", "js"), undefined)
  assert.equal(await rewriteLocation("// import.meta.url\nexport const text = \"import.meta.url and __dirname\"\n", "pkg@1.0.0", "a.js", "js"), undefined)
  assert.equal(await rewriteLocation("const __dirname = \"/fixed\"\nexport const where = __dirname\n", "pkg@1.0.0", "a.js", "js"), undefined)
  assert.equal(await rewriteLocation("export const own = object.__dirname\n", "pkg@1.0.0", "a.js", "js"), undefined)
})

test("an export map's public specifiers are its named entries and what each pattern reaches", () =>
  withTree({
    "dist/index.js": "",
    "dist/Open.js": "",
    "dist/deep/Nested.js": "",
    "dist/internal/Hidden.js": "",
    "dist/Open.d.ts": "",
    "data/table.json": "{}"
  }, (root) => {
    assert.deepEqual(
      publicSpecifiers("pkg", root, {
        ".": { types: "./dist/index.d.ts", import: { default: "./dist/index.js" } },
        "./package.json": "./package.json",
        "./Named": { default: "./dist/Open.js" },
        "./table": "./data/table.json",
        "./types": { types: "./dist/Open.d.ts" },
        "./*": "./dist/*.js",
        "./internal/*": null
      }),
      ["pkg", "pkg/Named", "pkg/Open", "pkg/deep/Nested", "pkg/index"]
    )
  }))

test("a package is reached from the CLI by the names that install it, shortest chain first", () =>
  withTree(installation, (root) => {
    const metafile = {
      inputs: {
        "smthrs-bundle:entry": { imports: [{ path: "src/a.js", original: "./src/a.js" }] },
        "src/a.js": {
          imports: [
            { path: "node_modules/outer/index.js", original: "outer" },
            { path: "node:fs", original: "node:fs", external: true },
            { path: "src/b.js", original: "./b.js" }
          ]
        },
        "node_modules/outer/index.js": {
          imports: [
            { path: "node_modules/outer/node_modules/inner/index.js", original: "inner" },
            { path: "left-outside", original: "left-outside", external: true }
          ]
        },
        "node_modules/outer/node_modules/inner/index.js": { imports: [{ path: "node_modules/outer/index.js", original: "outer" }] }
      }
    }
    assert.deepEqual([...dependencyChains(metafile, root)], [
      ["@smthrs/cli", []],
      ["outer@1.2.3", ["outer"]],
      ["inner@4.5.6", ["outer", "inner"]]
    ])
  }))

test("an inlined module's address is found where a package manager installed its package", () =>
  withTree(installation, (root) => {
    const bundle = pathToFileURL(join(root, "dist/bundle/bin.js")).href
    assert.equal(packageRoot(bundle, []), root)
    assert.equal(packageRoot(bundle, ["outer"]), join(root, "node_modules/outer"))
    assert.equal(packageRoot(bundle, ["outer", "inner"]), join(root, "node_modules/outer/node_modules/inner"))
    assert.equal(originFile(bundle, ["outer", "inner"], "index.js"), join(root, "node_modules/outer/node_modules/inner/index.js"))
    assert.throws(() => packageRoot(bundle, ["outer", "absent"]), /absent is not installed where .*outer can import it\. Reinstall @smthrs\/cli\./)
  }))

test("a package left outside the bundle resolves from the package that imports it", () =>
  withTree(installation, async (root) => {
    const bundle = pathToFileURL(join(root, "dist/bundle/bin.js")).href
    const hooks = registerHooks(resolveHooks(bundle))
    try {
      // `inner` is installed for `outer` alone: nothing above `outer` can import it.
      await assert.rejects(import(pathToFileURL(join(root, "src/absent.js")).href))
      assert.equal((await import("smthrs-from:outer!inner")).default, "inner of outer")
      assert.equal((await import("smthrs-from:outer!node:path")).sep, "/")
    } finally {
      hooks.deregister()
    }
  }))

test("a module's own resolve answers as the installed module would", () =>
  withTree(installation, (root) => {
    const outer = pathToFileURL(join(root, "node_modules/outer/index.js")).href
    const resolve = (specifier) => import.meta.resolve(specifier)
    assert.equal(resolveFrom(outer, "inner", resolve), pathToFileURL(join(root, "node_modules/outer/node_modules/inner/index.js")).href)
    assert.equal(resolveFrom(outer, "./beside.js", resolve), pathToFileURL(join(root, "node_modules/outer/beside.js")).href)
    assert.throws(() => resolveFrom(outer, "absent-package", resolve), { code: "ERR_MODULE_NOT_FOUND" })
    // The hook that answered is gone: the same question asked plainly resolves from this file.
    assert.throws(() => import.meta.resolve("inner"), { code: "ERR_MODULE_NOT_FOUND" })
  }))

const sources = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(?:ts|js)$/.test(entry.name) ? [join(directory, entry.name)] : []
  )

test("every package the CLI owns for a workspace's imports is in the bundle's table", () => {
  const owned = new Set([...Object.values(ownedPackages).flat(), ...Object.values(ownedModules).flat()])
  // What the resolver owns by itself.
  const resolver = readFileSync(join(cliRoot, "build/build-cli/src/effect-resolution.js"), "utf8")
  const builtIn = JSON.parse(/const cliOwnedPackages = (\[[^\]]*\])/.exec(resolver)[1])
  assert.ok(builtIn.length > 0)
  // What a command adds: `installEffectResolution({ "<name>": import.meta.url, ... })`.
  const registered = sources(join(cliRoot, "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/installEffectResolution\(\{([^}]*)\}/g)].flatMap(([, body]) =>
      [...body.matchAll(/"([^"]+)":/g)].map(([, name]) => name)
    )
  )
  assert.ok(registered.includes("@smthrs/agent"))
  for (const name of ["effect", ...builtIn, ...registered]) {
    assert.ok(owned.has(name), `${name} is owned by the CLI and missing from the bundle's table`)
  }
})

test("the real program bundles into one file that imports only what its packages install", { timeout: 600_000 }, async () => {
  const outdir = mkdtempSync(join(tmpdir(), "smthrs-bundle-real-"))
  try {
    const { metafile, chains } = await buildBundle({ outdir, logLevel: "silent" })
    assert.deepEqual(readdirSync(outdir), ["bin.js"])
    const text = readFileSync(join(outdir, "bin.js"), "utf8")
    assert.doesNotMatch(text, /__SMTHRS_CHAINS__/)
    // A workspace file's imports are answered from this table.
    for (const specifier of ["effect", "effect/Schema", "@smthrs/targets", "@smthrs/flow", "@smthrs/agent", "@smthrs/evals", "@smthrs/registry/Prompt/jsx-runtime"]) {
      assert.ok(text.includes(`[${JSON.stringify(specifier)}, () => `), `${specifier} is not in the bundle's table`)
    }
    // The package a chain ends at, found the way the running bundle finds it.
    const installed = pathToFileURL(join(cliRoot, "dist/bundle/bin.js")).href
    const declares = (chain, name) => {
      const manifest = JSON.parse(readFileSync(join(packageRoot(installed, chain), "package.json"), "utf8"))
      return [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies].some((group) => group?.[name] !== undefined)
    }
    const [output] = Object.values(metafile.outputs)
    let outside = 0
    for (const { path, external } of output.imports) {
      if (!external || path.startsWith("node:") || path.startsWith("bun:") || builtinModules.includes(path)) continue
      if (path === "../../bin/bundle-origin.mjs" || optionalProbes.includes(packageName(path))) continue
      outside += 1
      const from = /^smthrs-from:([^!]*)!(.*)$/.exec(path)
      const name = packageName(from === null ? path : from[2])
      assert.ok(externalPackages.includes(name), `${path} is left outside the bundle and is not a package the bundle leaves outside`)
    }
    assert.ok(outside > 0)
    // Each import the file carries names its importer by a chain of installed names, never by a version.
    for (const [, chain, specifier] of text.matchAll(/["']smthrs-from:([^!"']*)!([^"']+)["']/g)) {
      assert.doesNotMatch(chain, /@\d/)
      assert.ok(declares(chain.split(","), packageName(specifier)), `${chain} does not declare ${specifier}`)
    }
    assert.deepEqual(chains.get("@smthrs/cli"), [])
    assert.deepEqual(chains.get("@smthrs/build-cli"), ["@smthrs/build-cli"])
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
})
