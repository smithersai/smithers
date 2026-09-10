import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { EXPECTED_EFFECT_VERSION } from "./check-single-effect-version.mjs"
import { adapterProfiles, adjacentEffectVersion, candidateVersion, migrationProfiles, minimalProfiles, runConsumerProfile, templateProfile } from "./release-consumers.mjs"
import { releaseRegistry } from "./release-registry.mjs"

test("every library, adapter and migration profile selects the supplied candidate version", () => {
  for (const version of ["1.0.0", "1.1.0-rc.7"]) {
    const entries = [{ name: "@smthrs/database", version }]
    const profiles = [...minimalProfiles(entries), ...adapterProfiles(entries), ...migrationProfiles(entries)]
    assert.equal(profiles.length, 12)
    for (const profile of profiles) {
      const firstParty = Object.entries(profile.dependencies).filter(([name]) => name.startsWith("@smthrs/"))
      assert.ok(firstParty.length > 0, profile.name)
      for (const [name, range] of firstParty) assert.equal(range, version, `${profile.name}: ${name}`)
      assert.equal(profile.dependencies.effect, EXPECTED_EFFECT_VERSION)
    }
  }
})

test("the incompatible consumer requests the published RC one below the pin", () => {
  const [, rc] = /-rc\.(\d+)$/.exec(EXPECTED_EFFECT_VERSION)
  assert.equal(adjacentEffectVersion, EXPECTED_EFFECT_VERSION.replace(/-rc\.\d+$/, "-rc." + (Number(rc) - 1)))
  assert.notEqual(adjacentEffectVersion, EXPECTED_EFFECT_VERSION)
})

// Release logic that reads the pin imports it from check-single-effect-version.mjs.
// A second literal is the drift the exact-pin gate exists to stop: a bump there
// left these files asserting the old RC until a release rehearsal failed.
test("the release consumer matrix and the package contract declare no Effect RC of their own", () => {
  for (const file of ["release-consumers.mjs", "check-npm-dedupe.mjs", "smoke-release.mjs", "repo-contract/package-contract.test.mjs"]) {
    const literals = readFileSync(join(import.meta.dirname, file), "utf8").match(/\d+\.\d+\.\d+-rc\.\d+/g) ?? []
    assert.deepEqual(literals, [], `${file} hand-restates a release-line version: ${literals.join(", ")}`)
  }
})

// scripts/fixtures/ holds files a consumer copies: probes and the installed
// consumer. Lint ignores the directory and the boundary gate reads it as a
// consumer, so release logic that lived there ran unlinted and unchecked.
test("no release script imports a module from scripts/fixtures", () => {
  const importers = []
  for (const directory of [".", "repo-contract"]) {
    for (const entry of readdirSync(join(import.meta.dirname, directory))) {
      if (!entry.endsWith(".mjs")) continue
      const source = readFileSync(join(import.meta.dirname, directory, entry), "utf8")
      if (/from\s+["'](?:\.\.?\/)+fixtures\/[^/"']+\.mjs["']/.test(source)) importers.push(join(directory, entry))
    }
  }
  assert.deepEqual(importers, [], "move the module beside its importers under scripts/")
})

test("candidate selection rejects empty, mixed and non-exact versions", () => {
  for (const entries of [[], [{ version: "1.0.0" }, { version: "1.0.0-rc.0" }],
    [{ version: "^1.0.0" }], [{ version: "v1.0.0" }], [{}]]) {
    assert.throws(() => candidateVersion(entries), /candidate/)
  }
})

test("consumer and packed template requests resolve against a stable-only candidate registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-consumer-version-"))
  let registry
  const previousRegistry = process.env.npm_config_registry
  try {
    const version = "1.0.0"
    const entries = []
    for (const name of ["database", "create-app"]) {
      const directory = join(root, name)
      mkdirSync(join(directory, "package/template/default"), { recursive: true })
      writeFileSync(join(directory, "package/package.json"), JSON.stringify({ name: "@smthrs/" + name, version,
        dependencies: { effect: "4.0.0-rc.112" } }))
      writeFileSync(join(directory, "package/template/default/package.json"), JSON.stringify({
        private: true, dependencies: { "@smthrs/database": version }, devDependencies: { "@smthrs/create-app": version }
      }))
      const filename = name + ".tgz"
      execFileSync("tar", ["-czf", join(root, filename), "-C", directory, "package"])
      entries.push({ name: "@smthrs/" + name, version, filename })
    }
    mkdirSync(join(root, "effect/package"), { recursive: true })
    writeFileSync(join(root, "effect/package/package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.112" }))
    execFileSync("tar", ["-czf", join(root, "effect.tgz"), "-C", join(root, "effect"), "package"])
    registry = await releaseRegistry(root, [...entries, { name: "effect", version: "4.0.0-rc.112", filename: "effect.tgz" }])
    // All package bytes, including the minimal Effect identity fixture, come
    // from loopback. No existing publication or external install is needed.
    process.env.npm_config_registry = registry.url
    const profiles = [minimalProfiles(entries)[0], templateProfile(root, entries)]
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
      const installed = await runConsumerProfile(profiles[0], manager, registry.url)
      assert.equal(installed.effectCopies.length, 1)
    }
    writeFileSync(join(root, "create-app/package/template/default/package.json"), JSON.stringify({
      private: true, dependencies: { "@smthrs/database": "1.0.0-rc.0" }
    }))
    execFileSync("tar", ["-czf", join(root, "create-app.tgz"), "-C", join(root, "create-app"), "package"])
    assert.throws(() => templateProfile(root, entries), /shipped template @smthrs\/database must select candidate 1\.0\.0/)
  } finally {
    if (previousRegistry === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = previousRegistry
    await registry?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
