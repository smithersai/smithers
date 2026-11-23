/**
 * The sources of the workspace packages one package reaches, as file groups.
 *
 * A package's tests, type-check and lint load the source of every workspace
 * package it imports, and of every package those import. A confined run is
 * shown only what its target declares, and a file another package owns is
 * declared through a file group of that package, so the package lists these
 * groups among its targets and hands them to
 * {@link BuildAndCheckTypeScriptPackage} as `reads`. Their files are then in
 * the key of each run that reads them: an edit to a reached package's source
 * reruns those runs, and an edit to any other package does not.
 *
 * The reach is read from the manifests when the declaration is evaluated,
 * which every command does: the package's `dependencies`,
 * `devDependencies` and `peerDependencies`, then the `dependencies` and
 * `peerDependencies` of each package reached. Membership is
 * `pnpm-workspace.yaml`'s, through `scripts/workspace-packages.mjs`.
 *
 * A file group that names a directory holding no file is refused where every
 * declared input is resolved (`smthrs target //:targetIndex --write`, which a
 * release cut runs: `declared_input_missing`). So a `<directory>/**` pattern
 * is kept only for a package that has that directory; most have no `bin/`.
 *
 * @since 0.1.0
 */

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Filegroup } from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import { repoRoot, workspacePackages } from "../scripts/workspace-packages.mjs"

type Member = ReturnType<typeof workspacePackages>[number]

const cachedMembers = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly members: ReadonlyArray<Member> }
>()

type SourceEntry = Input.File | Input.Glob

const cachedSrcs = new Map<string, ReadonlyArray<SourceEntry>>()

const loadWorkspacePackages = (root: string): ReadonlyArray<Member> => {
  const manifestPath = join(root, "pnpm-workspace.yaml")
  const stat = statSync(manifestPath)
  const hit = cachedMembers.get(root)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.members
  const members = workspacePackages(root)
  cachedMembers.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, members })
  // Invalidate cached input lists for this root if workspace membership changed.
  for (const key of cachedSrcs.keys()) {
    if (key.startsWith(`${root}\0`)) cachedSrcs.delete(key)
  }
  return members
}

/**
 * Options accepted by {@link WorkspaceSources}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The workspace-relative directory of the package whose reach is read. */
  readonly cwd: string
  /**
   * The files of each reached package a run reads, relative to that package:
   * its sources, the launchers its command line starts from, its manifest,
   * and its compiler configuration, which the test runner's compiler reads for
   * each source it loads from that package.
   *
   * @default ["src/**", "bin/**", "package.json", "{tsconfig,jsconfig,vibe.config}.json"]
   */
  readonly files?: ReadonlyArray<string> | undefined
  /** The workspace root. Omitted, the repository this module is in. */
  readonly root?: string | undefined
}

/**
 * One file group per workspace package reached from the package at `cwd`,
 * keyed by `sources-` and the package's directory with `/` as `-`. The
 * package itself is not among them.
 *
 * @category macros
 * @since 0.1.0
 */
export const WorkspaceSources = (options: Options): Readonly<Record<string, ReturnType<typeof Filegroup>>> => {
  const root = options.root ?? repoRoot
  const members = loadWorkspacePackages(root)
  const byName = new Map(members.map((member) => [member.name, member]))
  const own = members.find((member) => member.dir === options.cwd)
  if (own === undefined) throw new TypeError(`WorkspaceSources: ${options.cwd} is not a workspace package`)
  const reached = new Map<string, Member>()
  const visit = (manifest: Member["manifest"], fields: ReadonlyArray<string>): void => {
    for (const field of fields) {
      for (const name of Object.keys((manifest as Record<string, Record<string, string> | undefined>)[field] ?? {})) {
        const member = byName.get(name)
        if (member === undefined || member === own || reached.has(member.dir)) continue
        reached.set(member.dir, member)
        visit(member.manifest, ["dependencies", "peerDependencies"])
      }
    }
  }
  visit(own.manifest, ["dependencies", "devDependencies", "peerDependencies"])
  const files = options.files ?? ["src/**", "bin/**", "package.json", "{tsconfig,jsconfig,vibe.config}.json"]
  const filesKey = files.join("\0")
  const present = (member: Member, file: string): boolean => {
    const directory = /^([^*?{[]+)\/\*\*$/.exec(file)?.[1]
    return directory === undefined || existsSync(join(root, member.dir, directory))
  }
  const srcsFor = (member: Member): ReadonlyArray<SourceEntry> => {
    const cacheKey = `${root}\0${member.dir}\0${filesKey}`
    let srcs = cachedSrcs.get(cacheKey)
    if (srcs === undefined) {
      srcs = files.filter((file) => present(member, file))
        .map((file) => /[*?{[]/.test(file) ? Input.glob(file) : Input.file(file))
      cachedSrcs.set(cacheKey, srcs)
    }
    return srcs
  }
  return Object.fromEntries(
    [...reached.values()].sort((left, right) => left.dir < right.dir ? -1 : 1).map((member) => [
      `sources-${member.dir.replaceAll("/", "-")}`,
      Filegroup({ srcs: srcsFor(member), cwd: member.dir })
    ])
  )
}
