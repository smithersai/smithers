import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import test from "node:test"
import { satisfies } from "semver"
import {
  EXPECTED_EFFECT_VERSION,
  SUPPORTED_EFFECT_RANGE,
  UNSUPPORTED_EFFECT_VERSION
} from "../../../packages/repo-targets/contracts/check-single-effect-version.mjs"
import {
  adapterProfiles,
  assertConsumerTree,
  candidateVersion,
  consumerCacheFlags,
  importedPackages,
  latestEffectVersion,
  migrationProfiles,
  minimalProfiles,
  onEffect,
  pathWithoutJj,
  pnpmIgnoredBuilds,
  readQuickstart,
  refuseUnsupportedEffect,
  runConsumerProfile,
  runQuickstartConsumer,
  specName,
} from "./release-consumers.mjs"
import { releaseRegistry } from "./release-registry.mjs"
import { repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"

/**
 * Makes `url` the default registry of both package managers and returns the
 * undo. pnpm 11 reads `pnpm_config_registry` and ignores npm's variable, so
 * setting npm's alone left every pnpm consumer here resolving `effect` from
 * the public registry, or from a warm store, instead of from the fixture.
 */
const useRegistry = (url) => {
  const names = ["npm_config_registry", "pnpm_config_registry"]
  const previous = names.map((name) => process.env[name])
  for (const name of names) process.env[name] = url
  return () =>
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
}

test("external pnpm consumers retain the workspace's configured store and report cache reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-release-store-"))
  const consumer = mkdtempSync(join(tmpdir(), "smithers-release-store-consumer-"))
  try {
    const store = join(root, "shared-store")
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }))
    writeFileSync(join(root, "pnpm-workspace.yaml"), `storeDir: ${JSON.stringify(store)}\n`)
    const actualStore = execFileSync("pnpm", ["store", "path"], { cwd: root, encoding: "utf8" }).trim()
    assert.equal(dirname(actualStore), store, "the real manager reads the workspace store override")
    assert.deepEqual(consumerCacheFlags("pnpm", root), [
      "--prefer-offline",
      "--store-dir",
      actualStore,
      "--reporter=append-only"
    ])
    // `store path` accepts the store selection, not install-only cache flags.
    const storeFlags = consumerCacheFlags("pnpm", root).filter((flag) =>
      flag !== "--prefer-offline" && flag !== "--reporter=append-only"
    )
    const selectedStore = execFileSync("pnpm", [...storeFlags, "store", "path"], {
      cwd: consumer,
      encoding: "utf8"
    }).trim()
    assert.equal(
      selectedStore,
      actualStore,
      "an external project uses the populated store, including its version suffix"
    )
    assert.deepEqual(consumerCacheFlags("npm", root), ["--prefer-offline"])
    // An install that follows a tag reads today's metadata and keeps the store.
    assert.deepEqual(consumerCacheFlags("npm", root, { offline: false }), [])
    assert.deepEqual(consumerCacheFlags("pnpm", root, { offline: false }), [
      "--store-dir",
      actualStore,
      "--reporter=append-only"
    ])
    assert.throws(() => consumerCacheFlags("unknown", root), /Unsupported release package manager/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(consumer, { recursive: true, force: true })
  }
})

test("every library, adapter and migration profile selects the supplied candidate version", () => {
  for (const version of ["1.0.0", "1.1.0-rc.7"]) {
    const entries = [{ name: "@smthrs/database", version }]
    const profiles = [...minimalProfiles(entries), ...adapterProfiles(entries), ...migrationProfiles(entries)]
    assert.equal(profiles.length, 10)
    for (const profile of profiles) {
      const firstParty = Object.entries(profile.dependencies).filter(([name]) => name.startsWith("@smthrs/"))
      assert.ok(firstParty.length > 0, profile.name)
      for (const [name, range] of firstParty) assert.equal(range, version, `${profile.name}: ${name}`)
      assert.equal(profile.dependencies.effect, EXPECTED_EFFECT_VERSION)
      if (profile.dependencies["@effect/platform-node"] !== undefined) {
        assert.equal(
          profile.dependencies["@effect/platform-node-shared"],
          EXPECTED_EFFECT_VERSION,
          `${profile.name}: the selected Node adapter and its shared package use the same Effect release`
        )
      }
    }
  }
})

test("the refused Effect is outside the supported range and the tested release is inside it", () => {
  assert.equal(satisfies(UNSUPPORTED_EFFECT_VERSION, SUPPORTED_EFFECT_RANGE), false)
  assert.equal(satisfies(EXPECTED_EFFECT_VERSION, SUPPORTED_EFFECT_RANGE), true)
})

test("profiles selecting the native Node host require its relocated runtime and SQLite driver", () => {
  const entries = [{ version: "1.0.0" }]
  const profiles = [...adapterProfiles(entries), ...migrationProfiles(entries)]
  for (const name of ["bun", "migrate-apply"]) {
    const profile = profiles.find((profile) => profile.name === name)
    for (const dependency of ["@smthrs/flows", "@effect/sql-sqlite-node"]) {
      assert.ok(profile.required.includes(dependency), name + ": " + dependency)
      assert.ok(!profile.absent.includes(dependency), name + ": " + dependency)
    }
  }
  // Scanning still installs no agent or native runtime.
  const scan = profiles.find((profile) => profile.name === "migrate-scan")
  assert.ok(scan.absent.includes("@smthrs/flows"))
  assert.ok(scan.absent.includes("@effect/sql-sqlite-node"))
})

test("a profile moved onto another Effect moves the application's Effect packages and nothing else", () => {
  const [node] = adapterProfiles([{ version: "1.0.0" }]).filter((profile) => profile.name === "node")
  const moved = onEffect(node, "4.9.0", "latest")
  assert.equal(moved.name, "node-effect-latest")
  // The copied adapter probe still runs the Node program.
  assert.equal(moved.probe, "node")
  assert.equal(onEffect(moved, "4.9.1").probe, "node")
  assert.equal(moved.effect, "4.9.0")
  for (const [name, spec] of Object.entries(moved.dependencies)) {
    const family = name === "effect" || name.startsWith("@effect/")
    assert.equal(spec, family ? "4.9.0" : node.dependencies[name], name)
  }
  assert.deepEqual(
    Object.keys(moved.dependencies).filter((name) => moved.dependencies[name] === "4.9.0").sort(),
    ["@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node", "effect"]
  )
  assert.deepEqual([moved.absent, moved.imports], [node.absent, node.imports])
  // The pinned profile is untouched: it keeps installing the tested release.
  assert.equal(node.effect, undefined)
  assert.equal(node.dependencies.effect, EXPECTED_EFFECT_VERSION)
})

test("a registry spec names its package with or without a scope, a version, a range or a tag", () => {
  for (
    const [spec, name] of [
      ["effect", "effect"],
      ["effect@4.0.5", "effect"],
      ["effect@^4.0.5", "effect"],
      ["effect@latest", "effect"],
      ["@smthrs/flows", "@smthrs/flows"],
      ["@smthrs/flows@next", "@smthrs/flows"],
      ["@smthrs/flows@1.0.0-rc.5", "@smthrs/flows"],
      ["@effect/sql-sqlite-bun", "@effect/sql-sqlite-bun"],
      ["@effect/sql-sqlite-bun@>=4.0.5 <5", "@effect/sql-sqlite-bun"]
    ]
  ) assert.equal(specName(spec), name, spec)
})

// Release logic that reads the Effect release or its supported range imports
// them from check-single-effect-version.mjs. A second literal is the drift that
// gate exists to stop: a bump there left these files asserting the old RC until
// a release rehearsal failed.
test("the release consumer matrix and the package contract declare no Effect version of their own", () => {
  // The files name other packages' versions, so only Effect's are refused: any
  // release candidate, and the tested release with or without a range operator.
  const tested = EXPECTED_EFFECT_VERSION.replaceAll(".", "\\.")
  const restated = new RegExp(`\\d+\\.\\d+\\.\\d+-rc\\.\\d+|(?<![\\d.])${tested}(?![\\d.])`, "g")
  assert.deepEqual("0.4.0.54 14.0.5 4.0.50".match(restated), null, "a longer version is another package's")
  assert.deepEqual(`effect@${EXPECTED_EFFECT_VERSION} ${SUPPORTED_EFFECT_RANGE} ${UNSUPPORTED_EFFECT_VERSION}`.match(restated), [
    EXPECTED_EFFECT_VERSION,
    EXPECTED_EFFECT_VERSION,
    UNSUPPORTED_EFFECT_VERSION
  ])
  for (
    const file of [
      "release-consumers.mjs",
      "check-npm-dedupe.mjs",
      "smoke-release.mjs",
      "../../../packages/repo-targets/contracts/package-contract.test.mjs"
    ]
  ) {
    const literals = readFileSync(join(import.meta.dirname, file), "utf8").match(restated) ?? []
    assert.deepEqual(literals, [], `${file} hand-restates an Effect version: ${literals.join(", ")}`)
  }
})

// .smithers/flows/release/fixtures/ holds files a consumer copies: probes and the installed
// consumer. Lint ignores the directory and the boundary gate reads it as a
// consumer, so release logic that lived there ran unlinted and unchecked.
test("no release script imports a module from .smithers/flows/release/fixtures", () => {
  const importers = []
  for (const directory of [".", "../../../packages/repo-targets/contracts"]) {
    for (const entry of readdirSync(join(import.meta.dirname, directory))) {
      if (!entry.endsWith(".mjs")) continue
      const source = readFileSync(join(import.meta.dirname, directory, entry), "utf8")
      if (/from\s+["'](?:\.\.?\/)+fixtures\/[^/"']+\.mjs["']/.test(source)) importers.push(join(directory, entry))
    }
  }
  assert.deepEqual(importers, [], "move the module beside its importers under .smithers/flows/release/")
})

test("every release script imports only names its sibling modules export", () => {
  // smoke-release.mjs runs its work at module scope, so no suite imports it,
  // and nothing linked it until a release run did. #3385 removed
  // `templateProfile` from release-consumers.mjs with the create-app template
  // and left the import behind: dry run 37843714479 built and packed 49
  // tarballs and then died on a SyntaxError before the first smoke command.
  // This reads each script's named imports from a sibling module and checks
  // them against that module's own export statements, without running either.
  const scripts = import.meta.dirname
  const exported = (file) => {
    const source = readFileSync(file, "utf8")
    const names = new Set([...source.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]))
    for (const list of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of list[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()
        if (name) names.add(name)
      }
    }
    return { names, reexportsAll: /^export\s*\*\s*from\b/m.test(source) }
  }
  const broken = []
  let checked = 0
  for (const entry of readdirSync(scripts)) {
    if (!entry.endsWith(".mjs")) continue
    const source = readFileSync(join(scripts, entry), "utf8")
    // Siblings, and the workspace reader the release modules import from scripts/.
    for (const statement of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']((?:\.\/|\.\.\/\.\.\/scripts\/)[^"'\/]+\.mjs)["']/gm)) {
      const target = exported(join(scripts, statement[2]))
      if (target.reexportsAll) continue
      for (const part of statement[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (name === "") continue
        checked += 1
        if (!target.names.has(name)) broken.push(`${entry}: ${name} from ${statement[2]}`)
      }
    }
  }
  assert.ok(checked > 150, `${checked} sibling imports is too few to be the release modules`)
  assert.deepEqual(broken, [])
  assert.match(readFileSync(join(scripts, "smoke-release.mjs"), "utf8"), /from "\.\/release-consumers\.mjs"/)
})

test("candidate selection rejects empty, mixed and non-exact versions", () => {
  for (
    const entries of [[], [{ version: "1.0.0" }, { version: "1.0.0-rc.0" }], [{ version: "^1.0.0" }], [{
      version: "v1.0.0"
    }], [{}]]
  ) {
    assert.throws(() => candidateVersion(entries), /candidate/)
  }
})

test("consumer requests resolve against a stable-only candidate registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-consumer-version-"))
  let registry
  let restoreRegistry = () => {}
  try {
    const version = "1.0.0"
    const entries = []
    for (const name of ["database"]) {
      const directory = join(root, name)
      mkdirSync(join(directory, "package"), { recursive: true })
      writeFileSync(
        join(directory, "package/package.json"),
        JSON.stringify({
          name: "@smthrs/" + name,
          version,
          type: "module",
          main: "index.js",
          peerDependencies: { effect: SUPPORTED_EFFECT_RANGE }
        })
      )
      writeFileSync(join(directory, "package/index.js"), "export const installed = true\n")
      const filename = name + ".tgz"
      execFileSync("tar", ["-czf", join(root, filename), "-C", directory, "package"])
      entries.push({ name: "@smthrs/" + name, version, filename })
    }
    mkdirSync(join(root, "effect/package"), { recursive: true })
    writeFileSync(
      join(root, "effect/package/package.json"),
      JSON.stringify({
        name: "effect",
        version: EXPECTED_EFFECT_VERSION,
        type: "module",
        exports: { "./package.json": "./package.json", "./*": "./*.js" }
      })
    )
    // Minimal local modules let the real copied adapter probe check identity
    // and the installed-consumer boundary without downloading Effect.
    for (const module of ["Effect", "Layer", "Schema"]) {
      writeFileSync(
        join(root, "effect/package", module + ".js"),
        module === "Schema"
          ? "export const String = {}; export const decodeUnknownSync = () => {}\n"
          : "export {}\n"
      )
    }
    execFileSync("tar", ["-czf", join(root, "effect.tgz"), "-C", join(root, "effect"), "package"])
    registry = await releaseRegistry(root, [...entries, {
      name: "effect",
      version: EXPECTED_EFFECT_VERSION,
      filename: "effect.tgz"
    }])
    // All package bytes, including the minimal Effect identity fixture, come
    // from loopback. No existing publication or external install is needed.
    restoreRegistry = useRegistry(registry.url)
    const profiles = [minimalProfiles(entries)[0]]
    for (const profile of profiles) {
      for (const [name, requested] of Object.entries(profile.dependencies)) {
        if (!name.startsWith("@smthrs/")) continue
        const response = await fetch(`${registry.url}/${encodeURIComponent(name)}`)
        assert.equal(response.status, 200)
        const metadata = await response.json()
        assert.deepEqual(Object.keys(metadata.versions), [version])
        assert.ok(metadata.versions[requested], `${profile.name} requested unavailable ${name}@${requested}`)
      }
    }
    for (const manager of ["npm", "pnpm"]) {
      const installed = await runConsumerProfile(profiles[0], manager, registry.url, { runtime: true })
      assert.equal(installed.effectCopies.length, 1)
    }
  } finally {
    restoreRegistry()
    await registry?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("consumer tree refuses an off-pin Effect-family dependency even with one correct Effect copy", () => {
  const consumer = mkdtempSync(join(tmpdir(), "smithers-consumer-family-"))
  try {
    const install = (name, version) => {
      const directory = join(consumer, "node_modules", name)
      mkdirSync(directory, { recursive: true })
      // An adapter on the Effect release line peers `effect` from its own version up.
      const peer = name === "effect" ? {} : { peerDependencies: { effect: "^" + version } }
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version, ...peer }))
    }
    const [earlier, later] = ["4.0.3", "4.1.0"]
    install("effect", EXPECTED_EFFECT_VERSION)
    const profile = { name: "off-pin-family", dependencies: { effect: EXPECTED_EFFECT_VERSION } }
    // An adapter that needs a later Effect than the installed one: #2398.
    install("@effect/platform-node-shared", later)
    assert.throws(() => assertConsumerTree(consumer, profile), /do not accept effect@/)
    // An earlier adapter accepts this Effect, and a pinned profile still
    // holds the whole family to the tested release.
    install("@effect/platform-node-shared", earlier)
    assert.throws(() => assertConsumerTree(consumer, profile), /Effect-family packages off/)
    install("@effect/platform-node-shared", EXPECTED_EFFECT_VERSION)
    const actual = assertConsumerTree(consumer, profile)
    assert.equal(actual.effectCopies.length, 1)
    assert.equal(actual.effectFamily.length, 2)
    // A profile moved onto a later Effect keeps the adapter built for the
    // tested release, and fails when the tree holds some other Effect.
    assert.throws(() => assertConsumerTree(consumer, onEffect(profile, later)), /installed another Effect release/)
    install("effect", later)
    assert.throws(() => assertConsumerTree(consumer, onEffect(profile, later)), /is outside the supported range/)
    assert.throws(() => assertConsumerTree(consumer, profile), /is outside the supported range/)
    // An Effect below the range is refused whatever the profile asked for.
    install("effect", UNSUPPORTED_EFFECT_VERSION)
    for (const asked of [profile, onEffect(profile, UNSUPPORTED_EFFECT_VERSION)]) {
      assert.throws(() => assertConsumerTree(consumer, asked), /is outside the supported range/)
    }
    install("effect", EXPECTED_EFFECT_VERSION)
    const nested = join(consumer, "node_modules/nested/node_modules/effect")
    mkdirSync(nested, { recursive: true })
    writeFileSync(
      join(consumer, "node_modules/nested/package.json"),
      JSON.stringify({ name: "nested", version: "1.0.0" })
    )
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "effect", version: EXPECTED_EFFECT_VERSION }))
    assert.throws(() => assertConsumerTree(consumer, profile), /exactly one physical Effect copy/)
  } finally {
    rmSync(consumer, { recursive: true, force: true })
  }
})

/** Packs fixture packages into `directory` and returns their release-manifest entries. */
const packFixtures = (directory, manifests) =>
  manifests.map((manifest) => {
    const name = manifest.name.replace("/", "-")
    mkdirSync(join(directory, name, "package"), { recursive: true })
    writeFileSync(join(directory, name, "package/package.json"), JSON.stringify({ type: "module", main: "index.js", ...manifest }))
    writeFileSync(join(directory, name, "package/index.js"), "export const installed = true\n")
    execFileSync("tar", ["-czf", join(directory, name + ".tgz"), "-C", join(directory, name), "package"])
    return { name: manifest.name, version: manifest.version, filename: name + ".tgz" }
  })

/** Serves each roster from a loopback registry that is also the default registry while `body` runs. */
const withRegistries = async (prefix, rosters, body) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  let restoreRegistry = () => {}
  const registries = []
  try {
    for (const [name, manifests] of Object.entries(rosters)) {
      const directory = join(root, name)
      const entries = packFixtures(directory, manifests)
      const registry = await releaseRegistry(directory, entries)
      registries.push(registry)
      restoreRegistry()
      restoreRegistry = useRegistry(registry.url)
      await body(name, registry, entries.filter((entry) => entry.name.startsWith("@smthrs/")))
    }
  } finally {
    restoreRegistry()
    for (const registry of registries) await registry.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test("each manager refuses an Effect below the supported range, and the gate fails when a library admits it", { timeout: 5 * 60_000 }, async () => {
  const version = "1.0.0"
  // Each registry holds the refused release alone, so no other Effect can be installed in its place.
  const roster = (peer) => [
    { name: "@smthrs/database", version, peerDependencies: { effect: peer } },
    { name: "effect", version: UNSUPPORTED_EFFECT_VERSION }
  ]
  await withRegistries("smithers-unsupported-effect-", {
    ranged: roster(SUPPORTED_EFFECT_RANGE),
    // What an over-wide peer would publish: the old release candidate installs cleanly.
    admitting: roster(">=" + UNSUPPORTED_EFFECT_VERSION)
  }, async (name, registry, entries) => {
    for (const manager of ["npm", "pnpm"]) {
      const run = refuseUnsupportedEffect(manager, registry.url, entries)
      if (name === "ranged") {
        const refusal = await run
        assert.notEqual(refusal.exit, 0, manager)
        assert.deepEqual(
          { ...refusal, exit: undefined },
          { manager, exit: undefined, effect: UNSUPPORTED_EFFECT_VERSION, range: SUPPORTED_EFFECT_RANGE }
        )
      } else {
        await assert.rejects(run, /must be refused/, manager + " installed an Effect the range excludes")
      }
    }
  })
})

test("a profile runs on the Effect the registry tags latest, beside the adapter a library pins", { timeout: 5 * 60_000 }, async () => {
  const version = "1.0.0"
  // The registry currently serves the exact supported cohort.
  const later = EXPECTED_EFFECT_VERSION
  assert.equal(satisfies("4.9.0", SUPPORTED_EFFECT_RANGE), false)
  assert.equal(satisfies(later, SUPPORTED_EFFECT_RANGE), true)
  await withRegistries("smithers-effect-latest-", {
    later: [
      // The published shape: a ranged peer, and a driver at the tested release exactly.
      {
        name: "@smthrs/database",
        version,
        dependencies: { "@effect/sql-sqlite-node": EXPECTED_EFFECT_VERSION },
        peerDependencies: { effect: SUPPORTED_EFFECT_RANGE }
      },
      { name: "@effect/sql-sqlite-node", version: EXPECTED_EFFECT_VERSION, peerDependencies: { effect: "^" + EXPECTED_EFFECT_VERSION } },
      { name: "effect", version: later }
    ]
  }, async (_name, registry, entries) => {
    assert.equal(await latestEffectVersion(), later, "read from the registry, not from this repository's pin")
    const pinned = {
      name: "application",
      dependencies: { "@smthrs/database": candidateVersion(entries), effect: EXPECTED_EFFECT_VERSION },
      imports: ["@smthrs/database"]
    }
    const profile = onEffect(pinned, await latestEffectVersion(), "latest")
    for (const manager of ["npm", "pnpm"]) {
      const installed = await runConsumerProfile(profile, manager, registry.url)
      assert.equal(installed.profile, "application-effect-latest")
      assert.equal(installed.effectCopies.length, 1, manager)
      assert.deepEqual(
        installed.effectFamily.map((entry) => entry.name + "@" + entry.version),
        ["@effect/sql-sqlite-node@" + EXPECTED_EFFECT_VERSION, "effect@" + later],
        manager + " keeps the driver the library pins beside the application's later Effect"
      )
    }
  })
})

// #3838: rc.4's quickstart needed five packages its install line never named.
const flowsPages = () => {
  const directory = join(repoRoot, "packages/smithers/flows")
  return ["README.md", ...readdirSync(join(directory, "docs"), { recursive: true }).map((entry) => join("docs", String(entry)))]
    .filter((page) => page.endsWith(".md"))
    .map((page) => [page, readFileSync(join(directory, page), "utf8")])
}

test("the published rc.16 quickstart installs its pinned runtime and every package it imports", () => {
  const quickstart = readQuickstart()
  // 96628360 pins the guide to the published API, whose NodeRuntime is under
  // @smthrs/flows. The checkout's relocated host API is a different contract.
  const packages = ["@smthrs/platform-node@1.0.0-rc.16", "@smthrs/flows@1.0.0-rc.16", "effect@4.0.5"]
  assert.deepEqual(quickstart.packages, packages)
  assert.deepEqual(quickstart.pnpmPackages, packages)
  assert.deepEqual(importedPackages(quickstart.program), ["@smthrs/flows", "effect"])
  assert.ok(quickstart.program.includes('from "@smthrs/flows/NodeRuntime"'))
  assert.deepEqual(quickstart.run, ["node", "quickstart.ts"])
  assert.equal(quickstart.printed, "the note")
  // pnpm 11 ends `pnpm add` with ERR_PNPM_IGNORED_BUILDS for esbuild's install script.
  assert.deepEqual(quickstart.approveBuilds, ["esbuild"])
  const pages = new Map(flowsPages())
  for (const page of ["README.md", "docs/README.md", "docs/installation.md"]) {
    assert.ok(pages.get(page).split("\n").includes("npm install @smthrs/platform-node@next @smthrs/flows@next effect"),
      page + " must install the current runtime and its dependencies")
  }
})

test("pnpm's ignored build scripts reduce to package names, without versions", () => {
  const output = [
    "+ @smthrs/flows 1.0.0-rc.6",
    "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.2, @scope/native@1.2.3-rc.1.",
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.'
  ].join("\n")
  assert.deepEqual(pnpmIgnoredBuilds(output), ["@scope/native", "esbuild"])
  assert.deepEqual(pnpmIgnoredBuilds("+ effect 4.0.5\nDone in 1s"), [])
})

test("program imports reduce to package names, without relative and node: specifiers", () => {
  const program = [
    'import { Action } from "@smthrs/flows"',
    'import { NodeRuntime } from "@smthrs/platform-node"',
    'import * as Effect from "effect/Effect"',
    'import { resolve } from "node:path"',
    'import { local } from "./local.ts"',
    'import type * as Schema from "effect/Schema"'
  ].join("\n")
  assert.deepEqual(importedPackages(program), ["@smthrs/flows", "@smthrs/platform-node", "effect"])
  assert.deepEqual(importedPackages("console.log(1)"), [])
})

test("the quickstart runs with every PATH entry that holds an executable jj removed", () => {
  const root = mkdtempSync(join(tmpdir(), "release-path-without-jj-"))
  try {
    const [withJj, plain, inert, named] = ["with-jj", "plain", "inert", "named"].map((name) => join(root, name))
    for (const directory of [withJj, plain, inert, join(named, "jj")]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(withJj, "jj"), "#!/bin/sh\n", { mode: 0o755 })
    writeFileSync(join(inert, "jj"), "not a program\n", { mode: 0o644 })
    assert.equal(pathWithoutJj([withJj, plain, "", inert, named, withJj].join(delimiter)), [plain, inert, named].join(delimiter))
    assert.equal(pathWithoutJj(undefined), "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("every Flows page states the manifest's Node floor and none says the package is off npm", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "packages/smithers/flows/package.json"), "utf8"))
  const [, floor] = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines.node)
  let stated = 0
  for (const [page, text] of flowsPages()) {
    assert.doesNotMatch(text, /not (?:yet )?(?:on|published to) npm/i, page)
    // "Node.js 26.4.0 or later", "Node.js 26.4+", and "`engines` requires Node `>=26.4.0`".
    for (const [, version] of text.matchAll(/Node(?:\.js)? `?>?=?(\d+\.\d+(?:\.\d+)?)/g)) {
      assert.ok(version === floor || version + ".0" === floor, page + " states another Node floor: " + version)
      stated += 1
    }
  }
  assert.ok(stated >= 5, "the pages that state a floor were not read")
})

test("the quickstart consumer passes only when the install line brings what the program imports", { timeout: 5 * 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-quickstart-gate-"))
  let restoreRegistry = () => {}
  const registries = []
  try {
    const version = "1.0.0"
    const pack = (directory, name, manifest, files) => {
      mkdirSync(join(directory, name, "package"), { recursive: true })
      writeFileSync(join(directory, name, "package/package.json"), JSON.stringify(manifest))
      for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, name, "package", file), source)
      execFileSync("tar", ["-czf", join(directory, name + ".tgz"), "-C", join(directory, name), "package"])
      return { name: manifest.name, version: manifest.version, filename: name + ".tgz" }
    }
    // A fixture engine: the host journals the first read, as the real one does.
    const candidate = (name, flowsEdges, latestEffect = EXPECTED_EFFECT_VERSION) => {
      const directory = join(root, name)
      return [
        pack(directory, "flows", {
          name: "@smthrs/flows", version, type: "module",
          exports: { "./NodeRuntime": "./NodeRuntime.js" },
          ...flowsEdges
        }, { "NodeRuntime.js": 'export { read } from "@smthrs/platform-node"\n' }),
        pack(directory, "platform-node", { name: "@smthrs/platform-node", version, type: "module", main: "index.js" }, {
          "index.js": [
            'import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"',
            'export const read = (path) => {',
            '  // The gate runs the quickstart where no jj is reachable (#3894).',
            '  if (process.env.SMITHERS_JJ_PATH !== undefined) throw new Error("SMITHERS_JJ_PATH is set")',
            '  for (const entry of (process.env.PATH ?? "").split(":")) {',
            '    if (entry !== "" && existsSync(entry + "/jj") && statSync(entry + "/jj").isFile()) {',
            '      throw new Error("jj is on the quickstart PATH: " + entry)',
            '    }',
            '  }',
            '  if (!existsSync(".journal")) writeFileSync(".journal", readFileSync(path))',
            '  return readFileSync(".journal", "utf8")',
            '}',
            ''
          ].join("\n")
        }),
        pack(directory, "effect", {
          name: "effect", version: latestEffect, type: "module",
          exports: { "./package.json": "./package.json", "./*": "./*.js" }
        }, { "Effect.js": "export const succeed = (value) => value\n" }),
        // Packages with an install script, which pnpm 11 holds back until approved.
        ...["esbuild", "native-thing"].map((script) =>
          pack(directory, script, {
            name: script, version: "1.0.0",
            scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('built', '')\"" }
          }, {})
        )
      ].map((entry) => ({ ...entry, directory }))
    }
    // The page's own shape: `effect` with no version is whatever the registry tags latest.
    const install = "npm install @smthrs/flows@next effect"
    const quickstart = {
      commands: ["npm init -y && npm pkg set type=module", install, 'mkdir -p workspace && echo "the note" > workspace/note.txt'],
      install,
      packages: install.split(" ").slice(2),
      pnpmPackages: ["@smthrs/flows@" + version, "effect"],
      program: [
        'import { read } from "@smthrs/flows/NodeRuntime"',
        'import * as Effect from "effect/Effect"',
        // The fixture Effect is this one function.
        'if (typeof Effect.succeed !== "function") throw new Error("effect did not resolve")',
        'console.log(read("workspace/note.txt"))',
        ''
      ].join("\n"),
      run: ["node", "quickstart.ts"],
      printed: "the note",
      approveBuilds: ["esbuild"]
    }
    const peer = { effect: SUPPORTED_EFFECT_RANGE }
    const cases = [
      ["declared", { dependencies: { "@smthrs/platform-node": version, esbuild: "1.0.0" }, peerDependencies: peer }, undefined],
      // npm installs with --ignore-scripts; pnpm stops on a build script the page does not approve.
      ["unapproved build script", {
        dependencies: { "@smthrs/platform-node": version, esbuild: "1.0.0", "native-thing": "1.0.0" },
        peerDependencies: peer
      }, { pnpm: /pnpm held back build scripts the page does not approve/ }],
      // rc.4's shape: the import resolves only if the program installs the peer.
      ["optional peer", {
        peerDependencies: { ...peer, "@smthrs/platform-node": version },
        peerDependenciesMeta: { "@smthrs/platform-node": { optional: true } }
      }, /Cannot find package '@smthrs\/platform-node'/],
      // The line installs whatever the registry tags latest. An Effect the
      // range does not admit stops npm at install; pnpm installs it with a
      // warning, so the gate reads the tree.
      ["latest below the range", { dependencies: { "@smthrs/platform-node": version }, peerDependencies: peer },
        /ERESOLVE|installed effect@\S+ is outside the supported range/, UNSUPPORTED_EFFECT_VERSION]
    ]
    for (const [name, edges, refusal, latestEffect] of cases) {
      const entries = candidate(name.replaceAll(" ", "-"), edges, latestEffect)
      const registry = await releaseRegistry(entries[0].directory, entries)
      registries.push(registry)
      restoreRegistry()
      restoreRegistry = useRegistry(registry.url)
      for (const manager of ["npm", "pnpm"]) {
        const run = runQuickstartConsumer(manager, registry.url, { quickstart })
        const expected = refusal instanceof RegExp ? refusal : refusal?.[manager]
        if (expected === undefined) {
          const result = await run
          assert.deepEqual(result.declared, ["@smthrs/flows", "effect"], manager + " " + name)
          assert.equal(result.effect, EXPECTED_EFFECT_VERSION, manager + " " + name + " installs the registry's latest Effect")
          // The matrix passes what npm calls latest. npm must install exactly
          // it; pnpm may hold a young release back, so it is held to the range.
          const held = runQuickstartConsumer(manager, registry.url, { quickstart, latestEffect: "4.9.9" })
          if (manager === "npm") await assert.rejects(held, /npm quickstart installed effect@\S+, not latest 4\.9\.9/)
          else assert.equal((await held).effect, EXPECTED_EFFECT_VERSION)
          assert.deepEqual(result.runs, ["the note", "the note"], manager + " " + name)
          assert.equal(result.install.startsWith(manager === "npm" ? "npm install " : "pnpm add "), true)
        } else {
          await assert.rejects(run, expected, manager + " " + name + " must fail on the first run")
        }
      }
    }
  } finally {
    restoreRegistry()
    for (const registry of registries) await registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})
