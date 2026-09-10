/** Private deployment artifact; the existing Plue provisioner stages one executable. */
import { build } from "esbuild"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Used to build the same runtime acceptance entry with the deployment bundler; not a package export. */
export const bundle = async (entryPoint, outfile) => {
  const result = await build({
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
  const compiled = result.outputFiles[0].text
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
