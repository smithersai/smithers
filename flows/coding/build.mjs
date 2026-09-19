/** Private deployment artifact; the existing Plue provisioner stages one executable. */
import { build } from "esbuild"
import { chmod, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Used to build the same runtime acceptance entry with the deployment bundler; not a package export. */
export const bundle = async (entryPoint, outfile) => {
  // Resolve workspace packages from this checkout even when node_modules is
  // shared with another worktree. Otherwise a release silently bundles old code.
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  const alias = {}
  for (const pattern of manifest.workspaces) {
    const paths = pattern.endsWith("/*")
      ? (await readdir(resolve(root, pattern.slice(0, -2)), { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => resolve(root, pattern.slice(0, -2), entry.name))
      : [resolve(root, pattern)]
    for (const path of paths) {
      try {
        const pkg = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"))
        if (pkg.name) {
          for (const [key, target] of Object.entries(pkg.exports ?? {})) {
            if (typeof target !== "string" || key.includes("*")) continue
            alias[pkg.name + (key === "." ? "" : key.slice(1))] = resolve(path, target)
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }
  const result = await build({
    alias,
    entryPoints: [entryPoint], outfile, write: false, bundle: true, platform: "node", format: "esm", target: "node22.19",
    banner: { js: "#!/usr/bin/env node\nimport {createRequire as __smithersCreateRequire} from 'node:module'; const require=__smithersCreateRequire(import.meta.url);" },
    plugins: [{
      name: "lazy-bun-sqlite",
      setup(build) {
        // esbuild hoists static external imports from dynamically loaded ESM
        // modules. Keep Bun's existing builtin behind that same lazy boundary,
        // so a Node launch never attempts to resolve bun:sqlite.
        build.onResolve({ filter: /^bun:sqlite$/ }, args => args.namespace === "lazy-bun-sqlite"
          ? { path: args.path, external: true }
          : { path: args.path, namespace: "lazy-bun-sqlite" })
        build.onLoad({ filter: /.*/, namespace: "lazy-bun-sqlite" }, () => ({
          contents: 'const native = await import("bun:sqlite"); export const Database = native.Database;', loader: "js"
        }))
      }
    }]
  })
  if (result.outputFiles.length !== 1) throw new Error("Coding host must be one immutable executable")
  // The authoring pack's prompt bodies travel with the executable.
  //
  // They are `.mdx` files in this repository and the deployment carries no
  // repository tree, so the host would have nothing to install on a workspace.
  // They go in BEFORE the artifact is hashed, so the policy digest a workspace
  // records covers the exact prompts it will run: editing one respins the
  // host, as it should.
  const packRoot = fileURLToPath(new URL("../create-flow/", import.meta.url))
  const pack = {}
  for (const name of ["", "clarify", "provision", "design", "scaffold", "fix", "document"]) {
    const file = resolve(packRoot, name, "flow.mdx")
    pack[name === "" ? "create-flow" : `create-flow/${name}`] = await readFile(file, "utf8")
  }
  const compiled = result.outputFiles[0].text.replace(/^(#![^\n]*\n)/,
    `$1const __SMITHERS_CREATE_FLOW_PACK__ = ${JSON.stringify(pack)};\n`)
  if (compiled === result.outputFiles[0].text) throw new Error("Coding artifact has no executable banner")
  const digest = createHash("sha256").update(compiled).digest("hex")
  // Hash the exact compiled artifact before inserting its own identity. This
  // includes the reviewer implementation and its complete bundled dependency
  // graph, with no dependency on files vendored in the target repository.
  const output = compiled.replace(/^(#![^\n]*\n)/,
    `$1const __SMITHERS_CODING_ARTIFACT_DIGEST__ = ${JSON.stringify(digest)};\n`)
  if (output === compiled) throw new Error("Coding artifact has no executable banner")
  await mkdir(dirname(resolve(outfile)), { recursive: true })
  await writeFile(outfile, output)
  await chmod(outfile, 0o755)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outfile = resolve(process.argv[2] ?? "dist/coding-host/smithers.mjs")
  await bundle(fileURLToPath(new URL("./serve.ts", import.meta.url)), outfile)
  process.stdout.write(`${outfile}\n`)
}
