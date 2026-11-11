/**
 * Targets for the remote-cache and sandbox-service infrastructure workspace.
 *
 * This directory is a workspace package (`packages/smithers/build/infra` in
 * `pnpm-workspace.yaml`) but not a `packages/*` directory, so the standard
 * package defaults never match it and `//packages/...` planned nothing here.
 * `pnpm run check` and `pnpm test` used to reach it only through the recursive
 * root scripts; these targets are the same gates as declarations.
 */
import { ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"
import { sourceFiles as cliSources, testHelpers as cliTestHelpers } from "../build-cli/SourceInputs.ts"

const cwd = "packages/smithers/build/infra"

/** Infrastructure Markdown read by the umbrella documentation suite. */
const docsFiles = Smithers.Filegroup({ cwd, srcs: [Smithers.glob("**/*.md")] })

/**
 * The workers, the cache's migrations, the sandbox image, and the operator
 * scripts the gates read.
 *
 * The migrations are declared inputs because they are the production D1
 * schema and `worker/test/migrations.test.ts` executes them: without them a
 * schema change leaves the target key unchanged and the suite reports green
 * on a stale remote-cache hit. `PACKAGE.ts` and `vitest.config.ts` are declared
 * for the same reason, since `tsconfig.node.json` typechecks both.
 */
const sources = [
  Smithers.glob("//packages/smithers/build/infra/worker/**/*.ts"),
  Smithers.glob("//packages/smithers/build/infra/worker/migrations/**/*.sql"),
  Smithers.glob("//packages/smithers/build/infra/scripts/**/*.ts"),
  Smithers.file("alchemy.run.ts"),
  Smithers.file("deployment.ts"),
  // The sandbox suite reads the image's pins and its base image tag.
  Smithers.file("sandbox/Dockerfile"),
  Smithers.file("package.json"),
  Smithers.file("PACKAGE.ts"),
  Smithers.file("vitest.config.ts"),
  Smithers.file("tsconfig.worker.json"),
  Smithers.file("tsconfig.node.json"),
  Smithers.file("tsconfig.test.json"),
  Smithers.file("tsconfig.contract.json"),
  Smithers.file("//packages/repo-targets/src/vibelang-eslint.d.ts"),
]

/** Owning source group for protocol consumers outside this package. */
const sourceFiles = Smithers.Filegroup({ srcs: sources, cwd })

/**
 * Checks the workspace against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [cliSources, cliTestHelpers],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: true,
  incremental: false,
  cwd
})

/**
 * Runs the worker protocol, migration, and redaction suites.
 *
 * @since 0.1.0
 * @category test
 */
const suite = Smithers.Vitest({
  tests: [
    Smithers.glob("//packages/smithers/build/infra/worker/test/**/*.ts"),
    Smithers.glob("//packages/smithers/build/infra/scripts/**/*.test.ts")
  ],
  sources,
  deps: [cliSources, cliTestHelpers],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

/**
 * Lints the worker and the operator scripts.
 *
 * Shares the infra-local JSDoc policy and file scope with `pnpm run lint`.
 * Workspace-rooted declarations resolve identically for planning and ESLint.
 *
 * @since 0.1.0
 * @category lint
 */
const lint = Smithers.EsLint({
  sources: [
    Smithers.glob("//packages/smithers/build/infra/worker/**/*.ts"),
    Smithers.glob("//packages/smithers/build/infra/scripts/**/*.ts"),
    Smithers.file("//packages/smithers/build/infra/deployment.ts"),
    Smithers.file("//packages/smithers/build/infra/alchemy.run.ts")
  ],
  deps: [],
  configs: [
    Smithers.file("//packages/smithers/build/infra/eslint.config.js"),
    Smithers.file("//eslint.jsdoc.js")
  ],
  maxWarnings: 0,
  fix: false,
  cwd
})

/**
 * Checks the same formatting policy as `pnpm run lint`.
 *
 * @since 0.1.0
 * @category lint
 */
const fmt = Smithers.Dprint({
  sources: [
    Smithers.glob("//packages/smithers/build/infra/worker/**/*.ts"),
    Smithers.glob("//packages/smithers/build/infra/scripts/**/*.ts"),
    Smithers.file("deployment.ts"),
    Smithers.file("alchemy.run.ts"),
    Smithers.file("package.json"),
    Smithers.file("eslint.config.js"),
    Smithers.file("dprint.json")
  ],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

/**
 * Checks that the deployment documents itself beside its code.
 *
 * @since 0.1.0
 * @category docs
 */
const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/** The public code of the worker and the operator scripts; tests are out of scope. */
const reviewedSources = [
  Smithers.glob("worker/*.ts"),
  Smithers.file("scripts/deploy.ts"),
  Smithers.file("scripts/failure-message.ts"),
  Smithers.file("scripts/redact-state.ts"),
  Smithers.file("scripts/remote-state.ts"),
  Smithers.file("scripts/state-ownership.ts"),
  Smithers.file("deployment.ts"),
  Smithers.file("alchemy.run.ts")
]

/**
 * Changed worker and deployment code against the operator prose that
 * documents it. The package has no site API page, so the context is its own
 * README and the cache trust model.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  include: reviewedSources,
  context: [Smithers.file("README.md"), Smithers.file("CACHE-TRUST.md")]
})

/**
 * Changed worker and deployment exports against their own JSDoc.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd, include: reviewedSources })

/**
 * Security review of the hosted remote cache and its deployment tooling.
 *
 * The Worker is a public endpoint whose answers restore build outputs, and
 * the deploy scripts hold Cloudflare credentials and cache bearer tokens.
 *
 * @since 0.1.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: [
    "worker/**/*.ts",
    "worker/migrations/**/*.sql",
    "scripts/**/*.ts",
    "alchemy.run.ts",
    "deployment.ts",
    "sandbox/Dockerfile",
    "CACHE-TRUST.md",
    "README.md"
  ],
  checks: [
    {
      id: "cache-credential-classification",
      title: "Only the write credential can publish, and no credential classifies as both",
      threat: "A CI job holding only the read token, or no token, publishes poisoned action results every other build restores.",
      lookFor: [
        "A PUT or DELETE route reachable when presentedCredential returns kind read or none.",
        "A token comparison that short circuits, skips constantTimeEquals, or compares the raw bearer instead of its SHA-256.",
        "createHandler or CacheWorker handlerFor accepting equal or non-hex readTokenHash and writeTokenHash, or reusing a handler after a token binding rotated.",
        "A non-Bearer authorization header or an empty token classified as read or write."
      ],
      paths: ["worker/protocol.ts", "worker/CacheWorker.ts", "worker/constantTimeEquals.ts", "worker/digestBytes.ts"]
    },
    {
      id: "read-namespace-scope",
      title: "A namespaced read credential reads only action keys under its prefix",
      threat: "An untrusted fork job holding a namespaced read token reads trusted namespace results or probes the CAS.",
      lookFor: [
        "An /ac/ key compared against readNamespacePrefix before decodeURIComponent, or a prefix check that encoded slashes or dot segments bypass.",
        "A /cas/ route, findMissing included, reachable by a read credential when readNamespacePrefix is set.",
        "A readNamespacePrefix accepted without the single-segment ending-in-slash validation."
      ],
      paths: ["worker/protocol.ts"]
    },
    {
      id: "cas-content-integrity",
      title: "Stored artifacts and action results match the digests they are served under",
      threat: "A write-token holder or a corrupted store makes the cache serve bytes whose SHA-256 differs from the requested digest, poisoning builds.",
      lookFor: [
        "A CAS PUT stored without sha256Hex of the full buffered body equalling the path digest.",
        "A CAS GET or findMissing answer that trusts R2 metadata or a store-returned digest outside the request.",
        "An action-cache PUT whose declared output digests are not 64 lowercase hex, or whose stored text is re-served without validation.",
        "An R2 object key derived from a digest that was not validated against the hex pattern first."
      ],
      paths: ["worker/protocol.ts", "worker/R2ContentStore.ts", "worker/D1ActionCache.ts"]
    },
    {
      id: "d1-parameterized-sql",
      title: "Every D1 statement binds request data as parameters",
      threat: "A cache client injects SQL through a key digest or fence field and reads, rewrites, or deletes other cache rows.",
      lookFor: [
        "A prepare() call whose SQL string is built with template interpolation or concatenation of request-derived values.",
        "A migration or retention query whose bounds let one scheduled run delete rows newer than the retention cutoff."
      ],
      paths: ["worker/D1ActionCache.ts", "worker/RetentionSweep.ts", "worker/migrations/**"]
    },
    {
      id: "admission-and-budget-bounds",
      title: "Every request is bounded in bytes, concurrency, and per-credential budget",
      threat: "Any token holder exhausts isolate memory, R2 operations, or D1 capacity and takes the cache down for every build.",
      lookFor: [
        "A body read that buffers past its limit or trusts content-length without enforcing the streamed length.",
        "An admission counter incremented on a path whose error or cancelled stream never decrements it.",
        "A findMissing request above maxFindMissingDigests, or a budget charge after the store is touched, or a budget outcome other than success=true treated as admitted.",
        "An action-cache JSON body parsed or passed to canonicalJson without the nesting-depth and output-size budget.",
        "The unauthenticated /healthz route reaching D1 or R2 without its single-slot bound, or returning failure detail in its body."
      ],
      paths: ["worker/protocol.ts", "worker/RateLimitCredentialBudget.ts", "worker/discardBody.ts", "worker/jsonTextFault.ts"]
    },
    {
      id: "state-redaction-before-publish",
      title: "Deployment state never persists or publishes a cache bearer token",
      threat: "Anyone with read access to the R2 state bucket or the local .alchemy directory recovers the write token and poisons the cache.",
      lookFor: [
        "A deploy path that publishes the state snapshot when redaction failed or was skipped.",
        "A credential binding or SMITHERS_CACHE_* value missing from the redaction set, or a JSON shape the walker does not descend into.",
        "A Worker binding that carries the bearer value instead of cacheTokenDigest's SHA-256 verifier."
      ],
      paths: ["scripts/redact-state.ts", "scripts/deploy.ts", "deployment.ts", "alchemy.run.ts"]
    },
    {
      id: "remote-state-path-safety",
      title: "Pulled state snapshots write only inside the stack state directory",
      threat: "Whoever can write the R2 state object overwrites arbitrary files on the deploying operator's machine.",
      lookFor: [
        "A snapshot file name with .., an absolute path, a backslash, or a control character accepted by parseSnapshot.",
        "A symlink inside the state directory followed by writeStateSnapshot, redaction, or ownership locking.",
        "A lock or snapshot PUT not conditioned on the pulled ETag, letting two deploys interleave state."
      ],
      paths: ["scripts/remote-state.ts", "scripts/state-ownership.ts", "scripts/redact-state.ts"]
    },
    {
      id: "operator-credential-leaks",
      title: "Cloudflare and cache credentials never reach logs, errors, or metrics",
      threat: "A CI log reader or Analytics Engine viewer learns the Cloudflare API token, derived R2 secret, or a cache bearer token.",
      lookFor: [
        "An error message, console line, or describeFailure output that includes a token, Authorization header, or signed URL.",
        "A metrics datapoint whose blobs or indexes carry a key digest, credential digest, or request path.",
        "The Alchemy child spawned with arguments or env that echo secrets beyond the inherited process env."
      ],
      paths: ["scripts/remote-state.ts", "scripts/deploy.ts", "scripts/failure-message.ts", "worker/CacheWorker.ts", "worker/cache-failure.ts"]
    },
    {
      id: "sandbox-service-credential",
      title: "Only the sandbox token holder reaches a machine, and the token never persists",
      threat: "Anyone who reaches the sandbox Worker, or reads Alchemy state, runs arbitrary commands on Cloudflare containers the account pays for.",
      lookFor: [
        "A request served by a machine without HttpSandbox.serve comparing the bearer, or a Worker that serves with an empty or missing SANDBOX_TOKEN.",
        "SANDBOX_TOKEN missing from the redaction set, or the token reaching a log line, a response body, or a container's environment.",
        "An instance type whose maxInstances is unbounded, or a size declared to CloudflareSandbox that differs from the deployed instanceType."
      ],
      paths: ["worker/SandboxService.ts", "worker/SandboxWorker.ts", "worker/sandbox-instances.ts", "deployment.ts", "scripts/redact-state.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    docs,
    docsFiles,
    fmt,
    lint,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    suite,
    sourceFiles,
    ...securityReview
  }
})
