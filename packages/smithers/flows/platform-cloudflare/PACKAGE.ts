import {
  BuildAndCheckTypeScriptPackage,
  ReviewDocsAgainstCode,
  ReviewJsdocAgainstCode,
  SdkRules
} from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import { Package as flows } from "../../../../.smithers/flows/PACKAGE.ts"

const cwd = "packages/smithers/flows/platform-cloudflare"

const { check, circular, docsFiles, fmt, lib, lint } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("{src,examples}/**/*.{ts,vibe}"),
  cwd
})

/**
 * The PostgreSQL the execution suites drive the engine against. Without it
 * they skip, and the coverage gate fails, so the test target declares it.
 */
const postgres = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_PASSWORD: "smithers-cloudflare-test", POSTGRES_DB: "smithers_cloudflare_test" },
  ports: { "5432": 55438 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "smithers_cloudflare_test"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

/** The production image's CLI input, built before the container integration starts. */
const sandboxCli = Smithers.NodeBinary({
  entry: Smithers.file("//apps/mvp/infra/sandbox/pack-cli.mjs"),
  args: ["--built"],
  srcs: [],
  // As with releasePack, library builds are explicit graph dependencies.
  // NodeBinary always assembles the current manifests, bins and other published assets.
  deps: [flows.automationModules, Smithers.Target.subtree("//packages/...", "lib")],
  timeout: "5m"
})

/**
 * The package suite at its 100% coverage threshold, over the declared
 * PostgreSQL. The PgBouncer cases run where `SMITHERS_TEST_PGBOUNCER_URL`, or
 * the compose PgBouncer on 127.0.0.1:54322, answers, and skip elsewhere.
 */
const test = Smithers.Shell.Test({
  shell: "cd packages/smithers/flows/platform-cloudflare && npx vitest run",
  data: [
    lib,
    sandboxCli,
    Smithers.file("//apps/mvp/infra/sandbox/Dockerfile"),
    Smithers.file("//apps/mvp/infra/sandbox/tmux.conf"),
    Smithers.file("//apps/mvp/infra/sandbox/.dockerignore"),
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/**/*.{ts,vibe}"),
    Smithers.glob("examples/**/*.vibe"),
    Smithers.file("package.json"),
    Smithers.file("PACKAGE.ts"),
    Smithers.file("vitest.config.ts")
  ],
  timeout: "20m",
  hosts: ["linux"],
  env: {
    SMITHERS_TEST_PG_URL: "postgres://postgres:smithers-cloudflare-test@127.0.0.1:55438/smithers_cloudflare_test"
  },
  services: [postgres],
  sandbox: { network: "loopback" }
})

/**
 * The quickstart's VibeLang tab is held to `examples/quickstart.vibe`; `docs`
 * depends on this package's own `check` and `test`, the suite with its
 * PostgreSQL service and the sandbox CLI the container suite's image copies,
 * so the docs verb compiles and runs the example.
 */
const docs = Smithers.DocsParity({
  readme: Input.file("README.md"),
  examples: [{
    page: Input.file("docs/quickstart.md"),
    example: Input.file("examples/quickstart.vibe"),
    test: Input.file("test/quickstart.test.vibe")
  }],
  deps: [check, test],
  cwd
})

/**
 * Changed public APIs against the package README and every docs page,
 * concepts and guides included.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  context: [Smithers.file("README.md"), Smithers.glob("docs/**/*.md")]
})

/**
 * Changed exports against their own JSDoc.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd })

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every source file.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "steal-only-dead-incarnations",
      title: "A runtime takes a run early only from an earlier incarnation of its own Durable Object",
      threat:
        "Two incarnations drive one execution at once: a model call is made twice, or a live owner's writes are fenced out mid-answer, because a liveness answer called a live owner dead.",
      lookFor: [
        "isAlive answering false for an owner whose hostId differs from the claimant's, instead of deferring to the lease.",
        "isAlive answering false for the claimant's own incarnation (same hostId, pid and nonce).",
        "CloudflareRuntime.layer's canExecute admitting a run other than its own executionId, or a sweep other than { host: executionId }.",
        "An OwnerIdentity that can mint one incarnation number for two runtimes, such as one read from process.pid."
      ],
      paths: ["src/CloudflareHost.ts", "src/CloudflareRuntime.ts"]
    },
    {
      id: "alarm-never-drops-an-execution",
      title: "Every alarm path either settles, parks with a wake, or re-arms",
      threat:
        "An execution stops being driven for good: an alarm that returns or dies without an armed successor leaves a run nothing will ever wake, and a user's answer never settles.",
      lookFor: [
        "A path in ExecutionObject.alarm that deletes the alarm while the run is neither terminal nor parked on an event.",
        "The settled key written, or the intent deleted, before the drive settled and its routing succeeded, so an unsettled or unrouted execution is forgotten.",
        "Driving before the attempt is counted and the backoff alarm is armed, so a death mid-drive leaves nothing armed.",
        "An outcome whose wake time is now or earlier armed without counting an attempt, which loops alarms without backoff.",
        "ExecutionObject.alarm failing instead of returning Retrying, which hands retries to Cloudflare's capped retry.",
        "Routing taken from the drive's report instead of read from the store, so an alarm that dies between its drive and its routing never starts a child or wakes a parent.",
        "A parked execution's alarm deleted or armed later without reading EngineStore.nextWake again afterwards, which loses a wake another object delivered while the alarm ran."
      ],
      paths: ["src/ExecutionObject.ts", "src/internal/Routing.ts"]
    },
    {
      id: "no-content-in-telemetry",
      title:
        "Start and alarm telemetry carries ids, outcomes, error tags and SQL error codes, and a failed migration's cause only",
      threat:
        "A question, a prompt or a provider error that echoes one reaches logs, spans or metrics, which are retained and readable far more widely than the conversation.",
      lookFor: [
        "A log annotation, span attribute or metric attribute built from the intent's payload or a failure's message, outside a MigrationError's detail.",
        "FailureDetail.detail keeping a message or statement for a failure that is not a MigrationError, or a database message whose SQLSTATE is a data exception (class 22), which quotes the rejected value.",
        "The start span ending with the caller's exit, whose failure becomes an exported exception.",
        "failureType reading anything but an error's tag."
      ],
      paths: ["src/ExecutionObject.ts", "src/internal/FailureDetail.ts"]
    },
    {
      id: "fail-closed-refusals",
      title: "Services a Worker lacks refuse every call, and the network slot never follows a redirect",
      threat:
        "A flow believes a file is absent and writes where it should have stopped, or the Worker fetches an origin the capability kernel never authorized by following a 3xx.",
      lookFor: [
        "A FileSystem method that succeeds, answers exists with false, or fails with NotFound.",
        "A ChildProcessSpawner or Jj operation that succeeds.",
        "The FetchHttpClient RequestInit set to anything other than redirect: \"manual\"."
      ],
      paths: ["src/CloudflareHost.ts", "src/internal/Refusals.ts"]
    }
  ]
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "host" })

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    importRules,
    jevRules,
    lib,
    lint,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    sandboxCli,
    test,
    ...securityReview
  }
})
