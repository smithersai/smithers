// The shared dual-format build program for a conventional package. It runs
// from the package directory, which is where `pnpm run build` and the `lib`
// target start it, and resolves `typescript` and `esbuild` from that package,
// so each package keeps building with the versions it pins.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const packageRoot = process.cwd()
const packageRequire = createRequire(resolve(packageRoot, "package.json"))
const tsc = resolve(packageRoot, "node_modules/typescript/bin/tsc")
const { build } = packageRequire("esbuild")

const filesWithExtension = (directory, extension) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesWithExtension(path, extension) : entry.name.endsWith(extension) ? [path] : []
  })

rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true })
const declarationResult = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit"
})
if (declarationResult.status !== 0) process.exit(declarationResult.status ?? 1)

// The `require` condition serves the CommonJS tree below, so that tree needs
// its own declarations: TypeScript reads a file's module format from the
// nearest package.json, and `dist/cjs/package.json` marks these as CommonJS.
// Emitting the same declarations there is what lets a Node16 consumer's value
// import land on a CommonJS declaration file instead of the ESM one, which is
// TS1479. Declaration-only, because esbuild writes the JavaScript.
const cjsDeclarationResult = spawnSync(
  process.execPath,
  [tsc, "-p", "tsconfig.json", "--emitDeclarationOnly", "--declarationDir", "dist/cjs"],
  { cwd: packageRoot, stdio: "inherit" }
)
if (cjsDeclarationResult.status !== 0) process.exit(cjsDeclarationResult.status ?? 1)

await build({
  entryPoints: filesWithExtension(resolve(packageRoot, "src"), ".ts"),
  outbase: resolve(packageRoot, "src"),
  outdir: resolve(packageRoot, "dist/cjs"),
  format: "cjs",
  bundle: false,
  platform: "neutral",
  target: "es2022",
  sourcemap: true
})

for (const file of filesWithExtension(resolve(packageRoot, "dist/cjs"), ".js")) {
  const source = readFileSync(file, "utf8")
  writeFileSync(
    file,
    source.replace(
      /(require\(["'](?:\.\.?\/)[^"']+)\.ts(["']\))/g,
      "$1.js$2"
    )
  )
}

mkdirSync(resolve(packageRoot, "dist/cjs"), { recursive: true })
writeFileSync(resolve(packageRoot, "dist/cjs/package.json"), '{\n  "type": "commonjs"\n}\n')
