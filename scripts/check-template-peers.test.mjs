// A scaffolded app resolves one Effect family under strict peer resolution.
//
// `@effect/platform-node` and `@effect/platform-bun` each depend on
// `@effect/platform-node-shared` through a caret range, so a resolver is free
// to select the next shared-adapter RC, whose own `effect` peer is that next
// RC. Against the exact `effect` a template pins that is a peer conflict, and
// the two managers disagree about how loudly to say so:
//
// - `npm install --strict-peer-deps` exits 1 with an ERESOLVE naming an Effect
//   RC no manifest here asks for.
// - `pnpm install --strict-peer-dependencies` reports the same unmet peer, but
//   only on some cache states; on others it installs the mismatched pair and
//   exits 0. Its exit code is therefore not a detector, so each cell also
//   reads what landed on disk, which is the same either way.
//
// Reading the resolution is the stronger claim anyway. It is the rule
// `scripts/check-single-effect-version.mjs` holds this workspace to, asked of a
// generated app: the shared adapter an app loads must be the version that app
// pins, and it must load the app's own `effect` rather than a second copy.
//
// This repository pins the shared adapter in its root overrides. A scaffolded
// app is not a workspace member and inherits none of them, so each template
// names the shared adapter itself. A direct pin, not an `overrides` entry:
// `pnpm` reads `pnpm.overrides` and ignores npm's field, and a template
// declares `pnpm` as its package manager, so the npm field would leave the
// declared manager resolving the mismatched pair.
//
// What runs here is the template the package publishes, the only one a scaffold
// outside this checkout can select. `template/aomi` is absent from `files`, and
// its `tevm` and `viem` dependencies carry peer conflicts of their own that
// have nothing to do with Effect. Every template, published or not, is held to
// the pin itself by `templateManifests.test.ts` in `@smthrs/create-app`.
//
// The consumer installed here is the generated manifest minus its `@smthrs/*`
// entries. That release line is absent from the registry between publications,
// while this conflict is entirely among third-party packages, so dropping the
// first-party half is what lets this run every day instead of only after a
// publication. `scripts/check-npm-dedupe.test.mjs` installs the first-party
// half from packed candidate bytes.
//
// The installs read the registry, so this needs the network. Both cells
// together take about 15 s against a warm cache and under a minute cold.
//
// Run it with `node --test scripts/check-template-peers.test.mjs`.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { repoRoot } from "./workspace-packages.mjs"

const createApp = join(repoRoot, "packages/smithers/create-app")
const buildCli = join(repoRoot, "packages/smithers/build/build-cli/src/main.js")

/** The host adapters that reach `@effect/platform-node-shared` through a caret range. */
const shared = "@effect/platform-node-shared"
const adapters = ["@effect/platform-node", "@effect/platform-bun"]

/** The templates the tarball carries, read from the same `files` globs npm packs. */
const publishedTemplates = (JSON.parse(readFileSync(join(createApp, "package.json"), "utf8")).files ?? [])
  .map((pattern) => /^template\/([^/]+)\/\*\*$/.exec(pattern))
  .filter((match) => match !== null)
  .map((match) => match[1])
  .sort()

/** The half of a generated manifest the public registry can resolve. */
const thirdParty = (section) =>
  Object.fromEntries(Object.entries(section ?? {}).filter(([name]) => !name.startsWith("@smthrs/")))

/** Scaffolds with the real CLI, exactly as `smithers-build create-app` runs it. */
const scaffold = (root, template) => {
  const directory = join(root, "app")
  const result = spawnSync(process.execPath, [buildCli, "create-app", directory, "--template", template], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000
  })
  assert.equal(result.status, 0, `scaffolding template/${template} failed:\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
}

const resolveFrom = (directory, specifier) =>
  realpathSync(createRequire(join(directory, "package.json")).resolve(`${specifier}/package.json`))

const versionAt = (path) => JSON.parse(readFileSync(path, "utf8")).version

const managers = [
  { name: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--strict-peer-deps"] },
  { name: "pnpm", args: ["install", "--ignore-scripts", "--ignore-workspace", "--strict-peer-dependencies"] }
]

test("the package publishes a template to scaffold from", () => {
  assert.ok(publishedTemplates.length > 0, "no `files` glob packs a template, so the cells below are vacuous")
})

for (const template of publishedTemplates) {
  for (const manager of managers) {
    test(`template/${template} resolves one Effect family under ${manager.name}`, { timeout: 10 * 60_000 }, () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-template-peers-")))
      try {
        const generated = scaffold(root, template)
        const pins = { ...generated.dependencies, ...generated.devDependencies }
        const pinned = adapters.filter((name) => pins[name] !== undefined)
        assert.ok(pinned.length > 0, `template/${template} pins no Effect host adapter, so this cell is vacuous`)

        const consumer = join(root, "consumer")
        mkdirSync(consumer)
        writeFileSync(
          join(consumer, "package.json"),
          JSON.stringify({
            name: generated.name,
            private: true,
            version: generated.version,
            type: generated.type,
            packageManager: generated.packageManager,
            dependencies: thirdParty(generated.dependencies),
            devDependencies: thirdParty(generated.devDependencies)
          })
        )

        const install = spawnSync(manager.name, manager.args, { cwd: consumer, encoding: "utf8", timeout: 9 * 60_000 })
        assert.equal(
          install.status,
          0,
          `${manager.name} refused the manifest template/${template} generates:\n${install.stdout}\n${install.stderr}`
        )

        const effect = resolveFrom(consumer, "effect")
        assert.equal(versionAt(effect), pins.effect, "the app must install the `effect` it pins")
        for (const adapter of pinned) {
          const host = resolveFrom(consumer, adapter)
          const sharedPath = resolveFrom(join(host, ".."), shared)
          assert.equal(
            versionAt(sharedPath),
            pins[adapter],
            `${manager.name}: ${adapter}@${pins[adapter]} loaded ${shared}@${versionAt(sharedPath)}; pin ${shared}`
          )
          assert.equal(
            resolveFrom(join(sharedPath, ".."), "effect"),
            effect,
            `${manager.name}: ${shared} loaded a second physical Effect, so the app has two Effect families`
          )
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
}
