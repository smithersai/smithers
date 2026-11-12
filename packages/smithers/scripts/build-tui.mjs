/**
 * Bundles the Smithers TUI (`apps/tui/src/main.tsx`) into `dist/tui/main.js`
 * so `smthrs tui` can run it under Node or Bun, from a checkout or an
 * installation.
 *
 * Workspace `@smthrs/*` sources and pure JavaScript dependencies are inlined:
 * the checkout's TypeScript and VibeLang sources do not run on plain Node, and
 * vibelang-unplugin compiles each `.vibe` module with its package's project.
 * Every package the CLI declares as a dependency stays external so the
 * installed copy is the one that loads (effect and react must be single instances, and
 * `@opentui/core` carries native libraries). The build fails when the bundle
 * imports a package the CLI does not declare. Code splitting keeps Bun-only
 * modules that load through a dynamic `import()` out of the entry chunk.
 *
 * Only changed files are written, so `smthrs tui` can rebuild before every
 * checkout launch under Node without disturbing a TUI already running from
 * the same output. Chunk names carry a content hash, so a chunk never changes
 * under a running TUI.
 *
 * Run it alone with `node scripts/build-tui.mjs`. `logLevel` is esbuild's:
 * the package build prints warnings, and the launch-time rebuild that
 * `smthrs tui` runs prints only errors, so a launch's stderr carries the
 * TUI's own output and not the compile warnings of the sources it bundles.
 */
import { build } from "esbuild"
import vibelang from "vibelang-unplugin/esbuild"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildPrivateEffectAdapters,
  privateEffectAdapters
} from "../../repo-targets/scripts/private-effect-adapters.mjs"
import { verifyNativeArtifacts } from "../vendor/opentui-native/verify.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const builtin = (specifier) =>
  specifier.startsWith("node:") || specifier.startsWith("bun:") || builtinModules.includes(specifier)

/** The package name a bare specifier names: `@scope/name` or `name`. */
const packageName = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

/**
 * esbuild probes Yarn's virtual PnP API inside a try/catch when its native
 * binary lives in a zip. Yarn supplies it; ordinary Node installations do not.
 * Only that dependency's CommonJS probe is optional.
 */
const optionalEnvironmentProbe = (path, importer, kind) =>
  path === "pnpapi" && kind === "require-call" && /(?:^|[/\\])esbuild[/\\]lib[/\\]main\.js$/.test(importer)

/** The bare specifier a `#import` names in the nearest manifest's `imports`, if it names a package. */
const packageImportTarget = (specifier, directory) => {
  for (let current = directory; ; current = dirname(current)) {
    const path = resolve(current, "package.json")
    if (existsSync(path)) {
      const target = JSON.parse(readFileSync(path, "utf8")).imports?.[specifier]?.default
      return typeof target === "string" && !target.startsWith(".") ? target : undefined
    }
    if (dirname(current) === current) return undefined
  }
}

/**
 * Keeps declared packages external, and so also a package an inlined module
 * reaches through its own `#import`, such as `@smthrs/platform-bun`'s optional
 * Electrobun: the bundle must load the installed copy, or fail where it is
 * used if none is installed.
 */
export const declaredDependenciesExternal = (declared) => ({
  name: "declared-dependencies-external",
  setup(context) {
    context.onResolve({ filter: /^[^./]/ }, ({ path, resolveDir, importer, kind }) => {
      const specifier = path.startsWith("#") ? packageImportTarget(path, resolveDir) : path
      if (specifier === undefined) return undefined
      if (optionalEnvironmentProbe(specifier, importer, kind)) return { path: specifier, external: true }
      if (builtin(specifier)) return { path: specifier, external: true }
      if (specifier === "@smthrs/cli/tui-native") return { path: specifier, external: true }
      const name = packageName(specifier)
      return !name.startsWith("@smthrs/") && declared.has(name) ? { path: specifier, external: true } : undefined
    })
  }
})

/** Reject undeclared imports, allowing only dependency-scoped optional environment probes. */
export const assertTuiImports = (metafile, declared) => {
  const optional = new Set()
  const required = new Set()
  for (const [importer, input] of Object.entries(metafile.inputs)) {
    for (const { path, external, kind } of input.imports) {
      if (!external) continue
      if (optionalEnvironmentProbe(path, importer, kind)) optional.add(path)
      else required.add(path)
    }
  }
  const undeclared = new Set()
  for (const output of Object.values(metafile.outputs)) {
    for (const { path, external, kind } of output.imports) {
      if (
        external && path !== "@smthrs/cli/tui-native" && !builtin(path) && !path.startsWith(".") &&
        !declared.has(packageName(path)) &&
        !(kind === "require-call" && optional.has(path) && !required.has(path))
      ) {
        undeclared.add(path)
      }
    }
  }
  if (undeclared.size > 0) {
    throw new Error(`The TUI bundle imports packages @smthrs/cli does not declare: ${[...undeclared].join(", ")}`)
  }
}

export const buildTui = async ({ logLevel = "warning" } = {}) => {
  verifyNativeArtifacts()
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...privateEffectAdapters(manifest)
  ])
  const outdir = resolve(packageRoot, "dist/tui")
  const app = resolve(packageRoot, "../../apps/tui")
  const result = await build({
    entryPoints: { main: resolve(app, "src/main.tsx") },
    outdir,
    bundle: true,
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    format: "esm",
    platform: "node",
    target: "esnext",
    jsx: "automatic",
    jsxImportSource: "@opentui/react",
    // Inlined CommonJS dependencies `require` Node builtins at run time.
    banner: {
      js:
        "import { createRequire as __tuiRequire } from \"node:module\"; const require = __tuiRequire(import.meta.url);"
    },
    metafile: true,
    write: false,
    logLevel,
    // `.vibe` modules of the workspace packages the TUI imports compile with
    // their own package's tsconfig.
    plugins: [vibelang({ root: app }), declaredDependenciesExternal(declared)]
  })
  if (result.errors.length > 0) throw new Error("The TUI bundle failed to build")
  assertTuiImports(result.metafile, declared)
  for (const file of result.outputFiles) {
    let current
    try {
      current = readFileSync(file.path)
    } catch {
      current = undefined
    }
    if (current !== undefined && Buffer.compare(current, file.contents) === 0) continue
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.contents)
  }
  await buildPrivateEffectAdapters(packageRoot)
  return result.metafile
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildTui()
