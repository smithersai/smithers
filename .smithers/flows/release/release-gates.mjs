import { parse } from "yaml"
import { packageShards, shardJobId } from "../../../packages/repo-targets/ci/shards.ts"

const shardCommands = (verb) => packageShards.map((shard) =>
  `pnpm exec smthrs ${verb} ${shard.patterns.map((pattern) => `'${pattern}'`).join(" ")} --jobs 2 --verbose`)


/**
 * The release-validation inventory: every build-graph gate a release candidate
 * must pass before `build-release.mjs` and `pack-release.mjs` run.
 *
 * It is the only copy. Two release paths run it through one runner,
 * `runReleaseGates` in `release/gates/flow.ts`: the root release flow's
 * `checks` step, and `.github/workflows/release.yml`, whose publish job starts
 * the `release/gates` flow in one step and copies no gate.
 * `release-gates.test.mjs` proves that step is the publish job's only gate
 * entry, and that every gate in the generated ci.yml is an entry here or a
 * declared {@link releaseGateExclusions} entry.
 *
 * Ordinary `ci '//packages/...'` deliberately excludes the `faults` tier, so
 * that selection is spelled out here with the same serial `--jobs 1` the
 * workflow uses: the fault suites hold exclusive resources and cannot share a
 * machine.
 */

/**
 * @typedef {object} ReleaseGate
 * @property {string} name The gate's name in receipts, logs and its results file.
 * @property {"ci" | "test" | "lint" | "build"} verb The `smthrs` verb.
 * @property {string} target The build-graph selection.
 * @property {number} [jobs] An explicit `--jobs` bound; omitted for the default.
 * @property {readonly string[]} [ciCommands] Exact CI commands selected by this gate's recursive target. New commands require an explicit inventory decision.
 */

/**
 * @typedef {object} ReleaseGateException
 * @property {string} name The inventory gate's name.
 * @property {string} command The gate's command, as {@link releaseGateCommand} spells it.
 * @property {string} reason The platform fact that keeps the local path from running it.
 * @property {{ platform: string; arch: string }} [requiredHost] Hosts outside this platform/architecture report the exception.
 */

/**
 * @typedef {object} ReleaseGateExclusion
 * @property {string} job The ci.yml job id.
 * @property {readonly string[]} [commands] The job's exact commands the release omits. Omission describes a whole job for drift diagnostics, but cannot discharge parity.
 * @property {string} reason Why the release does not mirror them.
 */

/**
 * Every release gate, in the order the release runs them.
 *
 * The first block combines the required CI `test`, `repository`, `scripts`,
 * and `docs` gates of the generated ci.yml, plus the root flows' own
 * typecheck and suite, which no CI job runs; then the `apps-e2e` gates the
 * release runs without the browser suite; then the exclusive fault matrix
 * (nightly in reliability.yml, no longer a ci.yml job) and the release-only
 * targets; then the `wasm-repro` pair and the shared backend gates.
 * `release-gates.test.mjs` proves every ci.yml gate is here or excluded.
 *
 * @type {readonly ReleaseGate[]}
 */
export const releaseGates = [
  { name: "Workspace targets", verb: "ci", target: "//packages/...", jobs: 2, ciCommands: shardCommands("ci") },
  { name: "Issue claims and check receipts", verb: "test", target: "//.smithers/flows:issueClaim" },
  { name: "Check bindings", verb: "test", target: "//.smithers/flows:evidenceBindings" },
  { name: "Release rehearsal and gate inventory", verb: "test", target: "//.smithers/flows:releaseRehearsal" },
  { name: "Release version suite", verb: "test", target: "//.smithers/flows:releaseVersion" },
  { name: "Command check runner", verb: "test", target: "//.smithers/flows:checkRunner" },
  { name: "Benchmark cost gate", verb: "test", target: "//.smithers/flows:benchmarkGate" },
  { name: "Mutation gate", verb: "test", target: "//.smithers/flows:mutationGate" },
  { name: "Campaign verifiers", verb: "test", target: "//.smithers/flows:campaignVerifiers" },
  { name: "Signal campaign verifier", verb: "test", target: "//.smithers/flows:signalCampaign" },
  { name: "Landing helper", verb: "test", target: "//.smithers/flows:land" },
  { name: "Landing helper end to end", verb: "test", target: "//.smithers/flows:landCommit" },
  { name: "GitHub triage publisher", verb: "test", target: "//.smithers/flows:triagePublish" },
  { name: "Release manifest", verb: "test", target: "//.smithers/flows:packManifest" },
  { name: "Changelog generator", verb: "test", target: "//.smithers/flows:changelog" },
  { name: "Release cut", verb: "test", target: "//.smithers/flows:releaseCut" },
  { name: "Release candidate suites", verb: "test", target: "//.smithers/flows:releaseSuite" },
  { name: "Release publication integrity", verb: "test", target: "//.smithers/flows:releaseIntegrity" },
  { name: "Release smoke", verb: "test", target: "//.smithers/flows:releaseSmoke" },
  { name: "npm consumer dedupe", verb: "test", target: "//.smithers/flows:npmDedupe" },
  { name: "npm consumer dedupe cells", verb: "test", target: "//.smithers/flows:npmDedupeUnit" },
  { name: "Release tools and host recorders", verb: "test", target: "//.smithers/flows:releaseTools" },
  { name: "Release step flows", verb: "test", target: "//.smithers/flows:releaseSteps" },
  { name: "Repository flows", verb: "test", target: "//.smithers/flows:pack" },
  { name: "Judge egress", verb: "test", target: "//.smithers/flows:egress" },
  { name: "Coding host size", verb: "test", target: "//.smithers/flows:codingHostSize" },
  { name: "Repository flow fixtures", verb: "test", target: "//.smithers/flows:repository" },
  { name: "Wiki and release fixtures", verb: "test", target: "//.smithers/flows:fixtures" },
  { name: "Repository flows lint", verb: "lint", target: "//.smithers/flows/..." },
  // The generated ci.yml declares no job for the root flows; the release gates their sources.
  { name: "Root flows typecheck", verb: "ci", target: "//.smithers/flows:check" },
  { name: "Root flows suite", verb: "ci", target: "//.smithers/flows:suite" },
  { name: "Public export JSDoc", verb: "lint", target: "//:jsdocTree" },
  { name: "Repository automation lint", verb: "lint", target: "//.smithers/flows:moduleLint" },
  { name: "JSDoc rule harness", verb: "test", target: "//:jsdocRules" },
  { name: "Reference-host runner hooks", verb: "test", target: "//:referenceHostHooks" },
  { name: "Agent eval suite (offline, baseline-gated)", verb: "test", target: "//packages/smithers/agent/regression:test" },
  { name: "Agent eval typecheck", verb: "build", target: "//packages/smithers/agent/regression:check" },
  { name: "Authoring eval dataset (offline)", verb: "test", target: "//evals/authoring:test" },
  { name: "Authoring eval typecheck", verb: "build", target: "//evals/authoring:check" },
  { name: "SWE-bench offline fixtures", verb: "test", target: "//packages/smithers/agent/harness/benchmarks/swebench:offline", jobs: 1 },
  { name: "SWE-bench rig typecheck", verb: "build", target: "//packages/smithers/agent/harness/benchmarks/swebench:check" },
  { name: "SWE-bench rig lint", verb: "lint", target: "//packages/smithers/agent/harness/benchmarks/swebench/..." },
  { name: "TUI typecheck, lint and tests", verb: "ci", target: "//apps/tui/..." },
  // Exclusive, so the wildcard above omits it; the explicit label opts in.
  { name: "TUI end-to-end suite", verb: "test", target: "//apps/tui:e2eTests" },
  { name: "Review flow", verb: "ci", target: "//.smithers/flows/review/..." },
  { name: "Bug worker", verb: "ci", target: "//apps/bug-worker/..." },
  { name: "Maintainer site", verb: "ci", target: "//apps/maintainer-site/..." },
  { name: "Project copy drift", verb: "lint", target: "//:projectCopy" },
  { name: "Site", verb: "ci", target: "//apps/site/..." },
  { name: "Review eval suite (offline, baseline-gated)", verb: "test", target: "//.smithers/flows/review/seeded-bugs/..." },
  { name: "Review eval typecheck", verb: "build", target: "//.smithers/flows/review/seeded-bugs:check" },
  { name: "Generated workflow drift", verb: "lint", target: "//:ci" },
  { name: "Factory projection drift", verb: "lint", target: "//:factoryProjection" },
  { name: "Target index drift", verb: "lint", target: "//:targetIndex" },
  { name: "Package documentation tarballs", verb: "test", target: "//.smithers/flows:packageDocs" },
  { name: "Native FFI clippy and tests", verb: "build", target: "//:nativeFfi" },
  // Ordinary workspace CI omits this exclusive tier; the explicit label opts in.
  { name: "Exclusive fault matrix", verb: "test", target: "//packages/...:faults", jobs: 1 },
  // Release-only: a pinned target outside its package's `ci`.
  { name: "Disaster-recovery script test", verb: "test", target: "//packages/smithers/flows/engine-store:disasterRecovery" },
  { name: "Build-script unit tests", verb: "test", target: "//packages/smithers/flows/jj-wasm:buildScript" },
  // The committed flows_jj.wasm is rebuilt and byte-compared before packing.
  { name: "Rebuild and byte-compare flows_jj.wasm", verb: "test", target: "//packages/smithers/flows/jj-wasm:wasmReproducibility" }
]

/**
 * Publish-job gates the local release path cannot run, each with the platform
 * fact that stops it. The flow never runs these; it records them in the
 * candidate's gate evidence and the approval prompt so an operator sees what
 * the tag-driven release proves that this run did not.
 *
 * The WASM build script rejects foreign Rust host triples, since their byte
 * output differs by construction. Keep it in the shared inventory and move it
 * into the local exception partition on non-Linux or non-x64 hosts. Linux x64
 * still runs the gate: its own guard verifies the GNU Rust triple, so missing
 * or incompatible tools fail instead of being excused.
 *
 * @type {readonly ReleaseGateException[]}
 */
export const releaseGateExceptions = [{
  name: "Rebuild and byte-compare flows_jj.wasm",
  command: "pnpm exec smthrs test '//packages/smithers/flows/jj-wasm:wasmReproducibility' --verbose",
  reason: "Byte equality requires the pinned x86_64-unknown-linux-gnu Rust host. build-wasm.mjs refuses foreign hosts because Cargo metadata changes the WASM bytes; the canonical release runner must prove this gate.",
  requiredHost: { platform: "linux", arch: "x64" }
}]

/**
 * Partition the shared inventory into gates this host runs and explicit
 * exceptions. Missing tools are failures, never new platform exceptions.
 *
 * @param {{ platform: string; arch: string }} [host]
 * @returns {{ inventory: readonly ReleaseGate[]; exceptions: readonly ReleaseGateException[] }}
 */
export const releaseGateSetForHost = (host = process) => {
  const exceptions = releaseGateExceptions.filter(({ requiredHost }) =>
    requiredHost && (requiredHost.platform !== host.platform || requiredHost.arch !== host.arch))
  return {
    inventory: releaseGates.filter((gate) => !exceptions.some((exception) => exception.command === releaseGateCommand(gate))),
    exceptions
  }
}

/**
 * The CI gates the release intentionally does not mirror, by job. Naming them
 * here keeps each omission a decision rather than an oversight: the drift test
 * proves each is still a ci.yml gate, that the inventory does not run it (or
 * the reason would be false), and that every other CI gate is run by an
 * inventory gate. A job with no entry is mirrored whole: `test`, `repository`, `scripts`, `docs`
 * and `wasm-repro` step for step. Even omitted
 * jobs enumerate today's commands so future additions cannot hide behind a
 * whole-job waiver. `push` is an `on` trigger, not a job.
 *
 * @type {readonly ReleaseGateExclusion[]}
 */
export const releaseGateExclusions = [
  {
    job: "rust",
    commands: [
      "pnpm exec smthrs lint '//packages/smithers/flows/jj-wasm/...' --verbose",
      "pnpm exec smthrs test '//packages/smithers/flows/jj-wasm:cargoTest' --verbose",
      "pnpm exec smthrs test '//packages/smithers/flows/jj:thirdPartyNotices' --verbose"
    ],
    reason: "Native Rust lint and tests validate the native crates, which are not published release artifacts. The release verifies the shipped WASM with the pinned Rust toolchain instead. Third-party notices run under ci '//packages/...'."
  },
  ...shardCommands("test").map((command, index) => ({
    job: shardJobId("packages", index),
    commands: [command],
    reason: "Package shards repeat the Workspace targets gate's tests across platforms; the release runs their complete union through ci '//packages/...' on Linux."
  })),
  {
    job: "browser",
    commands: ["pnpm exec smthrs test '//packages/repo-targets:webBundleContract' --verbose"],
    reason: "The web bundle contract is a //packages/repo-targets NodeTest, so the Workspace targets gate's ci '//packages/...' runs it; the CI job only isolates it under its historical job id."
  }
]

/**
 * The `smthrs` argument vector for one gate, after `pnpm exec smthrs`, writing
 * its results to `resultsFile` when given.
 *
 * @param {ReleaseGate} gate
 * @param {{ resultsFile?: string }} [options]
 * @returns {string[]}
 */
export const releaseGateArgs = (gate, { resultsFile } = {}) => [
  gate.verb,
  gate.target,
  ...(gate.jobs === undefined ? [] : ["--jobs", String(gate.jobs)]),
  ...(resultsFile === undefined ? [] : ["--results-file", resultsFile]),
  "--verbose"
]

/**
 * A gate's results file in `directory`: its name in lowercase words joined by
 * hyphens, so every gate's file is distinct and readable.
 *
 * @param {string} directory
 * @param {Pick<ReleaseGate, "name">} gate
 * @returns {string}
 */
export const releaseGateResultsFile = (directory, gate) =>
  `${directory}/${gate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`

/**
 * The gate as a workflow spells it: single-quoted target, explicit `--jobs`.
 *
 * @param {ReleaseGate} gate
 * @returns {string}
 */
export const releaseGateCommand = (gate) =>
  `pnpm exec smthrs ${gate.verb} '${gate.target}'${gate.jobs === undefined ? "" : ` --jobs ${gate.jobs}`} --verbose`

/**
 * The verb, target and `--jobs` bound of one workflow command, or undefined
 * when the line is not a `pnpm exec smthrs` gate in the workflow's spelling.
 * A `--known-red` list is accepted and dropped: it changes which red targets
 * fail the step, not which targets run.
 *
 * @param {string} command
 * @returns {{ verb: string; target: string; additionalTargets?: string[]; jobs?: number } | undefined}
 */
export const parseGateCommand = (command) => {
  const match = /^pnpm exec smthrs ([a-z]+)((?: '\/\/[^']+')+)(?: --jobs (\d+))?(?: --known-red '[^']+')? --verbose$/.exec(command)
  if (!match) return undefined
  const [, verb, selections, jobs] = match
  const [target, ...additionalTargets] = [...selections.matchAll(/'([^']+)'/g)].map((match) => match[1])
  return { verb, target, ...(additionalTargets.length ? { additionalTargets } : {}), ...(jobs === undefined ? {} : { jobs: Number(jobs) }) }
}

/**
 * Whether a workflow command runs the gate: the same verb and either the exact
 * target, or a recursive `//dir/...` selection that contains it. A gate with an
 * explicit `--jobs` bound is covered only by a command carrying the same bound,
 * because the bound is part of what the gate promises.
 *
 * Verbs never subsume one another here. `ci` does plan the test targets under
 * its pattern, but which tiers it skips is a property of the targets, which a
 * workflow line cannot show; a claim of coverage this function cannot see is
 * left unclaimed.
 *
 * @param {string} command A `pnpm exec smthrs …` line from a workflow.
 * @param {Pick<ReleaseGate, "verb" | "target" | "jobs">} gate
 * @returns {boolean}
 */
export const commandCovers = (command, gate) => {
  const parsed = parseGateCommand(command)
  if (!parsed || parsed.verb !== gate.verb) return false
  const { jobs } = parsed
  return [parsed.target, ...(parsed.additionalTargets ?? [])].some((target) => {
    if (gate.jobs !== undefined) return target === gate.target && jobs === gate.jobs
    if (jobs !== undefined) return false
    if (target === gate.target) return true
    if (!target.endsWith("/...")) return false
    const prefix = target.slice(0, -"/...".length)
    return gate.target === prefix || gate.target.startsWith(`${prefix}/`) || gate.target.startsWith(`${prefix}:`)
  })
}

/**
 * Whether an inventory gate runs a workflow command: the gate's own command
 * covers the command's selection under {@link commandCovers}.
 *
 * @param {ReleaseGate} gate
 * @param {string} command
 * @returns {boolean}
 */
export const gateRuns = (gate, command) => {
  const parsed = parseGateCommand(command)
  if (parsed && (parsed.additionalTargets || gate.ciCommands?.includes(command))) {
    return parsed.jobs === gate.jobs && [parsed.target, ...(parsed.additionalTargets ?? [])].every((target) =>
      commandCovers(releaseGateCommand({ ...gate, jobs: undefined }), { verb: parsed.verb, target }))
  }
  return parsed !== undefined && commandCovers(releaseGateCommand(gate), parsed)
}

/** @param {string} source */
const jobsOf = (source) => {
  const jobs = parse(source)?.jobs
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error("the workflow declares no jobs")
  return jobs
}

/**
 * The job ids a workflow declares, in order.
 *
 * @param {string} source The workflow YAML.
 * @returns {string[]}
 */
export const workflowJobs = (source) => Object.keys(jobsOf(source))

/**
 * Tokenize literal POSIX shell words, retaining the raw command for reports.
 * Quotes concatenate word fragments; backslashes escape outside single
 * quotes, with POSIX's narrower escape set inside double quotes. A comment
 * starts at an unquoted word boundary and ends at the physical newline.
 * This is deliberately not an evaluator: candidate segments containing
 * substitutions are rejected by the caller. Unsupported syntax cannot match an
 * inventory command. Incomplete quotes or escapes cannot certify coverage.
 *
 * @param {string} run
 * @returns {{ command: string; tokens: string[]; valid: boolean }[]}
 */
const shellCommands = (run) => {
  /** @type {{ command: string; tokens: string[]; valid: boolean }[]} */
  const commands = []
  /** @type {string[]} */
  let tokens = []
  let word = ""
  let active = false
  let quote = ""
  let start = 0
  let valid = true
  const finishWord = () => {
    if (active) tokens.push(word)
    word = ""
    active = false
  }
  /** @param {number} end */
  const finishCommand = (end) => {
    finishWord()
    if (tokens.length) commands.push({ command: run.slice(start, end).trim(), tokens, valid: valid && quote === "" })
    tokens = []
    valid = true
  }
  for (let i = 0; i < run.length; i++) {
    const char = run[i]
    if (quote === "'") {
      if (char === "'") quote = ""
      else word += char
      continue
    }
    if (char === "\\") {
      const next = run[i + 1]
      if (next === "\n") { i++; continue }
      if (next === "\r" && run[i + 2] === "\n") { i += 2; continue }
      active = true
      if (next === undefined) { word += char; valid = false; continue }
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += char
      else { word += next; i++ }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ""
      else word += char
      continue
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue }
    if (char === "#" && !active) {
      finishCommand(i)
      while (i < run.length && run[i] !== "\n") i++
      start = i + 1
      continue
    }
    if (char === "\n" || char === ";" || char === "|" || (char === "&" && run[i + 1] === "&")) {
      finishCommand(i)
      if (char === "&") i++
      start = i + 1
      continue
    }
    if (char === " " || char === "\t" || char === "\r") { finishWord(); continue }
    active = true
    word += char
  }
  finishCommand(run.length)
  return commands
}

/**
 * @typedef {{ name: string; command: string; tokens: string[]; valid: boolean }} WorkflowGate
 */

const wrappers = new Set(["env", "time", "nice", "xargs", "sudo", "bash", "sh", "zsh", "eval", "exec"])

/** @param {string} token */
const isGateToken = (token) => /^(\.\/|\/)?(.*\/)?(smthrs|smithers-build)$/.test(token)

/**
 * A release step that starts one repository flow by its literal id:
 * `pnpm exec smthrs flow start <id> [--data <json>] [--wait]`. A flow step is
 * not a target-graph gate, exactly as the `node <module>` steps it replaced
 * were not; only its `--data` value may carry an expansion, because data never
 * selects what runs.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
const isFlowStep = (tokens) => {
  if (tokens.length < 6 || tokens.slice(0, 5).join(" ") !== "pnpm exec smthrs flow start") return false
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(tokens[5])) return false
  for (let at = 6; at < tokens.length; at++) {
    if (tokens[at] === "--data") { at++; if (tokens[at] === undefined) return false; continue }
    if (tokens[at] !== "--wait") return false
  }
  return true
}

/**
 * A binary word or path is a candidate wherever it appears in the segment.
 * Only wrappers interpret their arguments as further shell commands; a node
 * expression or package name containing the binary's name is ordinary data.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
const isGateCandidate = (tokens) => (!isFlowStep(tokens) && tokens.some(isGateToken)) ||
  (wrappers.has(tokens[0]) && tokens.slice(1).some((argument) =>
    shellCommands(argument).some((command) => isGateCandidate(command.tokens))))

/** @param {string} token */
const assignmentOf = (token) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token)

/**
 * Find expansion in the executable position, including pnpm exec and shell
 * wrappers. Expansions in ordinary arguments do not turn metadata into gates.
 * This only applies when the same block assigns a gate-bearing variable.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
const hasIndirectExecutable = (tokens) => {
  let i = 0
  while (tokens[i] !== undefined && assignmentOf(tokens[i])) i++
  const executable = tokens[i]
  if (executable === undefined) return false
  if (/[$`]/.test(executable)) return true
  if (executable === "pnpm" && tokens[i + 1] === "exec") return hasIndirectExecutable(tokens.slice(i + 2))
  if (!wrappers.has(executable)) return false
  const args = tokens.slice(i + 1)
  if (executable === "eval") return shellCommands(args.join(" ")).some((command) => hasIndirectExecutable(command.tokens))
  if (["bash", "sh", "zsh"].includes(executable)) {
    const at = args.findIndex((arg) => /^-[^-]*c/.test(arg))
    return at !== -1 && shellCommands(args[at + 1] ?? "").some((command) => hasIndirectExecutable(command.tokens))
  }
  // These wrapper options consume a value before the executable. Unknown
  // syntax still cannot acquire canonical ownership through token matching.
  const valueOptions = {
    env: ["-u", "--unset", "-C", "--chdir"],
    time: ["-f", "--format", "-o", "--output"],
    nice: ["-n", "--adjustment"],
    xargs: ["-I", "-L", "-n", "-P", "-s", "-E", "-d"],
    sudo: ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-T"],
    exec: ["-a"]
  }
  let at = 0
  while (args[at]?.startsWith("-")) {
    const option = args[at++]
    if (option === "--") break
    if (valueOptions[executable]?.includes(option)) at++
  }
  return hasIndirectExecutable(args.slice(at))
}

/**
 * Discover gate candidates by segment, retaining raw text for unowned reports.
 * Comments and longer words are not candidates. Track same-block assignments
 * so an indirect executable cannot hide a gate without a literal binary word
 * in its own segment. Dynamic candidates can never prove canonical coverage.
 *
 * @param {ReturnType<typeof jobsOf>} jobs
 * @param {string} job
 * @returns {WorkflowGate[]}
 */
const discoveredJobGates = (jobs, job) => {
  if (!Object.hasOwn(jobs, job)) throw new Error(`${job} is not a job in this workflow`)
  return (jobs[job].steps ?? []).flatMap((step) => {
    if (typeof step.run !== "string") return []
    const commands = shellCommands(step.run)
    const assignedValues = []
    for (const { tokens } of commands) {
      let at = ["export", "readonly", "env"].includes(tokens[0]) ? 1 : 0
      while (tokens[at] !== undefined) {
        const assignment = assignmentOf(tokens[at++])
        if (!assignment) break
        assignedValues.push(assignment[2])
      }
    }
    const gateVariable = assignedValues.some((value) => shellCommands(value).some(({ tokens }) => isGateCandidate(tokens)))
    return commands.filter(({ tokens }) => isGateCandidate(tokens) || (gateVariable && hasIndirectExecutable(tokens)))
      .map((command) => {
        const text = command.command.replace(/ --known-red '[^']+'/, "").replace(` ${resultsFileOption}`, "")
        return {
          name: step.name ?? "",
          ...command,
          command: text,
          tokens: withoutResultsFile(withoutKnownRed(command.tokens)),
          valid: command.valid && !/[$`]/.test(text)
        }
      })
  })
}

/** @param {WorkflowGate} step */
const reportedStep = ({ name, command }) => ({ name, command })

/**
 * Every possible gate in a job, in order, with its raw text. YAML parsing
 * handles block/folded scalars and unnamed steps. Ordinary node scripts/...
 * and pnpm exec scripts/... runners remain out of scope unless they contain
 * a gate token. Discovery never requires a known executable prefix or verb.
 *
 * @param {string} source The workflow YAML.
 * @param {string} job The job id.
 * @returns {{ name: string; command: string }[]}
 */
export const workflowGateSteps = (source, job) => discoveredJobGates(jobsOf(source), job).map(reportedStep)

/**
 * Compare literal token vectors to a canonical gate declaration. Wrappers,
 * extra arguments, legacy executable names and dynamic candidates never match.
 *
 * @param {WorkflowGate} step
 * @param {string} command
 */
const matchesCommand = (step, command) => {
  if (!step.valid || !parseGateCommand(command)) return false
  const [canonical] = shellCommands(command)
  return canonical.tokens.length === step.tokens.length && canonical.tokens.every((token, i) => token === step.tokens[i])
}

/**
 * The results file every CI and release step writes for the check receipts
 * (#3663). Like a known-red list it changes neither which targets run nor which
 * fail, so discovery drops it. Only this exact generated path is dropped: any
 * other path or expansion stays in the command and leaves the step unowned.
 */
const resultsFilePath = "$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json"
const resultsFileOption = `--results-file "${resultsFilePath}"`

/** @param {readonly string[]} tokens */
const withoutResultsFile = (tokens) => {
  const at = tokens.indexOf("--results-file")
  return at >= 0 && tokens[at + 1] === resultsFilePath ? [...tokens.slice(0, at), ...tokens.slice(at + 2)] : tokens
}

/**
 * A step's tokens without one `--known-red <path>` pair. The list decides
 * which red targets fail the step, not which targets it runs, so it neither
 * grants nor removes coverage of a gate; discovery reports the step without it.
 *
 * @param {readonly string[]} tokens
 */
const withoutKnownRed = (tokens) => {
  const at = tokens.indexOf("--known-red")
  return at < 0 || tokens[at + 1] === undefined ? tokens : [...tokens.slice(0, at), ...tokens.slice(at + 2)]
}

/**
 * CI requires exactly one canonical owner or an explicit exclusion. The two
 * existing recursive coverage claims are pinned in the inventory, and must
 * still be selections their owner runs. A newly added descendant command is
 * unowned until explicitly inventoried. Dynamic candidates are never excluded.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The generated CI workflow YAML.
 * @param {readonly ReleaseGateExclusion[]} exclusions
 * @returns {{ job: string; name: string; command: string }[]}
 */
export const ciGatesMissingFromInventory = (inventory, source, exclusions) => {
  const jobs = jobsOf(source)
  return Object.keys(jobs).flatMap((job) =>
    discoveredJobGates(jobs, job)
      .filter((step) => !step.valid || !exclusions.some((exclusion) => exclusion.job === job &&
        exclusion.commands?.some((command) => matchesCommand(step, command))))
      .filter((step) => inventory.filter((gate) =>
        matchesCommand(step, releaseGateCommand(gate)) ||
        (gate.ciCommands ?? []).some((command) => gateRuns(gate, command) && matchesCommand(step, command))).length !== 1)
      .map((step) => ({ job, ...reportedStep(step) })))
}

/**
 * Exclusions that no longer describe ci.yml: a job that is gone, a command the
 * job does not run, or an excluded command the inventory runs anyway, which
 * makes the stated reason false.
 *
 * @param {readonly ReleaseGate[]} inventory
 * @param {string} source The generated CI workflow YAML.
 * @param {readonly ReleaseGateExclusion[]} exclusions
 * @returns {string[]}
 */
export const staleExclusions = (inventory, source, exclusions) => {
  const jobs = workflowJobs(source)
  /** @type {string[]} */
  const stale = []
  for (const exclusion of exclusions) {
    if (!jobs.includes(exclusion.job)) { stale.push(`${exclusion.job} is not a ci.yml job`); continue }
    const steps = discoveredJobGates(jobsOf(source), exclusion.job)
    for (const command of exclusion.commands ?? []) {
      if (!steps.some((step) => matchesCommand(step, command))) stale.push(`${exclusion.job} does not run ${command}`)
    }
    for (const step of steps.filter((step) => exclusion.commands === undefined || exclusion.commands.some((command) => matchesCommand(step, command)))) {
      const command = exclusion.commands?.find((command) => matchesCommand(step, command)) ?? step.command
      if (inventory.some((gate) => gateRuns(gate, command))) stale.push(`${exclusion.job} excludes ${step.command}, which the inventory runs`)
    }
  }
  return stale
}
