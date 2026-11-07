import assert from "node:assert/strict"
import test from "node:test"

import { readWorkspaceManifests } from "../../../.smithers/flows/release/pack-release.mjs"
import { repoRoot } from "../scripts/workspace-packages.mjs"
import {
  assertEffectPins,
  assertNodeSharedPins,
  effectDeclarations,
  effectLockVersions,
  EXPECTED_EFFECT_VERSION,
  expectedEffectDeclaration,
  nodeSharedPinProblems,
  optionalAdapterPeerProblems,
  SUPPORTED_EFFECT_RANGE,
  UNSUPPORTED_EFFECT_VERSION
} from "./check-single-effect-version.mjs"

const pin = EXPECTED_EFFECT_VERSION
const range = "^" + pin
const manifests = (entries) =>
  new Map(entries.map((manifest, index) => [`packages/fixture-${index}`, { name: `@fixture/${index}`, ...manifest }]))

test("the supported version is exactly the tested release", () => {
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the tested release is one exact stable version")
  // An adapter a library installs at the tested release peers `effect` from
  // that release up, so a lower floor would promise an install that fails.
  assert.equal(SUPPORTED_EFFECT_RANGE, pin)
  assert.match(UNSUPPORTED_EFFECT_VERSION, /^4\.0\.0-rc\.\d+$/)
  assert.notEqual(UNSUPPORTED_EFFECT_VERSION, pin)
})

test("published libraries and executables require the tested release", () => {
  const library = { peerDependencies: { effect: range } }
  const executable = { dependencies: { effect: pin } }
  assert.equal(expectedEffectDeclaration(library, "peerDependencies"), pin)
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    assert.equal(expectedEffectDeclaration(library, section), pin, section)
    assert.equal(expectedEffectDeclaration(executable, section), pin, section)
  }
  // An executable installs its own `effect`, so the adapters it asks its
  // installer for have to be the ones built for that release.
  assert.equal(expectedEffectDeclaration(executable, "peerDependencies"), pin)
  // Executables' private adapters are built on the tested release. Their
  // peer must select it even when npm publishes a newer Effect.
  assert.equal(expectedEffectDeclaration({ ...library, bin: { cli: "bin.js" } }, "peerDependencies"), pin)
  assert.throws(
    () => assertEffectPins(effectDeclarations({ ...library, bin: { cli: "bin.js" } }, "fixture")),
    /effect@.* must be 4\.1\.1/
  )
  // A private package is never installed by an application.
  assert.equal(expectedEffectDeclaration({ ...library, private: true }, "peerDependencies"), pin)
})

test("the checker requires exact published library peers and refuses ranges", () => {
  for (const name of ["effect", "@effect/sql-pg", "@effect/vitest", "@effect/new-adapter"]) {
    const peers = (version) => ({ peerDependencies: { effect: pin, [name]: version } })
    assert.doesNotThrow(() => assertEffectPins(effectDeclarations(peers(pin), "fixture")), name)
    for (
      const version of [
        range,
        "~" + pin,
        ">=" + pin,
        "^4.0.0",
        "*",
        UNSUPPORTED_EFFECT_VERSION,
        "^" + UNSUPPORTED_EFFECT_VERSION
      ]
    ) {
      const records = effectDeclarations(peers(version), "fixture").filter((record) => record.name === name)
      assert.equal(records.length, 1, `${name}@${version} is read`)
      assert.throws(
        () => assertEffectPins(records),
        new RegExp(`fixture \\(peerDependencies\\): ${name.replace("/", "\\/")}@.* must be ${pin}`),
        `${name}@${version}`
      )
    }
  }
})

test("the checker requires the tested release everywhere else and refuses a range there", () => {
  const owners = [{ peerDependencies: { effect: pin } }, { dependencies: { effect: pin } }, { private: true }]
  for (const owner of owners) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (
        const name of [
          "effect",
          "@effect/platform-node",
          "@effect/sql-sqlite-node",
          "@effect/sql-pg",
          "@effect/new-adapter"
        ]
      ) {
        const manifest = (version) => ({ ...owner, [section]: { ...owner[section], [name]: version } })
        assert.doesNotThrow(() => assertEffectPins(effectDeclarations(manifest(pin), "fixture")), `${section} ${name}`)
        for (const version of [range, "~" + pin, "4.0.3", "4.0.4", UNSUPPORTED_EFFECT_VERSION, "latest"]) {
          const records = effectDeclarations(manifest(version), "fixture")
            .filter((record) => record.name === name && record.source.includes(section))
          assert.equal(records.length, 1, `${section} ${name}@${version} is read`)
          assert.throws(() => assertEffectPins(records), /must be \d+\.\d+\.\d+\n?$/m, `${section} ${name}@${version}`)
        }
      }
    }
  }
  // An executable's and a private package's peers are exact too.
  for (const owner of [{ dependencies: { effect: pin } }, { private: true, dependencies: { effect: pin } }]) {
    const manifest = (version) => ({ ...owner, peerDependencies: { "@effect/sql-sqlite-node": version } })
    assert.doesNotThrow(() => assertEffectPins(effectDeclarations(manifest(pin), "fixture")))
    assert.throws(() => assertEffectPins(effectDeclarations(manifest(range), "fixture")), /must be \d+\.\d+\.\d+$/m)
  }
})

test("every Effect package is in the family on a stable version, and tooling off the release line is not", () => {
  // The family used to be seven names plus anything carrying `-rc.`, so a
  // stable `@effect/sql-pg` at the wrong version passed unread.
  const adapters = [
    "@effect/sql-pg",
    "@effect/sql-d1",
    "@effect/sql-sqlite-bun",
    "@effect/sql-sqlite-do",
    "@effect/future"
  ]
  const manifest = { devDependencies: Object.fromEntries(adapters.map((name) => [name, "4.0.3"])) }
  assert.deepEqual(effectDeclarations(manifest, "fixture").map((record) => record.name), adapters)
  assert.throws(() => assertEffectPins(effectDeclarations(manifest, "fixture")), /@effect\/sql-pg@4\.0\.3 must be/)
  const lock = adapters.map((name) => `  '${name}@4.0.3':\n`).join("")
  assert.deepEqual(effectLockVersions("packages:\n" + lock, "pnpm").map((record) => record.name), adapters)
  assert.throws(
    () => assertEffectPins(effectLockVersions("packages:\n" + lock, "pnpm")),
    /pnpm-lock\.yaml: @effect\/sql-d1@4\.0\.3/
  )
  // The TypeScript plugin has its own version line.
  assert.deepEqual(effectDeclarations({ devDependencies: { "@effect/language-service": "0.87.2" } }, "fixture"), [])
  assert.deepEqual(effectLockVersions("packages:\n  '@effect/language-service@0.87.2':\n", "pnpm"), [])
})

// npm, pnpm and Bun each resolved @effect/platform-node-shared@4.0.0-rc.118
// under a package shaped like the rejected fixtures (#2398).
test("rejects a platform dependency without an exact node-shared dependency", () => {
  for (const platform of ["@effect/platform-bun", "@effect/platform-node"]) {
    for (
      const manifest of [
        { dependencies: { [platform]: pin, effect: pin } },
        { dependencies: { [platform]: pin, effect: pin }, peerDependencies: { "@effect/platform-node-shared": pin } },
        {
          dependencies: { [platform]: pin },
          peerDependencies: { effect: range, "@effect/platform-node-shared": range }
        },
        { dependencies: { [platform]: pin, effect: pin }, devDependencies: { "@effect/platform-node-shared": pin } },
        { dependencies: { [platform]: pin, "@effect/platform-node-shared": range } },
        { optionalDependencies: { [platform]: pin } }
      ]
    ) {
      const problems = nodeSharedPinProblems(manifests([manifest]))
      assert.equal(problems.length, 1, JSON.stringify(manifest))
      assert.match(
        problems[0],
        new RegExp(
          `${platform.replace("/", "\\/")} without @effect/platform-node-shared at ${
            pin.replaceAll(".", "\\.")
          } in dependencies$`
        )
      )
      assert.throws(
        () => assertNodeSharedPins(manifests([manifest])),
        /leave @effect\/platform-node-shared to a transitive caret range/
      )
    }
  }
})

test("rejects a platform peer without node-shared among its dependencies or peers", () => {
  const library = { "@effect/platform-bun": range, "@effect/platform-node": range, effect: range }
  const message =
    `packages/fixture-0 (@fixture/0): peerDependencies declares @effect/platform-bun and @effect/platform-node without @effect/platform-node-shared at ${pin} in dependencies or ${pin} in peerDependencies`
  assert.deepEqual(nodeSharedPinProblems(manifests([{ peerDependencies: library }])), [message])
  // A library's peer on the shared adapter is the range, like its other peers.
  assert.deepEqual(
    nodeSharedPinProblems(manifests([{ peerDependencies: { ...library, "@effect/platform-node-shared": range } }])),
    [message]
  )
  // An executable pins the platform it asks for, and the shared adapter with it.
  assert.deepEqual(
    nodeSharedPinProblems(manifests([{
      dependencies: { effect: pin },
      peerDependencies: { "@effect/platform-node": pin, "@effect/platform-node-shared": range }
    }])),
    [
      `packages/fixture-0 (@fixture/0): peerDependencies declares @effect/platform-node without @effect/platform-node-shared at ${pin} in dependencies or ${pin} in peerDependencies`
    ]
  )
})

test("accepts the pinned shapes and packages without a platform", () => {
  const accepted = manifests([
    { dependencies: { "@effect/platform-node": pin, "@effect/platform-node-shared": pin, effect: pin } },
    {
      dependencies: { "@effect/platform-bun": pin, "@effect/platform-node": pin, "@effect/platform-node-shared": pin }
    },
    { peerDependencies: { "@effect/platform-node": pin, "@effect/platform-node-shared": pin, effect: pin } },
    {
      peerDependencies: { "@effect/platform-bun": range, effect: range },
      dependencies: { "@effect/platform-node-shared": pin }
    },
    {
      dependencies: { effect: pin },
      peerDependencies: { "@effect/platform-node": pin, "@effect/platform-node-shared": pin }
    },
    { dependencies: { effect: pin }, devDependencies: { "@effect/platform-node": pin } },
    {}
  ])
  assert.deepEqual(nodeSharedPinProblems(accepted), [])
  assert.doesNotThrow(() => assertNodeSharedPins(accepted))
})

test("every published workspace package pins node-shared where it declares a platform", () => {
  const published = readWorkspaceManifests(repoRoot)
  assert.ok(published.size > 0)
  assert.deepEqual(nodeSharedPinProblems(published), [])
  const cli = [...published.values()].find((manifest) => manifest.name === "@smthrs/cli")
  assert.equal(cli.dependencies["@effect/platform-node-shared"], undefined)
  assert.equal(cli.devDependencies["@effect/platform-node-shared"], pin)
  assert.ok(cli.smthrs.privateEffectAdapters.includes("@effect/platform-node-shared"))
})

test("every published workspace manifest follows the declaration policy", () => {
  const published = readWorkspaceManifests(repoRoot)
  const records = [...published].flatMap(([directory, manifest]) => effectDeclarations(manifest, directory))
  assert.ok(records.length > 100, `${records.length} Effect declarations is too few to be the published set`)
  assert.doesNotThrow(() => assertEffectPins(records))
  const peers = records.filter((record) => record.source.endsWith("(peerDependencies)"))
  // Executables pin their shared peer; libraries accept the supported range.
  const effectPeers = peers.filter((record) => record.name === "effect")
  assert.equal(effectPeers.length, published.size - 1, "every published runtime package except the notice")
  assert.equal(effectPeers.filter((record) => record.version === pin).length, published.size - 1)
  assert.equal(effectPeers.filter((record) => record.version === range).length, 0)
})

// npm --strict-peer-deps loads an optional peer's newest version into the peer
// set even when nothing installs it. A ranged optional adapter peer therefore
// refused every application pinned at the tested release the day upstream
// published the next adapter (measured against a registry serving 4.0.5).
test("optional Effect adapters are pinned or left to application selection", () => {
  const meta = { peerDependenciesMeta: { "@effect/sql-pg": { optional: true }, vitest: { optional: true } } }
  for (const version of [range, "*"]) {
    const problems = optionalAdapterPeerProblems(manifests([
      { ...meta, peerDependencies: { effect: range, "@effect/sql-pg": version, vitest: "5.0.0" } }
    ]))
    assert.deepEqual(problems, [
      `packages/fixture-0 (@fixture/0): optional peer @effect/sql-pg@${version} must be pinned to ${pin} or declared in peerDependenciesMeta only`
    ])
  }
  const accepted = manifests([
    { ...meta, peerDependencies: { effect: range, vitest: "5.0.0" } },
    { ...meta, peerDependencies: { effect: range, "@effect/sql-pg": pin } },
    // A required adapter peer, an executable's exact optional peer, and a private package are other rules.
    { peerDependencies: { effect: range, "@effect/opentelemetry": range } },
    { dependencies: { effect: pin }, peerDependencies: { "@effect/sql-pg": pin }, ...meta },
    { private: true, peerDependencies: { "@effect/sql-pg": range }, ...meta }
  ])
  assert.deepEqual(optionalAdapterPeerProblems(accepted), [])
  assert.deepEqual(optionalAdapterPeerProblems(readWorkspaceManifests(repoRoot)), [])
})
