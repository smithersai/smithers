import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

/** Read package manifests independently of test/config presence, including nested packages. */
export const readWorkspaceInventory = (root = resolve(import.meta.dirname, "..")) => {
  const packagesDir = join(root, "packages")
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  const directories = (parent: string): Array<string> =>
    readdirSync(join(packagesDir, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .flatMap((entry) => {
        const name = parent === "" ? entry.name : `${parent}/${entry.name}`
        return isFile(join(packagesDir, name, "package.json")) ? [name, ...directories(name)] : []
      })
  const manifests = directories("").map((name) => {
    const path = join(packagesDir, name, "package.json")
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      readonly name?: string
      readonly smthrs?: { readonly group?: unknown }
    }
    return { name, path, manifest }
  })
  // One carve-out, named rather than derived: the two private UI kits use
  // `bun test tests` and have no vitest config or publication exports. They
  // remain unpublished, so no public surface escapes the gate.
  //
  // This is a smaller universe, not a smaller assertion: every other package
  // under `packages/` is still derived, so a new config-less package is still
  // visible to every assertion below.
  const zeroXUiKits = new Set(["smithers/ui", "smithers/ui/ui-styleguide"])
  // A third carve-out, for the one nested member that is not a library:
  // `packages/smithers/build/infra` is the hosted cache Cloudflare Worker that ships
  // inside `smithers-build`. It is private, unpublished, and has no
  // publication exports for these cells to describe; it is a workspace member
  // only so its own suite and typecheck run under the root fan-out. It was
  // outside this universe when the derivation read one directory level, and it
  // stays outside now the derivation descends. Every other nested package is a
  // published library and is held to every assertion below.
  const nestedNonLibraries = new Set(["smithers/build/infra"])
  // A fourth carve-out, for the private contract package the two apps share.
  // `@smthrs/rpc` is runtime-free zod schemas and route constants imported by
  // `apps/app` and `apps/server`; it runs `bun test src` beside its sources,
  // ships no `src/index.ts` barrel and no publication exports, and is never
  // published. It is named rather than derived for the same reason the UI kits
  // are: a smaller universe, not a smaller assertion.
  const bunTestedContracts = new Set(["rpc"])
  const packages = manifests.map(({ name }) => name)
    .filter((name) => !zeroXUiKits.has(name))
    .filter((name) => !nestedNonLibraries.has(name))
    .filter((name) => !bunTestedContracts.has(name))
  const configs = packages.map((name) => {
    const path = join(packagesDir, name, "vitest.config.ts")
    return {
      name,
      path,
      source: isFile(path) ? readFileSync(path, "utf8") : ""
    }
  })

  return { packagesDir, manifests, packages, configs }
}
