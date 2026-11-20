/** Publish only the exact tarballs validated by the release manifest. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

// The installer jobs run this module with no dependencies installed.
import { isMain } from "../../../packages/repo-targets/scripts/workspace-root.mjs"

export const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

export const candidateIntegrity = (candidate) => integrity(Buffer.from(JSON.stringify(candidate)))

/** Seconds between registry attempts after a transient failure, and between version reads. */
const retryDelays = [10, 30, 60]

/** npm accepts an upload minutes before it serves the version. On the v1.0.0-rc.18
 * tag run (44620940500) the registry recorded each version 82 to 498 s (median
 * 138 s) after its upload started, out of upload order, so 45 of 51 outlasted a
 * 100 s read ladder per package and the train took 95 minutes. The train therefore
 * uploads every package without waiting, then re-reads every name not yet served
 * for up to 30 minutes after the last upload. Different bytes fail at once. */
const settleDelays = Array(60).fill(30)

/**
 * Packages people run by bare name. `bunx smithers-ci` installs what `latest`
 * names, so `latest` follows every release of these, prereleases included.
 *
 * Every version is published under `staging` and then given its consumer tags
 * with `npm dist-tag add`. npm's documentation says "Publishing a package sets
 * the `latest` tag to the published version unless the `--tag` option is used"
 * (https://docs.npmjs.com/cli/v11/commands/npm-dist-tag), and says nothing of
 * a first version published under another tag, so the release sets `latest`
 * itself rather than rely on what the registry does then.
 */
export const runByName = new Set(["smithers-ci"])

/** The consumer tags a published version takes. */
export const consumerTags = ({ name, version }) =>
  !version.includes("-") ? ["latest"] : runByName.has(name) ? ["next", "latest"] : ["next"]

/** Record the relative release date without treating a clock or a build as shipment.
 * The Mac lifecycle and authenticated artifact receipt providers are not mounted
 * in this publisher yet (T-INS-07 / T-MNT-05). Keep stage M dark until they are.
 * Reuse this publisher rather than creating a second maintainer release path.
 */
export const maintainerReleasePlan = (candidate) => {
  const release = candidate.maintainerRelease
  if (!release || typeof release !== "object") throw new Error("Maintainer release record is required")
  const utc = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) throw new Error("Release dates must be recorded in UTC")
    const time = Date.parse(value)
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("Invalid release date")
    return time
  }
  const launch = utc(release.launchUtc)
  const targetReleaseUtc = new Date(launch + 604800000).toISOString()
  if (release.targetReleaseUtc !== targetReleaseUtc) throw new Error("Maintainer target must be launch UTC plus seven calendar days")
  if (typeof release.launchVersion !== "string" || !release.launchVersion.trim() || release.launchVersion === candidate.source?.tag?.replace(/^v/, "")) throw new Error("Distinct launch and maintainer versions are required")
  // Availability is an observation, never inferred from the requested date.
  if (release.availableUtc !== null && release.availableUtc !== undefined) {
    const available = utc(release.availableUtc)
    if (available < launch + 604800000 || available >= launch + 691200000) throw new Error("Artifact availability must be on UTC day seven")
  }
  return { launchUtc: release.launchUtc, targetReleaseUtc, availableUtc: release.availableUtc ?? null,
    launchVersion: release.launchVersion, releaseVersion: candidate.source?.tag?.replace(/^v/, ""),
    requiredChecks: ["C-MNT-01", "C-MNT-02", "C-MNT-03", "C-MNT-04", "C-MNT-05", "C-MNT-06", "C-REL-03", "C-SEC-02", "C-SEC-03", "C-COL-04", "C-MCH-06"],
    state: "blocked" }
}

const requireReleaseProviders = (candidate) => {
  if (candidate.releaseStage !== undefined && !["launch", "M"].includes(candidate.releaseStage)) throw new Error("Unknown release stage")
  if (candidate.releaseStage === "M" || Object.hasOwn(candidate, "maintainerRelease")) {
    if (candidate.releaseStage !== "M") throw new Error("Maintainer release must declare stage M")
    maintainerReleasePlan(candidate)
    // Caller-written check links or passed markers cannot authorize publication.
    // No alternate publisher, root step, timer unlock or receipt bypass is added.
    throw new Error("Maintainer publication disabled: authenticated Mac upgrade, dependency, security, docs and artifact journey receipts are unavailable (T-MNT-05)")
  }
}

/** The manifest, legacy pack roster and every local artifact must describe the same train. */
export const verifyLocalCandidate = async (directory, candidate) => {
  if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate.packages) || candidate.packages.length === 0 || !candidate.source) throw new Error("Invalid release manifest")
  const roster = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
  if (JSON.stringify(roster) !== JSON.stringify(candidate.packages)) throw new Error("Release manifest does not match the smoke-test package roster")
  const names = new Set()
  const filenames = new Set()
  for (const entry of candidate.packages) {
    if (typeof entry.name !== "string" || entry.name.length === 0 || names.has(entry.name) || typeof entry.filename !== "string" || !entry.filename.endsWith(".tgz") || entry.filename.includes("\\") || basename(entry.filename) !== entry.filename || filenames.has(entry.filename)) throw new Error(`Invalid release entry: ${entry.name}`)
    names.add(entry.name)
    filenames.add(entry.filename)
    if (integrity(await readFile(join(directory, entry.filename))) !== entry.integrity) throw new Error(`Local tarball integrity mismatch: ${entry.name}`)
  }
  const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz")).sort()
  if (JSON.stringify(tarballs) !== JSON.stringify([...filenames].sort())) throw new Error("Release archive contains tarballs outside the tested roster")
}

/** Called only after every installed-consumer probe succeeds; changes during testing invalidate it. */
export const recordSmokeSuccess = async (directory, candidate) => {
  const current = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"))
  if (candidateIntegrity(current) !== candidateIntegrity(candidate)) throw new Error("Release manifest changed during smoke testing")
  await verifyLocalCandidate(directory, candidate)
  await writeFile(join(directory, "smoke-evidence.json"), JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    candidateIntegrity: candidateIntegrity(candidate),
    command: "node .smithers/flows/release/smoke-release.mjs <pack-directory>",
    toolchain: { node: process.version, platform: process.platform, arch: process.arch },
    completedAt: new Date().toISOString()
  }, null, 2) + "\n")
}

/** The `@scope` of a scoped package name, or undefined for an unscoped one. */
export const scopeOf = (name) => name.startsWith("@") && name.includes("/") ? name.slice(0, name.indexOf("/")) : undefined

/** `allowNewNames` (RELEASE_ALLOW_NEW_NAMES): exact package names, comma separated. */
export const parseAllowNewNames = (value = "") => {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "")
  for (const name of names) {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) throw new Error(`allowNewNames takes exact package names, comma separated: ${name}`)
  }
  return names
}

/**
 * Refuse a new name the release credentials cannot create. The release token
 * creates names in the scope it was granted, and trusted publishing creates
 * none. The v1.0.0-rc.18 tag run (44620940500) created `@smthrs/fuzz`,
 * `@smthrs/platform-cloudflare` and `@smthrs/views` with the token, then the
 * unscoped `smithers-ci` answered 403 after 49 immutable uploads, leaving
 * `smthrs` unpublished and no consumer tag moved.
 *
 * A new name is admitted when npm already serves another package of the roster
 * in its scope, or when `allowNewNames` lists it exactly. An unscoped name, or
 * one in a scope with no existing roster package, is refused. `readName`
 * answers the name, or undefined when npm has no package of that name; any
 * other answer fails closed. Entries outside `unread` are already on npm.
 */
export const requireCreatableNames = async (roster, unread, { readName, allowNewNames = [], log = console.log }) => {
  for (const name of allowNewNames) {
    if (!roster.some((entry) => entry.name === name)) throw new Error(`allowNewNames names a package outside this candidate: ${name}`)
  }
  const existing = new Set(roster.filter((entry) => !unread.includes(entry)).map((entry) => entry.name))
  const fresh = []
  for (const entry of unread) {
    const answer = await readName(entry.name)
    if (answer === entry.name) existing.add(entry.name)
    else if (answer === undefined) fresh.push(entry)
    else throw new Error(`Registry name check unavailable: ${entry.name}`)
  }
  const established = new Set([...existing].map(scopeOf).filter((scope) => scope !== undefined))
  const refused = []
  for (const entry of fresh) {
    if (established.has(scopeOf(entry.name))) log(`New npm name ${entry.name}: its scope ${scopeOf(entry.name)} already holds packages of this candidate, so the release token creates it.`)
    else if (allowNewNames.includes(entry.name)) log(`allowNewNames admitted ${entry.name}: npm has no package of that name, and this run creates it.`)
    else refused.push(entry)
  }
  if (refused.length === 0) return
  throw new Error([
    `npm has no package named ${refused.map((entry) => entry.name).join(", ")}. The release credentials cannot create it: the release token creates names only in a scope it was granted, taken here as a scope that already holds a published package of this candidate, and trusted publishing creates none. No package of this candidate is uploaded until npm knows these names. For each name, the npm account owner:`,
    "  1. Publishes it once by hand from this candidate's own tarball, in the candidate's release-candidate-<run id> archive. The resume's integrity check accepts only those bytes:",
    ...refused.map((entry) => `       npm publish ${entry.filename} --access public --tag staging --provenance=false`),
    "  2. Gives the release credentials the name: adds it to the packages of the NPM_TOKEN token and configures its trusted publisher.",
    "  3. Resumes this candidate as .smithers/flows/release/release-resume.md says (\"A package name that is new to npm\").",
    "Once the release token can create such a name, list it in allowNewNames (the Release workflow input, or RELEASE_ALLOW_NEW_NAMES), comma separated, instead."
  ].join("\n"))
}

/** Preflight the whole train before any publish: an existing mismatch refuses all missing packages. */
export const preflight = async (directory, candidate, { sourceSha, releaseTag, readRegistry, readName, allowNewNames = [], log = console.log }) => {
  requireReleaseProviders(candidate)
  await verifyLocalCandidate(directory, candidate)
  if (candidate.source.sha !== sourceSha || candidate.source.tag !== releaseTag || candidate.source.dirty !== false) throw new Error("Release source/tag does not match the clean tested candidate")
  const evidence = JSON.parse(await readFile(join(directory, "smoke-evidence.json"), "utf8"))
  if (evidence.schemaVersion !== 1 || evidence.status !== "passed" || evidence.candidateIntegrity !== candidateIntegrity(candidate)) throw new Error("Release candidate has no matching successful smoke evidence")
  const pending = []
  for (const entry of candidate.packages) {
    if (entry.version !== releaseTag.replace(/^v/, "")) throw new Error(`Invalid release entry: ${entry.name}`)
    const existing = await readRegistry(`${entry.name}@${entry.version}`)
    if (existing === undefined) pending.push(entry)
    else if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch or unavailable: ${entry.name}`)
  }
  // A version npm already serves proves its name exists, so a resume after a
  // name was published by hand reads only the names still pending.
  await requireCreatableNames(candidate.packages, pending, { readName, allowNewNames, log })
  return pending
}

export const publishCandidate = async (directory, candidate, options) => {
  const pending = await preflight(directory, candidate, options)
  const published = []
  const awaiting = []
  const promoted = []
  const record = () => writeFile(join(directory, "publish-receipt.json"), JSON.stringify({ schemaVersion: 1, source: candidate.source, published, promoted, awaiting: awaiting.map((entry) => entry.name) }, null, 2) + "\n")
  // The registry can accept a tarball before it serves the version. Only an
  // absent version waits; different bytes fail at once.
  const served = async (entry) => {
    const observed = await options.readRegistry(`${entry.name}@${entry.version}`)
    if (observed !== undefined && observed !== entry.integrity) throw new Error(`Published integrity could not be verified: ${entry.name}`)
    return observed !== undefined
  }
  for (const [index, entry] of pending.entries()) {
    // A predecessor's publication may take minutes. Recheck the next local bytes
    // instead of relying on the earlier train preflight across that interval.
    if (integrity(await readFile(join(directory, entry.filename))) !== entry.integrity) throw new Error(`Local tarball integrity mismatch: ${entry.name}`)
    await options.publish(join(directory, entry.filename), entry)
    // One read catches different bytes before the next upload; an absent
    // version waits with the train instead of holding the next upload.
    if (await served(entry)) published.push(entry.name)
    else awaiting.push(entry)
    await record()
    if (index < pending.length - 1) await options.pause?.(2)
  }
  for (const delay of [...settleDelays, undefined]) {
    for (const entry of [...awaiting]) {
      if (!(await served(entry))) continue
      awaiting.splice(awaiting.indexOf(entry), 1)
      published.push(entry.name)
      await record()
    }
    if (awaiting.length === 0) break
    if (delay !== undefined) await options.pause?.(delay)
  }
  if (awaiting.length) throw new Error(`Published integrity could not be verified: ${awaiting.map((entry) => entry.name).join(", ")}`)
  // Existing versions on a resume also need to be served before any consumer
  // tag moves. The tested roster is dependency ordered; the CLI alias moves last.
  for (const entry of candidate.packages) {
    let verified = await options.verifyVersion(entry)
    for (const delay of [...retryDelays, ...settleDelays]) {
      if (verified) break
      await options.pause?.(delay)
      verified = await options.verifyVersion(entry)
    }
    if (!verified) throw new Error(`Published version is not served: ${entry.name}@${entry.version}`)
  }
  await record()
  for (const entry of [...candidate.packages.filter((entry) => entry.name !== "smthrs"), ...candidate.packages.filter((entry) => entry.name === "smthrs")]) {
    // Idempotent tag writes recover a partial promotion without trusting a
    // local receipt over the registry or publishing immutable versions twice.
    // A resumed older train never moves a consumer tag back: a newer version
    // keeps it, and npm-dist-tag.yml remains the deliberate way to move it.
    for (const tag of consumerTags(entry)) {
      const current = await options.readTag(entry, tag)
      // Loaded here, not at the top: the installer jobs import this module for
      // its candidate checks with no dependencies installed, and never promote.
      const { gt } = await import("semver")
      if (current !== undefined && gt(current, entry.version)) continue
      await options.promote(entry, tag)
      if (!promoted.includes(entry.name)) promoted.push(entry.name)
      await record()
    }
  }
  return published
}

/** Keep registry throttling and detached-tag publication behind the verified candidate boundary. */
export const registryPublisher = ({ run = execFileSync, pause = (seconds) => execFileSync("sleep", [String(seconds)]) } = {}) => {
  const invoke = (args, allowMissing, recovered, command = "pnpm") => {
    for (let attempt = 0;; attempt++) {
      try {
        return run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 })
      } catch (error) {
        const diagnostic = `${error.code ?? ""}\n${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`
        // A new name answers 404; a missing version of an existing name answers
        // ERR_PNPM_PACKAGE_NOT_FOUND with no status code.
        if (allowMissing && /\bE?404\b|\bERR_PNPM_PACKAGE_NOT_FOUND\b/.test(diagnostic)) return undefined
        const transient = /\b(?:ERR_PNPM_FETCH_|E)?(?:429|5[0-9][0-9])\b/.test(diagnostic) ||
          /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)\b|socket hang up/i.test(diagnostic)
        if (!transient) throw error
        // A disconnected publish may already have reached the registry. Only
        // an exact integrity match turns its lost acknowledgement into success.
        if (recovered?.()) return undefined
        if (attempt >= retryDelays.length) throw error
        pause(retryDelays[attempt])
      }
    }
  }
  const readRegistry = (spec) => {
    const output = invoke(["view", spec, "dist.integrity", "--json"], true)
    if (output === undefined) return undefined
    const value = JSON.parse(output)
    if (typeof value !== "string" || !value.startsWith("sha512-")) throw new Error(`Registry returned no verifiable integrity for ${spec}`)
    return value
  }
  return { pause, readRegistry,
    // A bare name answers 404 only when npm has no package of that name;
    // a missing version is not asked here.
    readName: (name) => {
      const output = invoke(["view", name, "name", "--json"], true, undefined, "npm")
      return output === undefined ? undefined : JSON.parse(output)
    },
    verifyVersion: (entry) => {
      const output = invoke(["view", `${entry.name}@${entry.version}`, "version", "--json"], true, undefined, "npm")
      return output !== undefined && JSON.parse(output) === entry.version
    },
    // The publish job supplies the same NODE_AUTH_TOKEN as npm-dist-tag.yml.
    // Use the same npm command and token path as npm-dist-tag.yml.
    // A new name answers 404 and a name without the tag prints nothing.
    readTag: (entry, tag) => {
      const output = invoke(["view", entry.name, `dist-tags.${tag}`, "--json"], true, undefined, "npm")
      return output?.trim() ? JSON.parse(output) : undefined
    },
    promote: (entry, tag = entry.version.includes("-") ? "next" : "latest") => invoke(["dist-tag", "add", `${entry.name}@${entry.version}`, tag], false, undefined, "npm"),
    publish: (tarball, entry) =>
    invoke(["publish", tarball, "--provenance", "--access", "public", "--tag", "staging", "--no-git-checks"], false, () => {
      const existing = readRegistry(`${entry.name}@${entry.version}`)
      if (existing === undefined) return false
      if (existing !== entry.integrity) throw new Error(`Registry integrity mismatch or unavailable: ${entry.name}`)
      return true
    }) }
}

export const registryIntegrity = (spec) => registryPublisher().readRegistry(spec)

export const registryName = (name) => registryPublisher().readName(name)

if (isMain(import.meta) && process.argv[2] === "--check-names") {
  // A dry run of a new candidate never reaches the preflight, so its publish
  // plan step runs this. It reads every name: a new one would stop the real run.
  const directory = resolve(process.argv[3] ?? "dist/release-packs")
  const candidate = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"))
  await verifyLocalCandidate(directory, candidate)
  await requireCreatableNames(candidate.packages, candidate.packages, {
    readName: registryName, allowNewNames: parseAllowNewNames(process.env.RELEASE_ALLOW_NEW_NAMES)
  })
  console.log(`The release credentials can publish all ${candidate.packages.length} package names.`)
} else if (isMain(import.meta)) {
  const directory = resolve(process.argv[2] ?? "dist/release-packs")
  const candidate = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"))
  const releaseTag = process.env.RELEASE_TAG
  if (!releaseTag) throw new Error("RELEASE_TAG is required")
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const tagSha = execFileSync("git", ["rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`], { encoding: "utf8" }).trim()
  if (sourceSha !== tagSha) throw new Error("The checked-out source is not the requested release tag")
  await publishCandidate(directory, candidate, {
    sourceSha, releaseTag, allowNewNames: parseAllowNewNames(process.env.RELEASE_ALLOW_NEW_NAMES), ...registryPublisher()
  })
}
