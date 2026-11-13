/**
 * Fails when a workspace manifest and `bun.lock` disagree about a dependency.
 *
 * The repository requires a manifest change to refresh both lockfiles, but
 * nothing enforced it: every CI job installs with pnpm, so `pnpm-lock.yaml` is
 * proved by `--frozen-lockfile` on every run while `bun.lock` is never read.
 * Bun still runs `apps/*`, the `ci/legacy declaration` matrix, and `packages/smithers/agent/regression`, so a
 * stale entry there resolves a real package at the wrong version, and it does
 * so only on the Bun surfaces. `packages/smithers/agent/fs` reached rc.0 still asking for
 * `@smthrs/core@0.1.0` that way.
 *
 * The check is a comparison, not an install: it reads the lockfile's own
 * `workspaces` table, which records the dependency ranges Bun resolved for
 * each workspace, and holds it against the manifests on disk. That runs
 * offline in milliseconds and needs no Bun on the machine.
 */
import { isDeepStrictEqual } from "node:util"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { isMain, workspacePackages, repoRoot as root } from "../scripts/workspace-packages.mjs"

/**
 * `bun.lock` is JSONC: it carries whole-line comments, trailing commas, and
 * occasionally a raw control character inside a string. `JSON.parse` rejects
 * all three, so the text is normalized first. Only whole-line comments are
 * stripped, because a `//` inside a registry URL is not a comment.
 */
const readLock = () => {
  const raw = readFileSync(path.join(root, "bun.lock"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(new RegExp("[\\u0000-\\u001f]", "g"), "")
  return JSON.parse(raw)
}

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/**
 * The ranges a manifest declares in one field, as Bun records them. An
 * optional peer named only in `peerDependenciesMeta` (the unversioned optional
 * adapter peer, #3839) is a peer of any version, which Bun writes as `*`.
 */
export const declaredRanges = (pkg, field) => {
  const declared = { ...pkg[field] }
  if (field === "peerDependencies") {
    for (const [name, meta] of Object.entries(pkg.peerDependenciesMeta ?? {})) {
      if (meta?.optional === true && declared[name] === undefined) declared[name] = "*"
    }
  }
  return declared
}

/** Compare root and member ranges, publication membership, overrides and patch paths. */
export function lockfileProblems(lock, packageEntries) {
  const workspaces = lock.workspaces ?? {}
  // The set comes from `pnpm-workspace.yaml` through the shared reader, so a
  // package that moves — a granular package nesting inside the product package
  // it belongs to — is still compared. A glob written here would answer for one
  // directory depth and silently stop covering the moved package. Every member
  // is compared, not only `packages/` and `apps/`: `packages/smithers/agent/regression` runs on Bun, and
  // a filter here once hid its `bun-types` devDependency from this check.
  const manifests = ["package.json", ...packageEntries.map((entry) => `${entry.dir}/package.json`)]
  const workspaceVersions = new Map(
    packageEntries.map((entry) => {
      const pkg = JSON.parse(readFileSync(path.join(root, entry.dir, "package.json"), "utf8"))
      return [pkg.name, pkg.version]
    })
  )

  // Bun may canonicalize an exact dependency on a same-version workspace package
  // to `workspace:*` in its lockfile. That is equivalent only while the package
  // named by the dependency still has the exact version the manifest declares;
  // retaining this version check preserves the stale-internal-range protection.
  const rangesAgree = (name, declared, locked) =>
    locked === declared || (locked === "workspace:*" && workspaceVersions.get(name) === declared)

  const problems = []
  for (const manifest of manifests) {
    const directory = manifest === "package.json" ? "" : path.dirname(manifest)
    const pkg = JSON.parse(readFileSync(path.join(root, manifest), "utf8"))
    const entry = workspaces[directory]
    if (entry === undefined) {
      problems.push(`${directory}: absent from bun.lock workspaces`)
      continue
    }
    for (const field of FIELDS) {
      const declared = declaredRanges(pkg, field)
      const locked = entry[field] ?? {}
      for (const [name, range] of Object.entries(declared)) {
        if (!rangesAgree(name, range, locked[name])) {
          problems.push(`${directory}: ${field} ${name}@${range} is ${locked[name] ?? "absent"} in bun.lock`)
        }
      }
      for (const name of Object.keys(locked)) {
        if (declared[name] === undefined) {
          problems.push(`${directory}: ${field} ${name} is in bun.lock but not in the manifest`)
        }
      }
    }
  }

  const expectedDirectories = new Set(["", ...packageEntries.map((entry) => entry.dir)])
  for (const directory of Object.keys(workspaces)) {
    if (!expectedDirectories.has(directory)) problems.push(`${directory}: no longer a workspace member`)
  }
  const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  for (const field of ["overrides", "patchedDependencies"]) {
    const declared = rootManifest[field] ?? {}
    const locked = lock[field] ?? {}
    for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
      if (!isDeepStrictEqual(declared[name], locked[name])) {
        problems.push(`${field} ${name}: manifest and bun.lock disagree`)
      }
    }
  }
  return problems
}

if (isMain(import.meta)) {
  const entries = workspacePackages(root)
  const problems = lockfileProblems(readLock(), entries)
  if (problems.length > 0) {
    console.error(`bun.lock disagrees with ${problems.length} manifest entries:`)
    for (const problem of problems) console.error(`  ${problem}`)
    console.error("\nRefresh it with: bun install --lockfile-only --offline")
    process.exit(1)
  }
  console.log(`bun.lock agrees with all ${entries.length + 1} workspace manifests`)
}
