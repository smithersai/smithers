import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compilePackage, copyInputDeclarations } from "../../../../repo-targets/scripts/build-library.mjs"
import { compileCommonJs } from "../../../scripts/compile-commonjs.mjs"
import { buildObserve } from "./build-observe.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = resolve(packageRoot, "src")
const esmRoot = resolve(packageRoot, "dist/esm")

const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true })
// tsc, or vibelang when VibeLang sources are in reach; it prints its diagnostics.
try {
  compilePackage(packageRoot, { timeoutMs: 600_000 })
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

copyInputDeclarations(sourceRoot, esmRoot)

for (
  const source of files(sourceRoot).filter((file) =>
    file.endsWith(".js") && !existsSync(file.replace(/\.js$/, ".ts"))
  )
) {
  const target = resolve(esmRoot, relative(sourceRoot, source))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
}

await compileCommonJs(sourceRoot, resolve(packageRoot, "dist/cjs"), esmRoot)

// A release build (SMITHERS_NATIVE=1, or =required to fail without zig) ships the recorder; a build in the workspace
// leaves it to the `observe` target.
const native = process.env.SMITHERS_NATIVE
if (native === "1" || native === "required") buildObserve({ root: packageRoot, required: native === "required" })
