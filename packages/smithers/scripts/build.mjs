import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { compileCommonJs } from "./compile-commonjs.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsc = resolve(packageRoot, "node_modules/typescript/bin/tsc")

rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true })
const declarationResult = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit"
})
if (declarationResult.status !== 0) process.exit(declarationResult.status ?? 1)

await compileCommonJs(resolve(packageRoot, "src"), resolve(packageRoot, "dist/cjs"), resolve(packageRoot, "dist/esm"))

// `smthrs tui` runs this bundle under Bun. Packages stay external: the CLI
// depends on every package the TUI imports.
const tui = await build({
  entryPoints: [resolve(packageRoot, "../../apps/tui/src/main.tsx")],
  outfile: resolve(packageRoot, "dist/tui/main.js"),
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "esnext",
  jsx: "automatic",
  jsxImportSource: "@opentui/react",
  logLevel: "warning"
})
if (tui.errors.length > 0) process.exit(1)
