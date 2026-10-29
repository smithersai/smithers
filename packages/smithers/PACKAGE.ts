import {
  BuildAndCheckTypeScriptPackage,
  ImportRules,
  ReviewDocsAgainstCode,
  ReviewJsdocAgainstCode
} from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { Package as repoTargetsPackage } from "../repo-targets/PACKAGE.ts"

/** Regression cases wait on process receipts, conditions or the Effect test clock. */
const importRules = ImportRules({
  cwd: "packages/smithers",
  rules: [
    {
      kind: "forbidCalls",
      files: ["src/Cli.ts"],
      callees: ["Effect.runPromise", "Effect.runPromiseExit"],
      because: "Command Effects use ControlBridge.run so host services and cancellation cross the command boundary."
    },
    {
      kind: "forbid",
      files: ["src/internal/ClaudeCode.ts"],
      modules: ["@anthropic-ai/claude-agent-sdk"],
      allowTypeOnly: true,
      because: "Provider SDKs load through the injected ProviderModules Effect only when their provider is selected."
    },
    {
      kind: "forbidCalls",
      files: [
        "test/ConfigurationRace.test.ts",
        "test/CloudSandboxLease.test.ts",
        "test/Bug.test.ts",
        "test/ClaudeMirror.test.ts",
        "test/support/configuration-race.mjs"
      ],
      callees: ["setTimeout", "*.sleep", "*.waitForTimeout", "vi.mock", "vi.spyOn"],
      because:
        "test.behavioral: configuration and lease regressions use real dependencies and condition barriers, never fixed sleeps or mocks."
    },
    {
      kind: "forbidCalls",
      files: [
        "test/BackendSafety*.test.ts",
        "test/BackendCommands.test.ts",
        "test/ProductApi*.test.ts",
        "test/BackendStack.test.ts",
        "test/BackendMutations.test.ts",
        "test/BackendWorkspace*.test.ts",
        "test/Environment.test.ts"
      ],
      callees: ["setTimeout", "*.sleep", "*.waitForTimeout"],
      because: "test.behavioral: wait on conditions or TestClock, never fixed sleeps. See AGENTS.md."
    },
    {
      kind: "forbidCalls",
      files: ["test/BackendSafety*.test.ts", "test/ProductApiBodies.test.ts"],
      callees: ["vi.mock", "vi.doMock", "vi.stubGlobal", "vi.spyOn", "jest.mock"],
      because:
        "Backend safety regressions use real transports and inject faults through Effect services. See AGENTS.md."
    },
    {
      kind: "rootImportsOnly",
      files: ["src/commands/{Open,Bug,Claude,FlowCatalog}.ts"],
      packages: ["@smthrs/*"],
      because: "sdk.root-imports-only: commands consume public package roots. See apps/mvp/docs/rules.md."
    },
    {
      kind: "forbidCalls",
      files: ["test/{Open,CommandVerbs,CommandProjections}.test.ts"],
      callees: ["vi.mock", "vi.doMock", "vi.stubGlobal", "jest.mock"],
      because: "test.no-mocks-of-our-code: inject faulty Effect services or use real dependencies."
    },
    {
      kind: "forbidCalls",
      files: ["test/{Open,CommandVerbs,CommandProjections}.test.ts"],
      callees: ["setTimeout", "*.setTimeout", "sleep", "*.sleep", "*.waitForTimeout"],
      because: "test.behavioral: wait on a condition or use TestClock. See apps/mvp/docs/rules.md."
    },
    {
      kind: "forbidCalls",
      files: ["test/ClaudeCode.test.ts", "test/CodexLogin*.test.ts", "test/fixtures/codex-login-lock-race-child.ts"],
      callees: ["setTimeout", "setInterval", "globalThis.setTimeout", "globalThis.setInterval"],
      because: "test.behavioral: provider regressions wait on a condition or TestClock, never a fixed wall-clock delay."
    },
    {
      kind: "forbidCalls",
      files: [
        "src/internal/backend/History.ts",
        "test/BackendHistory.test.ts",
        "test/BackendContracts.test.ts",
        "test/HostServiceRecovery.test.ts"
      ],
      callees: ["setTimeout", "setInterval"],
      because: "DUR-2: history subscribes without timer polling; TEST-2: tests synchronize on conditions."
    },
    {
      kind: "rootImportsOnly",
      files: ["src/internal/backend/ProductApi.ts", "test/fixtures/workflow-rpc-types.ts"],
      packages: ["@smthrs/*"],
      because: "SDK-5: the relay uses the public control and gateway contracts."
    },
    {
      kind: "forbidCalls",
      files: ["test/ControlSurface.test.ts"],
      callees: ["setTimeout", "*.sleep", "*.waitForTimeout", "vi.mock", "vi.doMock", "jest.mock"],
      because: "test.behavioral: control HTTP host tests use real services and completion signals."
    }
  ]
})

const tuiSources = Smithers.Filegroup({
  cwd: "apps/tui",
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("src/**/*.tsx")]
})

const { check, circular, docs: readmeDocs, docsFiles, fmt, lib, lint } = BuildAndCheckTypeScriptPackage({
  deps: [tuiSources],
  cwd: "packages/smithers",
  // On the Node 22 CI hosts this complete process-boundary suite took
  // 1166.5 s on macOS and was killed at 1200.1 s on Ubuntu. Keep its
  // aggregate coverage gate in one run, with twice the observed completed
  // duration available; individual test deadlines remain unchanged.
  testTimeoutMs: 40 * 60_000,
  // `scripts/build.mjs` bundles the TUI that `smthrs tui` runs.
  buildInputs: [
    Smithers.glob("vendor/opentui-native/**"),
    Smithers.file("scripts/build-tui.mjs"),
    Smithers.file("scripts/tui-native-editor.mjs")
  ],
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] }),
  // Runnable examples are linted and type-checked with the sources.
  sources: Smithers.glob("{src,examples}/**/*.ts")
})

/** Registered operator commands must remain in the package reference. */
const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  cwd: "packages/smithers",
  deps: [
    readmeDocs,
    Smithers.Shell.Test({
      shell: "node --test packages/smithers/scripts/reference-docs.test.mjs",
      data: [
        Smithers.file("scripts/reference-docs.test.mjs"),
        Smithers.file("docs/reference/cli/README.md"),
        Smithers.file("src/internal/backend/catalog.mvp.json"),
        Smithers.file("src/internal/backend/Definitions.ts"),
        Smithers.file("src/cli/ControlCommands.ts"),
        Smithers.file("src/cli/StepCacheCommands.ts")
      ]
    })
  ]
})

/**
 * Changed public APIs and commands against the package README, every docs
 * page, and the site CLI reference page.
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd: "packages/smithers",
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/cli.mdx")
  ]
})

/** Changed exports against their own JSDoc. */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd: "packages/smithers" })

/** The history suite needs a real PostgreSQL server on the Linux CI runner. */
const historyPostgresDatabase = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_PASSWORD: "smithers-history-test", POSTGRES_DB: "smithers_history_test" },
  ports: { "5432": 55435 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "smithers_history_test"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

const vitest = "pnpm exec vitest run --config vitest.config.ts --environment node"

/**
 * One lane of the suite: its results and raw coverage go to a blob, and it
 * prints no coverage report and checks no thresholds of its own.
 */
const lane = `${vitest} --reporter=blob --coverage.reporter=json` +
  " --coverage.thresholds.lines=0 --coverage.thresholds.functions=0" +
  " --coverage.thresholds.branches=0 --coverage.thresholds.statements=0"

/** The longest file: 964 s (real lease expiries). */
const laneOne = ["test/Bin.test.ts"]

/** The 402 s recovery file plus the shorter end of the measured 46–265 s group. */
const laneTwo = [
  "test/NativeControlExternalPeerRecovery.test.ts",
  "test/NativeControlPortable.test.ts",
  "test/UnifiedCli.test.ts",
  "test/HistoryVerify.test.ts",
  "test/ObserveMode.test.ts",
  "test/TuiRuntimes.test.ts",
  "test/McpModeCli.test.ts",
  "test/ModuleHumanWaitBudget.test.ts"
]

const laneThree = [
  "test/ModuleSourceSnapshotCli.test.ts",
  "test/EndToEnd.test.ts",
  "test/NativeCancellationCli.test.ts",
  "test/FileFlowInputCli.test.ts",
  "test/CloudSandbox.test.ts",
  "test/DetachedHostResume.test.ts"
]

/** The remaining files join four shards automatically, including newly added files. */
const remainder = [...laneOne, ...laneTwo, ...laneThree].map((file) => `--exclude ${file}`).join(" ")

const test = Smithers.Shell.Test({
  // Keep the measured process-heavy groups separate, then share the remainder
  // across all four workers. Leaving every new file on worker four grew that
  // worker to 263 files while the other workers ran only 1, 8 and 6 (#4122).
  // A free worker takes the next group immediately, rather than waiting for
  // one assigned long group. Each invocation records its own blob; the merge
  // retains every failure and checks the original coverage thresholds.
  shell: [
    "cd packages/smithers && work=$(mktemp -d /tmp/smt.XXXXXXXX) && trap 'rm -rf \"$work\"' 0 && " +
    "blobs=\"$work/blobs\" && mkdir -p \"$blobs\" \"$work/tmp\" && " +
    "export TMPDIR=\"$work/tmp\" TEMP=\"$work/tmp\" TMP=\"$work/tmp\" NODE_COMPILE_CACHE=\"$work/cache\" && {",
    "printf '%s\\n'",
    `"${lane} --outputFile=$blobs/one-fixed.json ${laneOne.join(" ")}"`,
    `"${lane} --outputFile=$blobs/two-fixed.json ${laneTwo.join(" ")}"`,
    `"${lane} --outputFile=$blobs/three-fixed.json ${laneThree.join(" ")}"`,
    ...[1, 2, 3, 4].map((shard) =>
      `"${lane} --outputFile=$blobs/${["one", "two", "three", "four"][shard - 1]}.json ${remainder} --shard=${shard}/4"`
    ),
    "| xargs -P 4 -I '{}' sh -c '{}';",
    "if test -f $blobs/one-fixed.json && test -f $blobs/two-fixed.json && test -f $blobs/three-fixed.json && test -f $blobs/one.json && test -f $blobs/two.json && test -f $blobs/three.json && test -f $blobs/four.json;",
    `then ${vitest} --merge-reports=$blobs --coverage.reportsDirectory=$work/merged --reporter=github-actions --reporter=dot;`,
    "else echo \"a lane of the suite ended without its report\" >&2; false; fi; };",
    "status=$?; exit $status"
  ].join(" "),
  data: [
    lib,
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] }),
    Smithers.file("vitest.config.ts"),
    Smithers.file("test/support/configuration-race.mjs"),
    Smithers.file("test/temporaryEnvironment.ts"),
    Smithers.file("//packages/repo-targets/test-utils/coverage-teardown.mjs"),
    Smithers.file("//packages/repo-targets/test-utils/test-process-environment.mjs"),
    Smithers.file("//packages/repo-targets/test-utils/vitest-root-temp.mjs"),
    Smithers.file("//packages/repo-targets/test-utils/effect-property.mjs"),
    Smithers.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
    // `EvaluationCli.test.ts` lists the repository's shipped suites.
    repoTargetsPackage.repositoryInputs,
    // `ProductApi.test.ts` checks the generated client against the operations it was generated from.
    Smithers.file("test/fixtures/product-api-operations.json")
  ],
  timeout: "40m",
  hosts: ["linux"],
  // The package's PostgreSQL cases read this URL. It is deliberately not
  // `SMITHERS_TEST_PG_URL`: that name switches every `TestDatabase` case into
  // the PostgreSQL matrix, and the CLI announces it as an ignored 0.x setting
  // on stderr, so exporting it here changed every spawned command's output.
  env: {
    SMITHERS_HISTORY_TEST_PG_URL: "postgres://postgres:smithers-history-test@127.0.0.1:55435/smithers_history_test"
  },
  services: [historyPostgresDatabase],
  sandbox: { network: "loopback" }
})

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`, and unconfined.
 *
 * This is the release gate's "Exclusive fault matrix": everything under
 * `test/faults`. Its file cases took 945 s on the release runner
 * (2026-10-10), so it declares 40 minutes rather than the Vitest default 20.
 */
const faults = Smithers.FaultSuite({
  cwd: "packages/smithers",
  tests: Smithers.glob("test/faults/**/*.test.ts"),
  sandbox: "none",
  timeoutMs: 40 * 60_000
})

/** The corrected native editor and its reproducible source used by the TUI. */
const nativeSources = Smithers.Filegroup({
  srcs: [Smithers.glob("vendor/opentui-native/**")],
  cwd: "packages/smithers"
})

/**
 * The command sources, README, package docs, and the manifest whose version
 * the docs pin. The site's `//apps/site:cliData` generator lists this group in
 * `data`, so a help string, a removed-command anchor, or the version moves the
 * docs' key.
 */
const docsSources = Smithers.Filegroup({
  srcs: [
    Smithers.glob("src/**/*.ts"),
    Smithers.file("README.md"),
    Smithers.file("package.json"),
    Smithers.glob("docs/*.md")
  ],
  cwd: "packages/smithers"
})

/**
 * C-SEC-02's host-process sampler: process-tree and open-file sampling with
 * real `ps`/`lsof` positive controls, and injected launchd resolution.
 *
 * @since 1.0.0
 * @category test
 */
const hostProcessSampler = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/smithers/scripts/host-process-sampler.test.mjs")]),
  srcs: [Smithers.file("//packages/smithers/scripts/host-process-sampler.mjs")],
  deps: []
})

/**
 * The CommonJS half of the hand-written dual builds (`compile-commonjs.mjs`):
 * `import.meta` paths, top-level-await delegates, JSON beside the modules, and
 * a VibeLang package's CommonJS converted from the ESM vibelang emitted.
 *
 * @since 1.0.0
 * @category test
 */
const commonJsBuild = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/smithers/scripts/compile-commonjs.test.mjs")]),
  srcs: [
    Smithers.file("//packages/smithers/scripts/compile-commonjs.mjs"),
    Smithers.file("//packages/repo-targets/scripts/build-library.mjs"),
    Smithers.file("//packages/repo-targets/scripts/private-effect-adapters.mjs")
  ],
  deps: []
})

/**
 * The CLI's release installer: `install-cli.mjs` installs a packed release
 * closure with relocatable installation receipts, and `build-cli.mjs` packs
 * and installs the CLI for the distribution and offline boxes. They build
 * the CLI itself, so they run before `smthrs` exists and are not flows.
 *
 * @since 1.0.0
 * @category test
 */
const cliInstall = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/smithers/scripts/install-cli.test.mjs")]),
  srcs: [
    Smithers.file("//packages/smithers/scripts/install-cli.mjs"),
    Smithers.file("//packages/smithers/scripts/build-cli.mjs")
  ],
  deps: []
})

/**
 * Security review of the CLI's own sources. Nested packages (agent, build,
 * control, flows, gateway, ...) carry their own declarations.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers",
  include: ["src/**", "bin/**", "scripts/**"],
  checks: [
    {
      id: "cli-login-callback",
      title: "Browser login callbacks accept only the state-bound loopback handoff",
      threat:
        "A web page or local process the operator visits plants its own token or steals the operator's Smithers or Observe session during `auth login`.",
      lookFor: [
        "A callback server in Auth.ts that binds to anything but 127.0.0.1 or accepts a POST before the constant-time callback_state compare.",
        "The /callback POST handler lacking an Origin or Host check that openObserve applies, so a DNS-rebound page can race the handoff.",
        "A token or ticket echoed into the bridge HTML, a query string, or a log instead of staying in the URL fragment."
      ],
      paths: ["src/internal/backend/Auth.ts"]
    },
    {
      id: "token-origin-binding",
      title: "A saved Smithers token is sent only to the origin it was saved for",
      threat:
        "A malicious repository, remote, or redirect receives the operator's Smithers bearer token and acts on their repositories and workspaces.",
      lookFor: [
        "Client.response sending `authorization` to an origin other than the one Session.resolve bound the token to, or following redirects.",
        "Session.record or resolve returning a token when the auth file's api_url or host does not match the requested origin.",
        "Session.keyring building the macOS `security -i` script from a token or host that can contain quotes or newlines.",
        "auth.json or its temp file written with a mode wider than 0600, or into a directory wider than 0700."
      ],
      paths: ["src/internal/backend/Session.ts", "src/internal/backend/Client.ts", "src/internal/backend/Auth.ts"]
    },
    {
      id: "workspace-ssh-injection",
      title: "Server-supplied SSH commands and remote scripts cannot run attacker-chosen local or remote code",
      threat:
        "A compromised or spoofed backend runs arbitrary commands on the operator's machine through ssh options, or on the workspace through unquoted paths.",
      lookFor: [
        "sshArgs accepting an -o directive such as ProxyCommand, LocalCommand, or a flag besides -p/-i/-l and the listed booleans.",
        "An -i identity path or destination word that can start with '-' or contain shell metacharacters reaching ssh.",
        "A remote script in SSH.ts, Copy.ts, or Workspaces.ts that interpolates a path, env value, or exec id without quote() or the id regex."
      ],
      paths: ["src/internal/backend/SSH.ts", "src/internal/backend/Copy.ts", "src/internal/backend/Workspaces.ts"]
    },
    {
      id: "workspace-copy-containment",
      title: "`workspace cp` downloads write only inside the requested local destination",
      threat:
        "A compromised workspace sends a tar stream that writes or overwrites files outside the operator's destination, such as ~/.ssh or shell rc files.",
      lookFor: [
        "archiveFilter admitting an absolute path, a '..' segment, or a hard link whose target leaves the requested root.",
        "A SymbolicLink entry extracted into scratch and then followed by a later entry or by merge() rename into the destination.",
        "merge() or the parent walk writing through a symlinked destination component created between check and rename."
      ],
      paths: ["src/internal/backend/Copy.ts"]
    },
    {
      id: "subscription-credential-export",
      title: "Host provider credentials never enter a workspace, and subscriptions stay with their provider CLIs",
      threat:
        "A backend or SSH endpoint the operator did not intend receives their ChatGPT OAuth refresh tokens or Anthropic API key and spends their account. A Claude subscription token is never read, stored, or sent (#2777).",
      lookFor: [
        "A seedAgentAuth handler, workspace issue path or SSH stdin payload exporting a host provider credential into a workspace instead of refusing or using the secrets egress proxy.",
        "providerLogin or auth connect posting refresh tokens to an origin taken from SMITHERS_API_ORIGIN or --hostname without confirmation.",
        "Any read of Claude's .credentials.json or keychain entry. A token read from ~/.codex/auth.json that is not passed to c.protect before output streams."
      ],
      paths: ["src/internal/backend/Workspaces.ts", "src/internal/backend/Auth.ts"]
    },
    {
      id: "codex-login-read-only",
      title: "Smithers reads the Codex login and Codex alone writes it",
      threat:
        "Smithers rewrites the login or spends its refresh token and logs the operator out, sends the access token anywhere but the route's ChatGPT backend, or silently replaces a subscription with an ambient API key.",
      lookFor: [
        "A write to Codex auth.json, a read of its refresh_token, or a request to the OAuth token endpoint anywhere outside the Codex CLI.",
        "An access token or account id in a model error, a log, a journal receipt or the sealed request view, or signed onto a request to another origin.",
        "A refresh lock in CodexLogin.ts opened without 'wx' and mode 0600, or removed while its recorded pid is alive, so two processes ask Codex to refresh at once.",
        "A `codex app-server` process that is unbounded, outlives its answered request or a cancelled run, or receives an API key in its environment."
      ],
      paths: ["src/internal/CodexLogin.ts", "src/Providers.ts", "src/internal/NativeEquipment.ts"]
    },
    {
      id: "serve-bind-auth",
      title: "`smthrs serve` never exposes an unauthenticated control plane off loopback",
      threat:
        "A host on the operator's LAN launches agents and approves plans with the operator's credentials through the gateway.",
      lookFor: [
        "Serve.refuse accepting a non-loopback host such as 0.0.0.0, ::, or a LAN address without both --listen and a non-empty credential.",
        "The serve composition handing the gateway an empty or undefined bearer for a non-loopback bind, or dropping the loopback Host and Origin policy a DNS-rebound browser page would hit.",
        "The gateway approval authority in NativeControl.ts granting Plan or Node approval to a principal other than local or the configured bearer."
      ],
      paths: ["src/Serve.ts", "src/internal/NativeControl.ts", "src/NodeControl.ts"]
    },
    {
      id: "approved-envelope-enforcement",
      title: "Native flow handlers run only under their owning approved plan's capability envelope",
      threat:
        "An agent or flow author runs code or capabilities the operator never approved by forking, resuming, or editing a module after approval.",
      lookFor: [
        "ModuleAuthority.owner admitting an execution whose root plan is not approved or whose planDigest or executionDigest no longer matches.",
        "A handler registration path in ModuleAuthority.ts or NativeControl.ts that skips CapabilitySet.attenuate with the envelope's capabilities.",
        "A delegate executable admitted when card.envelope.flows does not name it."
      ],
      paths: ["src/internal/ModuleAuthority.ts", "src/internal/ModuleAdmission.ts", "src/internal/NativeControl.ts"]
    },
    {
      id: "open-runs-untrusted-checkout",
      title: "`smthrs open` never runs package scripts from a checkout",
      threat:
        "An attacker repository whose remote names any owner/repo gets one of its package scripts executed on the operator's machine by `smthrs .`.",
      lookFor: [
        "host.launch running pnpm, a package script, or any binary other than `open -a <installed Smithers.app>`.",
        "A launch argument derived from the checkout's files rather than its parsed owner/repo."
      ],
      paths: ["src/commands/Open.ts"]
    },
    {
      id: "bug-report-redaction",
      title: "`smthrs bug` sends only redacted context to the configured endpoint",
      threat:
        "A maintainer or a spoofed SMITHERS_BUG_ENDPOINT receives the operator's API keys, tokens, or connection strings from a bug report.",
      lookFor: [
        "A report field in Bug.ts or commands/Bug.ts added after Redaction.redact runs, or read from env or journal without redaction.",
        "The endpoint taken from the environment over plain http or without showing it to the operator before posting."
      ],
      paths: ["src/Bug.ts", "src/commands/Bug.ts"]
    },
    {
      id: "local-credential-store",
      title: "Operator credentials stored by `credentials` commands are encrypted and never printed",
      threat:
        "Anyone who reads the project's control database or command output recovers the operator's stored provider secrets.",
      lookFor: [
        "A write path in operator/Credentials.ts that uses CredentialCipher.makeNoop instead of the SMITHERS_CREDENTIAL_KEY cipher.",
        "--secret-file resolved relative to an untrusted root or following a symlink into another user's file, or the secret echoed in output."
      ],
      paths: ["src/operator/Credentials.ts", "src/operator/Store.ts"]
    }
  ]
})

/**
 * Internal scripts execute the Smithers working tree, never an installed copy.
 *
 * A published-CLI invocation inside this repository silently runs a release
 * build instead of the code under edit. The guard scans only positions that
 * actually spawn a process, so the documentation's own `bunx smithers-build`
 * prose stays legal. It reads other trees, so it re-runs regardless.
 *
 * @since 0.1.0
 * @category test
 */
const localSmithers = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//packages/smithers/test/support/check-local-smithers.mjs")),
  srcs: [
    Smithers.file("//packages/smithers/test/support/check-local-smithers.mjs"),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs")
  ],
  deps: []
})

/**
 * The local-Smithers guard's own unit suite: the violation patterns, the
 * allowlist, and the scanned execution surfaces.
 *
 * @since 0.1.0
 * @category test
 */
const localSmithersUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/smithers/test/support/check-local-smithers.test.mjs")]),
  srcs: [
    Smithers.file("//packages/smithers/test/support/check-local-smithers.mjs"),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs")
  ],
  deps: []
})

export const Package = Smithers.Package({
  targets: {
    importRules,
    localSmithers,
    localSmithersUnit,
    tuiSources,
    check,
    circular,
    docs,
    docsFiles,
    faults,
    fmt,
    hostProcessSampler,
    commonJsBuild,
    cliInstall,
    lib,
    lint,
    nativeSources,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    test,
    historyPostgresDatabase,
    docsSources,
    ...securityReview
  }
})
