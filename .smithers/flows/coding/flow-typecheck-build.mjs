/** Type inputs shipped with the coding host, measured as part of its artifact. */
import ts from "typescript"
import { existsSync, readFileSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { gzipSync } from "node:zlib"

/** Preserve the complete type graph inside the bounded, immutable executable. */
export const typecheckSource = (inputs) => {
  const compressed = gzipSync(JSON.stringify(inputs), { level: 9 }).toString("base64")
  return `import {gunzipSync as __smithersGunzipTypes} from "node:zlib";\nconst __SMITHERS_FLOW_TYPES__ = JSON.parse(__smithersGunzipTypes(Buffer.from(${JSON.stringify(compressed)}, "base64")).toString("utf8"));\n`
}

/**
 * The declaration a `.vibe` module's sidecar holds for a `.d.vibe.ts` path beside its source. A migrated project
 * writes sidecars under its tsconfig's `vibe.sidecarDir`, so a `.ts` file's `import "./X.vibe"` reaches stock
 * TypeScript (`allowArbitraryExtensions`) only through that directory; the shipped graph keeps it beside the source.
 */
const sidecarOf = (file) => {
  if (!/\.d\.vibex?\.ts$/.test(file) || existsSync(file)) return undefined
  for (let directory = dirname(file); directory !== dirname(directory); directory = dirname(directory)) {
    let sidecarDir
    try {
      sidecarDir = JSON.parse(readFileSync(join(directory, "tsconfig.json"), "utf8")).vibe?.sidecarDir
    } catch {
      continue
    }
    if (typeof sidecarDir !== "string") continue
    const sidecar = join(directory, sidecarDir, relative(directory, file))
    if (existsSync(sidecar)) return { path: sidecar, sources: directory, sidecars: join(directory, sidecarDir) }
  }
  return undefined
}

/**
 * A sidecar's text as the declaration beside its source. Its relative imports name files from the sidecar's own
 * directory (`../../src/X.ts` under `.vibe/declarations/src/`), so each one is re-aimed from the source's directory:
 * a sidecar it names maps to the declaration beside that sidecar's source, any other file stays the same file.
 */
const sidecarText = (file, sidecar) => {
  const from = dirname(sidecar.path), beside = dirname(file)
  return readFileSync(sidecar.path, "utf8").replace(
    /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.\.?\/[^"']*)\2/g,
    (whole, keyword, quote, specifier) => {
      let target = resolve(from, specifier)
      const inside = relative(sidecar.sidecars, target)
      if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) target = join(sidecar.sources, inside)
      let moved = relative(beside, target).split("\\").join("/")
      if (!moved.startsWith(".")) moved = `./${moved}`
      return `${keyword}${quote}${moved}${quote}`
    }
  )
}

/** A compiler host that reads each `.vibe` module's sidecar as the declaration beside it. */
const sidecarHost = (options) => {
  const host = ts.createCompilerHost(options)
  const fileExists = host.fileExists, getSourceFile = host.getSourceFile
  host.fileExists = (name) => fileExists(name) || sidecarOf(name) !== undefined
  host.readFile = (name) => {
    const sidecar = sidecarOf(name)
    return sidecar === undefined ? ts.sys.readFile(name) : sidecarText(name, sidecar)
  }
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const sidecar = sidecarOf(name)
    return sidecar === undefined ? getSourceFile(name, languageVersion, ...rest)
      : ts.createSourceFile(name, sidecarText(name, sidecar), languageVersion)
  }
  return host
}

export const typecheckInputs = async (root, aliases) => {
  const require = createRequire(join(root, ".smithers/flows/package.json"))
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, allowArbitraryExtensions: true, strict: true, skipLibCheck: true,
    noEmit: true, types: ["node"],
    paths: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, [value]]))
  }
  const compiler = dirname(require.resolve("typescript"))
  const nodeTypes = dirname(require.resolve("@types/node/package.json"))
  options.typeRoots = [dirname(nodeTypes)]
  const roots = [...Object.values(aliases), join(nodeTypes, "index.d.ts")]
  const host = sidecarHost(options)
  const program = ts.createProgram(roots, options, host)
  const files = {}, resolvedEntries = { ...aliases }
  const virtual = path => {
    const local = relative(root, resolve(path)).split("\\").join("/")
    if (local === ".." || local.startsWith("../")) throw new Error(`Flow type input is outside the build checkout: ${path}`)
    return "/__smithers_types__/" + local
  }
  // These sources are read as types, never evaluated. Including the complete
  // compiler-reached graph preserves generic inference across package seams.
  for (const source of program.getSourceFiles()) {
    files[virtual(source.fileName)] = source.text
    for (const imported of ts.preProcessFile(source.text).importedFiles) {
      const specifier = imported.fileName
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue
      const target = ts.resolveModuleName(specifier, source.fileName, options, host).resolvedModule
      if (target) resolvedEntries[specifier] = target.resolvedFileName
    }
  }
  for (const name of await readdir(compiler)) {
    if (name.startsWith("lib.") && name.endsWith(".d.ts")) {
      files[virtual(join(compiler, name))] = await readFile(join(compiler, name), "utf8")
    }
  }
  // Package metadata is needed for ordinary dependency resolution in the
  // trusted type graph. It is install data, never the repository's package.
  const visited = new Set()
  for (const filename of Object.keys(files)) {
    for (let parent = dirname(resolve(root, filename.slice("/__smithers_types__/".length))); parent !== dirname(root); parent = dirname(parent)) {
      const name = join(parent, "package.json"), key = virtual(name)
      if (visited.has(key)) continue
      visited.add(key)
      try { files[key] = await readFile(name, "utf8") } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }
  const entries = Object.fromEntries(Object.entries(resolvedEntries).map(([key, value]) => [key, virtual(value)]))
  return { files, entries, lib: virtual(join(compiler, "lib.es2024.full.d.ts")), node: virtual(join(nodeTypes, "index.d.ts")) }
}
