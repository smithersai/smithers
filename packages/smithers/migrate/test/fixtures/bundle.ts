/**
 * Bundles one entry point for `bundleOnce` in `helpers.ts`.
 *
 * Workspace sources import `.vibe` modules, which esbuild loads only through
 * the VibeLang plugin, and esbuild runs plugins only in its asynchronous API.
 * `bundleOnce` stays synchronous by running this file as a child process: it
 * reads the esbuild options as JSON from the first argument and prints the
 * metafile's input paths as JSON.
 */
import { build, type BuildOptions } from "esbuild"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"

const options = JSON.parse(process.argv[2]!) as BuildOptions
const result = await build({
  ...options,
  metafile: true,
  plugins: [vibelang({ root: fileURLToPath(new URL("../../", import.meta.url)) })]
})
process.stdout.write(JSON.stringify(Object.keys(result.metafile.inputs)))
