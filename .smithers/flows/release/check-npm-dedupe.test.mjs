// The dependency policy of combined and individual release consumers.
//
// The script reports both findings through one exit code, so a regression in
// either reads as an opaque non-zero exit. These cells name the claim that
// broke and the package that broke it.
//
// Real release manifests are packed unchanged. The combined fixture inspects
// npm's lockfile, while individual npm and pnpm consumers inspect physical
// files and each installed package's native Effect resolution.
//
// The fixture install reads registry metadata, so this suite needs the network.
//
// Run it with `node --test .smithers/flows/release/check-npm-dedupe.test.mjs`.
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { SINGLETONS, copiesOf, maxPackagesFrom, optionalPeersOf, resolveConsumerTree, resolveConsumerProfiles } from "./check-npm-dedupe.mjs"
import { EXPECTED_EFFECT_VERSION } from "../../../packages/repo-targets/contracts/check-single-effect-version.mjs"
import { assertConsumerTree } from "./release-consumers.mjs"
import { repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"
import { readWorkspaceManifests } from "./pack-release.mjs"
import { peerRangesOf } from "./release-peer-ranges.mjs"

it("refuses a --max-packages value that cannot fail", () => {
  // The budget's only use is `total > maxPackages`, and that comparison is
  // false for NaN. A bare flag, or one followed by another flag, therefore used
  // to disable the package-count assertion while the log still printed the
  // budget it was no longer applying.
  assert.equal(maxPackagesFrom([]), 925)
  assert.equal(maxPackagesFrom(["--keep-tmp"]), 925)
  assert.equal(maxPackagesFrom(["--max-packages", "1200"]), 1200)
  for (const args of [["--max-packages"], ["--max-packages", "--keep-tmp"], ["--max-packages", ""], ["--max-packages", "0"], ["--max-packages", "-1"], ["--max-packages", "9.5"], ["--max-packages", "1e400"]]) {
    assert.throws(() => maxPackagesFrom(args), /--max-packages requires a positive integer/, args.join(" "))
  }
})

it("exits 2 with usage on a bare --max-packages instead of installing under no budget", () => {
  const result = spawnSync(process.execPath, [".smithers/flows/release/check-npm-dedupe.mjs", "--max-packages"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /--max-packages requires a positive integer/)
  assert.match(result.stderr, /usage: node \.smithers\/flows\/release\/check-npm-dedupe\.mjs/)
  assert.doesNotMatch(result.stdout, /resolved package count/)
})

it("requires exactly one physical Effect copy at the zero, one, and two-copy boundaries", async () => {
  for (const count of [0, 1, 2]) {
    const root = await mkdtemp(join(tmpdir(), "smithers-k-effect-boundary-"))
    try {
      for (let index = 0; index < count; index++) {
        const directory = index === 0
          ? join(root, "node_modules/effect")
          : join(root, "node_modules/parent/node_modules/effect")
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "package.json"), JSON.stringify({ name: "effect", version: EXPECTED_EFFECT_VERSION }))
      }
      const profile = { name: "boundary-" + count, dependencies: { effect: EXPECTED_EFFECT_VERSION } }
      if (count === 1) assert.equal(assertConsumerTree(root, profile).effectCopies.length, 1)
      else assert.throws(() => assertConsumerTree(root, profile), /expected exactly one physical Effect copy/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it("distinguishes optional library peers from a selected executable's requirements", () => {
  const library = { peerDependencies: { runtime: "1", renderer: "1" },
    peerDependenciesMeta: { runtime: { optional: true }, renderer: { optional: true } } }
  assert.deepEqual(optionalPeersOf([library]), ["renderer", "runtime"])
  assert.deepEqual(optionalPeersOf([library, { dependencies: { runtime: "1" } }]), ["renderer"])
  assert.deepEqual(optionalPeersOf([library, { peerDependencies: { runtime: "1" } }]), ["renderer"])
  assert.deepEqual(optionalPeersOf([library, { name: "runtime" }]), ["renderer"])
})

it("follows required transitive peers without excusing optional lockfile branches", () => {
  const library = { peerDependencies: { runtime: "1", renderer: "1" },
    peerDependenciesMeta: { runtime: { optional: true }, renderer: { optional: true } } }
  const bridge = { dependencies: { adapter: "1" } }
  const adapter = { peerDependencies: { runtime: "1", renderer: "1" },
    peerDependenciesMeta: { renderer: { optional: true } } }
  assert.deepEqual(optionalPeersOf([library, bridge], { "node_modules/adapter": adapter }), ["renderer"])
  for (const orphan of [
    { name: "runtime", version: "1" },
    { optional: true, peerDependencies: { runtime: "1" } },
    { optionalDependencies: { runtime: "1" } },
    { dependencies: { runtime: "1" } }
  ]) assert.deepEqual(optionalPeersOf([library], { "node_modules/orphan": orphan }), ["renderer", "runtime"])
  assert.deepEqual(optionalPeersOf([library, bridge], {
    "node_modules/adapter": { dependencies: { runtime: "1" }, optionalDependencies: { runtime: "1" } }
  }), ["renderer", "runtime"])
  assert.deepEqual(optionalPeersOf([library], {
    "node_modules/adapter": { dependencies: { runtime: "1" } },
    "node_modules/runtime": { dependencies: { adapter: "1" } }
  }), ["renderer", "runtime"])
})

it("resolves required peers in nested scopes and honors the fixture root's optional edges", () => {
  const library = { name: "library", peerDependencies: { runtime: "1", renderer: "1" },
    peerDependenciesMeta: { runtime: { optional: true }, renderer: { optional: true } } }
  const lock = {
    "": { dependencies: { library: "1", bridge: "1", orphan: "1" }, optionalDependencies: { orphan: "1" } },
    "node_modules/library": library,
    "node_modules/bridge": { dependencies: { "@scope/adapter": "1" } },
    "node_modules/bridge/node_modules/@scope/adapter": { peerDependencies: { runtime: "1" } },
    "node_modules/bridge/node_modules/runtime": {},
    "node_modules/@scope/adapter": { dependencies: { renderer: "1" } },
    "node_modules/orphan": { optional: true, peerDependencies: { renderer: "1" } }
  }
  assert.deepEqual(optionalPeersOf([library], lock), ["renderer"])
  delete lock["node_modules/bridge/node_modules/@scope/adapter"]
  assert.deepEqual(optionalPeersOf([library], lock), ["runtime"])
})


it("isolates each default library and the CLI on npm and pnpm, and refuses an Effect below the supported range", { timeout: 10 * 60_000 }, async () => {
  const results = await resolveConsumerProfiles()
  for (const manager of ["npm", "pnpm"]) {
    const profiles = results.filter((result) => result.manager === manager)
    assert.deepEqual(profiles.map((result) => result.profile), [
      "database-default", "gateway-default", "observability-default", "flows-default", "cli-default"
    ])
    for (const profile of profiles) {
      assert.equal(profile.effectCopies.length, 1)
      assert.ok(profile.resolutions.length > 0)
      if (manager === "pnpm") assert.equal(profile.managerVersion, "11.25.0", "consumer must use the release toolchain, including on Node 22")
    }
    assert.equal(results.filter((result) => result.unsupported?.manager === manager).length, 1)
  }
})

describe("check-npm-dedupe", () => {
  let tree

  before(() => {
    tree = resolveConsumerTree()
  }, { timeout: 10 * 60_000 })

  it("resolves every singleton to exactly one copy", () => {
    for (const name of SINGLETONS) {
      const copies = copiesOf(tree.lockPackages, name)
      const versions = [...new Set(copies.map((key) => tree.lockPackages[key]?.version))]
      assert.equal(copies.length, 1, `${name} resolves to ${copies.length} copies:\n  - ${copies.join("\n  - ")}`)
      assert.equal(versions.length, 1, `${name} resolves to ${versions.length} versions: ${versions.join(", ")}`)
    }
  })

  it("keeps peers optional across the selected release set out of the default install", () => {
    const present = tree.optionalPeers
      .map((name) => [name, copiesOf(tree.lockPackages, name)])
      .filter(([, copies]) => copies.length > 0)
    assert.deepEqual(
      present.map(([name]) => name),
      [],
      "an optional peer a release manifest still pulls in through a hard dependency is not optional for a consumer:\n"
        + present.map(([name, copies]) => `  ${name}\n    - ${copies.join("\n    - ")}`).join("\n"),
    )
  })

  it("derives the optional-peer set from the release manifests", () => {
    assert.ok(tree.packages.length > 0, "the release set is empty")
    assert.ok(
      tree.optionalPeers.length > 0,
      "no release manifest declares an optional peer, which would make the cell above vacuous",
    )
  })

  it("allows a workspace optional peer explicitly installed by the consumer fixture", () => {
    assert.equal(tree.optionalPeers.includes("@smthrs/platform-browser"), false)
    assert.equal(copiesOf(tree.lockPackages, "@smthrs/platform-browser").length, 1)
    // Private adapters are shipped inside their owner, without resolver edges.
    assert.equal(copiesOf(tree.lockPackages, "@effect/platform-bun").length, 0)
  })
})

it("unpinned CLI-only and CLI plus targets installs select the tested shared Effect runtime", { timeout: 10 * 60_000 }, async () => {
  const { version } = JSON.parse(await readFile(join(repoRoot, "packages/smithers/package.json"), "utf8"))
  const results = await resolveConsumerProfiles({
    managers: ["npm", "pnpm"],
    profiles: [
      { name: "cli-only-unpinned", dependencies: { "@smthrs/cli": version }, imports: ["@smthrs/cli"] },
      {
        name: "cli-targets-unpinned",
        dependencies: { "@smthrs/cli": version, "@smthrs/targets": version },
        imports: ["@smthrs/cli", "@smthrs/targets"]
      }
    ]
  })
  const profiles = results.filter(result => result.profile?.endsWith("-unpinned"))
  assert.equal(profiles.length, 4)
  for (const profile of profiles) {
    assert.equal(profile.effectCopies.length, 1)
    assert.ok(profile.effectFamily.every(entry => entry.version === EXPECTED_EFFECT_VERSION))
    assert.ok(profile.resolutions.some(result => result.name === "@smthrs/build-cli"))
    if (profile.profile === "cli-targets-unpinned") {
      assert.ok(profile.resolutions.some(result => result.name === "@smthrs/targets"))
    }
  }
})

// The main release smoke selects every optional peer. Test its real manifest
// intersection before building or cutting an immutable release tag.
it("the release all-adapter consumer shares the tested Effect runtime", { timeout: 10 * 60_000 }, async () => {
  const manifests = [...readWorkspaceManifests(repoRoot).values()]
  // The unscoped package is only a deprecation notice, not a runtime consumer.
  const dependencies = Object.fromEntries(manifests.filter(manifest => manifest.name.startsWith("@smthrs/"))
    .map(manifest => [manifest.name, manifest.version]))
  for (const [name, range] of peerRangesOf(manifests)) {
    if (!Object.hasOwn(dependencies, name)) dependencies[name] = range
  }
  const results = await resolveConsumerProfiles({
    managers: ["npm", "pnpm"],
    profiles: [{ name: "release-all-adapters", dependencies, imports: [] }]
  })
  const profiles = results.filter(result => result.profile === "release-all-adapters")
  assert.equal(profiles.length, 2)
  for (const profile of profiles) {
    assert.equal(profile.effectCopies.length, 1)
    for (const name of ["@effect/sql-pg", "@effect/sql-sqlite-node", "@effect/sql-sqlite-bun", "@effect/vitest"]) {
      assert.ok(profile.effectFamily.some(entry => entry.name === name && entry.version === EXPECTED_EFFECT_VERSION), name)
    }
  }
})
