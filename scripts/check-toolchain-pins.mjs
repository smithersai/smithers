/**
 * The toolchain drift gate.
 *
 * `.smithers/WORKSPACE.ts` declares the Node and Bun runtimes and the pnpm
 * version once. Three other files spell the same facts in their own syntax:
 * package.json (`engines`, `packageManager`), flake.nix (the pinned pnpm
 * tarball and the Node major), and the generated CI workflow (the exact
 * releases the runners install). This gate reads the declaration and fails
 * on the first file that disagrees with it, so the workspace declaration is
 * the one place a version moves.
 *
 * Run as `node scripts/check-toolchain-pins.mjs`; `findings` is the pure
 * comparison the test drives with fixtures.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isMain, repoRoot } from "./workspace-packages.mjs"

/** The numeric floor of a `>=x.y.z` requirement, or of a bare `x.y.z`. */
export const floorOf = (requirement) => {
  const match = /^(?:>=)?(\d+)\.(\d+)\.(\d+)/.exec(requirement.trim())
  if (match === null) throw new Error(`unreadable version requirement: ${JSON.stringify(requirement)}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compare = (left, right) => {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** Whether an exact release satisfies the declared `>=` requirement within its major. */
export const satisfies = (release, requirement) => {
  const floor = floorOf(requirement)
  const version = floorOf(release)
  return version[0] === floor[0] && compare(version, floor) >= 0
}

/**
 * The disagreements between the workspace declaration and the other files,
 * each one line naming the file and both values. Empty means in sync.
 */
export const findings = ({ workspace, packageJson, flake, ci }) => {
  const out = []
  const { runtime, packageManager, bunRuntime } = workspace
  const manifest = JSON.parse(packageJson)
  const expectedManager = `pnpm@${packageManager.version}`
  if (manifest.packageManager !== expectedManager) {
    out.push(`package.json packageManager is ${JSON.stringify(manifest.packageManager)}; WORKSPACE.ts declares ${expectedManager}`)
  }
  if (manifest.engines?.node !== runtime.version) {
    out.push(`package.json engines.node is ${JSON.stringify(manifest.engines?.node)}; WORKSPACE.ts declares ${runtime.version}`)
  }
  if (manifest.engines?.bun !== bunRuntime.version) {
    out.push(`package.json engines.bun is ${JSON.stringify(manifest.engines?.bun)}; WORKSPACE.ts declares ${bunRuntime.version}`)
  }
  const pnpmPin = /pname = "pnpm";\s*version = "([^"]+)"/.exec(flake)
  if (pnpmPin === null) out.push("flake.nix pins no pnpm tarball (expected pname = \"pnpm\"; version = \"...\")")
  else if (pnpmPin[1] !== packageManager.version) {
    out.push(`flake.nix pins pnpm ${pnpmPin[1]}; WORKSPACE.ts declares ${packageManager.version}`)
  }
  const nodeMajor = floorOf(runtime.version)[0]
  const nodeAttrs = [...new Set([...flake.matchAll(/nodejs_(\d+)/g)].map((match) => match[1]))]
  if (nodeAttrs.length === 0) out.push("flake.nix names no nodejs_<major> package")
  for (const major of nodeAttrs) {
    if (Number(major) !== nodeMajor) out.push(`flake.nix uses nodejs_${major}; WORKSPACE.ts declares Node ${runtime.version}`)
  }
  for (const [, release] of ci.matchAll(/node-version:\s*([^\s]+)/g)) {
    if (!satisfies(release, runtime.version)) {
      out.push(`ci.yml installs node ${release}; WORKSPACE.ts declares ${runtime.version}`)
    }
  }
  for (const [, release] of ci.matchAll(/bun-version:\s*([^\s]+)/g)) {
    if (!satisfies(release, bunRuntime.version)) {
      out.push(`ci.yml installs bun ${release}; WORKSPACE.ts declares ${bunRuntime.version}`)
    }
  }
  for (const [name, version] of [["bun", workspace.bunVersion], ["jujutsu", workspace.jjVersion]]) {
    const pin = new RegExp(`assert pkgs\\.${name}\\.version == "([^"\\s]+)";`).exec(flake)
    if (pin === null) out.push(`flake.nix pins no ${name} version assertion`)
    else if (pin[1] !== version) out.push(`flake.nix pins ${name} ${pin[1]}; WORKSPACE.ts declares ${version}`)
  }
  const jjPins = [...ci.matchAll(/jj-cli@([^\s]+)/g)]
  if (jjPins.length === 0) out.push("ci.yml installs no jj-cli release")
  for (const [, release] of jjPins) {
    if (release !== workspace.jjVersion) out.push(`ci.yml installs jj ${release}; WORKSPACE.ts declares ${workspace.jjVersion}`)
  }
  for (const [, release] of ci.matchAll(/bun-version:\s*([^\s]+)/g)) {
    if (release !== workspace.bunVersion) out.push(`ci.yml pins bun ${release}; WORKSPACE.ts declares ${workspace.bunVersion}`)
  }
  return out
}

/** Reads the four files of the real repository and compares them. */
export const check = async (root = repoRoot) => {
  const workspace = await import(pathToFileURL(resolve(root, ".smithers/WORKSPACE.ts")).href)
  return findings({
    workspace,
    packageJson: readFileSync(resolve(root, "package.json"), "utf8"),
    flake: readFileSync(resolve(root, "flake.nix"), "utf8"),
    ci: readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")
  })
}

if (isMain(import.meta)) {
  const drift = await check()
  if (drift.length > 0) {
    process.stderr.write(`toolchain pins drift from .smithers/WORKSPACE.ts:\n${drift.map((line) => `  ${line}`).join("\n")}\n`)
    process.exit(1)
  }
  process.stdout.write("toolchain pins agree with .smithers/WORKSPACE.ts\n")
}
