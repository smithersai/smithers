/**
 * The release-validation inventory: every build-graph gate a release candidate
 * must pass before `build-release.mjs` and `pack-release.mjs` run.
 *
 * Two release paths consume it. The root release flow
 * (`flows/release-support/operations.ts`) runs each entry, in order, as its
 * `checks` step. The hand-written `.github/workflows/release.yml` cannot import
 * it, so `release-gates.test.mjs` asserts every entry here appears in that
 * workflow. Before this inventory existed the flow kept its own partial copy
 * and silently skipped the exclusive fault matrix and the WASM byte-compare
 * that the workflow requires; a flow-driven release then proved less than a
 * tag-driven one.
 *
 * Ordinary `ci '//packages/...'` deliberately excludes the `faults` tier, so
 * that selection is spelled out here with the same serial `--jobs 1` the
 * workflow uses: the fault suites hold exclusive resources and cannot share a
 * machine.
 */

/**
 * @typedef {object} ReleaseGate
 * @property {string} name The workflow step name the gate carries in release.yml.
 * @property {"ci" | "test"} verb The `smthrs` verb.
 * @property {string} target The build-graph selection.
 * @property {number} [jobs] An explicit `--jobs` bound; omitted for the default.
 * @property {string} [flowOnly] Why the root flow runs this gate although release.yml does not.
 */

/** @type {readonly ReleaseGate[]} */
export const releaseGates = [
  { name: "Workspace targets", verb: "ci", target: "//packages/...", jobs: 2 },
  { name: "Examples", verb: "ci", target: "//examples/..." },
  {
    name: "Root flows typecheck", verb: "ci", target: "//flows:check",
    flowOnly: "The generated ci.yml declares no job for the root flows, so release.yml mirrors none; the flow gates its own sources."
  },
  {
    name: "Root flows suite", verb: "ci", target: "//flows:suite",
    flowOnly: "The generated ci.yml declares no job for the root flows, so release.yml mirrors none; the flow gates its own sources."
  },
  { name: "Site", verb: "ci", target: "//apps/site/..." },
  { name: "Docs", verb: "ci", target: "//apps/docs/..." },
  // Ordinary workspace CI omits this exclusive tier; the explicit label opts in.
  { name: "Exclusive fault matrix", verb: "test", target: "//packages/...:faults", jobs: 1 },
  // The committed flows_jj.wasm is rebuilt and byte-compared before packing.
  { name: "Rebuild and byte-compare flows_jj.wasm", verb: "test", target: "//crates/flows-jj:wasmReproducibility" },
  { name: "Pack manifest", verb: "test", target: "//scripts:packManifest" },
  { name: "Release version coherence", verb: "test", target: "//scripts:releaseVersion" },
  { name: "Release rehearsal", verb: "test", target: "//scripts:releaseRehearsal" },
  { name: "Release cut", verb: "test", target: "//scripts:releaseCut" }
]

/**
 * The CI jobs the release intentionally does not mirror. Naming them here keeps
 * the omission a decision rather than an oversight: the drift test proves each
 * is still a ci.yml job and that none of its gates leaked into the inventory.
 *
 * @type {readonly { job: string; reason: string }[]}
 */
export const releaseGateExclusions = [
  { job: "rust", reason: "Native Rust tests need cargo and the crate toolchain; the release ships only the committed WASM, which the byte-compare gate proves." },
  { job: "apps-e2e", reason: "The app browser suite needs the runner's Chrome; the release runs the apps/ui typecheck and unit tests instead." }
]

/**
 * The `smthrs` argument vector for one gate, after `pnpm exec smthrs`.
 *
 * @param {ReleaseGate} gate
 * @returns {string[]}
 */
export const releaseGateArgs = (gate) =>
  [gate.verb, gate.target, ...(gate.jobs === undefined ? [] : ["--jobs", String(gate.jobs)]), "--verbose"]

/**
 * The gate as release.yml spells it: single-quoted target, explicit `--jobs`.
 *
 * @param {ReleaseGate} gate
 * @returns {string}
 */
export const releaseGateCommand = (gate) =>
  `pnpm exec smthrs ${gate.verb} '${gate.target}'${gate.jobs === undefined ? "" : ` --jobs ${gate.jobs}`} --verbose`

/**
 * Whether a workflow command runs the gate: the same verb and either the exact
 * target, or a recursive `//dir/...` selection that contains it. A gate with an
 * explicit `--jobs` bound is covered only by a command carrying the same bound,
 * because the bound is part of what the gate promises.
 *
 * @param {string} command A `pnpm exec smthrs …` line from a workflow.
 * @param {ReleaseGate} gate
 * @returns {boolean}
 */
export const commandCovers = (command, gate) => {
  const match = /^pnpm exec smthrs (ci|test) '([^']+)'((?: --jobs \d+)?) --verbose$/.exec(command)
  if (!match || match[1] !== gate.verb) return false
  const [, , target, jobs] = match
  if (gate.jobs !== undefined) return target === gate.target && jobs === ` --jobs ${gate.jobs}`
  if (target === gate.target) return true
  if (!target.endsWith("/...")) return false
  const prefix = target.slice(0, -"/...".length)
  return gate.target === prefix || gate.target.startsWith(`${prefix}/`) || gate.target.startsWith(`${prefix}:`)
}
