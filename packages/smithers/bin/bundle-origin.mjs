/**
 * Where the packages inlined into `dist/bundle/bin.js` are installed.
 *
 * The bundle holds the code of `@smthrs/cli`'s dependencies, and the
 * installation still holds their files. A module that asks where it is
 * (`import.meta.url`) and an import the bundle leaves outside both have to be
 * answered from the package the code came from, wherever a package manager
 * put it. The bundle records, for each package, the names to resolve in turn
 * starting at `@smthrs/cli`; this module walks them the way Node resolves a
 * bare specifier.
 */
import { existsSync, realpathSync } from "node:fs"
import { registerHooks } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const roots = new Map()

/** The directory `name` is installed in, as a module in `from` would find it. */
const installed = (from, name) => {
  for (let directory = from;; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
    if (dirname(directory) === directory) {
      throw new Error(`${name} is not installed where ${from} can import it. Reinstall @smthrs/cli.`)
    }
  }
}

/**
 * The directory of the package a dependency chain ends at.
 *
 * @param {string} bundleUrl `import.meta.url` of `dist/bundle/bin.js`
 * @param {ReadonlyArray<string>} chain package names, each resolved from the one before; empty is `@smthrs/cli`
 */
export const packageRoot = (bundleUrl, chain) => {
  const key = `${bundleUrl}\n${chain.join(",")}`
  let root = roots.get(key)
  if (root === undefined) {
    root = chain.length === 0
      ? realpathSync(fileURLToPath(new URL("../../", bundleUrl)))
      : installed(packageRoot(bundleUrl, chain.slice(0, -1)), chain[chain.length - 1])
    roots.set(key, root)
  }
  return root
}

/** The installed file an inlined module is published as. */
export const originFile = (bundleUrl, chain, path) => join(packageRoot(bundleUrl, chain), path)

const scheme = "smthrs-from:"

/**
 * Resolves `smthrs-from:<chain>!<specifier>`: the specifier, as a module in
 * the package the chain ends at would import it.
 *
 * @param {string} bundleUrl `import.meta.url` of `dist/bundle/bin.js`
 */
export const resolveHooks = (bundleUrl) => ({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(scheme)) return nextResolve(specifier, context)
    const separator = specifier.indexOf("!")
    const chain = specifier.slice(scheme.length, separator).split(",")
    const parentURL = pathToFileURL(join(packageRoot(bundleUrl, chain), "package.json")).href
    return nextResolve(specifier.slice(separator + 1), { ...context, parentURL })
  }
})

const probe = "smthrs-resolve-from:"

/**
 * What `import.meta.resolve(specifier)` answers in the module at `parentURL`:
 * the process's resolve hooks run with that parent. Node's own second
 * argument needs a flag, so a hook that lives for this one call sets the
 * parent and hands the request down the chain.
 *
 * @param {string} parentURL the module the specifier is resolved from
 * @param {string} specifier what that module would import
 * @param {(specifier: string) => string} resolve any module's `import.meta.resolve`
 */
export const resolveFrom = (parentURL, specifier, resolve) => {
  let outcome
  const hooks = registerHooks({
    resolve(request, context, nextResolve) {
      if (request !== probe) return nextResolve(request, context)
      try {
        outcome = { url: nextResolve(specifier, { ...context, parentURL }).url }
      } catch (error) {
        // As `import.meta.resolve` does: a file that is not there still has an address.
        const missing = error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ERR_UNSUPPORTED_DIR_IMPORT"
        outcome = missing && typeof error.url === "string" ? { url: error.url } : { error }
      }
      return { url: "node:module", shortCircuit: true }
    }
  })
  try {
    resolve(probe)
  } finally {
    hooks.deregister()
  }
  if (outcome.error !== undefined) throw outcome.error
  return outcome.url
}
