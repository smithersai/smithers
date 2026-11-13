/**
 * The manifest contract every workspace package keeps.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/package-and-build-contract`
 * suites. The 0.x version asserted a build pipeline that no longer exists —
 * `tsup` entry points, a `dist/` layout, a bin shim — so what survives here is
 * the part that is still a claim about the shipped tree: one version across the
 * release line, a publishable surface that is actually declared, and the four
 * scripts every gate invokes.
 *
 * Run it with `node --test packages/repo-targets/contracts/package-contract.test.mjs`.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  EXPECTED_EFFECT_VERSION as effectVersion,
  SUPPORTED_EFFECT_RANGE as effectRange
} from "./check-single-effect-version.mjs"
import { retarget } from "../../../.smithers/flows/release/set-release-version.mjs"
import { publicationManifest } from "../../../.smithers/flows/release/pack-release.mjs"
import { libraryPackages } from "../scripts/workspace-packages.mjs"
import { repoRoot as root } from "../scripts/workspace-packages.mjs"

/**
 * The one version every package on the release line carries, read from the CLI
 * manifest `set-release-version.mjs` rewrites, so a cut never leaves this suite
 * asserting the previous line.
 */
const releaseManifest = "packages/smithers/package.json"
const releaseVersion = JSON.parse(readFileSync(join(root, releaseManifest), "utf8")).version

/**
 * The release-line rule, over any set of manifests: the version is the CLI
 * manifest's, read from that same set, and every other publishable package
 * carries it. The rule owns its version source so a retargeted copy of the
 * workspace is judged against its own line, never against this file's idea of
 * the current one.
 */
const releaseLine = (entries) => {
  const version = entries.find((entry) => entry.path === join(root, releaseManifest)).manifest.version
  return {
    version,
    offLine: entries.filter((entry) => entry.manifest.private !== true && entry.manifest.version !== version)
  }
}

/** npm's `overrides`, a nested `parent: { child: version }` flattened to pnpm's `parent>child` key. */
const npmOverrides = (overrides, parent) =>
  Object.fromEntries(Object.entries(overrides).flatMap(([name, value]) => {
    const key = parent === undefined ? name : `${parent}>${name}`
    return typeof value === "object" ? Object.entries(npmOverrides(value, key)) : [[key, value]]
  }))

/**
 * The `overrides:` block of `pnpm-workspace.yaml` as a name-to-version map.
 * Comment and blank lines are skipped; every other line must be one pin.
 */
const pnpmOverrides = (planner) => {
  const block = planner.match(/^overrides:\n((?:[ \t]+.*\n|\n)*)/m)?.[1]
  assert.ok(block, "pnpm-workspace.yaml has no overrides block")
  return Object.fromEntries(
    block.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")).map((line) => {
      const match = line.match(/^['"]?([^'"\s]+)['"]?: ['"]?([^'"\s]+)['"]?$/)
      assert.ok(match, `unexpected override: ${line}`)
      return [match[1], match[2]]
    })
  )
}

/** Executables own their runtime; libraries make the host supply the singleton. */
const effectRuntimeOwners = new Set(["@smthrs/build-cli", "@smthrs/cli", "@smthrs/migrate"])

/** Public packages whose implementation and API do not touch Effect. */
const effectIndependent = new Set([])

/**
 * Publishable packages that are deliberately NOT on the release line, and why.
 *
 * A package here still has to keep every other rule; it is exempt only from the
 * synchronized version. Adding a row is a review decision, which is the point of
 * enumerating them instead of loosening the assertion.
 */
const offReleaseLine = new Map([])

/**
 * The one publishable package whose whole surface is a single throwing module,
 * so it exposes no subpaths and no manifest.
 */
const manifestNotExposed = new Map([
  [
    "smthrs",
    "The 1.0 migration notice. Importing it throws; there is no subpath surface "
    + "and nothing that would read its manifest at runtime."
  ]
])

/** Every library package, at any depth, named by its path under `packages/`. */
const manifests = libraryPackages(root).map((entry) => ({
  directory: entry.dir.slice("packages/".length),
  path: entry.manifestPath,
  manifest: entry.manifest
}))

const publishable = manifests.filter((entry) => entry.manifest.private !== true)

// SDK-6: pnpm rewrites exact workspace references when packing a package.
// Existing release-version pins remain valid; floating published ranges do not.
const exactWorkspaceDependency = (range, version) =>
  range === version || range === "workspace:*" || range === `workspace:${version}`

/** Installed dependency edges of publishable packages must resolve publicly. */
const assertNoPrivateDependencies = (entries) => {
  const privateNames = new Set(
    entries.filter((entry) => entry.manifest.private === true).map((entry) => entry.manifest.name)
  )
  for (const entry of entries.filter((entry) => entry.manifest.private !== true)) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(entry.manifest[field] ?? {})) {
        assert.ok(
          !privateNames.has(name),
          `packages/${entry.directory} publishes a dependency on ${name}, which is never published`
        )
      }
    }
  }
}

describe("the workspace package contract", () => {
  it("has packages to check", () => {
    assert.ok(manifests.length > 20, `expected a populated packages/ tree, found ${manifests.length}`)
    assert.ok(publishable.length > 20, `expected publishable packages, found ${publishable.length}`)
  })

  it("keeps one version across the release line", () => {
    const line = releaseLine(manifests)
    assert.equal(line.version, releaseVersion, `${releaseManifest} is the release line's source`)
    for (const entry of line.offLine) {
      assert.ok(
        offReleaseLine.has(entry.manifest.name),
        `packages/${entry.directory} publishes ${entry.manifest.name}@${entry.manifest.version} instead of `
          + `${releaseVersion}. Move it onto the release line, or add it to offReleaseLine with the reason.`
      )
    }
    // The exemptions are for packages that exist. A stale row would quietly stop
    // guarding anything.
    for (const name of offReleaseLine.keys()) {
      assert.ok(
        publishable.some((entry) => entry.manifest.name === name),
        `offReleaseLine names ${name}, which is not a publishable package any more`
      )
    }
  })

  it("follows the release line when a cut retargets every manifest", () => {
    // The cut rewrites manifests, shipped templates, and a few source
    // literals; it does not rewrite this suite. So the version the gate asserts
    // must come from the manifests themselves, or the first cut after a release
    // reddens a required gate. Retarget a copy through the cut's own function
    // and hold it to the version it now declares.
    const nextVersion = `${releaseVersion}-retarget-probe`
    const workspaceNames = new Set(manifests.map((entry) => entry.manifest.name))
    const cut = manifests.map((entry) => ({
      ...entry,
      manifest: retarget(entry.manifest, nextVersion, workspaceNames)
    }))
    const line = releaseLine(cut)

    assert.equal(line.version, nextVersion, "the gate reads the version the cut wrote, not this file's")
    assert.deepEqual(
      line.offLine.map((entry) => entry.manifest.name),
      [...offReleaseLine.keys()],
      "after a cut, only the enumerated exemptions may sit off the release line"
    )
  })

  it("declares a publishable surface for every published package", () => {
    for (const entry of publishable) {
      const { manifest } = entry
      const where = `packages/${entry.directory}`
      assert.equal(manifest.type, "module", `${where} must be an ES module`)
      assert.equal(manifest.license, "MIT", `${where} must declare its licence`)
      assert.equal(manifest.publishConfig?.access, "public", `${where} must publish publicly`)
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, `${where} must declare files`)
      assert.ok(manifest.exports?.["."], `${where} must declare a root export`)
      if (!manifestNotExposed.has(manifest.name)) {
        assert.equal(
          manifest.exports?.["./package.json"],
          "./package.json",
          `${where} must expose its own manifest, which tooling reads`
        )
      }
      assert.equal(manifest.repository?.directory, where, `${where} must name its own directory in repository`)
      assert.ok(manifest.engines?.node, `${where} must declare the Node range it supports`)
    }
  })

  it("ships the root LICENSE verbatim in every published package", () => {
    const license = readFileSync(join(root, "LICENSE"))
    for (const entry of publishable) {
      const where = `packages/${entry.directory}`
      assert.ok(entry.manifest.files.includes("LICENSE"), `${where} must list LICENSE in files`)
      assert.deepEqual(readFileSync(join(root, where, "LICENSE")), license, `${where}/LICENSE must match root`)
    }
  })

  it("tags the release line so an RC never lands on the latest dist-tag", () => {
    for (const entry of publishable) {
      if (offReleaseLine.has(entry.manifest.name)) continue
      assert.equal(
        entry.manifest.publishConfig?.tag,
        "next",
        `packages/${entry.directory} would publish to the default dist-tag, which is how a release candidate `
          + "becomes somebody's `npm install` by accident"
      )
    }
  })

  it("wires the scripts every gate invokes", () => {
    for (const entry of publishable) {
      const scripts = entry.manifest.scripts ?? {}
      for (const name of ["lint", "build", "check", "test", "coverage"]) {
        assert.ok(scripts[name], `packages/${entry.directory} is missing scripts.${name}`)
      }
    }
  })

  it("resolves every workspace dependency to a package that exists at the version it names", () => {
    const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry.manifest]))
    for (const entry of manifests) {
      const dependencies = { ...entry.manifest.dependencies, ...entry.manifest.peerDependencies }
      for (const [name, range] of Object.entries(dependencies)) {
        if (!name.startsWith("@smthrs/")) continue
        const target = byName.get(name)
        assert.ok(target, `packages/${entry.directory} depends on ${name}, which is not in this workspace`)
        if (entry.manifest.private === true) {
          // A private package is never published, so the `workspace:` protocol
          // never reaches a consumer and an exact pin buys nothing.
          assert.ok(
            range === target.version || range.startsWith("workspace:"),
            `packages/${entry.directory} pins ${name}@${range}, which is neither the workspace version `
              + `${target.version} nor a workspace protocol range`
          )
          continue
        }
        assert.ok(
          exactWorkspaceDependency(range, target.version),
          `packages/${entry.directory} must pin ${name} to ${target.version} or its exact workspace reference; got ${range}`
        )
      }
    }
  })

  it("accepts packable exact workspace dependencies and rejects mismatched or floating versions", () => {
    for (const range of [releaseVersion, "workspace:*", `workspace:${releaseVersion}`]) {
      assert.equal(exactWorkspaceDependency(range, releaseVersion), true, range)
    }
    for (const range of ["workspace:^", "workspace:~", "workspace:0.0.0", "0.0.0", `^${releaseVersion}`, "*"]) {
      assert.equal(exactWorkspaceDependency(range, releaseVersion), false, range)
    }
  })

  it("resolves workspace protocols before release packing leaves the workspace", () => {
    const target = publishable.find(({ manifest }) => manifest.name === "@smthrs/crypto").manifest
    for (const range of ["workspace:*", `workspace:${target.version}`]) {
      const manifest = {
        name: "@smthrs/packing-contract", version: "0.0.0",
        exports: { ".": "./src/index.ts" },
        publishConfig: { exports: { ".": "./dist/index.js" } },
        ...Object.fromEntries(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
          .map((field) => [field, { [target.name]: range, external: "1.2.3" }]))
      }
      const published = publicationManifest(manifest)
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        assert.deepEqual(published[field], { [target.name]: target.version, external: "1.2.3" })
        assert.equal(manifest[field][target.name], range, "publication must not mutate the workspace manifest")
      }
    }
    for (const [name, range] of [[target.name, "workspace:^"], [target.name, "workspace:0.0.0"], ["@smthrs/absent", "workspace:*"]]) {
      assert.throws(() => publicationManifest({
        name: "@smthrs/packing-contract", publishConfig: { exports: {} }, dependencies: { [name]: range }
      }), /no exact workspace dependency/)
    }
  })

  it("never lets a published package depend on a private one", () => {
    assertNoPrivateDependencies(manifests)
  })

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    it(`rejects private installed dependencies in ${field}`, () => {
      assert.throws(() => assertNoPrivateDependencies([
        { directory: "private", manifest: { name: "@fixture/private", private: true } },
        { directory: "public", manifest: { name: "@fixture/public", [field]: { "@fixture/private": "workspace:*" } } }
      ]), /packages\/public publishes a dependency on @fixture\/private, which is never published/)
    })
  }

  it("retains private development dependencies and public installed dependencies", () => {
    assert.doesNotThrow(() => assertNoPrivateDependencies([
      { directory: "private", manifest: { name: "@fixture/private", private: true, dependencies: { "@fixture/private": "workspace:*" } } },
      { directory: "empty", manifest: { name: "@fixture/empty" } },
      { directory: "public", manifest: {
        name: "@fixture/public",
        devDependencies: { "@fixture/private": "workspace:*" },
        dependencies: { "@fixture/empty": "workspace:*" },
        peerDependencies: { "@fixture/empty": "workspace:*" },
        optionalDependencies: { external: "1.0.0" }
      } }
    ]))
  })

  it("keeps overrides out of published packages and pins only the reviewed trains in both planners", () => {
    const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    for (const [where, manifest] of manifests.map((entry) => [entry.path, entry.manifest])) {
      assert.equal(manifest.overrides, undefined, `${where} must not use npm overrides`)
      assert.equal(manifest.pnpm?.overrides, undefined, `${where} must not use pnpm overrides`)
    }
    // Each row is a reviewed pin: 6c82383c pinned Bun types beside the Effect
    // family; one VibeLang toolchain and one Alchemy beta per install; one
    // happy-dom under Vitest 5.0.0, so @effect/vitest and a package's CLI share
    // one peer runtime.
    const vibelangVersion = rootManifest.devDependencies.vibelang
    const expected = {
      "@types/bun": "1.4.4",
      ...Object.fromEntries([
        "effect",
        "@effect/opentelemetry",
        "@effect/platform-bun",
        "@effect/platform-node",
        "@effect/platform-node-shared",
        "@effect/sql-d1",
        "@effect/sql-pg",
        "@effect/sql-sqlite-bun",
        "@effect/sql-sqlite-do",
        "@effect/sql-sqlite-node",
        "@effect/vitest"
      ].map((name) => [name, effectVersion])),
      ...Object.fromEntries(["vibelang", "vibelang-runtime", "vibelang-vite", "vibelang-unplugin"]
        .map((name) => [name, vibelangVersion])),
      ...Object.fromEntries(["alchemy", "@alchemy.run/node-utils", "@alchemy.run/frontend-frameworks"]
        .map((name) => [name, "2.0.0-beta.85"])),
      "vitest@5.0.0>happy-dom": "20.13.2"
    }
    assert.deepEqual(npmOverrides(rootManifest.overrides), expected)
    assert.equal(rootManifest.pnpm?.overrides, undefined)
    // Workspace locking also covers private tooling. Consumer certification
    // installs the unchanged tarballs without these overrides.
    const planner = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    assert.deepEqual(pnpmOverrides(planner), expected, "pnpm must pin the same versions as npm and Bun")
  })

  it("reads both planners' overrides in one spelling, past pnpm's comments", () => {
    assert.deepEqual(
      npmOverrides({ effect: effectVersion, "vitest@5.0.0": { "happy-dom": "20.13.2" } }),
      { effect: effectVersion, "vitest@5.0.0>happy-dom": "20.13.2" }
    )
    const planner = [
      "packages:",
      "  - packages/*",
      "overrides:",
      "  # Why the pin exists.",
      "  \"vitest@5.0.0>happy-dom\": \"20.13.2\"",
      "",
      `  effect: '${effectVersion}'`,
      "",
      "# The next block.",
      "patchedDependencies:",
      "  a: b",
      ""
    ].join("\n")
    assert.deepEqual(pnpmOverrides(planner), { "vitest@5.0.0>happy-dom": "20.13.2", effect: effectVersion })
    assert.throws(
      () => pnpmOverrides(`overrides:\n  effect ${effectVersion}\n`),
      new RegExp(`unexpected override: effect ${effectVersion.replaceAll(".", "\\.")}`)
    )
    assert.throws(() => pnpmOverrides("packages: []\n"), /no overrides block/)
  })

  it("keeps Effect as a ranged peer of every library and the tested release in every executable", () => {
    for (const entry of publishable) {
      const { manifest } = entry
      if (manifestNotExposed.has(manifest.name)) continue
      if (effectIndependent.has(manifest.name)) {
        assert.equal(manifest.dependencies?.effect, undefined, `${manifest.name} must not install unused Effect`)
        assert.equal(manifest.peerDependencies?.effect, undefined, `${manifest.name} must not impose an unused peer`)
        continue
      }
      if (effectRuntimeOwners.has(manifest.name)) {
        assert.equal(
          manifest.peerDependencies?.effect,
          effectVersion,
          `${manifest.name} must share the exact tested Effect runtime with its host`
        )
        assert.equal(manifest.dependencies?.effect, undefined, `${manifest.name} must not install a nested Effect runtime`)
        continue
      }
      assert.equal(
        manifest.peerDependencies?.effect,
        effectRange,
        `${manifest.name} must accept the Effect runtime its host supplies, anywhere in the supported range`
      )
      assert.equal(
        manifest.dependencies?.effect,
        undefined,
        `${manifest.name} is a library and must not install a private Effect runtime`
      )
      assert.equal(
        manifest.devDependencies?.effect,
        effectVersion,
        `${manifest.name} must install the peer only for its own development checks`
      )
    }
  })

  it("keeps Effect external and platform adapters private", () => {
    const owners = publishable.filter(({ manifest }) => manifest.smthrs?.privateEffectAdapters)
    // 8c69f33c moved host runtimes out of the platform-neutral flows barrel.
    assert.deepEqual(owners.map(({ manifest }) => manifest.name).sort(), [
      "@smthrs/build-cli", "@smthrs/cli", "@smthrs/gateway", "@smthrs/migrate",
      "@smthrs/platform-bun", "@smthrs/platform-node"
    ])
    for (const { manifest } of owners) {
      // An executable requires the exact peer its adapters are built from. A
      // library builds them from the release it develops against, and its
      // peer starts there.
      if (effectRuntimeOwners.has(manifest.name)) {
        assert.equal(manifest.peerDependencies?.effect, effectVersion)
      } else {
        assert.equal(manifest.peerDependencies?.effect, effectRange)
        assert.equal(manifest.devDependencies?.effect, effectVersion)
        assert.equal(effectRange, effectVersion)
      }
      assert.ok(manifest.smthrs.privateEffectAdapters.includes("@effect/platform-node-shared"))
      assert.ok(manifest.files.includes("dist/vendor/**"))
      for (const name of manifest.smthrs.privateEffectAdapters) {
        assert.equal(manifest.dependencies?.[name], undefined)
        assert.equal(manifest.peerDependencies?.[name], undefined)
        assert.equal(manifest.optionalDependencies?.[name], undefined)
        assert.equal(manifest.devDependencies?.[name], effectVersion)
      }
      for (const name of ["undici", "ws", "redis", "@types/ws"]) {
        assert.match(manifest.dependencies[name], /^\d+\.\d+\.\d+$/)
      }
    }
  })

  it("keeps kernel's browser test host out of the runtime graph", () => {
    const kernel = publishable.find((entry) => entry.manifest.name === "@smthrs/kernel")
    assert.ok(kernel, "@smthrs/kernel must be publishable")

    assert.equal(kernel.manifest.dependencies?.["@smthrs/platform-browser"], undefined)
    assert.equal(kernel.manifest.devDependencies?.["@smthrs/platform-browser"], undefined)
    assert.equal(kernel.manifest.peerDependencies?.["@smthrs/platform-browser"], undefined)
    assert.equal(kernel.manifest.peerDependenciesMeta?.["@smthrs/platform-browser"], undefined)
  })

  it("ships the Bun adapter imported by the root entry point privately", () => {
    const platform = publishable.find((entry) => entry.manifest.name === "@smthrs/platform-bun")
    assert.ok(platform, "@smthrs/platform-bun must be publishable")

    assert.equal(platform.manifest.peerDependencies?.["@effect/platform-bun"], undefined)
    assert.equal(platform.manifest.devDependencies?.["@effect/platform-bun"], effectVersion)
    assert.ok(platform.manifest.smthrs.privateEffectAdapters.includes("@effect/platform-bun"))
  })

  for (const name of ["platform-node", "gateway"]) {
    it(`ships ${name}'s shared adapter without a consumer resolver edge`, () => {
      const entry = publishable.find(({ manifest }) => manifest.name === "@smthrs/" + name)
      assert.ok(entry)
      for (const adapter of entry.manifest.smthrs.privateEffectAdapters) {
        assert.equal(entry.manifest.peerDependencies?.[adapter], undefined)
        assert.equal(entry.manifest.peerDependenciesMeta?.[adapter], undefined)
        assert.equal(entry.manifest.dependencies?.[adapter], undefined)
        assert.equal(entry.manifest.devDependencies[adapter], effectVersion)
      }
    })
  }
})
