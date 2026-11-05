#!/usr/bin/env node
/**
 * Packs `@smthrs/cli` and every workspace package it needs at runtime into `infra/sandbox/cli/`, from this checkout,
 * for the sandbox image (infra/sandbox/Dockerfile) to install. A repository's overflow box runs `smthrs runner serve`
 * (decision 0144), so its runner is always the one this deploy built, never a registry version: the image build copies
 * these tarballs, and their content is the image's pin.
 *
 * Each package is built clean and packed exactly as a release packs it (.smithers/flows/release/pack-release.mjs), from
 * a staged manifest whose exports point at the built artifacts. `cli/package.json` names each tarball as a `file:`
 * dependency, so `npm install` there installs the set together and satisfies their exact-version edges from each other.
 * `cli/manifest.json` lists each tarball's integrity.
 *
 * Run by `pnpm plan` and `pnpm deploy` before Alchemy builds the image. `pnpm dev` runs it with `--if-missing`, which
 * keeps a pack already there: a local box may run an older runner than the checkout until the pack is redone.
 * `--built` is for graph callers whose library dependencies have already established fresh build outputs.
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  dependencyOrder,
  packWorkspace,
  readWorkspaceManifests,
  workspaceDependencies
} from "../../../../.smithers/flows/release/pack-release.mjs"

/** The CLI the box runs. */
export const CLI = "@smthrs/cli"

/** The workspace directories `name` needs at runtime, itself included, in the order they must be built. */
export const closureOf = (name, manifests = readWorkspaceManifests()) => {
  const dependencies = workspaceDependencies(manifests)
  const root = [...manifests].find(([, manifest]) => manifest.name === name)?.[0]
  if (root === undefined) throw new Error(`${name} is not a published workspace package`)
  const needed = new Set([root])
  const pending = [root]
  while (pending.length > 0) {
    for (const next of dependencies.get(pending.pop()) ?? []) {
      if (!needed.has(next)) {
        needed.add(next)
        pending.push(next)
      }
    }
  }
  return dependencyOrder(new Map([...dependencies].filter(([directory]) => needed.has(directory))
    .map(([directory, edges]) => [directory, new Set([...edges].filter((edge) => needed.has(edge)))])))
}

/** Packs the CLI's closure into `output`, replacing what was there. */
export const pack = async (output = fileURLToPath(new URL("./cli/", import.meta.url)), { rebuild = true } = {}) => {
  await mkdir(output, { recursive: true })
  for (const entry of await readdir(output)) await rm(join(output, entry), { recursive: true, force: true })
  const staging = await mkdtemp(join(tmpdir(), "smthrs-box-cli-"))
  try {
    const packed = []
    for (const directory of closureOf(CLI)) {
      packed.push(await packWorkspace(directory, output, staging, { rebuild }))
    }
    await writeFile(join(output, "manifest.json"), `${JSON.stringify(packed, null, 2)}\n`)
    await writeFile(
      join(output, "package.json"),
      `${JSON.stringify({
        name: "smthrs-box-cli",
        private: true,
        dependencies: Object.fromEntries(packed.map((each) => [each.name, `file:./${each.filename}`]))
      }, null, 2)}\n`
    )
    return packed
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--if-missing" && existsSync(new URL("./cli/manifest.json", import.meta.url))) process.exit(0)
  const packed = await pack(undefined, { rebuild: process.argv[2] !== "--built" })
  console.log(`packed ${packed.length} packages for the sandbox image: ${packed.map((each) => each.filename).join(", ")}`)
}
