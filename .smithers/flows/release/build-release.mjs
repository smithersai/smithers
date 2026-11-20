/** Build the validated release roster in required-dependency order. */
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { dependencyOrder, readWorkspaceManifests, workspaceDependencies } from "./pack-release.mjs"
import { isMain, repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"
import { zigProblem } from "../../../packages/smithers/build/build-cli/scripts/build-observe.mjs"

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
  // A release that must ship smthrs-observe stops here, before an hour of builds, when it cannot.
  if (process.env.SMITHERS_NATIVE === "required") {
    const problem = zigProblem()
    if (problem !== undefined) throw new Error(`smthrs-observe: ${problem}; install zig 0.17.1 or unset SMITHERS_NATIVE`)
  }
  for (const directory of order) {
    const packageRoot = join(root, directory)
    rmSync(join(packageRoot, "dist"), { recursive: true, force: true })
    console.log(`Building ${manifests.get(directory).name}`)
    // Installation is a separate frozen gate. A build must never auto-install
    // or silently refresh the dependency graph being certified.
    // A release ships the native programs a package builds where their compiler is there (`smthrs-observe` in
    // @smthrs/build-cli, with zig 0.17.1). SMITHERS_NATIVE=required makes a build without it fail.
    const result = spawnSync("pnpm", ["--dir", packageRoot, "--config.verify-deps-before-run=error", "run", "build"], {
      cwd: root, stdio: "inherit", env: { ...process.env, SMITHERS_NATIVE: process.env.SMITHERS_NATIVE ?? "1" }
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
    throw new Error("usage: node .smithers/flows/release/build-release.mjs [--list]")
  }
}
