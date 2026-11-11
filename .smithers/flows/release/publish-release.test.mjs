import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { maintainerReleasePlan, integrity, preflight, publishCandidate, recordSmokeSuccess, registryPublisher } from "./publish-release.mjs"

const fixture = async (body) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-publish-"))
  try {
    const packages = [{ name: "a", version: "1.0.0-rc.0", filename: "a.tgz", integrity: integrity(Buffer.from("a")) }, { name: "b", version: "1.0.0-rc.0", filename: "b.tgz", integrity: integrity(Buffer.from("b")) }]
    for (const entry of packages) await writeFile(join(directory, entry.filename), entry.name)
    const candidate = { schemaVersion: 1, source: { sha: "tested-sha", tag: "v1.0.0-rc.0", dirty: false }, packages }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(packages))
    await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
    await recordSmokeSuccess(directory, candidate)
    const options = { sourceSha: "tested-sha", releaseTag: "v1.0.0-rc.0", readTag: async () => undefined, promote: async () => {}, verifyVersion: async () => true }
    await body(directory, candidate, options)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test("publishes absent packages in manifest order and verifies every publication", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const calls = []
  const pauses = []
  const result = await publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => registry.get(spec), publish: async (path, entry) => { calls.push(path); registry.set(`${entry.name}@${entry.version}`, entry.integrity) }
  })
  assert.deepEqual(result, ["a", "b"])
  assert.deepEqual(pauses, [2])
  assert.deepEqual(calls, [join(directory, "a.tgz"), join(directory, "b.tgz")])
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, readRegistry: async (spec) => registry.get(spec), publish: () => assert.fail("identical retry must skip") }), [])
}))

test("a mismatched existing package refuses the entire partial retry", () => fixture(async (directory, candidate, options) => {
  let published = 0
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async (spec) => spec.startsWith("b@") ? integrity(Buffer.from("different candidate")) : undefined,
    publish: () => { published++ }
  }), /Registry integrity mismatch/)
  assert.equal(published, 0)
}))

test("missing registry integrity and transport failures fail closed", () => fixture(async (directory, candidate, options) => {
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry: async () => null }), /Registry integrity mismatch/)
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry: async () => { throw new Error("offline") } }), /offline/)
}))

test("tag, source, dirty state and altered tested bytes are refused", () => fixture(async (directory, candidate, options) => {
  const readRegistry = async () => undefined
  await assert.rejects(preflight(directory, candidate, { ...options, sourceSha: "another", readRegistry }), /source\/tag/)
  await assert.rejects(preflight(directory, candidate, { ...options, releaseTag: "v2.0.0", readRegistry }), /source\/tag/)
  await assert.rejects(preflight(directory, { ...candidate, source: { ...candidate.source, dirty: true } }, { ...options, readRegistry }), /source\/tag/)
  await writeFile(join(directory, "a.tgz"), "changed after smoke")
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry }), /Local tarball integrity mismatch/)
}))

test("a publication the registry never serves fails the run once the train has settled", () => fixture(async (directory, candidate, options) => {
  const calls = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options, readRegistry: async () => undefined, publish: async (_path, entry) => calls.push(entry.name) }), /Published integrity could not be verified: a/)
  assert.deepEqual(calls, ["a", "b"])
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")), { schemaVersion: 1, source: candidate.source, published: [], promoted: [], awaiting: ["a", "b"] })
}))

test("a publication the registry has not served yet is re-read through the retry ladder", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const lag = new Map()
  const pauses = []
  const result = await publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => {
      const missing = lag.get(spec) ?? 0
      if (missing === 0) return registry.get(spec)
      lag.set(spec, missing - 1)
      return undefined
    },
    publish: async (_path, entry) => {
      registry.set(`${entry.name}@${entry.version}`, entry.integrity)
      lag.set(`${entry.name}@${entry.version}`, entry.name === "a" ? 1 : 3)
    }
  })
  assert.deepEqual(result, ["a", "b"])
  assert.deepEqual(pauses, [10, 2, 10, 30, 60])
}))

test("a publication still absent after its ladder is settled with the train for 15 minutes", () => fixture(async (directory, candidate, options) => {
  const calls = []
  const pauses = []
  const reads = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => { reads.push(spec) },
    publish: async (_path, entry) => calls.push(entry.name)
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(calls, ["a", "b"])
  assert.deepEqual(pauses, [10, 30, 60, 2, 10, 30, 60, ...Array(30).fill(30)])
  assert.equal(pauses.slice(7).reduce((sum, seconds) => sum + seconds, 0), 900)
  // Preflight reads both once; each ladder reads its package four times; each
  // settle round reads every package still absent.
  const both = ["a@1.0.0-rc.0", "b@1.0.0-rc.0"]
  assert.deepEqual(reads, [...both, ...Array(4).fill(both[0]), ...Array(4).fill(both[1]), ...Array(31).fill(both).flat()])
}))

// A brand-new npm name took about 200 s to be served on the v1.0.0-rc.2 tag run
// (37988746485), past the per-package ladder, and the run stopped after one package.
test("a new name the registry serves late does not hold the rest of the train", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const lag = new Map()
  const pauses = []
  const calls = []
  const result = await publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => {
      const missing = lag.get(spec) ?? 0
      if (missing === 0) return registry.get(spec)
      lag.set(spec, missing - 1)
      return undefined
    },
    publish: async (_path, entry) => {
      calls.push(entry.name)
      registry.set(`${entry.name}@${entry.version}`, entry.integrity)
      if (entry.name === "a") lag.set(`${entry.name}@${entry.version}`, 5)
    }
  })
  assert.deepEqual(calls, ["a", "b"])
  assert.deepEqual(result, ["b", "a"])
  assert.deepEqual(pauses, [10, 30, 60, 2, 30])
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).awaiting, [])
}))

test("different bytes found while settling fail at once", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const reads = new Map()
  const pauses = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => {
      const count = (reads.get(spec) ?? 0) + 1
      reads.set(spec, count)
      // a: absent at preflight and through its ladder, then different bytes.
      if (spec.startsWith("a@") && count > 5) return integrity(Buffer.from("different candidate"))
      return registry.get(spec)
    },
    publish: async (_path, entry) => { if (entry.name === "b") registry.set(`${entry.name}@${entry.version}`, entry.integrity) }
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(pauses, [10, 30, 60, 2])
}))

test("a publication with different registry integrity fails closed without waiting", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const pauses = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => registry.get(spec),
    publish: async (_path, entry) => { registry.set(`${entry.name}@${entry.version}`, integrity(Buffer.from("different candidate"))) }
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(pauses, [])
}))

test("a partial publication resumes only the missing packages from the tested train", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const calls = []
  const readRegistry = async (spec) => registry.get(spec)
  await assert.rejects(publishCandidate(directory, candidate, { ...options, readRegistry, publish: async (_path, entry) => {
    calls.push(entry.name)
    if (entry.name === "b") throw new Error("connection lost")
    registry.set(`${entry.name}@${entry.version}`, entry.integrity)
  } }), /connection lost/)
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).published, ["a"])
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, readRegistry, publish: async (_path, entry) => {
    calls.push(entry.name)
    registry.set(`${entry.name}@${entry.version}`, entry.integrity)
  } }), ["b"])
  assert.deepEqual(calls, ["a", "b", "b"])
}))

test("a successful smoke receipt is required and bound to the complete manifest", () => fixture(async (directory, candidate, options) => {
  const readRegistry = async () => assert.fail("untested candidates cannot query the registry")
  await rm(join(directory, "smoke-evidence.json"))
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry }), /smoke-evidence/)
  await recordSmokeSuccess(directory, candidate)
  await assert.rejects(preflight(directory, { ...candidate, toolchain: { node: "changed" } }, { ...options, readRegistry }), /matching successful smoke evidence/)
  await writeFile(join(directory, "smoke-evidence.json"), JSON.stringify({ schemaVersion: 1, status: "failed" }))
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry }), /matching successful smoke evidence/)
}))

test("smoke success cannot attest changed manifest, roster or tarball bytes", () => fixture(async (directory, candidate) => {
  await rm(join(directory, "smoke-evidence.json"))
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify({ ...candidate, source: { ...candidate.source, sha: "new" } }))
  await assert.rejects(recordSmokeSuccess(directory, candidate), /changed during smoke/)
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
  await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages.slice(1)))
  await assert.rejects(recordSmokeSuccess(directory, candidate), /smoke-test package roster/)
  await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages))
  await writeFile(join(directory, "b.tgz"), "changed")
  await assert.rejects(recordSmokeSuccess(directory, candidate), /Local tarball integrity mismatch/)
  await assert.rejects(readFile(join(directory, "smoke-evidence.json")), /ENOENT/)
}))

test("a tarball changed while its predecessor publishes is refused", () => fixture(async (directory, candidate, options) => {
  const registry = new Map()
  const calls = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async (spec) => registry.get(spec),
    publish: async (_path, entry) => {
      calls.push(entry.name)
      registry.set(`${entry.name}@${entry.version}`, entry.integrity)
      await writeFile(join(directory, "b.tgz"), "changed after preflight")
    }
  }), /Local tarball integrity mismatch: b/)
  assert.deepEqual(calls, ["a"])
}))

test("duplicate package names and filenames and unsafe paths are refused before registry access", () => fixture(async (directory, candidate, options) => {
  for (const mutate of [
    (entry) => ({ ...entry, name: "a" }),
    (entry) => ({ ...entry, filename: "a.tgz" }),
    (entry) => ({ ...entry, filename: "../b.tgz" }),
    (entry) => ({ ...entry, filename: "..\\b.tgz" })
  ]) {
    const changed = { ...candidate, packages: [candidate.packages[0], mutate(candidate.packages[1])] }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(changed.packages))
    await assert.rejects(preflight(directory, changed, { ...options, readRegistry: async () => assert.fail("invalid train queried registry") }), /Invalid release entry/)
  }
}))

// Literal T-MNT-05 dates and checks; no spec/catalog-derived expectations.
const maintainerCandidate = () => ({ releaseStage: "M", source: { tag: "v1.1.0" }, maintainerRelease: {
  launchUtc: "2026-12-28T23:30:00.000Z", targetReleaseUtc: "2027-01-04T23:30:00.000Z",
  launchVersion: "1.0.0", availableUtc: null
} })

test("maintainer release records year rollover and stays blocked without availability", () => {
  assert.deepEqual(maintainerReleasePlan(maintainerCandidate()), {
    launchUtc: "2026-12-28T23:30:00.000Z", targetReleaseUtc: "2027-01-04T23:30:00.000Z",
    availableUtc: null, launchVersion: "1.0.0", releaseVersion: "1.1.0", state: "blocked",
    requiredChecks: ["C-MNT-01", "C-MNT-02", "C-MNT-03", "C-MNT-04", "C-MNT-05", "C-MNT-06", "C-REL-03", "C-SEC-02", "C-SEC-03", "C-COL-04", "C-MCH-06"]
  })
})

test("maintainer dates reject normalization, local zones, early and missed publication", () => {
  for (const [field, value, message] of [
    ["launchUtc", "2026-02-30T23:30:00.000Z", /Invalid release date/],
    ["launchUtc", "2026-12-28T23:30:00-08:00", /UTC/],
    ["launchUtc", null, /UTC/],
    ["targetReleaseUtc", "2027-01-04T23:29:59.000Z", /seven calendar days/],
    ["availableUtc", "2027-01-04T23:29:59.000Z", /day seven/],
    ["availableUtc", "2027-01-05T23:30:00.000Z", /day seven/],
    ["availableUtc", "2027-01-04", /UTC/],
    ["launchVersion", "1.1.0", /Distinct/],
    ["launchVersion", "", /Distinct/]
  ]) {
    const candidate = maintainerCandidate()
    candidate.maintainerRelease[field] = value
    assert.throws(() => maintainerReleasePlan(candidate), message)
  }
  for (const value of ["2027-01-04T23:30:00.000Z", "2027-01-05T23:29:59.000Z"]) {
    const candidate = maintainerCandidate()
    candidate.maintainerRelease.availableUtc = value
    assert.equal(maintainerReleasePlan(candidate).state, "blocked")
  }
  assert.throws(() => maintainerReleasePlan({}), /record is required/)
})

test("M publication fails before registry reads or writes even with claimed passing receipts", () => fixture(async (directory, candidate, options) => {
  let reads = 0, writes = 0
  const doors = { ...options, readRegistry: async () => { reads++ }, publish: async () => { writes++ } }
  for (const availableUtc of [null, "2027-01-04T23:30:00.000Z"]) {
    const m = { ...candidate, releaseStage: "M", maintainerRelease: {
      ...maintainerCandidate().maintainerRelease, availableUtc, checks: { "C-MNT-05": "passed" }
    } }
    await assert.rejects(publishCandidate(directory, m, doors), /Maintainer publication disabled/)
  }
  await assert.rejects(preflight(directory, { ...candidate, releaseStage: "M" }, doors), /record is required/)
  await assert.rejects(preflight(directory, { ...candidate, maintainerRelease: {} }, doors), /declare stage M/)
  await assert.rejects(preflight(directory, { ...candidate, releaseStage: "cloud" }, doors), /Unknown release stage/)
  assert.equal(reads, 0)
  assert.equal(writes, 0)
}))

// Model the npm boundary: a tag write is observable immediately, while views
// can only serve versions whose publication has propagated.
for (const version of ["1.0.0-rc.0", "1.0.0"]) {
  test(`consumer tags never expose missing first-party dependencies (${version})`, () => fixture(async (directory, candidate, options) => {
    const dependencies = { smthrs: ["@smthrs/cli"], "@smthrs/base": [], "@smthrs/cli": ["@smthrs/base"] }
    candidate.packages = Object.keys(dependencies).map((name, index) => ({ name, version, filename: `${index}.tgz`, integrity: integrity(Buffer.from(name)) }))
    candidate.source.tag = `v${version}`
    await rm(join(directory, "a.tgz"))
    await rm(join(directory, "b.tgz"))
    for (const entry of candidate.packages) await writeFile(join(directory, entry.filename), entry.name)
    await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages))
    await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
    await recordSmokeSuccess(directory, candidate)
    const served = new Map(), tags = new Map(), versionViews = new Set(), calls = []
    let failPromotion = true
    const adapter = registryPublisher({ pause: () => {}, run: (command, args) => {
      calls.push([command, ...args])
      if (args[0] === "view" && args[2].startsWith("dist-tags.")) return tags.has(`${args[1]}:${args[2].slice(10)}`) ? JSON.stringify(tags.get(`${args[1]}:${args[2].slice(10)}`)) : ""
      if (args[0] === "view") {
        const entry = candidate.packages.find((entry) => `${entry.name}@${version}` === args[1])
        if (!served.has(entry.name)) throw new Error("E404")
        if (args[2] === "version") versionViews.add(entry.name)
        return JSON.stringify(args[2] === "version" ? version : entry.integrity)
      }
      let name, tag
      if (args[0] === "publish") {
        name = candidate.packages.find((entry) => join(directory, entry.filename) === args[1]).name
        served.set(name, true)
        tag = args[args.indexOf("--tag") + 1]
      } else {
        assert.equal(command, "npm")
        assert.equal(args[0], "dist-tag")
        assert.equal(args[1], "add")
        name = args[2].slice(0, args[2].lastIndexOf("@"))
        tag = args[3]
        assert.equal(served.size, candidate.packages.length, "all versions must be served before promotion")
        assert.equal(versionViews.size, candidate.packages.length, "every exact version must be viewed before promotion")
        if (name === "@smthrs/cli" && failPromotion) { failPromotion = false; throw new Error("E401") }
      }
      tags.set(`${name}:${tag}`, version)
      for (const [key] of tags) {
        if (!key.endsWith(":next") && !key.endsWith(":latest")) continue
        for (const dependency of dependencies[key.slice(0, key.lastIndexOf(":"))]) {
          assert.ok(served.has(dependency), `${key} exposes missing ${dependency}@${version}`)
        }
      }
      return ""
    } })
    const publish = () => publishCandidate(directory, candidate, { ...options, releaseTag: candidate.source.tag, ...adapter })
    await assert.rejects(publish(), /E401/)
    const receipt = JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8"))
    assert.deepEqual(receipt.promoted, ["@smthrs/base"])
    const count = calls.filter(([, verb]) => verb === "publish").length
    await publish()
    assert.equal(calls.filter(([, verb]) => verb === "publish").length, count, "resume must not republish")
    const promotions = calls.filter(([, verb]) => verb === "dist-tag")
    assert.equal(promotions.at(-1)[3], `smthrs@${version}`)
    assert.deepEqual(promotions.slice(-3).map((call) => call[3]), [`@smthrs/base@${version}`, `@smthrs/cli@${version}`, `smthrs@${version}`])
    assert.ok(calls.some(([, verb, , field]) => verb === "view" && field === "version"))
  }))
}

for (const eventuallyServed of [true, false]) {
  test(`version propagation is bounded and holds every consumer tag (${eventuallyServed})`, () => fixture(async (directory, candidate, options) => {
    const registry = new Map()
    const promotions = [], pauses = []
    let reads = 0
    const publish = () => publishCandidate(directory, candidate, { ...options,
      readRegistry: async (spec) => registry.get(spec),
      publish: async (_path, entry) => registry.set(`${entry.name}@${entry.version}`, entry.integrity),
      verifyVersion: async () => { reads++; return eventuallyServed && reads > 3 },
      pause: async (seconds) => pauses.push(seconds),
      promote: async (entry) => promotions.push(entry.name)
    })
    if (eventuallyServed) {
      await publish()
      assert.deepEqual(promotions, ["a", "b"])
      assert.deepEqual(pauses, [2, 10, 30, 60])
    } else {
      await assert.rejects(publish(), /Published version is not served: a@/)
      assert.equal(reads, 34)
      assert.deepEqual(promotions, [])
      assert.deepEqual(pauses, [2, 10, 30, 60, ...Array(30).fill(30)])
    }
  }))
}

// An older train resumed after a newer one became the consumer tag must not
// hand new installs the older train. Only the npm boundary is recorded.
for (const [version, tag, newer] of [["1.0.0", "latest", "2.0.0"], ["1.0.0-rc.2", "next", "1.0.0-rc.10"]]) {
  test(`a resumed older train never moves ${tag} backwards`, () => fixture(async (directory, candidate, options) => {
    candidate.packages = candidate.packages.map((entry) => ({ ...entry, version }))
    candidate.source.tag = `v${version}`
    await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages))
    await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
    await recordSmokeSuccess(directory, candidate)
    // a's tag has moved on to the newer train and b's still holds an older
    // one, so only b is promoted.
    const tags = new Map([[`a:${tag}`, newer], [`b:${tag}`, "0.9.0"]])
    const writes = []
    const adapter = registryPublisher({ pause: () => {}, run: (command, args) => {
      assert.ok(command === "npm" || args[0] === "view")
      if (args[0] === "view" && args[2] === `dist-tags.${tag}`) return tags.has(`${args[1]}:${tag}`) ? JSON.stringify(tags.get(`${args[1]}:${tag}`)) : ""
      if (args[0] === "view") {
        const entry = candidate.packages.find((entry) => `${entry.name}@${version}` === args[1])
        return JSON.stringify(args[2] === "version" ? version : entry.integrity)
      }
      assert.deepEqual(args.slice(0, 2), ["dist-tag", "add"])
      writes.push(args.slice(2))
      tags.set(`${args[2].slice(0, args[2].lastIndexOf("@"))}:${args[3]}`, version)
      return ""
    } })
    const result = await publishCandidate(directory, candidate, { ...options, releaseTag: candidate.source.tag, ...adapter, publish: () => assert.fail("resume cannot republish") })
    assert.deepEqual(result, [])
    assert.deepEqual(writes, [[`b@${version}`, tag]])
    assert.equal(tags.get(`a:${tag}`), newer)
    assert.equal(tags.get(`b:${tag}`), version)
    // Re-resuming writes the tag it already holds, so a lost acknowledgement recovers.
    await publishCandidate(directory, candidate, { ...options, releaseTag: candidate.source.tag, ...adapter })
    assert.deepEqual(writes, [[`b@${version}`, tag], [`b@${version}`, tag]])
    assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).promoted, ["b"])
  }))
}

test("an integrity-verified resume still checks every version before promotion", () => fixture(async (directory, candidate, options) => {
  const versions = [], promotions = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async (spec) => candidate.packages.find((entry) => `${entry.name}@${entry.version}` === spec).integrity,
    publish: () => assert.fail("resume cannot republish existing versions"),
    verifyVersion: async (entry) => { versions.push(entry.name); return entry.name === "a" },
    promote: async (entry) => promotions.push(entry.name)
  }), /Published version is not served: b@/)
  assert.equal(versions[0], "a")
  assert.deepEqual(promotions, [])
}))

test("unreadable consumer tags fail closed before promotion", () => fixture(async (directory, candidate, options) => {
  for (const current of ["not-semver", null, {}, 42]) {
    await assert.rejects(publishCandidate(directory, candidate, { ...options,
      readRegistry: async (spec) => candidate.packages.find((entry) => spec === `${entry.name}@${entry.version}`).integrity,
      readTag: async () => current,
      promote: () => assert.fail("invalid tag must not be replaced")
    }))
  }
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async (spec) => candidate.packages.find((entry) => spec === `${entry.name}@${entry.version}`).integrity,
    readTag: async () => { throw new Error("tag read failed") },
    promote: () => assert.fail("unreadable tag must not be replaced")
  }), /tag read failed/)
}))
