/**
 * Deployment installation follows pnpm's workspace graph and the declared build inputs.
 * The CLI bundles another workspace's sources: package dependencies alone cannot describe that build.
 * No dependencies are needed to run this module in a fresh checkout.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { docsDirectory } from "../DocsBuild.ts"

export const root = resolve(import.meta.dirname, "../../../..")
const appDirectory = "apps/mvp"
// Shared packing and build modules resolve their tools from the root workspace.
export const roots = ["", appDirectory, relative(root, resolve(root, appDirectory, docsDirectory))]

/** Enumerate through pnpm itself, which works before installation and respects workspace exclusions. */
export const inventory = () => {
  const result = spawnSync("pnpm", ["--recursive", "list", "--depth", "-1", "--json"], {
    cwd: root, encoding: "utf8", timeout: 60_000
  })
  if (result.status !== 0) throw new Error("Deploy filter: pnpm could not enumerate the workspace")
  return JSON.parse(result.stdout).map(({ path }) => ({
    dir: relative(root, path).split("\\").join("/"),
    manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8"))
  }))
}

export const dependencyClosure = (packages, directories) => {
  const byDirectory = new Map(packages.map((p) => [p.dir, p]))
  const byName = new Map(packages.map((p) => [p.manifest.name, p.dir]))
  const selected = new Set()
  const visit = (dir) => {
    if (selected.has(dir)) return
    const entry = byDirectory.get(dir)
    if (!entry) throw new Error(`Deploy filter: missing workspace ${dir}`)
    selected.add(dir)
    for (const [name, version] of Object.entries({
      ...entry.manifest.dependencies, ...entry.manifest.devDependencies, ...entry.manifest.optionalDependencies
    })) {
      const workspace = byName.get(name)
      if (workspace !== undefined) visit(workspace)
      else if (version.startsWith("workspace:")) throw new Error(`Deploy filter: missing workspace dependency ${name}`)
    }
  }
  for (const directory of directories) visit(directory)
  return selected
}

/** Find workspace owners of external source inputs, including Filegroup dependencies of a bundle target. */
export const requiredWorkspaces = (packages, targets, directories = roots) => {
  const owner = (path) => packages.filter((p) => p.dir !== "" && (path === p.dir || path.startsWith(p.dir + "/")))
    .sort((a, b) => b.dir.length - a.dir.length)[0]?.dir
  const byLabel = new Map(targets.map((target) => [target.label, target]))
  const selected = dependencyClosure(packages, directories)
  const scanned = new Set()
  const scan = (target) => {
    if (scanned.has(target.label)) return
    scanned.add(target.label)
    for (const input of target.inputs ?? []) {
      const dir = owner(input.path ?? input.pattern ?? "")
      if (dir) for (const each of dependencyClosure(packages, [dir])) selected.add(each)
    }
    for (const label of target.dependencies ?? []) {
      const dependency = byLabel.get(label)
      if (!dependency) throw new Error(`Deploy filter: missing build target ${label}`)
      scan(dependency)
    }
  }
  let size
  do {
    size = selected.size
    for (const target of targets) {
      if (selected.has(target.package) && target.kinds.includes("build") && target.outputs.length > 0) scan(target)
    }
  } while (size !== selected.size)
  return [...selected].sort()
}

export const assertFilter = (packages, targets, directories) => {
  const selected = dependencyClosure(packages, directories)
  const missing = requiredWorkspaces(packages, targets).filter((dir) => !selected.has(dir))
  if (missing.length) throw new Error(`Deploy filter omits bundled workspaces: ${missing.join(", ")}`)
}

/** A missing dependency fails before packing, building an image or entering Alchemy. */
export const assertInstalled = (packages, directories, exists = existsSync) => {
  const wanted = new Set(directories)
  const missing = []
  for (const { dir, manifest } of packages) {
    if (!wanted.has(dir)) continue
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!exists(join(root, dir, "node_modules", name))) missing.push(`${manifest.name}: ${name}`)
    }
  }
  if (missing.length) throw new Error(
    `Deploy dependencies are missing (${missing.slice(0, 8).join("; ")}). Run pnpm --dir apps/mvp run deploy:install.`
  )
}

export const installArguments = (packages, directories) => [
  "install", "--frozen-lockfile",
  ...directories.flatMap((dir) => ["--filter", packages.find((p) => p.dir === dir).manifest.name + "..."])
]

export const deploymentGraph = () => {
  const packages = inventory()
  const targets = JSON.parse(readFileSync(join(root, ".smithers/target-index.json"), "utf8"))
  return { packages, targets, directories: requiredWorkspaces(packages, targets) }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { packages, targets, directories } = deploymentGraph()
    if (process.argv[2] === "--install") {
      const result = spawnSync("pnpm", installArguments(packages, directories), { cwd: root, stdio: "inherit" })
      process.exitCode = result.status ?? 1
    } else if (process.argv[2] === "--verify") {
      assertInstalled(packages, directories)
      console.log("deploy.dependencies: passed")
    } else if (process.argv[2] === "--check") {
      const names = process.argv.slice(3).map((name) => name.replace(/\.\.\.$/, ""))
      const requested = names.map((name) => {
        const entry = packages.find((p) => p.manifest.name === name)
        if (!entry) throw new Error(`Deploy filter: unknown package ${name}`)
        return entry.dir
      })
      assertFilter(packages, targets, requested.length ? requested : directories)
      console.log("deploy.filter: passed")
    } else console.log(installArguments(packages, directories).join(" "))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
