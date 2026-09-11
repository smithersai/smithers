/** Build the validated release roster in required-dependency order. */
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { dependencyOrder, readWorkspaceManifests, workspaceDependencies } from "./pack-release.mjs"
import { isMain, repoRoot } from "./workspace-packages.mjs"

/**
 * Optional peers and development dependencies can point back to their host
 * package (kernel's browser test host does). They are installed for tests but
 * do not order release artifacts. Use the same checked public graph as packing
 * and publication, without asking pnpm's recursive scheduler to order tests.
 * Each package still runs its complete production build from a clean dist.
 */
export const buildRelease = (root = repoRoot, manifests = readWorkspaceManifests(root)) => {
  const order = dependencyOrder(workspaceDependencies(manifests))
  for (const directory of order) {
    if (typeof manifests.get(directory).scripts?.build !== "string") {
      throw new Error(`${directory}: release package has no build script`)
    }
  }
  for (const directory of order) {
    const packageRoot = join(root, directory)
    rmSync(join(packageRoot, "dist"), { recursive: true, force: true })
    console.log(`Building ${manifests.get(directory).name}`)
    // Installation is a separate frozen gate. A build must never auto-install
    // or silently refresh the dependency graph being certified.
    const result = spawnSync("pnpm", ["--dir", packageRoot, "--config.verify-deps-before-run=error", "run", "build"], {
      cwd: root, stdio: "inherit"
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`${directory}: build failed (${result.signal ?? `exit ${result.status}`})`)
    }
  }
  return order
}

if (isMain(import.meta)) {
  if (process.argv[2] === "--list") {
    console.log(dependencyOrder(workspaceDependencies(readWorkspaceManifests())).join("\n"))
  } else if (process.argv.length === 2) {
    buildRelease()
  } else {
    throw new Error("usage: node scripts/build-release.mjs [--list]")
  }
}
