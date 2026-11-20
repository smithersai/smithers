import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { consumerTags, maintainerReleasePlan, integrity, parseAllowNewNames, preflight, publishCandidate, recordSmokeSuccess, registryPublisher } from "./publish-release.mjs"

const fixture = async (body, names = ["a", "b"]) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-publish-"))
  try {
    const packages = names.map((name) => ({ name, version: "1.0.0-rc.0", filename: `${name.replace(/^@/, "").replace("/", "-")}.tgz`, integrity: integrity(Buffer.from(name)) }))
    for (const entry of packages) await writeFile(join(directory, entry.filename), entry.name)
    const candidate = { schemaVersion: 1, source: { sha: "tested-sha", tag: "v1.0.0-rc.0", dirty: false }, packages }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(packages))
    await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
    await recordSmokeSuccess(directory, candidate)
    const options = { sourceSha: "tested-sha", releaseTag: "v1.0.0-rc.0", readName: async (name) => name, readTag: async () => undefined, promote: async () => {}, verifyVersion: async () => true }
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
  const missing = async () => undefined
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry: missing, readName: async () => null }), /Registry name check unavailable: a/)
  await assert.rejects(preflight(directory, candidate, { ...options, readRegistry: missing, readName: async () => { throw new Error("offline") } }), /offline/)
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

test("a publication the registry has not served yet is re-read with the train", () => fixture(async (directory, candidate, options) => {
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
  assert.deepEqual(pauses, [2, 30, 30])
}))

test("a publication still absent is re-read for 30 minutes after the last upload", () => fixture(async (directory, candidate, options) => {
  const calls = []
  const pauses = []
  const reads = []
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds) },
    readRegistry: async (spec) => { reads.push(spec) },
    publish: async (_path, entry) => calls.push(entry.name)
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(calls, ["a", "b"])
  assert.deepEqual(pauses, [2, ...Array(60).fill(30)])
  assert.equal(pauses.slice(1).reduce((sum, seconds) => sum + seconds, 0), 1800)
  // Preflight reads both once; each upload is read once; each settle round
  // reads every package still absent.
  const both = ["a@1.0.0-rc.0", "b@1.0.0-rc.0"]
  assert.deepEqual(reads, [...both, ...both, ...Array(61).fill(both).flat()])
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
  assert.deepEqual(pauses, [2, 30, 30, 30, 30])
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).awaiting, [])
}))

// Seconds from upload to the registry's `time` of each version on the
// v1.0.0-rc.18 tag run (44620940500), in its plan order. A 100 s read ladder per
// package outlasted 45 of them and the train took 95 minutes.
const servedAfter = [125, 141, 138, 168, 225, 283, 129, 126, 183, 119, 387, 205, 91, 111, 143, 260, 166, 101, 129, 249, 125, 93, 125, 124, 314, 102, 99, 190, 189, 157, 249, 158, 125, 123, 100, 311, 249, 95, 249, 129, 94, 92, 156, 254, 129, 128, 95, 82, 372, 373, 498]

test("a train the registry serves minutes late uploads every package before it waits", () => fixture(async (directory, candidate, options) => {
  let now = 0
  const uploadedAt = new Map()
  const pauses = []
  const uploads = []
  const lag = new Map(candidate.packages.map((entry, index) => [`${entry.name}@${entry.version}`, servedAfter[index]]))
  const result = await publishCandidate(directory, candidate, { ...options,
    pause: async (seconds) => { pauses.push(seconds); now += seconds },
    readRegistry: async (spec) => uploadedAt.has(spec) && now >= uploadedAt.get(spec) + lag.get(spec) ? candidate.packages.find((entry) => `${entry.name}@${entry.version}` === spec).integrity : undefined,
    publish: async (_path, entry) => { uploads.push(now); uploadedAt.set(`${entry.name}@${entry.version}`, now) }
  })
  assert.equal(result.length, servedAfter.length)
  assert.deepEqual(uploads, servedAfter.map((_lag, index) => index * 2))
  // The last upload starts at 100 s and is served 498 s later; the train ends
  // with the first 30 s settle round after that, not 51 ladders later.
  assert.equal(now, 610)
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).awaiting, [])
}, servedAfter.map((_lag, index) => `p${index}`)))

test("the receipt names only uploads the registry accepted", () => fixture(async (directory, candidate, options) => {
  await assert.rejects(publishCandidate(directory, candidate, { ...options,
    readRegistry: async () => undefined,
    publish: async (_path, entry) => { if (entry.name === "b") throw new Error("403 Forbidden - PUT https://registry.npmjs.org/b") }
  }), /403 Forbidden/)
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")), { schemaVersion: 1, source: candidate.source, published: [], promoted: [], awaiting: ["a"] })
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
      // a: absent at preflight and after its upload, then different bytes.
      if (spec.startsWith("a@") && count > 2) return integrity(Buffer.from("different candidate"))
      return registry.get(spec)
    },
    publish: async (_path, entry) => { if (entry.name === "b") registry.set(`${entry.name}@${entry.version}`, entry.integrity) }
  }), /Published integrity could not be verified: a/)
  assert.deepEqual(pauses, [2])
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

// npm as the v1.0.0-rc.18 tag run (44620940500) met it. pnpm answers a new name
// with ERR_PNPM_FETCH_404 and a missing version of an existing name with
// ERR_PNPM_PACKAGE_NOT_FOUND; `npm view <name> name` answers E404 only for a
// new name. The release token creates a name in the scope it was granted
// (`@smthrs`) and answers 403 for any other new name.
const npmRegistry = (directory, candidate, { known, published = new Map(), tags = new Map(), granted = new Set() }) => {
  const calls = []
  const failure = (code, message) => Object.assign(new Error(`Command failed: ${message}`), { status: 1, stdout: JSON.stringify({ error: { code, message } }), stderr: "" })
  const at = (spec) => [spec.slice(0, spec.lastIndexOf("@")), spec.slice(spec.lastIndexOf("@") + 1)]
  const adapter = registryPublisher({ pause: () => {}, run: (command, args) => {
    calls.push([command, ...args])
    const [verb, spec, field] = args
    if (verb === "view" && field === "name") {
      if (!known.has(spec)) throw failure("E404", `404 Not Found - GET https://registry.npmjs.org/${spec} - Not found`)
      return JSON.stringify(spec)
    }
    if (verb === "view" && field.startsWith("dist-tags.")) {
      const current = tags.get(`${spec}:${field.slice("dist-tags.".length)}`)
      return current === undefined ? "" : JSON.stringify(current)
    }
    if (verb === "view") {
      const [name, version] = at(spec)
      if (!known.has(name)) throw failure("ERR_PNPM_FETCH_404", `GET https://registry.npmjs.org/${name}: Not Found - 404`)
      if (!published.has(spec)) throw failure(command === "pnpm" ? "ERR_PNPM_PACKAGE_NOT_FOUND" : "E404", `No matching version found for ${spec}`)
      return JSON.stringify(field === "version" ? version : published.get(spec))
    }
    if (verb === "publish") {
      const entry = candidate.packages.find((entry) => args[1] === join(directory, entry.filename))
      if (!known.has(entry.name) && !entry.name.startsWith("@smthrs/") && !granted.has(entry.name)) {
        throw failure("E403", `403 Forbidden - PUT https://registry.npmjs.org/${entry.name} - You may not perform that action with these credentials.`)
      }
      known.add(entry.name)
      published.set(`${entry.name}@${entry.version}`, entry.integrity)
      return ""
    }
    assert.deepEqual([command, ...args.slice(0, 2)], ["npm", "dist-tag", "add"])
    const [name, version] = at(args[2])
    tags.set(`${name}:${args[3]}`, version)
    return ""
  } })
  return { calls, adapter }
}

const nameReads = (calls) => calls.filter(([, verb, , field]) => verb === "view" && field === "name").map(([, , name]) => name)
const uploads = (calls) => calls.filter(([, verb]) => verb === "publish").map(([, , path]) => path)
const refusal = (names) => (error) => {
  assert.ok(error.message.startsWith(`npm has no package named ${names}. `), error.message)
  assert.match(error.message, /release-resume\.md/)
  assert.match(error.message, /\nOnce the release token can create such a name, list it in allowNewNames /)
  return true
}

// v1.0.0-rc.18 (run 44620940500) created `@smthrs/fuzz`,
// `@smthrs/platform-cloudflare` and `@smthrs/views` with the release token:
// npm already served other `@smthrs` packages of that roster.
test("a new name in a scope the roster already holds on npm is created by the train", () => fixture(async (directory, candidate, options) => {
  const npm = npmRegistry(directory, candidate, { known: new Set(["@smthrs/core", "smthrs"]) })
  const lines = []
  const result = await publishCandidate(directory, candidate, { ...options, ...npm.adapter, log: (line) => lines.push(line) })
  assert.deepEqual(result, ["@smthrs/core", "@smthrs/fuzz", "@smthrs/views", "smthrs"])
  assert.deepEqual(nameReads(npm.calls), ["@smthrs/core", "@smthrs/fuzz", "@smthrs/views", "smthrs"])
  assert.deepEqual(lines, [
    "New npm name @smthrs/fuzz: its scope @smthrs already holds packages of this candidate, so the release token creates it.",
    "New npm name @smthrs/views: its scope @smthrs already holds packages of this candidate, so the release token creates it."
  ])
}, ["@smthrs/core", "@smthrs/fuzz", "@smthrs/views", "smthrs"]))

test("a new unscoped name stops the train before its first upload and is named", () => fixture(async (directory, candidate, options) => {
  const npm = npmRegistry(directory, candidate, { known: new Set(["a", "b"]) })
  await assert.rejects(publishCandidate(directory, candidate, { ...options, ...npm.adapter }), (error) => {
    refusal("smithers-ci")(error)
    assert.match(error.message, /\n +npm publish smithers-ci\.tgz --access public --tag staging --provenance=false\n/)
    return true
  })
  assert.deepEqual(uploads(npm.calls), [])
  assert.deepEqual(npm.calls.filter(([, verb]) => verb === "dist-tag"), [])
  await assert.rejects(readFile(join(directory, "publish-receipt.json")), /ENOENT/)
}, ["a", "smithers-ci", "b"]))

test("a new name in a scope with no package of the roster on npm stops the train", () => fixture(async (directory, candidate, options) => {
  const npm = npmRegistry(directory, candidate, { known: new Set(["@smthrs/core", "b"]) })
  await assert.rejects(publishCandidate(directory, candidate, { ...options, ...npm.adapter }), refusal("@elsewhere/tool"))
  assert.deepEqual(uploads(npm.calls), [])
  // Two new names cannot establish their own scope for each other.
  const fresh = { ...candidate, packages: candidate.packages.map((entry) => entry.name === "@smthrs/core" ? { ...entry, name: "@fresh/one" } : entry.name === "@elsewhere/tool" ? { ...entry, name: "@fresh/two" } : entry) }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(fresh.packages))
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify(fresh))
  await recordSmokeSuccess(directory, fresh)
  const other = npmRegistry(directory, fresh, { known: new Set(["b"]) })
  await assert.rejects(publishCandidate(directory, fresh, { ...options, ...other.adapter }), refusal("@fresh/one, @fresh/two"))
  assert.deepEqual(uploads(other.calls), [])
}, ["@smthrs/core", "@elsewhere/tool", "b"]))

test("allowNewNames admits exactly the packages it names", () => fixture(async (directory, candidate, options) => {
  const granted = new Set(["smithers-ci", "other-new"])
  const one = npmRegistry(directory, candidate, { known: new Set(["a"]), granted })
  await assert.rejects(publishCandidate(directory, candidate, { ...options, ...one.adapter, allowNewNames: ["smithers-ci"], log: () => {} }), refusal("other-new"))
  assert.deepEqual(uploads(one.calls), [])
  const lines = []
  const both = npmRegistry(directory, candidate, { known: new Set(["a"]), granted })
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, ...both.adapter, allowNewNames: ["smithers-ci", "other-new"], log: (line) => lines.push(line) }), ["a", "smithers-ci", "other-new"])
  assert.deepEqual(lines, [
    "allowNewNames admitted smithers-ci: npm has no package of that name, and this run creates it.",
    "allowNewNames admitted other-new: npm has no package of that name, and this run creates it."
  ])
  // Exact names only, and only names of this candidate.
  assert.deepEqual(parseAllowNewNames(" smithers-ci , other-new,"), ["smithers-ci", "other-new"])
  assert.deepEqual(parseAllowNewNames(undefined), [])
  for (const value of ["@smthrs/*", "smithers-ci other-new", "Smithers-CI"]) assert.throws(() => parseAllowNewNames(value), /exact package names/)
  const typo = npmRegistry(directory, candidate, { known: new Set(["a"]), granted })
  await assert.rejects(publishCandidate(directory, candidate, { ...options, ...typo.adapter, allowNewNames: ["smithers-ci", "other-neww"] }), /allowNewNames names a package outside this candidate: other-neww/)
  assert.deepEqual(uploads(typo.calls), [])
}, ["a", "smithers-ci", "other-new"]))

test("existing names that lack this version pass the name check and publish", () => fixture(async (directory, candidate, options) => {
  const npm = npmRegistry(directory, candidate, { known: new Set(["a", "b"]) })
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, ...npm.adapter }), ["a", "b"])
  assert.deepEqual(nameReads(npm.calls), ["a", "b"])
  // Every name is read before the first upload.
  const lastNameRead = npm.calls.findLastIndex(([, verb, , field]) => verb === "view" && field === "name")
  assert.ok(lastNameRead < npm.calls.findIndex(([, verb]) => verb === "publish"))
  assert.deepEqual(uploads(npm.calls), [join(directory, "a.tgz"), join(directory, "b.tgz")])
}))

// The recovery for run 44620940500: 49 versions were uploaded, `smithers-ci`
// was refused and `smthrs` never ran. The owner publishes `smithers-ci` once by
// hand from the candidate's own tarball, then the candidate resumes.
test("a resume treats a new name published by hand from the candidate tarball as published", () => fixture(async (directory, candidate, options) => {
  const [first, ci, cli] = candidate.packages
  const version = ci.version
  const handPublished = integrity(await readFile(join(directory, ci.filename)))
  const state = () => ({
    known: new Set(["a", "smithers-ci", "smthrs"]),
    published: new Map([[`a@${version}`, first.integrity], [`smithers-ci@${version}`, handPublished]]),
    // `npm publish --tag staging` of a first version may also set `latest`.
    tags: new Map([[`smithers-ci:staging`, version], [`smithers-ci:latest`, version]])
  })
  const npm = npmRegistry(directory, candidate, state())
  assert.deepEqual(await publishCandidate(directory, candidate, { ...options, ...npm.adapter }), ["smthrs"])
  // A version npm already serves proves its name, so only `smthrs` is read.
  assert.deepEqual(nameReads(npm.calls), ["smthrs"])
  assert.deepEqual(uploads(npm.calls), [join(directory, cli.filename)])
  assert.deepEqual(npm.calls.filter(([, verb]) => verb === "dist-tag").map(([, , , spec, tag]) => `${spec} ${tag}`),
    [`a@${version} next`, `smithers-ci@${version} next`, `smithers-ci@${version} latest`, `smthrs@${version} next`])
  // Bytes other than the candidate's under the hand-published version are refused.
  const repacked = state()
  repacked.published.set(`smithers-ci@${version}`, integrity(Buffer.from("repacked smithers-ci")))
  const other = npmRegistry(directory, candidate, repacked)
  await assert.rejects(publishCandidate(directory, candidate, { ...options, ...other.adapter }), /Registry integrity mismatch or unavailable: smithers-ci/)
  assert.deepEqual(uploads(other.calls), [])
}, ["a", "smithers-ci", "smthrs"]))

// A dry run publishes nothing, so nothing else would find a new name before
// the tag run. Its publish plan step runs this check on the candidate.
test("a dry run reads every name and names each one the credentials cannot create", () => fixture(async (directory, candidate) => {
  const bin = await mkdtemp(join(tmpdir(), "smithers-npm-"))
  try {
    // `npm view <name> name --json` as npm answers it: the name, or E404.
    await writeFile(join(bin, "npm"), [
      "#!/bin/sh",
      "echo \"$*\" >> \"$NPM_CALLS\"",
      "case \" $UNKNOWN \" in *\" $2 \"*) echo \"npm error code E404\" >&2; echo \"npm error 404 Not Found - GET https://registry.npmjs.org/$2 - Not found\" >&2; exit 1 ;; esac",
      "printf '\"%s\"\\n' \"$2\""
    ].join("\n") + "\n", { mode: 0o755 })
    const check = (unknown, allow = "") => spawnSync(process.execPath, [fileURLToPath(new URL("./publish-release.mjs", import.meta.url)), "--check-names", directory], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UNKNOWN: unknown, NPM_CALLS: join(bin, "calls"), RELEASE_ALLOW_NEW_NAMES: allow }
    })
    const fuzz = "New npm name @smthrs/fuzz: its scope @smthrs already holds packages of this candidate, so the release token creates it.\n"
    const done = `The release credentials can publish all ${candidate.packages.length} package names.\n`
    const refused = check("@smthrs/fuzz smithers-ci c")
    assert.equal(refused.status, 1, refused.stderr)
    assert.equal(refused.stdout, fuzz)
    assert.match(refused.stderr, /npm has no package named smithers-ci, c\. /)
    assert.match(refused.stderr, /npm publish smithers-ci\.tgz --access public --tag staging --provenance=false\n +npm publish c\.tgz /)
    const allowed = check("@smthrs/fuzz smithers-ci c", "smithers-ci,c")
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.equal(allowed.stdout, fuzz + [
      "allowNewNames admitted smithers-ci: npm has no package of that name, and this run creates it.",
      "allowNewNames admitted c: npm has no package of that name, and this run creates it."
    ].join("\n") + "\n" + done)
    const known = check("")
    assert.equal(known.status, 0, known.stderr)
    assert.equal(known.stdout, done)
    const reads = candidate.packages.map((entry) => `view ${entry.name} name --json`)
    assert.deepEqual((await readFile(join(bin, "calls"), "utf8")).trim().split("\n"), [...reads, ...reads, ...reads])
  } finally { await rm(bin, { recursive: true, force: true }) }
}, ["@smthrs/core", "@smthrs/fuzz", "smithers-ci", "c"]))

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
      if (args[0] === "view" && args[2] === "name") return JSON.stringify(args[1])
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
      assert.equal(reads, 64)
      assert.deepEqual(promotions, [])
      assert.deepEqual(pauses, [2, 10, 30, 60, ...Array(60).fill(30)])
    }
  }))
}

test("a package people run by name takes latest with every prerelease", () => {
  assert.deepEqual(consumerTags({ name: "smithers-ci", version: "1.0.0-rc.2" }), ["next", "latest"])
  assert.deepEqual(consumerTags({ name: "smithers-ci", version: "1.0.0" }), ["latest"])
  assert.deepEqual(consumerTags({ name: "@smthrs/cli", version: "1.0.0-rc.2" }), ["next"])
  assert.deepEqual(consumerTags({ name: "@smthrs/cli", version: "1.0.0" }), ["latest"])
})

test("a prerelease moves latest of smithers-ci and of nothing else", () => fixture(async (directory, candidate, options) => {
  const version = "1.0.0-rc.2"
  candidate.packages = candidate.packages.map((entry, index) => ({ ...entry, version, name: index === 0 ? "a" : "smithers-ci" }))
  candidate.source.tag = `v${version}`
  await writeFile(join(directory, "manifest.json"), JSON.stringify(candidate.packages))
  await writeFile(join(directory, "release-manifest.json"), JSON.stringify(candidate))
  await recordSmokeSuccess(directory, candidate)
  const registry = new Map()
  const promotions = []
  await publishCandidate(directory, candidate, { ...options, releaseTag: candidate.source.tag,
    readRegistry: async (spec) => registry.get(spec),
    publish: async (_path, entry) => registry.set(`${entry.name}@${entry.version}`, entry.integrity),
    verifyVersion: async () => true,
    readTag: async (entry, tag) => entry.name === "smithers-ci" && tag === "latest" ? "1.0.0-rc.1" : undefined,
    promote: async (entry, tag) => promotions.push(`${entry.name}:${tag}`)
  })
  assert.deepEqual(promotions, ["a:next", "smithers-ci:next", "smithers-ci:latest"])
  assert.deepEqual(JSON.parse(await readFile(join(directory, "publish-receipt.json"), "utf8")).promoted, ["a", "smithers-ci"])
}))

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
