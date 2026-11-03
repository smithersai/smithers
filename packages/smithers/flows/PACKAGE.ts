import {
  BuildAndCheckTypeScriptPackage,
  ImportRules,
  ReviewDocsAgainstCode,
  ReviewJsdocAgainstCode
} from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows"

// examples/ is type-checked and formatted with the tests, and run by
// test/examples/; each example is documentation users copy, so it is not held
// to the library lint rules.
const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd,
  testSources: Smithers.glob("{test,examples}/**/*.{ts,vibe}"),
  // The example projects examples 16 and 24 discover flows in read their
  // markdown descriptors off disk at run time.
  testData: ["examples/**/*.mdx"]
})

const importRules = ImportRules({
  cwd: "packages/smithers/flows",
  rules: [{
    kind: "forbidCalls",
    files: ["test/examples/24-control-plane-and-gateway.test.ts"],
    callees: ["setTimeout", "*.sleep", "*.waitForTimeout", "vi.mock", "vi.doMock", "jest.mock"],
    because: "test.behavioral: control HTTP host tests use real services and completion signals."
  }]
})

/**
 * Changed public APIs against the package README, every docs page (concepts
 * and guides included), and the site API reference page.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/flows.mdx")
  ]
})

/**
 * Changed exports against their own JSDoc.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd })

// Nested packages (engine, kernel, sandbox, ...) own their own reviews; these
// globs reach only this barrel's src/, docs/, scripts/ and examples. Users copy
// the examples, so a leak or an unguarded listener in one becomes one in every
// project built from it.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "scripts/**", "examples/**", "test/examples/**"],
  checks: [
    {
      id: "control-server-auth",
      title: "The example control server authenticates every HTTP and WebSocket call",
      threat:
        "A local process or a web page in the user's browser plans, approves, or launches flows on the example control plane.",
      lookFor: [
        "The bearer credential in serve() not drawn from randomBytes(32), or reused, logged, or returned in Summary.",
        "The Host/Origin middleware running after routing or the WebSocket upgrade, or accepting a mismatched Origin.",
        "NodeHttpServer.layer bound to anything other than 127.0.0.1, or a route mounted outside ControlRpcs.layerBearerAuth."
      ],
      paths: ["examples/24-control-plane-and-gateway.ts", "examples/24-project/**", "test/examples/24-*.test.ts"]
    },
    {
      id: "example-process-containment-scope",
      title: "Example processes run with the narrowest capability and are reaped",
      threat:
        "A copied example grants flows unrestricted process spawn on the host or leaves orphaned process groups running after a crash.",
      lookFor: [
        "A Capability.Permission.Rule allowing proc:spawn with resource '*' in an engine that registers flows other than the fixed sleep/containment demos of examples 19 and 37.",
        "A child spawned with a shell string built from payload or argv values.",
        "A sandbox session root or captureWork result applied to the host workspace without the caller deciding.",
        "A spawned child with no acquireRelease finalizer or ProcessLedger record."
      ],
      paths: [
        "examples/19-cancel-and-child-cleanup.ts",
        "examples/37-host-containment.ts",
        "examples/37-host-containment-host.ts",
        "examples/40-sandbox-placement.ts",
        "examples/41-sandboxed-flow.ts",
        "examples/sandboxed-child.ts"
      ]
    },
    {
      id: "example-fixture-servers-loopback",
      title: "Example fixture servers bind loopback and survive malformed input",
      threat:
        "A host on the network reads or poisons the example action cache, or one malformed request crashes the fixture mid-run.",
      lookFor: [
        "server.listen or a telemetry baseUrl bound to a non-loopback address.",
        "decodeURIComponent or JSON.parse on request input with no try/catch in a request or line handler.",
        "A PUT /ac/{key} accepted without a body size limit."
      ],
      paths: ["examples/35-remote-cache.ts", "examples/10-telemetry-export.ts"]
    },
    {
      id: "example-agent-prompt-payload",
      title: "Payload text in a model-authored plan cannot widen the work a round may run",
      threat:
        "A flow caller injects instructions through a prompt-interpolated payload field and makes the plan author schedule work beyond its declared envelope.",
      lookFor: [
        "A scripted model that splices prompt text into plan code without JSON.stringify.",
        "Budget.layerUnbounded or QuotaPolicy.layerUnclassified used in an example that reaches a real provider."
      ],
      paths: ["examples/33-delegation-trellis.vibe"]
    },
    {
      id: "runtime-guarded-layering",
      title: "The injected Runtime keeps the engine's privileged jj apart from what flow bodies resolve",
      threat:
        "A host composing Runtime.layer hands flow bodies the unguarded repository the engine snapshots with, so an action bypasses its capability ceiling.",
      lookFor: [
        "privilegedJj provided beside the engine instead of only to EngineStore.layerWithPrivilegedJj.",
        "Caller-supplied options read after validate returns, so a caller can change them after construction."
      ],
      paths: ["src/Runtime.ts", "src/internal/RuntimeOptions.ts"]
    },
    {
      id: "docs-copyable-snippets",
      title: "Copyable docs snippets do not teach unsafe sandbox or runtime configuration",
      threat:
        "A user copying a guide ships shared session keys, applies an unreviewed guest diff to the host, or hardcodes a credential.",
      lookFor: [
        "A snippet that applies Result.diff to the host workspace without a review or path check.",
        "A snippet with a literal API key, DSN password, or token, or a session key constant across executions."
      ],
      paths: ["docs/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    fmt,
    lib,
    lint,
    importRules,
    test,
    ...securityReview
  }
})
