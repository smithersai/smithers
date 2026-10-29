import { Smithers } from "@smthrs/targets"
import { ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "./src/index.ts"
import { listFiles } from "./contracts/check-tracked-hygiene.mjs"
import { repoRoot } from "./scripts/workspace-packages.mjs"

const cwd = "packages/repo-targets"
const sources = Smithers.glob("src/**/*.ts")
// Files the cases import or read beside the suites themselves: the shared
// test helpers, the property helper every package typechecks against, the
// build scripts `BuildLibrary.test.ts` runs, and this declaration, which
// `CiSelection.test.ts` loads.
const testSupportFiles = [
  Smithers.glob("test/**/*.ts"),
  Smithers.glob("test-utils/**"),
  Smithers.glob("scripts/**"),
  Smithers.file("PACKAGE.ts")
]
const testSupport = Smithers.Filegroup({
  srcs: [Smithers.file("//packages/smithers/build/targets/test-support/plan.ts")],
  cwd
})
const check = Smithers.Typecheck({
  srcs: [sources, ...testSupportFiles],
  deps: [testSupport],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [sources, ...testSupportFiles],
  deps: [testSupport],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

/** The whole checkout is the subject of repository-wide engineering gates. */
const repositoryPackages = Object.fromEntries(
  [...new Set(["", ...listFiles(repoRoot, { includeUntracked: true })
    .filter((path) => path === "PACKAGE.ts" || path.endsWith("/PACKAGE.ts"))
    .map((path) => path === "PACKAGE.ts" ? "" : path.slice(0, -"/PACKAGE.ts".length))])]
    .sort()
    .map((directory) => [
      `repositoryInputs_${Buffer.from(directory).toString("hex") || "root"}`,
      Smithers.Filegroup({ cwd: directory === "" ? "./" : directory, srcs: [Smithers.glob("**/*")] })
    ])
)
const repositoryInputs = Smithers.Filegroup({ srcs: Object.values(repositoryPackages) })
const workflowSources = Smithers.Filegroup({ cwd: ".github", srcs: [Smithers.glob("workflows/*.yml")] })

/**
 * The repository contract gates under `contracts/`, digested as the input of
 * each gate here, with the workspace inventory they import from this package's
 * `scripts/`.
 */
const contracts = [
  Smithers.glob("//packages/repo-targets/contracts/**/*.mjs"),
  Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs")
]

/**
 * Fails on a git or jj conflict marker committed into a tracked text file
 * (#3151). A per-commit drift gate: `git grep` over the tree takes a second.
 * Check mode runs it in a scratch copy with no `.git`, where it searches every
 * file no `.gitignore` excludes.
 *
 * @since 1.0.0
 * @category lint
 */
const conflictMarkers = Smithers.Shell.Diff({
  shell: "node packages/repo-targets/contracts/check-conflict-markers.mjs",
  changes: [],
  timeout: "2m"
})

/**
 * The conflict-marker check's own contract: every git and jj marker form, the
 * look-alikes it leaves, binary and untracked files, and a failed search.
 *
 * @since 1.0.0
 * @category test
 */
const conflictMarkersUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-conflict-markers.test.mjs")]),
  srcs: contracts,
  deps: []
})

/** Tracked files must resolve declared paths and exclude local build and agent state. */
const trackedHygiene = Smithers.Shell.Diff({
  shell: "node packages/repo-targets/contracts/check-tracked-hygiene.mjs --projected-tree",
  data: [repositoryInputs],
  changes: [],
  timeout: "2m"
})

const trackedHygieneUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-tracked-hygiene.test.mjs")]),
  srcs: contracts,
  deps: []
})

/**
 * The toolchain drift gate: package.json `engines` and `packageManager`,
 * flake.nix, and the generated CI workflow must agree with the runtimes and
 * package manager `.smithers/WORKSPACE.ts` declares, and every workflow,
 * script and image that names a Rust release must name the channel
 * `rust-toolchain.toml` pins. The gate reads both declarations itself, so a
 * version moves in one file.
 *
 * @since 0.1.0
 * @category test
 */
const toolchainPins = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-toolchain-pins.test.mjs")]),
  srcs: [
    ...contracts,
    Smithers.file("//.smithers/WORKSPACE.ts"),
    Smithers.file("//package.json"),
    Smithers.file("//flake.nix"),
    Smithers.file("//.node-version"),
    Smithers.file("//rust-toolchain.toml"),
    Smithers.file("//PACKAGE.ts"),
    Smithers.file("//.github/scripts/ci/cloud.sh")
  ],
  deps: [workflowSources]
})

/**
 * One `effect` version across every manifest, both lockfiles, and the install.
 *
 * Two Effect instances do not share schema internals, so a duplicate is a
 * runtime defect rather than a size problem. The release pins one supported
 * version and this target proves the tree agrees.
 *
 * @since 0.1.0
 * @category test
 */
const effectVersion = Smithers.NodeTest({
  summary: "Exactly one effect version resolves across every manifest and both lockfiles.",
  featured: true,
  runner: Smithers.entrypoint(Smithers.file("//packages/repo-targets/contracts/check-single-effect-version.mjs")),
  srcs: [...contracts, Smithers.file("//.smithers/flows/release/pack-release.mjs"), Smithers.file("//pnpm-lock.yaml"), Smithers.file("//bun.lock")],
  deps: []
})

/**
 * The effect-version gate's own cases, installed consumer boundaries, and
 * development-only compiler isolation in the root pnpm hook.
 *
 * @since 0.1.0
 * @category test
 */
const releaseContracts = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//packages/repo-targets/contracts/check-single-effect-version.test.mjs"),
    Smithers.file("//packages/repo-targets/contracts/installed-consumer-boundary.test.mjs"),
    Smithers.file("//packages/repo-targets/contracts/dev-compiler-isolation.test.mjs")
  ]),
  srcs: [
    ...contracts,
    Smithers.file("//.smithers/flows/release/pack-release.mjs"),
    Smithers.file("//packages/repo-targets/contracts/check-dependency-boundaries.mjs"),
    Smithers.file("//packages/repo-targets/src/ImportAnalysis.ts"),
    Smithers.file("//.smithers/flows/release/fixtures/installed-consumer/consumer-boundary.mjs"),
    Smithers.file("//.smithers/flows/release/fixtures/installed-consumer/dependency-adapters.mjs"),
    Smithers.file("//packages/repo-targets/scripts/private-effect-adapters.mjs"),
    Smithers.file("//.pnpmfile.mjs")
  ],
  deps: []
})

/**
 * Fails on any pin in the engine or tooling groups that
 * `packages/repo-targets/contracts/test-pins.md` does not explain.
 *
 * A test the default gate never runs to a pass is only acceptable when it is
 * written down.
 *
 * @since 0.1.0
 * @category test
 */
const testPinRegister = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-test-pins.test.mjs")]),
  srcs: [...contracts, Smithers.file("//packages/repo-targets/contracts/test-pins.md")],
  deps: []
})

/** The workspace packages whose manifests declare private Effect adapters. */
const privateAdapterManifests = [
  "packages/smithers",
  "packages/smithers/build/build-cli",
  "packages/smithers/migrate",
  "packages/smithers/flows/platform-node",
  "packages/smithers/flows/platform-bun",
  "packages/smithers/gateway",
  "packages/smithers/flows"
].map((directory) => Smithers.file(`//${directory}/package.json`))

const privateEffectAdapters = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/private-effect-adapters.test.mjs")]),
  srcs: [
    ...contracts,
    Smithers.file("//packages/repo-targets/scripts/private-effect-adapters.mjs"),
    Smithers.file("//packages/repo-targets/package.json"),
    Smithers.file("//packages/repo-targets/scripts/build-library.mjs"),
    Smithers.file("//packages/smithers/scripts/compile-commonjs.mjs"),
    ...privateAdapterManifests,
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: []
})

const driftJob = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/drift-job.test.mjs")]),
  srcs: [
    ...contracts,
    Smithers.file("//PACKAGE.ts"),
    Smithers.file("//package.json"),
    Smithers.file("//.smithers/flows/release/check-api-baseline.mjs"),
    Smithers.file("//.smithers/flows/PACKAGE.ts"),
    Smithers.file("//.smithers/flows/checks/coding-check.sh"),
    Smithers.file("//.github/workflows/drift.yml"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//.github/workflows/release.yml")
  ],
  deps: []
})

/** The Windows kernel suite runs independently of the native and Node host jobs. */
const nativeWindowsWorkflow = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/native-windows.test.mjs")]),
  srcs: [...contracts, Smithers.file("//.github/workflows/native-windows.yml")],
  deps: []
})

/**
 * The web bundle compatibility contract, compiled without a browser process.
 *
 * Browser support is a hard requirement met through layers: the contract entry
 * points must bundle for the browser, and the documented Node-only ones must
 * still fail, and fail only on a documented `node:` built-in. This gates both
 * halves.
 *
 * @since 0.1.0
 * @category test
 */
const webBundleContract = Smithers.NodeTest({
  summary: "Compile the web bundle and validate its exported surface; no browser process is started.",
  featured: true,
  runner: Smithers.entrypoint(Smithers.file("//packages/repo-targets/browser/browser-check.mjs")),
  // The entry points this bundles live in other packages, and a declared glob
  // may not cross a package boundary — it would expand to nothing and read as
  // a contract it is not. The gate is not cacheable, so it re-runs regardless.
  srcs: [Smithers.glob("//packages/repo-targets/browser/**/*.mjs"), Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs")],
  deps: []
})

/** Real-runner sentinels: a declared runner executes its suite and fails closed. */
const runnerContract = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/runner-contract.test.mjs")]),
  srcs: contracts,
  deps: []
})

/** Every red required target in a CI log has an owned known-red entry. */
const knownRedCoverage = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-known-red-coverage.test.mjs")]),
  srcs: [...contracts, Smithers.file("//packages/smithers/build/build-cli/src/KnownRed.ts")],
  deps: []
})

/** Exercises real Bun coverage collection and sealed process receipts. */
const bunCoverage = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//packages/repo-targets/bun-coverage/coverage.test.mjs"),
    Smithers.file("//packages/repo-targets/bun-coverage/receipts.test.mjs"),
    Smithers.file("//packages/repo-targets/bun-coverage/run.test.mjs")
  ]),
  srcs: [Smithers.glob("//packages/repo-targets/bun-coverage/**/*")],
  timeout: "2m",
  deps: []
})

/**
 * The workspace membership reader every release and repository gate shares.
 *
 * @since 0.1.0
 * @category test
 */
const workspacePackages = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/scripts/workspace-packages.test.mjs")]),
  srcs: [Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs"), Smithers.file("//packages/repo-targets/scripts/workspace-packages.d.mts")],
  deps: []
})

/**
 * Lints the contract gates and the Bun coverage collector against the root
 * config's operator-script block: statement style only, no semicolons.
 *
 * @since 1.0.0
 * @category lint
 */
const contractsLint = Smithers.EsLint({
  sources: [
    Smithers.glob("//packages/repo-targets/browser/**/*.mjs"),
    Smithers.glob("//packages/repo-targets/contracts/**/*.mjs"),
    Smithers.glob("//packages/repo-targets/bun-coverage/**/*.mjs"),
    Smithers.glob("//packages/repo-targets/scripts/**/*.mjs")
  ],
  configs: [Smithers.file("//eslint.config.js")],
  deps: [],
  maxWarnings: 0,
  fix: false
})

/**
 * One version across the release line, a declared publishable surface, and the
 * scripts every other gate invokes.
 *
 * The manifests it reads live in other packages, and a declared glob may not
 * cross a package boundary, so `srcs` names only this directory. The gate is
 * therefore not cacheable and re-runs regardless, which is correct: its subject
 * is the whole workspace.
 *
 * @since 1.0.0
 * @category test
 */
const packageContract = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/package-contract.test.mjs")]),
  srcs: contracts,
  deps: []
})

/**
 * Explicit entrypoints preserve reviewed imports and block future source files.
 * @since 1.0.0
 * @category test
 */
const publicExportMaps = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/public-export-maps.test.mjs")]),
  srcs: [
    ...contracts,
    Smithers.file("//packages/smithers/build/build-cli/scripts/public-export-map.mjs"),
    Smithers.file("//packages/repo-targets/contracts/fixtures/public-export-surface.json"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: []
})

/**
 * The barrels re-export what they claim, checked by importing them.
 *
 * A typecheck reads the same source the declarations are generated from, so it
 * cannot catch a re-export that was never written. Loading the module can.
 *
 * @since 1.0.0
 * @category test
 */
const barrels = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/barrels.test.mjs")]),
  srcs: contracts,
  deps: []
})

/**
 * The scheduled signal campaign records its seed, preserves its evidence and
 * verifies it.
 *
 * @since 1.0.0
 * @category test
 */
const reliabilityWorkflow = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/reliability-workflow.test.mjs")]),
  srcs: [...contracts, Smithers.file("//.smithers/flows/release/release-rehearsal.mjs"), Smithers.file("//.github/workflows/reliability.yml")],
  deps: []
})

/**
 * No focused or parked test in the fault matrix, every conditional skip
 * declared with its reason, and every package that carries fault cases wired to
 * a target that runs them.
 *
 * The coverage record the suite reads is an input beside the gates themselves:
 * a required red gate names a row in `fault-gaps.md`, so editing that row has
 * to re-key this target.
 *
 * @since 1.0.0
 * @category test
 */
const faultSkips = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/fault-skips.test.mjs")]),
  srcs: [...contracts, Smithers.file("//packages/repo-targets/contracts/fault-gaps.md")],
  deps: []
})

/**
 * No operator rig under `evals/`, `scripts/`, or a package's `test/faults` tree
 * names one machine's home directory.
 *
 * @since 1.0.0
 * @category test
 */
const machinePaths = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/machine-paths.test.mjs")]),
  srcs: contracts,
  deps: []
})

/**
 * No app tracks a run's scratch output: captured exit codes or enrollment
 * traces.
 *
 * @since 1.0.0
 * @category test
 */
const scratchArtifacts = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/scratch-artifacts.test.mjs")]),
  srcs: contracts,
  deps: []
})

/**
 * The reference indexes every canonical command, retains the compatibility
 * pages, and describes flags accepted by the public parser. The generated
 * manifest and help have their own executable drift gate.
 *
 * @since 1.0.0
 * @category test
 */
const cliVerbs = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/cli-verbs.test.mjs")]),
  srcs: contracts,
  deps: []
})

/**
 * Changed public APIs against the README. This private package has no docs
 * directory and no site reference page, so the README is its whole prose.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({ cwd, context: [Smithers.file("README.md")] })

/**
 * Changed exports against their own JSDoc.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd })

/**
 * `bun.lock` records the dependency ranges the manifests declare.
 *
 * A manifest change is required to refresh both lockfiles, but only
 * `pnpm-lock.yaml` was ever proved: every CI job installs with pnpm and
 * `--frozen-lockfile` rejects a stale one on the spot, while no job runs `bun
 * install` at all. Bun still executes `apps/*`, the `//packages/...:bunTest`
 * matrix, and `packages/smithers/agent/regression`, so a stale entry resolves a
 * real package at the wrong version on exactly those surfaces and nowhere else.
 *
 * The target compares rather than installs. It reads the lockfile's own
 * `workspaces` table against the manifests on disk, which is offline,
 * deterministic, and needs no Bun on the machine.
 *
 * @since 0.1.0
 * @category test
 */
const lockfileParity = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//packages/repo-targets/contracts/check-lockfile-parity.mjs")),
  srcs: [...contracts, Smithers.file("//bun.lock"), Smithers.pnpmWorkspace("//pnpm-workspace.yaml")],
  deps: []
})

/**
 * The lockfile parity gate's own cases.
 *
 * @since 1.0.0
 * @category test
 */
const lockfileParityUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-lockfile-parity.test.mjs")]),
  srcs: [...contracts],
  deps: []
})

/**
 * Every import a workspace source makes is declared by that workspace, and no
 * source under `apps/` or `packages/` imports a durable runtime or model SDK
 * that "Everything is a durable flow" in the root `AGENTS.md` bans: Cloudflare
 * Workflows (directly or through Alchemy), Temporal, Inngest, Trigger.dev, the
 * Vercel AI SDK, LangChain or Mastra.
 *
 * pnpm links the whole workspace under one `node_modules`, so an undeclared
 * import of a sibling still resolves locally and then fails for a consumer who
 * installs the tarball. The sources it reads live in other packages, and a
 * declared glob may not cross a package boundary, so the gate is not cacheable
 * and re-runs regardless.
 *
 * @since 0.1.0
 * @category test
 */
const dependencyBoundaries = Smithers.NodeTest({
  summary: "No package imports cross declared workspace boundaries or a banned durable runtime.",
  featured: true,
  runner: Smithers.entrypoint(Smithers.file("//packages/repo-targets/contracts/check-dependency-boundaries.mjs")),
  srcs: [
    ...contracts,
    Smithers.file("//packages/repo-targets/src/ImportAnalysis.ts"),
    Smithers.file("//packages/repo-targets/scripts/private-effect-adapters.mjs")
  ],
  deps: []
})

/**
 * The dependency-boundaries gate's own cases: workspace reach-throughs, the
 * runtime and development dependency split, private Effect adapters and
 * optional peers count as runtime imports, and the durable-flow ban catches
 * every import form of a banned runtime and no lookalike, and fails the gate
 * on one outside `src/`.
 *
 * @since 0.1.0
 * @category test
 */
const dependencyBoundariesUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/check-dependency-boundaries.test.mjs")]),
  srcs: [
    ...contracts,
    Smithers.file("//packages/repo-targets/src/ImportAnalysis.ts"),
    Smithers.file("//packages/repo-targets/scripts/private-effect-adapters.mjs")
  ],
  deps: []
})

/** The repository conformance suites and the workspace reader they share. */
const conformanceSources = [Smithers.glob("//packages/repo-targets/conformance/**/*.ts")]

/** Typecheck the repository conformance suites. */
const conformanceCheck = Smithers.Typecheck({
  srcs: conformanceSources,
  tsconfig: Smithers.file("conformance/tsconfig.conformance.json"),
  cwd,
  buildMode: false,
  incremental: false,
  deps: []
})

/**
 * Repository-wide CI, publication, coverage and containment policy.
 *
 * These checks read other packages and root configuration, so they run
 * uncached. One runner imports the suites to keep filesystem scans in one
 * process.
 */
const repositoryConformance = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/conformance/repositoryConformance.test.ts")]),
  srcs: conformanceSources,
  deps: [conformanceCheck]
})

/**
 * Every workspace member with tests is reachable from the command CI runs.
 *
 * @since 1.0.0
 * @category test
 */
const testScriptWiring = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/test-script-wiring.test.mjs")]),
  srcs: [
    ...contracts,
    Smithers.file("//.smithers/flows/release/release-rehearsal.mjs"),
    Smithers.file("//PACKAGE.ts"),
    Smithers.file("//.smithers/target-index.json"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: [repositoryInputs]
})

/** Mac distribution deletion and lifecycle handoff contract. */
const macDistribution = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/mac-distribution.test.mjs")]),
  srcs: [...contracts],
  deps: [repositoryInputs]
})

/**
 * No shipped Node composition installs an HTTP client that ignores the egress
 * proxy its environment names. The gate reads shipped source across
 * `packages/`, `apps/` and `flows/`, which a declared glob may not cross, so it
 * re-runs regardless: its subject is the whole workspace.
 *
 * @since 1.0.0
 * @category test
 */
const egressHttpClient = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/egress-http-client.test.mjs")]),
  srcs: [...contracts],
  deps: []
})

/**
 * Actual planner selection, runtime policy, sentinels and cache behavior. It
 * only plans commands, so it stays independent of builds and can run beside a
 * release gate; the NodeTest stays uncached.
 */
const ciInventory = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/ci-inventory.test.mjs")]),
  srcs: [...contracts],
  deps: []
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**",
    Smithers.glob("contracts/**/*.mjs", { exclude: ["**/*.test.mjs"] }),
    Smithers.glob("bun-coverage/**/*.mjs", { exclude: ["**/*.test.mjs"] }),
    Smithers.glob("bun-coverage/**/*.ts", { exclude: ["**/*.test.ts"] }),
    Smithers.glob("browser/**/*.mjs"),
    "scripts/**", "test-utils/**",
    // The repository-contract suites carry their own review checks below.
    "contracts/barrels.test.mjs", "contracts/cli-verbs.test.mjs", "contracts/fault-skips.test.mjs", "contracts/fault-gaps.md",
    "contracts/machine-paths.test.mjs", "contracts/package-contract.test.mjs", "contracts/public-export-maps.test.mjs",
    "contracts/reliability-workflow.test.mjs", "contracts/scratch-artifacts.test.mjs",
    "contracts/egress-http-client.test.mjs", "contracts/ci-inventory.test.mjs", "contracts/test-script-wiring.test.mjs"],
  checks: [
    {
      id: "review-gate-strength",
      title: "Shared review macros cannot be weakened or silenced by the code they review",
      threat:
        "A contributor whose diff carries prompt text or a narrowed include makes every package's model review pass their change unreviewed.",
      lookFor: [
        "smithersReviewPrompt or a rubric that lets diff contents redefine the rubric, or that tells the model to skip files, instead of treating reviewed text as data.",
        "A macro whose failOn defaults to a weaker severity than its README states, or a caller option that overrides failOn or rubric silently.",
        "An anchor or include mapping in review() where the gitDiff paths and the include globs can diverge so changed files escape the reviewed set."
      ],
      paths: ["src/ReviewLint.ts", "src/ReviewTagsMigrationsAndKeys.ts", "src/ReviewDocsAgainstCode.ts", "src/ReviewJsdocAgainstCode.ts"]
    },
    {
      id: "review-context-confinement",
      title: "A review sends the model only the declaring package's files and its named prose",
      threat:
        "A review macro ships a maintainer's .env, keys, or another package's private sources to a third-party model CLI because a default or derived glob matches more than the package.",
      lookFor: [
        "ReviewDocsAgainstCode interpolating packageName, taken from cwd, into a site glob without escaping glob metacharacters such as *, ?, {, or [.",
        "A default include or context glob in any macro that can match .env*, *.pem, credentials files, or node_modules.",
        "anchor() re-rooting an exclude or pattern without Input.resolvePath, so a '..' segment survives into the emitted workspace glob."
      ],
      paths: ["src/ReviewLint.ts", "src/ReviewDocsAgainstCode.ts"]
    },
    {
      id: "build-script-exec",
      title: "Build scripts execute only the package's own toolchain and write only its dist",
      threat:
        "A build started from the wrong working directory deletes or overwrites another tree's dist on a maintainer's machine or CI runner, or ships a CommonJS bundle whose rewritten require() loads a different module.",
      lookFor: [
        "A spawnSync or exec in build-library.mjs that uses a shell or a string command instead of process.execPath with an argv array.",
        "rmSync, cpSync, or writeFileSync whose target is not confined under packageRoot/dist, or that follows a symlink out of it.",
        "The require-path rewrite or import() lowering regex rewriting non-relative or computed specifiers, or content outside require() and import() calls, in emitted CommonJS."
      ],
      paths: ["scripts/**"]
    },
    {
      id: "gate-cache-integrity",
      title: "Every file a gate reads is a declared cache input",
      threat:
        "A contributor changes an undeclared test fixture, config, or tool script so CI reuses a stale green result and merges a broken or malicious change.",
      lookFor: [
        "A target in BuildAndCheckTypeScriptPackage whose tool reads a file (tsconfig, vitest config, eslint config, test-utils, build script) absent from its srcs or sources.",
        "A tsconfig.test.json or vitest config that extends or imports a file (tsconfig.json, a shared base) that the check or test target does not list as an input.",
        "A default such as maxWarnings, passWithNoTests, or fix that a caller can flip to make lint or test pass vacuously."
      ],
      paths: ["src/BuildAndCheckTypeScriptPackage.ts"]
    },
    {
      id: "ci-bootstrap-downloads",
      title: "Every tool the Cloud CI bootstrap downloads and executes is pinned by version and digest",
      threat:
        "A compromised or spoofed release host swaps a jj, ripgrep, Foundry, rustup or Node binary that then runs with the CI task's repository access.",
      lookFor: [
        "A download() or curl that reaches tar/chmod/exec without download_verified, which checks node_digest or tool_digest with sha256sum -c and exits on a mismatch.",
        "A version read from a repository file used unvalidated in a URL or shell word.",
        "apt or npm installs that run lifecycle scripts or use sudo in a Cloud task."
      ],
      paths: ["contracts/require-toolchain.mjs"]
    },
    {
      id: "script-subprocess-args",
      title: "Scripts spawn processes with argument vectors, never shell strings built from inputs",
      threat:
        "A crafted CLI flag, environment value, commit message or git ref makes an operator script run arbitrary shell commands on a maintainer or CI host.",
      lookFor: [
        "exec, execSync or spawn with shell:true, or sh -c, interpolating argv, environment variables, file contents or git output.",
        "A string option split on spaces and executed, like rebase-cache --install.",
        "An unvalidated positional argument placed into go build -ldflags or a similar command-line flag string."
      ],
      paths: ["contracts/check-known-red-coverage.mjs", "bun-coverage/**"]
    },
    {
      id: "credential-scrubbing",
      title: "Cache and registry tokens never reach child processes that do not need them",
      threat:
        "A planner, benchmark or consumer probe subprocess inherits SMITHERS_CACHE_* or registry tokens and leaks them into logs or untrusted package code.",
      lookFor: [
        "A spawn passing { ...process.env } to package installs or repository code without deleting SMITHERS_CACHE_TOKEN, SMITHERS_CACHE_READ_TOKEN, SMITHERS_CACHE_WRITE_TOKEN, NPM_TOKEN or GH_TOKEN.",
        "Environment dumps or error messages that print token-bearing variables."
      ],
      paths: ["contracts/ci-planner.mjs", "contracts/ci-inventory.mjs"]
    },
    {
      id: "home-path-leak-gate",
      title: "The machine-path gate catches every tracked home-directory path under evals, scripts and fault suites",
      threat: "A contributor commits an operator's username and home layout, leaking a maintainer's local identity and paths in the public repository, while the gate stays green.",
      lookFor: [
        "A homePath regex that misses a username-bearing path: the superuser's home (also under macOS's /var), a shell ~<name> home, Windows C:\\Users\\<name> at any escaping depth, or /Users/<name> followed by punctuation or the end of the line.",
        "An isRecorded exemption broader than the reports, archive and SFT-corpus directories it documents.",
        "An inventory command whose failure or empty output is treated as a pass instead of asserting status 0 and a nonempty list.",
        "A git/jj selection that reads an ancestor repository's inventory instead of this workspace's."
      ],
      paths: ["contracts/machine-paths.test.mjs", "contracts/scratch-artifacts.test.mjs"]
    },
    {
      id: "child-process-containment",
      title: "Gate child processes run fixed code with bounded time and no inherited secrets they do not need",
      threat: "A repository file or environment value controls code a gate evaluates, or a hung child survives the gate, running attacker-chosen code or holding CI runner resources.",
      lookFor: [
        "A spawn or spawnSync `--eval`/`-e` string built by interpolating file contents, package names or environment values instead of passing data on stdin or IPC.",
        "A shell: true spawn or an exec() of a string assembled from repository data.",
        "A child spawned without timeout, SIGKILL fallback or t.after cleanup.",
        "A child env built from `...process.env` that forwards cache tokens or credentials (SMITHERS_CACHE_TOKEN, NPM_TOKEN) to a stub it does not need them for.",
        "A PATH prefix pointing at a directory that is not a fresh mkdtemp owned by the test."
      ],
      paths: ["contracts/public-export-maps.test.mjs", "contracts/machine-paths.test.mjs", "contracts/scratch-artifacts.test.mjs"]
    },
    {
      id: "temp-file-safety",
      title: "Gates write only inside fresh temporary directories they create and remove",
      threat: "Another local user on a shared CI runner pre-plants a symlink at a predictable temp path so a gate overwrites or reads a file it should not.",
      lookFor: [
        "A writeFileSync to a predictable tmpdir() path (fixed name or pid) instead of a mkdtemp directory, such as the default smithers-ci-inventory-<pid>.json artifact.",
        "An environment-supplied output path (SMITHERS_CI_INVENTORY) written without checking it stays inside the workspace or a temp directory.",
        "rmSync(..., { recursive: true, force: true }) on a path not returned by mkdtemp in the same test.",
        "symlinkSync into a fixture that points outside the fixture root."
      ],
      paths: ["contracts/cli-verbs.test.mjs", "contracts/public-export-maps.test.mjs"]
    },
    {
      id: "publish-surface-gate",
      title: "The package contract keeps the published npm surface explicit and free of private code",
      threat: "A release publishes a private workspace package, an undeclared file (a .env or credentials fixture), or an unreviewed subpath to every npm user.",
      lookFor: [
        "A publishable manifest accepted without a nonempty `files` allowlist or with publishConfig.access other than public.",
        "The private-dependency check skipping dependency kinds (optionalDependencies, peerDependencies) a consumer installs.",
        "An export-map baseline entry or wildcard subpath admitted without the gate failing on a new source file.",
        "A private: true check that treats a missing or string \"true\" value as private."
      ],
      paths: ["contracts/package-contract.test.mjs", "contracts/public-export-maps.test.mjs", "contracts/barrels.test.mjs"]
    },
    {
      id: "ci-workflow-gates",
      title: "Workflow gates keep required CI jobs failing on real failures",
      threat: "A contributor edits ci.yml or reliability.yml so a required security or test job passes on failure, letting vulnerable code merge to main.",
      lookFor: [
        "An assertion that tolerates continue-on-error: true, `|| true`, or an allow-failure known-red list on a required job.",
        "A regex match on a workflow run string loose enough to accept an extra command that skips or neuters the suite.",
        "A test file excluded from every target in test-script-wiring without a stated reason.",
        "A skip or todo in the fault matrix accepted without a declared reason row in fault-gaps.md."
      ],
      paths: ["contracts/reliability-workflow.test.mjs", "contracts/fault-skips.test.mjs", "contracts/fault-gaps.md"]
    },
    {
      id: "egress-gate-coverage",
      title: "The egress gate reads every shipped source that could install a proxy-blind HTTP client",
      threat: "A contributor ships a Node host that dials origins directly past the sandbox egress proxy, letting a sandboxed run exfiltrate data, while the gate stays green.",
      lookFor: [
        "A shipped source extension (.js, .cjs, .mts, .cts, .jsx) that isSource drops, so layerUndici or makeDispatcher in it is never scanned.",
        "A skippedDirectories or skippedPaths entry that prunes a directory holding shipped, non-test source.",
        "An isComment rule that exempts a code line (for example one starting with `*` inside an expression, or code after a `/* */` on the same line).",
        "A banned spelling reachable without matching the regex, such as a renamed import or a computed property access on NodeHttpClient.",
        "The defines allowlist or install-count floor changed so the ban can pass with the replacement absent."
      ],
      paths: ["contracts/egress-http-client.test.mjs"]
    },
    {
      id: "inventory-child-process-containment",
      title: "Gate child processes run fixed code with bounded time and no inherited secrets they do not need",
      threat: "A repository file or environment value controls code a gate evaluates, or a hung child survives the gate, running attacker-chosen code or holding CI runner resources.",
      lookFor: [
        "A spawn or spawnSync `--eval`/`-e` string built by interpolating file contents, package names or environment values instead of passing data on stdin or IPC.",
        "A shell: true spawn or an exec() of a string assembled from repository data.",
        "A child spawned without timeout, SIGKILL fallback or t.after cleanup.",
        "A child env built from `...process.env` that forwards cache tokens or credentials (SMITHERS_CACHE_TOKEN, NPM_TOKEN) to a stub it does not need them for.",
        "A PATH prefix pointing at a directory that is not a fresh mkdtemp owned by the test."
      ],
      paths: ["contracts/ci-inventory.test.mjs"]
    },
    {
      id: "inventory-temp-file-safety",
      title: "Gates write only inside fresh temporary directories they create and remove",
      threat: "Another local user on a shared CI runner pre-plants a symlink at a predictable temp path so a gate overwrites or reads a file it should not.",
      lookFor: [
        "A writeFileSync to a predictable tmpdir() path (fixed name or pid) instead of a mkdtemp directory, such as the default smithers-ci-inventory-<pid>.json artifact.",
        "An environment-supplied output path (SMITHERS_CI_INVENTORY) written without checking it stays inside the workspace or a temp directory.",
        "rmSync(..., { recursive: true, force: true }) on a path not returned by mkdtemp in the same test.",
        "symlinkSync into a fixture that points outside the fixture root."
      ],
      paths: ["contracts/ci-inventory.test.mjs"]
    },
    {
      id: "inventory-ci-workflow-gates",
      title: "Workflow gates keep required CI jobs failing on real failures",
      threat: "A contributor edits ci.yml or reliability.yml so a required security or test job passes on failure, letting vulnerable code merge to main.",
      lookFor: [
        "An assertion that tolerates continue-on-error: true, `|| true`, or an allow-failure known-red list on a required job.",
        "A regex match on a workflow run string loose enough to accept an extra command that skips or neuters the suite.",
        "A test file excluded from every target in test-script-wiring without a stated reason.",
        "A skip or todo in the fault matrix accepted without a declared reason row in fault-gaps.md."
      ],
      paths: ["contracts/test-script-wiring.test.mjs", "contracts/ci-inventory.test.mjs"]
    }
  ]
})

/**
 * Checks the proposed Mac install ADR, its supersession links and relative
 * architecture document links, including target headings.
 *
 * @since 0.1.0
 * @category test
 */
const mvpDocs = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/repo-targets/contracts/mvp-docs.test.mjs")]),
  srcs: [
    Smithers.file("//packages/repo-targets/contracts/mvp-docs.test.mjs"),
    Smithers.file("//AGENTS.md"),
    Smithers.file("//docs/architecture/0001-shared-product.md"),
    Smithers.file("//docs/architecture/0002-mac-install.md"),
    Smithers.file("//docs/architecture/self-host-implementation.md"),
    Smithers.file("//.specs/product/mvp.md"),
    Smithers.file("//packages/repo-targets/contracts/check-release-evidence-tags.mjs"),
    Smithers.file("//.specs/engineering/README.md"),
    Smithers.file("//.specs/design/README.md"),
    Smithers.file("//.specs/engineering/spec.md")
  ],
  deps: [repositoryInputs]
})

export const Package = Smithers.Package({ targets: { ...repositoryPackages, repositoryInputs, workflowSources, lockfileParity, lockfileParityUnit, dependencyBoundaries, dependencyBoundariesUnit, conformanceCheck, repositoryConformance, testScriptWiring, macDistribution, egressHttpClient, ciInventory, check, test, workspacePackages, conflictMarkers, mvpDocs, conflictMarkersUnit, trackedHygiene, trackedHygieneUnit, toolchainPins, effectVersion, releaseContracts, privateEffectAdapters, driftJob, nativeWindowsWorkflow, runnerContract, webBundleContract, knownRedCoverage, bunCoverage, testPinRegister, contractsLint, packageContract, publicExportMaps, barrels, reliabilityWorkflow, faultSkips, machinePaths, scratchArtifacts, cliVerbs, reviewDocsAgainstCode, reviewJsdocAgainstCode, ...securityReview } })
