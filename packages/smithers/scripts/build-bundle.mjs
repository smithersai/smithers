/**
 * Bundles the `smthrs` executable (`src/bin.ts`) into `dist/bundle/bin.js`, the
 * one file a published installation runs.
 *
 * A start of the unbundled package resolves, reads and links about 3,000
 * modules before it reads a workspace: 6 to 7 s of CPU. The same program as
 * one file starts in under a third of that. The bundle is laid over the
 * installed package and changes nothing else in it: `dist/esm`, `dist/cjs`,
 * the export map and the dependencies stay what other packages import.
 *
 * Three rules keep the one file behaving as the separate files did.
 *
 * 1. **An inlined module keeps its own address.** `import.meta.url`,
 *    `__dirname` and `__filename` in an inlined module name the file that
 *    module is published as, found at run time through the dependency chain
 *    from `@smthrs/cli` (`bin/bundle-origin.mjs`). Native helpers, skills, the
 *    TUI and the cache keys the build makes from its own sources read the same
 *    installed files as before.
 * 2. **A package left outside resolves from its importer.** A package with
 *    native code or its own loader stays an import. When the importer is not
 *    `@smthrs/cli`, the import carries the importer's dependency chain
 *    (`smthrs-from:`) and the executable's resolve hook resolves it from that
 *    package, so two installed versions of one package both keep working.
 * 3. **A workspace file shares the bundle's instances.** The packages the CLI
 *    owns for declaration modules (`effect`, `@smthrs/targets`, `@smthrs/plan`,
 *    `@smthrs/core`, `@smthrs/flow`, `@smthrs/agent`, `@smthrs/integrations`,
 *    `@smthrs/patterns`, `@smthrs/evals`, `@smthrs/scorers`, the registry's
 *    JSX runtime) are in the bundle with
 *    every public subpath, each initialized on first use. The bundle publishes
 *    that table on `globalThis`, and `@smthrs/build-cli/effect-resolution`
 *    answers those specifiers from it. The build's cache keys, which hold a
 *    digest of the code that runs, digest the bundle.
 *
 * The bundle is not minified: a stack trace names functions, and each module
 * starts with a comment naming its path.
 *
 * Run it alone with `node scripts/build-bundle.mjs`.
 */
import { build, transform } from "esbuild"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")

/** The symbol the bundle publishes itself under: its URL and the modules it shares. */
export const bundleKey = "smthrs/bundle"

/**
 * Packages that stay imports. Each has native code, its own loader, files it
 * finds by a path the bundler cannot see, or runs only under Bun.
 *
 * An outside package is loaded when the bundle is, before the bundle can
 * answer an import, so none of these may import Effect or a first-party
 * package: it would get a second copy from disk. `vibelang-runtime` imports
 * Effect and is therefore inlined. A workspace's own `.vibe` modules still
 * load the `vibelang-runtime` their project installs, whose `effect` imports
 * the bundle answers.
 */
export const externalPackages = [
  "@anthropic-ai/claude-agent-sdk",
  "@effect/platform-bun",
  "@opentui/core",
  "@opentui/react",
  "@smthrs/platform-bun",
  "better-sqlite3",
  "electrobun",
  "esbuild",
  "react",
  "tsx",
  "vibelang"
]

/**
 * Imports that are probes: the importer catches the failure and goes on
 * without the package. They are not dependencies of anything in the bundle.
 */
export const optionalProbes = ["bufferutil", "utf-8-validate", "pg-native", "pg-cloudflare", "cpu-features", "pnpapi"]

/** The packages a declaration module shares with the CLI, by the package that owns the resolution. */
export const ownedPackages = {
  "packages/smithers/build/build-cli": ["effect", "@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"],
  "packages/smithers": ["@smthrs/agent", "@smthrs/integrations", "@smthrs/patterns", "@smthrs/evals", "@smthrs/scorers"]
}

/** Owned single modules that are not whole packages. */
export const ownedModules = { "packages/smithers": ["@smthrs/registry/Prompt/jsx-runtime"] }

const builtin = (specifier) =>
  specifier.startsWith("node:") || specifier.startsWith("bun:") || builtinModules.includes(specifier)

const bare = (specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("#")

/** The package name a bare specifier names: `@scope/name` or `name`. */
export const packageName = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

const posix = (path) => path.split(sep).join("/")

const manifests = new Map()

/** The nearest named package above a file: its directory and manifest. */
export const packageOf = (file) => {
  for (let directory = dirname(file);; directory = dirname(directory)) {
    let found = manifests.get(directory)
    if (found === undefined) {
      const path = join(directory, "package.json")
      found = null
      if (existsSync(path)) {
        const manifest = JSON.parse(readFileSync(path, "utf8"))
        // `dist/esm/package.json` only declares a module type.
        if (typeof manifest.name === "string") found = { root: directory, manifest }
      }
      manifests.set(directory, found)
    }
    if (found !== null) return found
    if (dirname(directory) === directory) throw new Error(`${file} is in no package`)
  }
}

const firstParty = (found) => found.manifest.name.startsWith("@smthrs/") && !found.root.includes(`${sep}node_modules${sep}`)

/**
 * The Effect platform adapters `@smthrs/cli` publishes inside its own
 * `dist/vendor` and does not depend on (`smthrs.privateEffectAdapters`).
 */
const privateAdapters = new Set(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).smthrs.privateEffectAdapters)

/** A package's key in the bundle: its name, with its version when it is not first-party. */
const keyOf = (found) =>
  privateAdapters.has(found.manifest.name)
    ? "@smthrs/cli"
    : firstParty(found)
    ? found.manifest.name
    : `${found.manifest.name}@${found.manifest.version}`

/**
 * The path a module is published at, inside its package. A first-party source
 * `src/a/B.ts` (or `.tsx`, `.vibe`) is published as `dist/esm/a/B.js`. A
 * private adapter's modules are published inside `@smthrs/cli`, in the
 * adapter's file under `dist/vendor`. Every other file is published where it is.
 */
export const publishedPath = (found, file) => {
  if (privateAdapters.has(found.manifest.name)) return `dist/vendor/${found.manifest.name.split("/")[1]}.js`
  const path = posix(relative(found.root, file))
  if (!firstParty(found) || !path.startsWith("src/")) return path
  return `dist/esm/${path.slice("src/".length).replace(/\.(?:tsx?|mts|vibe)$/, ".js")}`
}

const locationPattern = /\bimport\.meta\.(?:url|dirname|filename|resolve)\b|(?<![.\w$])__(?:dirname|filename)\b/

/** What a module can ask about its location, and the member of its `__smthrsMeta` that answers. */
const locations = {
  "import.meta.url": "__smthrsMeta.url",
  "import.meta.dirname": "__smthrsMeta.directory",
  "import.meta.filename": "__smthrsMeta.file",
  "import.meta.resolve": "__smthrsMeta.resolve",
  __dirname: "__smthrsMeta.directory",
  __filename: "__smthrsMeta.file"
}

/**
 * Gives a module that asks where it is the address it is published at.
 *
 * esbuild's own parser replaces `import.meta.url`, `.dirname`, `.filename`,
 * `.resolve`, and a CommonJS module's `__dirname` and `__filename`, with
 * members of one object declared at the module's top, which answers from
 * `bin/bundle-origin.mjs` when it is first asked. A parser, not a text search:
 * the same words in a string, a comment, or a module that declares its own
 * `__dirname` are left alone. Returns undefined when the module asks nothing.
 */
export const rewriteLocation = async (source, key, path, loader) => {
  if (!locationPattern.test(source)) return undefined
  const { code } = await transform(source, {
    loader,
    define: locations,
    jsx: "preserve",
    // Imports stay as written; the bundler decides what is unused.
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    logLevel: "silent"
  })
  if (!/\b__smthrsMeta\b/.test(code)) return undefined
  const shebang = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0
  const declaration = `const __smthrsMeta = __smthrsOriginMeta(${JSON.stringify(key)}, ${JSON.stringify(path)});\n`
  return `${code.slice(0, shebang)}${declaration}${code.slice(shebang)}`
}

const loaders = { ".ts": "ts", ".tsx": "tsx", ".mts": "ts", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" }

/**
 * Keeps the listed packages outside and gives every inlined module its
 * published address.
 */
const overlay = (externals) => ({
  name: "smthrs-overlay",
  setup(context) {
    context.onResolve({ filter: /^[^./#]/ }, ({ path, importer, namespace }) => {
      if (builtin(path) || path.startsWith("smthrs-bundle:")) return undefined
      const name = packageName(path)
      if (!externals.has(name) && !optionalProbes.includes(name)) return undefined
      if (namespace !== "file" || optionalProbes.includes(name)) return { path, external: true }
      const from = packageOf(importer)
      // The bundle is published inside `@smthrs/cli`, so its own imports resolve as written.
      return keyOf(from) === "@smthrs/cli"
        ? { path, external: true }
        : { path: `smthrs-from:${keyOf(from)}!${path}`, external: true }
    })
    context.onLoad({ filter: /\.(?:[cm]?js|tsx?|mts|jsx)$/, namespace: "file" }, async ({ path }) => {
      const source = readFileSync(path, "utf8")
      const found = packageOf(path)
      const loader = loaders[/\.[^.]+$/.exec(path)[0]]
      const contents = await rewriteLocation(source, keyOf(found), publishedPath(found, path), loader)
      if (contents === undefined) return undefined
      return { contents, loader: loader.endsWith("x") ? "jsx" : "js", resolveDir: dirname(path) }
    })
  }
})

const javascriptFiles = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? javascriptFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith(".js") ? [`${prefix}${entry.name}`] : []
  )

/**
 * Every specifier a package's export map lets a module import: its named
 * entries and, for a `./*` pattern, each file the pattern reaches that no
 * `null` entry closes.
 */
export const publicSpecifiers = (name, root, exports) => {
  const closed = Object.entries(exports).filter(([, target]) => target === null).map(([subpath]) =>
    new RegExp(`^${subpath.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", ".*")}$`)
  )
  const open = (subpath) => !closed.some((pattern) => pattern.test(subpath))
  const specifiers = new Set()
  for (const [subpath, target] of Object.entries(exports)) {
    if (target === null || subpath === "./package.json") continue
    const file = typeof target === "string" ? target : target.import?.default ?? target.default
    if (typeof file !== "string" || !/\.(?:[cm]?js|tsx?|vibe)$/.test(file)) continue
    if (!subpath.includes("*")) {
      specifiers.add(subpath === "." ? name : `${name}/${subpath.slice(2)}`)
      continue
    }
    const [before, after] = file.split("*")
    for (const path of javascriptFiles(join(root, before))) {
      if (!path.endsWith(after)) continue
      const reached = subpath.replace("*", path.slice(0, path.length - after.length))
      if (open(reached)) specifiers.add(`${name}/${reached.slice(2)}`)
    }
  }
  return [...specifiers].sort()
}

/** The owned specifiers, by the directory they resolve from. */
const ownedSpecifiers = () => {
  const owned = new Map()
  for (const [owner, names] of Object.entries(ownedPackages)) {
    const directory = join(repositoryRoot, owner)
    const specifiers = []
    for (const name of names) {
      let root = directory
      while (!existsSync(join(root, "node_modules", name, "package.json"))) root = dirname(root)
      root = realpathSync(join(root, "node_modules", name))
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      // A workspace package's export map names sources; what it publishes is `publishConfig.exports`.
      const published = manifest.publishConfig?.exports
      const exports = published === undefined
        ? manifest.exports
        : Object.fromEntries(Object.entries(manifest.exports).filter(([subpath]) => published[subpath] !== null))
      specifiers.push(...publicSpecifiers(name, root, exports))
    }
    owned.set(directory, [...specifiers, ...(ownedModules[owner] ?? [])])
  }
  return owned
}

/**
 * The bundle's entry and the tables of shared modules, as modules the bundler
 * reads from memory.
 *
 * A table entry is `require` of the module: esbuild turns it into the
 * module's initializer, run on first use, and the object it returns reads the
 * module's live exports.
 */
const entryModules = (owned) => ({
  name: "smthrs-bundle-entry",
  setup(context) {
    const tables = [...owned.keys()]
    context.onResolve({ filter: /^smthrs-bundle:/ }, ({ path }) => ({ path: path.slice("smthrs-bundle:".length), namespace: "smthrs-bundle" }))
    context.onLoad({ filter: /^entry$/, namespace: "smthrs-bundle" }, () => ({
      resolveDir: packageRoot,
      loader: "js",
      contents: [
        ...tables.map((_, index) => `import { modules as modules${index} } from "smthrs-bundle:owned/${index}"`),
        `globalThis[Symbol.for(${JSON.stringify(bundleKey)})] = { url: import.meta.url, modules: new Map([${tables.map((_, index) => `...modules${index}`).join(", ")}]) }`,
        `await import("./src/bin.ts")`
      ].join("\n")
    }))
    context.onLoad({ filter: /^owned\/\d+$/, namespace: "smthrs-bundle" }, ({ path }) => {
      const directory = tables[Number(path.slice("owned/".length))]
      return {
        resolveDir: directory,
        loader: "js",
        contents: `export const modules = [\n${
          owned.get(directory).map((specifier) => `  [${JSON.stringify(specifier)}, () => require(${JSON.stringify(specifier)})]`).join(",\n")
        }\n]\n`
      }
    })
  }
})

/**
 * The dependency chain from `@smthrs/cli` to every package in the bundle: the
 * names to resolve in turn, each from the package before it. Shortest chain
 * first, then by name, so two builds of one tree write the same file.
 */
export const dependencyChains = (metafile, cwd) => {
  const edges = new Map()
  const edge = (from, name, to) => {
    if (from === to) return
    const out = edges.get(from) ?? new Map()
    if (!out.has(name)) out.set(name, to)
    edges.set(from, out)
  }
  const keyOfInput = (input) => input.includes(":") && !existsSync(resolve(cwd, input)) ? undefined : keyOf(packageOf(resolve(cwd, input)))
  for (const [input, { imports }] of Object.entries(metafile.inputs)) {
    for (const { path, original, external } of imports) {
      if (external || original === undefined || !bare(original) || builtin(original)) continue
      const to = keyOfInput(path)
      if (to === undefined) continue
      // A table of shared modules resolves from the package that owns them.
      const owner = /^smthrs-bundle:owned\/(\d+)$/.exec(input)
      const from = owner !== null
        ? keyOf(packageOf(join(repositoryRoot, Object.keys(ownedPackages)[Number(owner[1])], "package.json")))
        : input === "smthrs-bundle:entry"
        ? "@smthrs/cli"
        : keyOfInput(input)
      if (from !== undefined) edge(from, packageName(original), to)
    }
  }
  const root = "@smthrs/cli"
  const chains = new Map([[root, []]])
  let frontier = [root]
  while (frontier.length > 0) {
    const next = []
    for (const from of frontier.sort()) {
      for (const [name, to] of [...(edges.get(from) ?? [])].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (chains.has(to)) continue
        chains.set(to, [...chains.get(from), name])
        next.push(to)
      }
    }
    frontier = next
  }
  return chains
}

/**
 * The lines the bundle starts with: `require` for inlined CommonJS, and the
 * object an inlined module asks for its location, which looks nothing up
 * until it is asked.
 */
const banner = [
  `import { createRequire as __smthrsCreateRequire } from "node:module";`,
  `import { originFile as __smthrsOriginFile, resolveFrom as __smthrsResolveFrom } from "../../bin/bundle-origin.mjs";`,
  `import { dirname as __smthrsDirname } from "node:path";`,
  `import { pathToFileURL as __smthrsFileUrl } from "node:url";`,
  `const require = __smthrsCreateRequire(import.meta.url);`,
  `const __smthrsChains = __SMTHRS_CHAINS__;`,
  `const __smthrsOriginMeta = (key, path) => {`,
  `  const meta = {`,
  `    get file() { return __smthrsOriginFile(import.meta.url, __smthrsChains[key], path) },`,
  `    get directory() { return __smthrsDirname(meta.file) },`,
  `    get url() { return __smthrsFileUrl(meta.file).href },`,
  `    resolve: (specifier) => __smthrsResolveFrom(meta.url, specifier, (probe) => import.meta.resolve(probe))`,
  `  };`,
  `  return meta;`,
  `};`
].join("\n")

/** Warnings that mean an inlined module will look for a file the bundle does not hold. */
const fatalWarnings = new Set(["require-resolve-not-external", "unsupported-require-call"])

export const buildBundle = async ({ logLevel = "warning", outdir = resolve(packageRoot, "dist/bundle") } = {}) => {
  const owned = ownedSpecifiers()
  const result = await build({
    entryPoints: { bin: "smthrs-bundle:entry" },
    outdir,
    absWorkingDir: packageRoot,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    // A package that ships both formats is inlined as ES modules, which initialize lazily and tree-shake.
    mainFields: ["module", "main"],
    conditions: ["import"],
    banner: { js: banner },
    metafile: true,
    write: false,
    logLevel,
    logOverride: Object.fromEntries([...fatalWarnings].map((id) => [id, "error"])),
    plugins: [entryModules(owned), vibelang({ root: packageRoot }), overlay(new Set(externalPackages))]
  })
  if (result.errors.length > 0) throw new Error("The CLI bundle failed to build")
  const chains = dependencyChains(result.metafile, packageRoot)
  const chainOf = (key) => {
    const chain = chains.get(key)
    if (chain === undefined) throw new Error(`No dependency chain from @smthrs/cli reaches ${key}`)
    return chain
  }
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
  for (const file of result.outputFiles) {
    const used = new Set()
    const text = file.text
      .replace(/__smthrsOriginMeta\(("(?:[^"\\]|\\.)*"), /g, (call, key) => {
        used.add(JSON.parse(key))
        return call
      })
      .replace(/(["'])smthrs-from:([^!"']+)!/g, (_, quote, key) => `${quote}smthrs-from:${chainOf(key).join(",")}!`)
    const table = Object.fromEntries([...used].sort().map((key) => [key, chainOf(key)]))
    writeFileSync(file.path, text.replace("__SMTHRS_CHAINS__", () => JSON.stringify(table)))
  }
  return { metafile: result.metafile, chains }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildBundle()
