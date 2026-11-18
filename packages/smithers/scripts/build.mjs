import { rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBundle } from "./build-bundle.mjs"
import { buildTui } from "./build-tui.mjs"
import { compilePackage } from "../../repo-targets/scripts/build-library.mjs"
import { compileCommonJs } from "./compile-commonjs.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true })
// tsc, or vibelang when VibeLang sources are in reach; it prints its diagnostics.
try {
  compilePackage(packageRoot, { timeoutMs: 600_000 })
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

await compileCommonJs(resolve(packageRoot, "src"), resolve(packageRoot, "dist/cjs"), resolve(packageRoot, "dist/esm"))

await buildTui()

// The one file a published installation runs; `dist/esm` stays what other packages import.
await buildBundle()
