/** Shared package assembly. Resolve tools from the package being built. */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { buildPrivateEffectAdapters } from "./private-effect-adapters.mjs"

const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

/** Input declarations are shipped beside generated declarations in every release. */
export const copyInputDeclarations = (source, destination) => {
  for (const file of files(source).filter((file) => file.endsWith(".d.ts"))) {
    const target = join(destination, relative(source, file))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(file, target)
  }
}

// A nested package boundary does not inherit the root's imports map. External
// targets stay external; source targets must address this branch's emitted files.
const commonJsImports = (target, types = false) => {
  if (typeof target === "string") {
    if (!target.startsWith("./")) return target
    const prefix = ["./src/", "./dist/cjs/"].find((prefix) => target.startsWith(prefix))
    if (prefix === undefined) throw new Error(`CommonJS import target ${JSON.stringify(target)} must name a compiled ./src/ or ./dist/cjs/ file`)
    return `./${target.slice(prefix.length)}`.replace(/(?<!\.d)\.(?:ts|vibe)$/, types ? ".d.ts" : ".js")
  }
  if (target === null) return null
  if (Array.isArray(target)) return target.map((entry) => commonJsImports(entry, types))
  return Object.fromEntries(Object.entries(target).map(([condition, entry]) =>
    [condition, commonJsImports(entry, types || condition === "types")]
  ))
}

/** Each runtime branch needs declarations, module kind and its package imports. */
export const copyCommonJsDeclarations = (packageRoot) => {
  const esm = join(packageRoot, "dist/esm")
  const cjs = join(packageRoot, "dist/cjs")
  for (const source of files(esm).filter((file) => /\.d\.ts(?:\.map)?$/.test(file))) {
    const target = join(cjs, relative(esm, source))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
  }
  mkdirSync(cjs, { recursive: true })
  const manifestPath = join(packageRoot, "package.json")
  const { imports } = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}
  const marker = { type: "commonjs", ...(imports === undefined ? {} : { imports: commonJsImports(imports) }) }
  writeFileSync(join(cjs, "package.json"), `${JSON.stringify(marker)}\n`)
}

/** Whether a source tree holds a VibeLang module. Installs and build output are not sources. */
export const hasVibeSources = (directory) =>
  existsSync(directory) && readdirSync(directory, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? entry.name !== "node_modules" && entry.name !== "dist" && hasVibeSources(join(directory, entry.name))
      : entry.name.endsWith(".vibe")
  )

// The directory Node would load `name` from for a module in `from`, as a real path.
const installedPackage = (from, name) => {
  for (let directory = from;; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
    if (dirname(directory) === directory) return undefined
  }
}

/**
 * The packages whose VibeLang sources a package's compile reads: the package
 * itself when its `src` holds a `.vibe` module, and each linked package it
 * depends on whose `src` does, followed transitively. A workspace package's
 * exports name its source, so a `.vibe` module in a dependency reaches every
 * dependent's program, and tsc cannot read it. A package installed under
 * `node_modules` ships JavaScript and is not followed. The package's own
 * development dependencies count, because its sources may import their
 * types; a dependency's do not. Each entry is `{ name, root }`.
 */
export const vibeSourcePackages = (packageRoot) => {
  const found = []
  const seen = new Set()
  const visit = (root, development) => {
    if (seen.has(root)) return
    seen.add(root)
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    if (hasVibeSources(join(root, "src"))) found.push({ name: manifest.name ?? root, root })
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      ...(development ? manifest.devDependencies : {})
    })
    for (const name of names) {
      const dependency = installedPackage(root, name)
      if (dependency !== undefined && !dependency.split(sep).includes("node_modules")) visit(dependency, false)
    }
  }
  visit(realpathSync(packageRoot), true)
  return found
}

/**
 * The compiler a package's build runs, resolved from the package: vibelang
 * when {@link vibeSourcePackages} finds VibeLang sources, else tsc. vibelang
 * is TypeScript 7 on plain TypeScript, so a package with no VibeLang in reach
 * keeps tsc and its declarations.
 */
export const packageCompiler = (packageRoot) => {
  const require = createRequire(join(packageRoot, "package.json"))
  const sources = vibeSourcePackages(packageRoot)
  const name = sources.length > 0 ? "vibelang" : "tsc"
  let manifest
  try {
    manifest = require.resolve(name === "vibelang" ? "vibelang/package.json" : "typescript/package.json")
  } catch (cause) {
    throw new Error(
      name === "vibelang"
        ? `${packageRoot} compiles VibeLang sources (${sources.map((source) => source.name).join(", ")}), and vibelang is not installed for it: add vibelang to its devDependencies`
        : `${packageRoot} has no typescript installed`,
      { cause }
    )
  }
  return { name, path: join(dirname(manifest), name === "vibelang" ? "bin/vibelang" : "bin/tsc"), sources }
}

/**
 * Runs the package compiler over the package's `tsconfig.json`: the ESM
 * branch, its declarations and maps. The compiler's diagnostics go to this
 * process's output.
 */
export const compilePackage = (packageRoot, { timeoutMs = 90_000 } = {}) => {
  const compiler = packageCompiler(packageRoot)
  if (compiler.name === "vibelang") {
    console.log(`compiling with vibelang: VibeLang sources in ${compiler.sources.map((source) => source.name).join(", ")}`)
  }
  const result = spawnSync(process.execPath, [compiler.path, "-p", "tsconfig.json"], {
    cwd: packageRoot,
    stdio: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  })
  if (result.error) throw new Error(`package compiler failed: ${result.error.message}`, { cause: result.error })
  if (result.status !== 0) throw new Error(`package compiler exited ${result.status ?? result.signal}`)
  return compiler
}

export const buildLibrary = async (packageRoot, { esmOnly = [], declarationTimeoutMs = 90_000 } = {}) => {
  const require = createRequire(join(packageRoot, "package.json"))
  const { build } = require("esbuild")
  const src = join(packageRoot, "src")
  const esm = join(packageRoot, "dist/esm")
  // esbuild cannot read .vibe, so a package with VibeLang sources takes its
  // CommonJS from the ESM vibelang emitted. A TypeScript package keeps
  // esbuild over its sources, whichever compiler emitted its ESM.
  const vibe = hasVibeSources(src)
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true })
  compilePackage(packageRoot, { timeoutMs: declarationTimeoutMs })
  const cjs = join(packageRoot, "dist/cjs")
  copyInputDeclarations(src, esm)
  const input = vibe ? esm : src
  const excluded = new Set(esmOnly.map((path) => resolve(input, vibe ? path.replace(/\.(?:ts|vibe)$/, ".js") : path)))
  await build({
    entryPoints: vibe
      ? files(esm).filter((file) => file.endsWith(".js") && !excluded.has(file))
      : files(src).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && !excluded.has(file)),
    outbase: input,
    outdir: cjs,
    format: "cjs",
    bundle: false,
    platform: "neutral",
    target: "es2022",
    sourcemap: true
  })
  for (const file of files(cjs).filter((file) => file.endsWith(".js"))) {
    const text = readFileSync(file, "utf8")
      // A lazy `import("./x.ts")` kept as-is names a .ts file the branch does
      // not ship, and Node's import() of an esbuild CommonJS module exposes
      // only `default`. Lowered to require(), it gets the .js rewrite below and
      // the named exports the ESM branch has. Computed and package specifiers
      // stay import(): require() cannot load a file URL or an ESM-only module.
      .replace(/(?<![\w$.])import\((["'])(\.\.?\/[^"'\n]+)\1\)/g, "Promise.resolve().then(() => require($1$2$1))")
      .replace(/(require\(["'](?:\.\.?\/)[^"']+)\.ts(["']\))/g, "$1.js$2")
    writeFileSync(file, text)
  }
  copyCommonJsDeclarations(packageRoot)
  await buildPrivateEffectAdapters(packageRoot)
}
