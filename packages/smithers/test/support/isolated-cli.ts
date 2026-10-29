/** Copy real runtime packages into one dependency graph with an omitted package. */
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

interface Manifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly smthrs?: { readonly privateEffectAdapters?: ReadonlyArray<string> }
}

const locate = async (name: string, from: string): Promise<string | undefined> => {
  let current = from
  for (;;) {
    try {
      return await realpath(join(current, "node_modules", name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export const isolatedCli = async (destination: string, omitted: string): Promise<ReadonlyArray<string>> => {
  const cli = await realpath(fileURLToPath(new URL("../..", import.meta.url)))
  const copies = new Map<string, string>()
  const skipped = new Set(["node_modules", ".git", ".jj", ".cache", "target", "coverage"])
  const copy = async (source: string): Promise<string> => {
    const previous = copies.get(source)
    if (previous !== undefined) return previous
    const target = source === cli ? destination : join(destination, ".packages", String(copies.size))
    copies.set(source, target)
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as Manifest
    if (manifest.name === omitted) throw new Error(`Omitted package entered the isolated graph: ${omitted}`)
    await mkdir(target, { recursive: true })
    if (source === cli) {
      for (const path of ["src", "bin", "package.json"]) {
        await cp(join(source, path), join(target, path), { recursive: true })
      }
    } else {
      await cp(source, target, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (path) =>
          path === source || !skipped.has(basename(path)) &&
            !(dirname(path) === source && (basename(path) === "test" || basename(path) === "tests"))
      })
    }
    const optional = manifest.optionalDependencies ?? {}
    const adapters = manifest.smthrs?.privateEffectAdapters ?? []
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(optional),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...adapters,
      // Source exports include .vibe files; this fixture carries the same
      // authoring compiler as the source CLI, rather than relying on the host.
      ...(source === cli ? ["vibelang", "@types/node"] : [])
    ])
    for (const name of dependencies) {
      if (name === omitted) continue
      const original = await locate(name, source)
      if (original === undefined) {
        if (name in optional || manifest.peerDependenciesMeta?.[name]?.optional === true) continue
        throw new Error(`Missing runtime dependency ${name} of ${manifest.name}`)
      }
      const dependency = await copy(original)
      const link = join(target, "node_modules", name)
      await mkdir(dirname(link), { recursive: true })
      await symlink(dependency, link, "dir")
    }
    return target
  }
  await copy(cli)
  return [...copies.values()]
}
