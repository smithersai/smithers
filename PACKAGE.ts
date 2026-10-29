import { nativeFfiInputs, nativeFfiLib } from "./packages/smithers-ffi/native-targets.ts"
import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import project from "./apps/site/src/data/project.json" with { type: "json" }
import { Package as codingFlowsPackage } from "./.smithers/flows/PACKAGE.ts"

// Workspace selections cross package boundaries as explicit files. Expansion
// retains the shared ignore, repository, symlink and host-state rules.
const workspaceFiles = async (patterns: ReadonlyArray<string>) =>
  (await Promise.all(patterns.map((pattern) => Input.expandGlob(import.meta.dirname, "", `//${pattern}`, {
    packageScoped: false
  })))).flat().sort().map((path) => Smithers.file(`//${path}`))
const workspaceSources = await workspaceFiles([
  "packages/*/src/**/*.ts", "packages/*/*/src/**/*.ts", "packages/*/*/*/src/**/*.ts"
])
const workspaceReviewSources = await workspaceFiles([
  "packages/*/src/**", "packages/*/*/src/**", "packages/*/*/*/src/**"
])
const workspaceReadmes = await workspaceFiles([
  "packages/*/README.md", "packages/*/*/README.md", "packages/*/*/*/README.md"
])
const flowEntries = await workspaceFiles([".smithers/flows/**/flow.ts", ".smithers/flows/**/flow.mdx", ".smithers/flows/**/SKILL.md"])

export const cacheToken = Smithers.Secret("SMITHERS_CACHE_READ_TOKEN")
export const cacheWriteToken = Smithers.Secret("SMITHERS_CACHE_WRITE_TOKEN")
export const cacheUrl = Smithers.Secret("SMITHERS_CACHE_URL")

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const rootInvariantsConfig = Smithers.file("//eslint.invariants.js")

// --- reference docs pipeline (apps/site/prompts/*.md) ---------------------
// The agent that writes generated reference pages. Declared inline because
// this workspace has no `.smithers/agents.ts`; `S.Agents.<name>` would fail
// at index time. Pages are committed, so the model only runs under
// `smithers-build target <pkg>:referenceDocs --write`, never under `ci`.
export const docsWriter = Smithers.Agent.ClaudeCode({ model: "opus" })
export const referenceStyle = Smithers.file("//apps/site/prompts/reference-style.md")
// --- end reference docs pipeline ------------------------------------------
const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")

const tsconfig = Smithers.Tsconfig({
  summary: "Regenerate and check the workspace tsconfig.json from PACKAGE.ts.",
  featured: true,
  mode: "check",
  extends: rootTsconfig,
  compilerOptions: {
    noEmit: true,
    lib: ["ES2024"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    paths: { "*": ["./*"] }
  },
  include: [
    Smithers.file("PACKAGE.ts"),
    Smithers.glob("apps/*/PACKAGE.ts"),
    Smithers.glob("evals/*/PACKAGE.ts"),
    // Eval suites and benchmark rigs live in the package they measure; the
    // depth globs below reach `regression`.
    Smithers.glob("packages/smithers/agent/harness/benchmarks/*/PACKAGE.ts"),
    Smithers.file(".smithers/flows/review/seeded-bugs/PACKAGE.ts"),
    Smithers.file(".smithers/flows/PACKAGE.ts"),
    // One entry per nesting depth, spelled out. Packages nest: a granular
    // package lives inside the product package it belongs to, so
    // `@smthrs/canonical` is `packages/smithers/flows/canonical` and
    // `@smthrs/cli` is `packages/smithers`. Three depths cover the tree, and
    // `packages/**` is deliberately not used: it would sweep in every `dist`
    // tree a build writes, which is the same reason `pnpm-workspace.yaml`
    // names one parent at a time.
    Smithers.glob("packages/*/PACKAGE.ts"),
    Smithers.glob("packages/*/*/PACKAGE.ts"),
    Smithers.glob("packages/*/*/*/PACKAGE.ts"),
  ],
  exclude: [
    Smithers.glob("**/dist/**"),
    Smithers.glob("packages/coding-agent/examples/extensions/gondolin/**")
  ]
})

// The package manager comes from `.smithers/WORKSPACE.ts`, which is where the
// workspace declares it once; the two targets name the file it writes because
// a target's output tree and declared inputs are fixed when this file is
// evaluated, before any workspace declaration has been read.
const lockfilePath = "pnpm-lock.yaml"

const lockfile = Smithers.Lockfile({
  lockfilePath,
  manifests: [workspace]
})

const nodeModules = Smithers.Install({
  lockfilePath,
  lockfile,
  // The workspace definition also keys the install on every patch file its
  // patchedDependencies names, so no patch list is kept here.
  workspaceManifest: workspace,
  // The registry, and the Playwright browser builds (with their apt
  // dependencies) the prepared environment installs for the locked release.
  destinations: [
    "registry.npmjs.org",
    "cdn.playwright.dev",
    "playwright-bkakghazbfe7grc5.z01.azurefd.net",
    "mr-z01.tm-azurefd.net",
    "deb.debian.org",
    "debian.map.fastly.net",
    "debian.map.fastlydns.net"
  ]
})

/**
 * The tool releases a prepared microVM environment installs, each pinned to
 * its linux/arm64 artifact and reviewed SHA-256. `packages/repo-targets/contracts/check-toolchain-pins.mjs`
 * fails when a version here disagrees with `.node-version`, WORKSPACE.ts,
 * go.mod or rust-toolchain.toml. Domain rules match the name a connection
 * resolved through, so CDN CNAME targets are listed beside their aliases.
 *
 * @since 1.0.0
 * @category build
 */
const environmentToolchain = Smithers.Environment.Toolchain({
  downloads: {
    node: {
      version: "26.5.0",
      url: "https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-arm64.tar.xz",
      sha256: "036df0b49662ebb350eb56f1cac603699b1e9ed1e2603ee129fefda473479030"
    },
    pnpm: {
      version: "11.25.0",
      url: "https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz",
      sha256: "33dd0748f27e7916c4f1c8b6943461983e3453b06bbda6312a6280130b4881e5"
    },
    bun: {
      version: "1.4.1",
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.1/bun-linux-aarch64.zip",
      sha256: "580ce77533108dc6b10bec1721397e4f5aa44e909726da2451d483dfc5e581d6"
    },
    go: {
      version: "1.26.8",
      url: "https://go.dev/dl/go1.26.8.linux-arm64.tar.gz",
      sha256: "211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0"
    },
    jj: {
      version: "0.39.0",
      url: "https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-aarch64-unknown-linux-musl.tar.gz",
      sha256: "15bbb0199adf57929d1e3cd90ae0b47356858cbe374814769815a1fb87d5ad1d"
    },
    rg: {
      version: "14.1.1",
      url: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
      sha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f"
    },
    fd: {
      version: "10.2.0",
      url: "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz",
      sha256: "4e8e596646d047d904f2c5ca74b39dccc69978b6e1fb101094e534b0b59c1bb0"
    },
    jq: {
      version: "1.7.1",
      url: "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64",
      sha256: "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5"
    },
    rustup: {
      version: "1.28.2",
      url: "https://static.rust-lang.org/rustup/archive/1.28.2/aarch64-unknown-linux-gnu/rustup-init",
      sha256: "e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c"
    }
  },
  rust: { channel: "1.98.0", components: ["clippy", "rustfmt"], targets: ["wasm32-wasip1"] },
  postgres: "18",
  destinations: [
    "nodejs.org",
    "registry.npmjs.org",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "go.dev",
    "dl.google.com",
    "static.rust-lang.org",
    "fastly-static.rust-lang.org",
    "dualstack.k.sni.global.fastly.net",
    "deb.debian.org",
    "debian.map.fastly.net",
    "debian.map.fastlydns.net",
    "www.postgresql.org",
    "www.mirrors.postgresql.org",
    "apt.postgresql.org",
    "dualstack.t.sni.global.fastly.net"
  ]
})

/**
 * The public project copy derived from one small data file: the root README,
 * the shared regions on the docs overview, and the repository manifest's
 * description. The generated files stay committed so GitHub, npm tooling, and
 * the static site all work without first running the build.
 *
 * `run` writes the files and `lint` checks them for drift. The GIFs are data
 * edges even though the renderer only writes their paths: deleting either
 * asset must break the graph instead of leaving a dead README and docs page.
 *
 * @since 1.0.0
 * @category build
 */
const projectCopySource = Smithers.file("//apps/site/src/data/project.json")
const projectCopy = Smithers.Generate({
  summary: "Regenerate and drift-check the README and shared public project copy.",
  featured: true,
  script: Smithers.file("//apps/site/scripts/generate-project-copy.mjs"),
  data: [
    projectCopySource,
    Smithers.file("//apps/site/public/images/app/home.png"),
    Smithers.file("//apps/site/public/images/build-graph.gif"),
    Smithers.file("//apps/site/public/images/build-graph-light.gif")
  ],
  changes: ["README.md", "package.json", "apps/site/src/content/docs/docs/index.mdx", "apps/site/src/content/docs/docs/developers.mdx"]
})

/**
 * Applies the canonical one-sentence description to the GitHub About panel.
 * ToolRun is an explicit run-only irreversible operation, so no build, lint,
 * test, or CI traversal can update the remote repository accidentally.
 *
 * @since 1.0.0
 * @category release
 */
const repoAbout = Smithers.ToolRun({
  command: "gh",
  args: ["repo", "edit", "smithersai/smithers", "--description", project.description],
  inputs: [projectCopySource],
  deps: [projectCopy],
  cwd: "."
})

// Explicitly snapshot every contributor's current edits. This run-only target
// is never executed by build, test, lint, or CI and never cached or replayed.
const commit = Smithers.ToolRun({
  command: "node",
  args: [".smithers/flows/land/commit.mjs"],
  inputs: [Smithers.file("//.smithers/flows/land/commit.mjs")],
  deps: [],
  cwd: "."
})

// --- factory projection ----------------------------------------------------
// The factory is declared in .smithers/FACTORY.ts beside WORKSPACE.ts: the
// featured flows, the Dispatcher table, the GitHub policy, and the homepage.
// This target projects that declaration into .smithers/factory.json and
// .smithers/home.json, the files smithers.sh reads from the public mirror, so
// a visitor signed out sees them and a workspace without node_modules never
// evaluates FACTORY.ts for a card. The planner fills the declaration from the
// loaded file; nothing here restates it.
const factoryProjection = Smithers.FactoryProjection({
  entries: flowEntries,
  summary: "Regenerate and drift-check .smithers/factory.json and .smithers/home.json from .smithers/FACTORY.ts.",
  featured: true
})
// --- end factory projection ------------------------------------------------

// --- target index ----------------------------------------------------------
// The declaration-derived target index smithers.sh reads from the public
// mirror to show targets beside files: one row per labeled target with its
// rule, kinds, declared inputs and outputs, labeled dependencies, and the
// declaring file, and nothing keyed on a host. The planner fills the rows
// from the loaded declarations, so their content is key material and an edit
// to any PACKAGE.ts re-keys the check. `target --write` writes the file and
// `lint` fails on drift; `smithers-build index '//...'` prints the same rows.
const targetIndex = Smithers.TargetIndex({
  summary: "Regenerate and drift-check .smithers/target-index.json, the declaration-derived target index.",
  featured: true,
  gates: [codingFlowsPackage.testCoverage]
})
// --- end target index ------------------------------------------------------

const ubuntu = "ubuntu-latest"

// One Node for every environment, named once in `.node-version` at the root:
// setup-node reads it here through `node-version-file`, `.github/scripts/ci/cloud.sh`
// reads it to bootstrap a Cloud runner, and fnm, nvm and asdf read it on a
// developer's machine. Before this the same fact was spelled three ways and
// three different releases came out: package.json said >=22.19.0, ci.yml
// installed 22.19.0, and the Cloud bootstrap downloaded 24.21.0.
const node = Smithers.CiToolchain.Node({ versionFile: ".node-version", npmRelease: "11.16.0" })

const bun = Smithers.CiToolchain.Bun({ release: "1.4.1" })

const jj = Smithers.CiToolchain.Jj({ release: "0.39.0" })
// `@smthrs/std` proves its portable search against a real `rg`: the conformance
// suite runs both implementations and compares them. Without the binary the
// native half cannot start and the parity check, which is the point of the
// suite, is the thing that fails.
const ripgrep = Smithers.CiToolchain.Ripgrep({ release: "14.1.1" })
// Confined targets run under bubblewrap on Linux, which the hosted runner
// image does not ship. The step is a no-op on the macOS and Windows rows.
const bubblewrap = Smithers.CiToolchain.Apt({ packages: ["bubblewrap"] })
const packageSystemTools = Smithers.CiToolchain.Apt({ packages: ["bubblewrap", "openssh-server"] })
// `//packages/smithers/build/build-cli:test` drives a real `forge` and a real Go toolchain:
// it builds and tests a Foundry package and asserts `forge fmt --check` drift,
// and it builds a Go package tree. Without them six cases fail on the REQUIRED
// ubuntu row with `host binary "forge" is not present on PATH`, which is a
// missing toolchain rather than a defect.
//
// These were withdrawn once, on the theory that they displaced pnpm from PATH
// and caused ~50 `spawn pnpm ENOENT` failures. That was wrong: the failures
// persisted through two pushes with no Go and no Foundry declared, and 52 of
// the 55 are the Windows `pnpm.cmd` shim problem, on a row that is advisory.
// Foundry v1.8.1 installed cleanly on every runner when it was last declared.
const go = Smithers.CiToolchain.Go({ release: "1.26.8" })
const foundry = Smithers.CiToolchain.Foundry({ release: "v1.8.1" })
// Hosted runners pull anonymously from shared addresses, and Docker Hub
// answered `429 Too Many Requests` for the pinned postgres and alpine images
// on the Release gates lane (job 114021383970: four postgres services and the
// container sandbox suites). Google's Docker Hub mirror serves the same
// digests; the daemon falls back to Docker Hub for anything it cannot serve.
const dockerImageStore = Smithers.CiToolchain.Docker({
  imageStore: "containerd",
  registryMirrors: ["https://mirror.gcr.io"]
})
// The storage matrix (`packages/smithers/flows/database/scripts/test-matrix.mjs`)
// runs every SQL-backed package suite on SQLite and on a throwaway PostgreSQL
// cluster it starts with `initdb`/`pg_ctl`, and refuses when they are missing.
const postgres = Smithers.CiToolchain.Postgres({ release: "18" })

// Clippy and the FFI tests, run by the rust-ffi CI job. Only a
// trusted-process-binding build can import a source outside a guest, so its
// source import CLI test runs as a second pass. It keeps its own rustup home
// and target directory so it never writes nativeFfiLib's output.
const nativeFfi = Smithers.Shell.Build({
  shell: "mkdir -p .native-ffi-check; export RUSTUP_HOME=\"$PWD/.native-ffi-check/rustup\" CARGO_TARGET_DIR=\"$PWD/.native-ffi-check/target\"; rustup toolchain install && cargo clippy -p smithers-ffi --all-targets --locked -- -D warnings && cargo test -p smithers-ffi --locked && cargo test -p smithers-ffi --locked --features trusted-process-binding --test source_import_cli && touch .native-ffi-check/qualified",
  outDirs: ["//.native-ffi-check"],
  data: nativeFfiInputs,
  sandbox: { network: true },
  timeout: "30m"
})

const nativeFilesystem = [{
  package: "smithers-ffi",
  binary: "smithers-jj-export",
  toolchain: "1.98.0",
  environment: "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY",
  platforms: ["linux", "darwin", "win32"]
}] as const

// Cheap drift checks retain a verdict for every commit independently of full CI.
const driftJob = {
  id: "drift",
  name: "Per-commit drift",
  runsOn: ubuntu,
  // A clean run takes 7-10 minutes on ubuntu-latest; a 10-minute cap
  // cancelled runs before //:driftCi and //:ci, leaving a SHA with no verdict.
  timeoutMinutes: 20,
  toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun] }),
  steps: [
    { name: "Formatting", verb: Smithers.Verb.Lint, pattern: "//...:fmt" },
    { name: "Target index drift", verb: Smithers.Verb.Lint, pattern: "//:targetIndex" },
    // factory.json drift used to surface only in the Release gates (#3770).
    { name: "Factory projection drift", verb: Smithers.Verb.Lint, pattern: "//:factoryProjection" },
    { name: "Documentation drift", verb: Smithers.Verb.Lint, pattern: "//:docsDrift" },
    { name: "Declaration baseline", verb: Smithers.Verb.Build, pattern: "//.smithers/flows:apiBaseline" },
    { name: "Conflict markers", verb: Smithers.Verb.Lint, pattern: "//packages/repo-targets:conflictMarkers" },
    { name: "Tracked file hygiene", verb: Smithers.Verb.Lint, pattern: "//packages/repo-targets:trackedHygiene" },
    { name: "Generated drift workflow", verb: Smithers.Verb.Lint, pattern: "//:driftCi" },
    { name: "Generated CI workflow", verb: Smithers.Verb.Lint, pattern: "//:ci" }
  ]
} as const

const trustedDriftCi = Smithers.GithubCiGen({
  workflowName: "Trusted drift",
  output: ".github/workflows/trusted-drift.yml",
  pushBranches: [],
  pullRequest: false,
  workflowDispatch: false,
  workflowCall: true,
  concurrency: "commit",
  knownRed: ".github/ci-known-red.json",
  mode: "check",
  requiredJobs: ["drift"],
  jobs: [{ ...driftJob, trustedSetupRevision: "c4ece3f812c7720ac622c11582d5ef2c085d6a2c" }]
})

const driftCi = Smithers.GithubCiGen({
  workflowName: "Drift",
  output: ".github/workflows/drift.yml",
  concurrency: "commit",
  trustedWorkflowRevision: "7df5f685fc8495bd32c05b192e10f1b8270f016a",
  workflowDispatch: false,
  knownRed: ".github/ci-known-red.json",
  mode: "check",
  deps: [trustedDriftCi],
  requiredJobs: ["drift"],
  jobs: [driftJob]
})

const ci = Smithers.GithubCiGen({
  summary: "Regenerate and drift-check .github/workflows/ci.yml, the pipeline definition (not the run itself).",
  featured: true,
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  workflowDispatch: false,
  // Targets already red on main, each with an owner and an expiry. A step
  // fails only on a red target this list does not name, so a new regression
  // stands out from the known ones. Delete an entry in the change that fixes it.
  knownRed: ".github/ci-known-red.json",
  // Every step writes its per-label results file and each job uploads them, so
  // a check receipt reads a target's status from CI, never from the log (#3663).
  results: true,
  mode: "check",
  gates: [
    { name: "documentation parity", verb: Smithers.Verb.Docs, pattern: "//packages/...", job: "test" },
    { name: "native FFI compiler and tests", verb: Smithers.Verb.Build, pattern: "//:nativeFfi", job: "rust-ffi" },
    { name: "web bundle compatibility", verb: Smithers.Verb.Test, pattern: "//packages/repo-targets:webBundleContract" }
  ],
  requiredJobs: [
    "test",
    "repository",
    "scripts",
    "docs",
    "apps-e2e",
    "rust",
    "wasm-repro",
    "browser",
    "packages",
    "rust-ffi"
  ],
  jobs: [
    {
      id: "test",
      name: "workspace graph (coverage gates enforced)",
      runsOn: ubuntu,
      // Run 36319330660 exceeded 120 min before this split; keep the workspace budget.
      // Remote-cache hits and the remaining workspace budget are tracked in #2254.
      timeoutMinutes: 180,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        postgres,
        docker: dockerImageStore,
        workflowLint: Smithers.CiToolchain.Actionlint({
          release: "1.7.11",
          workflows: [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/release-auth.yml",
            ".github/workflows/npm-dist-tag.yml",
            ".github/workflows/distribution.yml",
            ".github/workflows/reliability.yml",
            ".github/workflows/native-windows.yml",
            ".github/workflows/mirror-sync.yml",
            ".github/workflows/drift.yml",
            ".github/workflows/trusted-drift.yml",
            ".github/workflows/trusted-setup-validation.yml"
          ]
        })
      }),
      steps: [
        { name: "Workspace targets", verb: Smithers.Verb.Ci, pattern: "//packages/...", parallelism: 2 }
      ]
    },
    {
      // Everything the workspace graph used to run after its package step.
      // None of it reads that step's results, so it starts with the other
      // gates instead of queueing behind ~95 minutes of packages (#2361).
      id: "repository",
      name: "repository flows, apps and evals",
      runsOn: ubuntu,
      // Run 36691217680: these steps took ~24 min inside the workspace graph;
      // leave room for the package builds they no longer share with it.
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        postgres,
        docker: dockerImageStore
      }),
      steps: [
        // The registry and migrate-detector checks over flows/. `//.smithers/flows/...`
        // would also select the 45-minute codingNative/codingBundle gates.
        { name: "Repository flows", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:pack" },
        // The one case that proves the coding host's judge tunnels through the
        // egress proxy its environment names instead of dialling the gateway
        // directly. `//.smithers/flows:pack` does not reach it, and the repo-contract
        // grep beside it bans identifiers, not behaviour: a composition that
        // keeps the approved spelling and hands it an environment naming no
        // proxy passes that gate and fails this one.
        { name: "Judge egress", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:egress" },
        // Builds the real coding host: Plue refuses to stage one over its
        // limit, and every hosted coding turn failed when it did (plue#863).
        { name: "Coding host size", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:codingHostSize" },
        // The repository, wiki and release-content fixtures.
        // `//.smithers/flows:pack` reaches none of them and neither did any other job, so
        // until these two steps existed the only thing that ran them was
        // `pnpm test` inside .smithers/flows/, which no workflow invokes. The seven
        // fixtures that skip themselves without the Plue adapter and exporter
        // are deliberately not here: they are declared in the native gate,
        // where a missing prerequisite refuses instead of skipping.
        { name: "Repository flow fixtures", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:repository" },
        { name: "Wiki and release fixtures", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:fixtures" },
        // ESLint and dprint over the flows tree: `//.smithers/flows:lint` and `//.smithers/flows:fmt`.
        { name: "Repository flows lint", verb: Smithers.Verb.Lint, pattern: "//.smithers/flows/..." },
        { name: "Public export JSDoc", verb: Smithers.Verb.Lint, pattern: "//:jsdocTree" },
        { name: "Repository automation lint", verb: Smithers.Verb.Lint, pattern: "//.smithers/flows:moduleLint" },
        { name: "JSDoc rule harness", verb: Smithers.Verb.Test, pattern: "//:jsdocRules" },
        { name: "Reference-host runner hooks", verb: Smithers.Verb.Test, pattern: "//:referenceHostHooks" },
        // Each eval suite lives in the package it measures and is its own
        // workspace member, so its targets carry the standard `check`/`test`
        // names and run from the directory that pins their toolchain.
        {
          name: "Agent eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//packages/smithers/agent/regression:test"
        },
        { name: "Agent eval typecheck", verb: Smithers.Verb.Build, pattern: "//packages/smithers/agent/regression:check" },
        // The authoring fine-tune's dataset validator. It reads the committed
        // `data/pilot-sft.jsonl` and nothing else, so it gates offline; the
        // Fireworks upload and training targets beside it are `run`-verb only
        // and never enter a `ci` graph.
        {
          name: "Authoring eval dataset (offline)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/authoring:test"
        },
        { name: "Authoring eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/authoring:check" },
        // Offline fixtures need only the workspace install. Docker and funded
        // benchmark runs remain operator commands.
        { name: "SWE-bench offline fixtures", verb: Smithers.Verb.Test, pattern: "//packages/smithers/agent/harness/benchmarks/swebench:offline", parallelism: 1 },
        { name: "SWE-bench rig typecheck", verb: Smithers.Verb.Build, pattern: "//packages/smithers/agent/harness/benchmarks/swebench:check" },
        { name: "SWE-bench rig lint", verb: Smithers.Verb.Lint, pattern: "//packages/smithers/agent/harness/benchmarks/swebench/..." },
        // Apps and repository flows have separate source roots from packages.
        // Keep the review flow and its seeded-bug eval in the required gates.
        { name: "Review flow", verb: Smithers.Verb.Ci, pattern: "//.smithers/flows/review/..." },
        { name: "Bug worker", verb: Smithers.Verb.Ci, pattern: "//apps/bug-worker/..." },
        { name: "Project copy drift", verb: Smithers.Verb.Lint, pattern: "//:projectCopy" },
        // smithers.sh: the landing page and the Starlight docs. `astro check`
        // and `astro build` over apps/site/src/content/docs.
        { name: "Site", verb: Smithers.Verb.Ci, pattern: "//apps/site/..." },
        {
          name: "Review eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//.smithers/flows/review/seeded-bugs/..."
        },
        {
          name: "Review eval typecheck",
          verb: Smithers.Verb.Build,
          pattern: "//.smithers/flows/review/seeded-bugs:check"
        },
        // The fault matrix no longer typechecks here. It used to need its own
        // step because it was its own workspace member with its own tsconfig;
        // every case now lives in the package it tests, under `test/faults`,
        // which that package's `check` already covers through the
        // `//packages/...` step above. The reason for the check is unchanged:
        // a stale fixture is deterministic and cheap to catch, and
        // `fixtures/claimChild.ts` once called the removed `Control.pause` and
        // died at runtime in every case that spawned it.
        { name: "Generated workflow drift", verb: Smithers.Verb.Lint, pattern: "//:ci" },
        // The factory projection smithers.sh serves from the public mirror:
        // the featured flows, the Dispatcher table, and the homepage,
        // declared in .smithers/FACTORY.ts, rendered over the .smithers/flows/ tree,
        // checked in.
        { name: "Factory projection drift", verb: Smithers.Verb.Lint, pattern: "//:factoryProjection" },
        // The declaration-derived target index smithers.sh reads from the
        // public mirror, one row per labeled target, checked in.
        { name: "Target index drift", verb: Smithers.Verb.Lint, pattern: "//:targetIndex" }
      ]
    },
    {
      id: "scripts",
      name: "script gates",
      runsOn: ubuntu,
      // Run 36369423415: 13m18s; leave room for uncached work.
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        postgres,
        docker: dockerImageStore,
        artifacts: Smithers.CiToolchain.Artifacts({
          artifact: "ci-test-tier-evidence",
          sources: [
            { from: "/tmp/smithers-ci-inventory-*.json" },
            { from: "/tmp/smithers-mutations-*" },
            { from: "/tmp/smithers-benchmark-*" },
            { from: "/tmp/smithers-runner-*.log" },
            { from: "/tmp/smithers-runner-*.json" }
          ]
        })
      }),
      steps: [
        // The issue-claim convention, check receipts and their bindings, and the
        // release rehearsal and version gates: flows-owned repository automation.
        { name: "Issue claims and check receipts", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:issueClaim" },
        { name: "Check bindings", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:evidenceBindings" },
        { name: "Release rehearsal and gate inventory", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseRehearsal" },
        { name: "Release version suite", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseVersion" },
        { name: "Command check runner", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:checkRunner" },
        // The benchmark, mutation and campaign gates live with their flows in
        // .smithers/flows/bench; the evidence collected above is theirs.
        { name: "Benchmark cost gate", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:benchmarkGate" },
        { name: "Mutation gate", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:mutationGate" },
        { name: "Campaign verifiers", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:campaignVerifiers" },
        { name: "Signal campaign verifier", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:signalCampaign" },
        // The landing helper (`pnpm commit`) and its flows and lane gates.
        { name: "Landing helper", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:land" },
        { name: "Landing helper end to end", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:landCommit" },
        { name: "GitHub triage publisher", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:triagePublish" },
        // The release tooling lives beside the Release flow.
        { name: "Release manifest", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:packManifest" },
        { name: "Changelog generator", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:changelog" },
        { name: "Release cut", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseCut" },
        { name: "Release candidate suites", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseSuite" },
        { name: "Release publication integrity", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseIntegrity" },
        { name: "Release smoke", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseSmoke" },
        { name: "npm consumer dedupe", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:npmDedupe" },
        { name: "npm consumer dedupe cells", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:npmDedupeUnit" },
        { name: "Release tools and host recorders", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseTools" },
        { name: "Release step flows", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:releaseSteps" }
      ]
    },
    {
      id: "docs",
      name: "published package documentation",
      runsOn: ubuntu,
      timeoutMinutes: 45,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], apt: bubblewrap }),
      steps: [{ name: "Package documentation tarballs", verb: Smithers.Verb.Test, pattern: "//.smithers/flows:packageDocs" }]
    },
    {
      id: "apps-e2e",
      name: "apps e2e (TUI)",
      runsOn: ubuntu,
      timeoutMinutes: 70,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        artifacts: Smithers.CiToolchain.Artifacts({
          artifact: "apps-e2e-artifacts",
          sources: [
            { from: "/tmp/smithers-*.png" },
            { from: "apps/reports", as: "reports" }
          ]
        })
      }),
      // Fail the TUI's Linux checks promptly, without waiting behind the
      // workspace graph.
      steps: [
        // The terminal UI's typecheck, lint, format check and Bun suite. Its
        // shell-change capture runs the native helper this job installs.
        { name: "TUI typecheck, lint and tests", verb: Smithers.Verb.Ci, pattern: "//apps/tui/..." },
        // The browser and tmux tiers are exclusive, so the wildcards above omit
        // them and each runs here by label.
        { name: "TUI end-to-end suite", verb: Smithers.Verb.Test, pattern: "//apps/tui:e2eTests" }
      ]
    },
    {
      id: "rust",
      name: "rust fmt + clippy + test",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node],
        rust: Smithers.CiToolchain.Rust({})
      }),
      steps: [
        { name: "Cargo lint gates", verb: Smithers.Verb.Lint, pattern: "//packages/smithers/flows/jj-wasm/..." },
        { name: "Third-party notices", verb: Smithers.Verb.Test, pattern: "//packages/smithers/flows/jj:thirdPartyNotices" },
        { name: "Cargo test suite", verb: Smithers.Verb.Test, pattern: "//packages/smithers/flows/jj-wasm:cargoTest" }
      ]
    },
    {
      id: "rust-ffi",
      name: "native FFI compiler and tests",
      runsOn: ubuntu,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node],
        jj,
        ripgrep,
        apt: bubblewrap,
        rust: Smithers.CiToolchain.Rust({ cache: false })
      }),
      steps: [{ name: "Native FFI clippy and tests", verb: Smithers.Verb.Build, pattern: "//:nativeFfi" }]
    },
    {
      id: "wasm-repro",
      name: "wasm reproducibility",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node],
        rust: Smithers.CiToolchain.Rust({ cache: false })
      }),
      steps: [
        { name: "Build-script unit tests", verb: Smithers.Verb.Test, pattern: "//packages/smithers/flows/jj-wasm:buildScript" },
        {
          name: "Rebuild and byte-compare flows_jj.wasm",
          verb: Smithers.Verb.Test,
          pattern: "//packages/smithers/flows/jj-wasm:wasmReproducibility"
        }
      ]
    },
    {
      id: "browser",
      // This historical job id is pinned by the release roster contract.
      // The displayed name and selected suite describe compilation, not E2E.
      name: "web bundle compatibility",
      runsOn: ubuntu,
      timeoutMinutes: 10,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node] }),
      steps: [{ name: "Web bundle compilation guard", verb: Smithers.Verb.Test, pattern: "//packages/repo-targets:webBundleContract" }]
    },
    {
      // One matrix over the three platforms, replacing the two copy-pasted
      // advisory jobs `node-macos` and `node-windows` and adding a required
      // ubuntu row. The steps, the toolchain, and the timeout are declared
      // once, so a platform can never drift into running a different suite
      // than its neighbours.
      //
      // The ubuntu row re-runs package test targets the required `test` job
      // already covers: that job runs `ci '//packages/...'`, and the `ci` verb
      // aggregates Build, Test, Lint, and Docs. The two jobs run concurrently,
      // so the remote cache does not dedupe them, and ubuntu pays the package
      // suites twice per run. That cost buys a truthful `requiredJobs`: with no
      // required row, `packages` could be deleted or turned all-advisory and
      // nothing would fail. Drop the ubuntu row only together with `packages`
      // in `requiredJobs`.
      //
      // The advisory bit is per row, and it is data: `continue-on-error` reads
      // `matrix.advisory` out of the `include:` rows below, because the
      // generator's only `if:` is the cache-publish guard (unused here) and a
      // job-level `continue-on-error: true` would excuse ubuntu along with the
      // rest. ubuntu is required. macOS and
      // Windows are advisory ONLY until the matrix proves them green; promoting
      // one is flipping its boolean to `false`, and `requiredJobs` already
      // names `packages`, so at least one row must stay required.
      //
      // Windows red today (run 33441825323, job 99651619667) was the build tool
      // itself: `packageManagerEnvironment` held `process.env` to the POSIX
      // name rule, and `windows-latest` sets `ProgramFiles(x86)`, so every
      // target died in 13 s with "environment source contains a non-portable
      // name" before a single suite ran.
      id: "packages",
      name: "package suites (${{ matrix.os }})",
      matrix: [
        { os: ubuntu, advisory: false },
        { os: "macos-latest", advisory: true },
        { os: "windows-latest", advisory: true }
      ],
      // Windows ran the suites in ~48 min before twelve packages also ran on PostgreSQL (f59d673cd); 60 cut it off.
      timeoutMinutes: 90,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: packageSystemTools,
        go,
        foundry,
        postgres,
        docker: dockerImageStore
      }),
      // Match the workspace gate's bound: each suite also runs Vitest workers,
      // so host-sized package concurrency multiplies process and memory load.
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/...", parallelism: 2 }]
    }
  ]
})

// The two workspace-wide model reviews. They cover every package's sources
// with one wildcard rather than a hand-kept list of packages, so a new package
// is under both rubrics the day it exists. A package that wants a narrower or
// stricter review of its own declares one from the same macro in its own
// PACKAGE.ts, the way the storage packages declare `reviewTagsMigrationsAndKeys`.
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd: ".",
  featured: true,
  include: [
    ...workspaceReviewSources
  ],
  context: [
    ...workspaceReadmes,
    // Keep the shared context below LlmLint's 2 MiB cap. Package-level
    // reviews can opt into their full local docs; this overview selects
    // installation plus the runtime and build API sections explicitly.
    Smithers.file("//apps/site/src/content/docs/docs/installation.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/flows.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/flow.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/plan.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/journal.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/targets.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/build.mdx"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/build-cli.mdx")
  ]
})

const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({
  cwd: ".",
  featured: true,
  include: [
    ...workspaceSources
  ]
})

/**
 * Lints public package sources under the repository-default JSDoc convention.
 *
 * @since 1.0.0
 * @category lint
 */
const jsdocTree = Smithers.EsLint({
  sources: [
    ...workspaceSources
  ],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig],
  deps: [],
  maxWarnings: 0,
  fix: false
})

/**
 * The repository's custom JSDoc rule harness: `eslint.jsdoc.js` exports the
 * module-header rule and the convention config, and this suite runs both
 * through ESLint's `Linter` against sample sources. It sits at the root
 * because the config it tests does, and `pnpm run test:jsdoc` is the operator
 * alias.
 *
 * @since 0.1.0
 * @category test
 */
const jsdocRules = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//eslint.jsdoc.test.mjs")]),
  srcs: [
    Smithers.file("//eslint.jsdoc.test.mjs"),
    Smithers.file("//eslint.jsdoc.js"),
    Smithers.file("//eslint.config.js")
  ],
  deps: []
})

/**
 * The reference-host runner's job-started hook admits only main's
 * reference-host workflow and wipes what a previous job left. The hooks run on
 * the self-hosted runner before any checkout installs `smthrs`, so they live
 * with the workflows under `.github/scripts/reference-host/` and the root owns their suite.
 *
 * @since 1.0.0
 * @category test
 */
const referenceHostHooks = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//.github/scripts/reference-host/job-started.test.mjs")]),
  srcs: [Smithers.file("//.github/scripts/reference-host/job-started.sh"), Smithers.file("//.github/scripts/reference-host/setup-runner.sh")],
  deps: []
})

/**
 * The commit-level `CHANGELOG.md` section for the version the manifests carry.
 *
 * `Generate`'s kinds are `run` and `lint`, not `build` and `lint`, so writing
 * is `smithers-build run '//:changelog'` and drift-checking is
 * `smithers-build lint '//:changelog'`. The rule is uncacheable by
 * construction, which is what a generator reading git history needs: no cache
 * entry can outlive the commit that invalidates it.
 *
 * The declared inputs are the three files the generator reads. Its fourth
 * input is the commit range, and there is no input declaration for one. The
 * consequence is visible under `lint`: a check runs the generator against a
 * scratch copy of the tree that deliberately carries no `.git`, so the check
 * proves the block is the canonical rendering of the commits it names, not
 * that it still matches history. The gate that proves it against history is
 * the `Release changelog section` step in `.github/workflows/release.yml`,
 * which runs in a full checkout at the tag.
 *
 * @since 1.0.0
 * @category build
 */
const changelog = Smithers.Generate({
  summary: "Regenerate and drift-check the CHANGELOG.md commit section for the current version.",
  featured: true,
  script: Smithers.file("//.smithers/flows/release/generate-changelog.mjs"),
  data: [
    Smithers.file("//CHANGELOG.md"),
    Smithers.file("//package.json"),
    Smithers.file("//packages/smithers/package.json")
  ],
  changes: ["CHANGELOG.md"]
})

// Every nesting depth, in one brace pattern, because a declaration takes one
// glob and the marker rule already decides the rest: a directory synthesizes
// the standard targets only when it has a `package.json` and no `PACKAGE.ts`.
// The depths are spelled out rather than written `packages/**` so a build's
// `dist` tree can never be mistaken for a package.
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/{*,*/*,*/*/*}",
  macro: BuildAndCheckTypeScriptPackage
})

// Security review of the files the root owns and no nested PACKAGE.ts does:
// the GitHub workflows, the native FFI crate, install-time hooks and patches, and the public
// `.smithers` projections. `packages/smithers/flows/jj-wasm`, `flows`,
// `apps`, `evals`, and `packages` have their own reviewers.
const securityReview = Smithers.SecurityReview({
  cwd: ".",
  include: [
    "PACKAGE.ts",
    "package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.mjs",
    "flake.nix",
    ".github/workflows/*.yml",
    ".github/scripts/**/*.sh",
    ".smithers/*.ts",
    ".smithers/*.json",
    ...flowEntries.filter((input) => /\/flow\.(ts|mdx)$/.test(input.path)).map((input) => input.path),
    "packages/smithers-ffi/Cargo.toml",
    "packages/smithers-ffi/src/*.rs",
    "packages/smithers-ffi/native-targets.ts"
  ],
  checks: [
    {
      id: "gha-untrusted-trigger-secrets",
      title: "Jobs a fork pull request or a comment can start hold no write credential",
      threat:
        "An outside contributor opens a pull request or comments on an issue and runs code that steals the cache write token, npm token, Cloudflare token, mirror token, or an OIDC review identity.",
      lookFor: [
        "SMITHERS_CACHE_WRITE_TOKEN, NPM_TOKEN, CLOUDFLARE_API_TOKEN, IDENTITY_SERVICE_TOKEN, SMITHERS_CLOUD_MIRROR_TOKEN, or CANARY_SESSION_COOKIE referenced by a job that a pull_request or issue_comment event can reach, or by a job without an `environment:` gate.",
        "A pull_request_target or workflow_run trigger that checks out or executes the pull request head.",
        "The `ci` declaration in PACKAGE.ts that generates ci.yml putting a write secret or `cache-publish` step on a job whose `if:` admits pull_request."
      ],
      paths: [".github/workflows/*.yml", "PACKAGE.ts"]
    },
    {
      id: "gha-expression-injection",
      title: "Workflow expressions never splice untrusted text into a shell script",
      threat:
        "A contributor who controls a branch name, PR title, or dispatch input runs arbitrary commands on a runner that holds repository secrets.",
      lookFor: [
        "`${{ github.event.* }}`, `${{ github.head_ref }}`, or `${{ inputs.* }}` interpolated directly inside a `run:` block instead of passed through `env:` and quoted.",
        "release.yml sourceRef, releaseTag, or candidateRunId used before the step that checks it is a full hex SHA, a v<version> tag, or reachable from origin/main.",
        "A third-party `uses:` pinned to a tag or branch instead of a 40-character commit SHA."
      ],
      paths: [".github/workflows/*.yml"]
    },
    {
      id: "release-artifact-provenance",
      title: "Only a tested candidate built from main reaches npm",
      threat:
        "A contributor or a poisoned artifact from another run publishes a malicious @smthrs package to every npm user.",
      lookFor: [
        "The candidateRunId and candidateArtifactId restore path accepting an artifact from a run that a pull_request, a fork, or a non-release workflow produced.",
        "The npm publish step reachable when dryRun is true, when sourceRef is set, or from a tag not on main.",
        "NODE_AUTH_TOKEN or id-token: write present in steps that run repository scripts or `pnpm install` without --ignore-scripts before publication.",
        "npm-dist-tag.yml moving a tag of a name outside @smthrs/, to a version it has not confirmed is on npm, or moving a 0.x `latest` without replaceZeroLatest."
      ],
      paths: [".github/workflows/release.yml", ".github/workflows/release-auth.yml", ".github/workflows/npm-dist-tag.yml"]
    },
    {
      id: "ffi-path-confinement",
      title: "Native file operations never follow a symlink or escape their root",
      threat:
        "A repository author or agent inside a workspace plants a symlink or races a rename so the host reads or overwrites files outside that workspace, including another tenant's checkout.",
      lookFor: [
        "A path component opened without O_NOFOLLOW or openat relative to a held directory fd in atomic_fs.rs, workspace_files.rs, workspace_local.rs, or tree_export.rs.",
        "A check-then-use sequence (symlink_metadata or canonicalize, then a separate open by path) that a concurrent rename can win.",
        "A caller-supplied relative path joined to a root without rejecting absolute paths, `..`, NUL, or Windows drive and UNC prefixes."
      ],
      paths: [
        "packages/smithers-ffi/src/atomic_fs.rs",
        "packages/smithers-ffi/src/atomic_windows_fs.rs",
        "packages/smithers-ffi/src/atomic_windows_handle.rs",
        "packages/smithers-ffi/src/file_eligibility.rs",
        "packages/smithers-ffi/src/tree_export.rs",
        "packages/smithers-ffi/src/workspace_files.rs",
        "packages/smithers-ffi/src/workspace_local.rs"
      ]
    },
    {
      id: "ffi-git-transport",
      title: "Native git and jj invocations cannot be steered by repository or request data",
      threat:
        "A repository author or a crafted source-import request runs commands on the host, leaks the credential socket's token to another origin, or fetches from an attacker's server.",
      lookFor: [
        "A git or jj Command that does not env_clear, disable hooks, pin GIT_CONFIG_GLOBAL, or restrict protocol.allow before touching a checkout.",
        "A ref, URL, or path argument that can start with '-' or contain whitespace and reaches git argv without the exact-format check source_import.rs applies to refs/smithers/workspaces/.",
        "api_base_url or git_url accepted over plain http to a non-loopback host, or http.followRedirects enabled while the credential helper is set."
      ],
      paths: [
        "packages/smithers-ffi/src/source_import.rs",
        "packages/smithers-ffi/src/source_publish.rs",
        "packages/smithers-ffi/src/source_create.rs",
        "packages/smithers-ffi/src/smithers_jj_export.rs",
        "packages/smithers-ffi/src/workspace_engine.rs",
        "packages/smithers-ffi/src/workspace_source.rs"
      ]
    },
    {
      id: "ffi-abi-memory-safety",
      title: "Every exported C function validates its pointers and never unwinds across the ABI",
      threat:
        "A caller passing a null, dangling, or oversized buffer, or input that panics, corrupts memory in the Node or Go host process that serves every workspace.",
      lookFor: [
        "An `extern \"C\"` function in lib.rs that dereferences a pointer or calls from_raw_parts or CStr::from_ptr without a null and length check.",
        "An `extern \"C\"` function whose body is not routed through the catch_unwind `execute` wrapper, or code outside that wrapper that can panic on caller input.",
        "A returned buffer freed by a different allocator or free function than the one that allocated it, or freed twice."
      ],
      paths: ["packages/smithers-ffi/src/lib.rs"]
    },
    {
      id: "install-hook-supply-chain",
      title: "Install-time hooks, patches, and build allowlists add no hidden code execution",
      threat:
        "A contributor slips code into a dependency patch or pnpm hook that runs on every maintainer's machine and CI runner during install.",
      lookFor: [
        ".pnpmfile.mjs readPackage rewriting any package other than the classicCompilerTools names, or adding a dependency, script, or registry URL.",
        "pnpm-workspace.yaml allowBuilds admitting a package that has no documented need for an install script, or .npmrc adding a registry or auth line.",
        "flake.nix or the Dockerfile fetching a source without a pinned hash."
      ],
      paths: [".pnpmfile.mjs", ".npmrc", "pnpm-workspace.yaml", "flake.nix"]
    },
    {
      id: "root-tool-targets",
      title: "Root run and shell targets execute only fixed commands with scoped secrets",
      threat:
        "A contributor who edits project.json or a Shell target runs commands on the maintainer's machine with the GitHub CLI's credentials or the cache write token.",
      lookFor: [
        "A ToolRun or Shell target whose command or args derive from repository data that a pull request can change, beyond repoAbout's description argument to `gh repo edit`.",
        "A Shell target with `sandbox: { network: true }` that also receives cacheWriteToken or another Smithers.Secret.",
        "A credential other than the documented local test database password hard-coded in an env block."
      ],
      paths: ["PACKAGE.ts"]
    },
    {
      id: "public-projection-leak",
      title: "Projections published to the public mirror carry no secrets or private infrastructure",
      threat:
        "A signed-out visitor to smithers.sh reads a token, private hostname, local filesystem path, or private repository name from the committed .smithers projections.",
      lookFor: [
        "A token, key, cookie, or Authorization value in factory.json, home.json, target-index.json, or coding-project.json.",
        "An absolute host path such as /Users/ or /home/, or a private repository or plue-only hostname, in those files.",
        "FACTORY.ts or WORKSPACE.ts naming a Secret by value instead of by Smithers.Secret, or a `github.push:main` trigger that runs a flow with write authority on unreviewed input."
      ],
      paths: [".smithers/*.json", ".smithers/*.ts"]
    }
  ]
})

/**
 * Documentation drift: package docs tarballs and every generated site page
 * match their sources. The site generators and the package docs check run
 * from the checkout root.
 *
 * @since 1.0.0
 * @category lint
 */
const docsDrift = Smithers.Shell.Diff({
  shell:
    "pnpm run docs:check && cd apps/site && node scripts/sync-support-docs.mjs --check && node scripts/gen-cli-data.mjs --check && node scripts/sync-api-docs.mjs --check && node scripts/ingest-reference.mjs --check && node scripts/generate-llms.mjs --check",
  changes: [],
  // The full durable docs flow plus projection checks measured 859s on a 48-core host.
  // Retain the guarded filesystem and tarball checks; allow startup and host-load headroom.
  timeout: "20m"
})

export const Package = Smithers.Package({
  targets: {
    docsDrift,
    ...securityReview,
    nativeFfiLib,
    nativeFfi,
    commit,
    changelog,
    ci,
    driftCi,
    trustedDriftCi,
    environmentToolchain,
    factoryProjection,
    reviewDocsAgainstCode,
    jsdocRules,
    referenceHostHooks,
    jsdocTree,
    reviewJsdocAgainstCode,
    lockfile,
    nodeModules,
    projectCopy,
    repoAbout,
    targetIndex,
    tsconfig
  }
})
