/**
 * Targets for the shared agent contract: the typecheck and the unit suite.
 *
 * Both apps import this package. The suite uses the same Vitest runner and
 * test directory convention as the other contract packages.
 *
 * @since 1.0.0
 */
import { ReviewDocsAgainstCode, ReviewJsdocAgainstCode, SdkRules } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/rpc"

/** The contract sources both apps import. */
const sources = Smithers.glob("//packages/rpc/src/**/*.ts")

/**
 * plue's failure registry as this package vendors it, plus the script that
 * refreshes it. Declared as sources so a refreshed artifact invalidates the
 * suite that checks it: the drift test reads the JSON off disk and imports the
 * script's digest function, neither of which the `*.ts` glob above sees.
 */
const failureCodes = [
  Smithers.glob("//packages/rpc/src/plue-failure-codes.json"),
  Smithers.glob("//packages/rpc/scripts/*.mjs")
]

/**
 * Checks the contract against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts"), ...failureCodes],
  deps: [],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite and projection schema tests.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [
    sources,
    Smithers.glob("test/**/*.{ts,json,snap}"),
    Smithers.glob("testdata/**"),
    ...failureCodes,
    // The coverage gate's global setup, which vitest.config.ts names.
    Smithers.file("//packages/repo-targets/test-utils/coverage-teardown.mjs"),
    Smithers.file("//packages/repo-targets/test-utils/test-process-environment.mjs")
  ],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

/** The colocated documentation checked under the docs verb.
 * @since 1.0.0
 * @category documentation
 */
const docsFiles = Smithers.Filegroup({ srcs: [Smithers.glob("docs/**/*.md")] })
const docs = Smithers.DocsParity({ readme: Smithers.file("README.md"), deps: [docsFiles], cwd })

const lint = Smithers.EsLint({
  sources: [sources],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})
const fmt = Smithers.Dprint({
  sources: [Smithers.glob("**/*.{ts,json,md,js}")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

/**
 * Security review of the wire contracts and the few runtime guards this
 * package ships: model-credential origin pinning, journal capabilities, the agent
 * context prompt, card URLs, and the failure-code generator.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**"],
  checks: [
    {
      id: "model-credential-origin-pinning",
      title: "A model credential travels only to its pinned origin over https or loopback http",
      threat:
        "A user or operator config sends a provider API key to an attacker origin or in cleartext across the network.",
      lookFor: [
        "modelOriginOf or isLoopbackHost admitting plain http to a non-loopback host.",
        "A custom SMITHERS_MODEL_KEY_<NAME>_ORIGIN pair that can re-pin a built-in credential name.",
        "A ConfiguredModel baseUrl or path whose origin is not checked against the credential's origins before use."
      ],
      paths: ["src/ConfiguredModel.ts"]
    },
    {
      id: "secret-free-wire",
      title: "No response, listing, receipt or persisted pending record carries a secret value",
      threat:
        "A renderer script, log reader or browser storage reader obtains an API key, bearer, owner token or journal capability.",
      lookFor: [
        "A response or listing schema (ModelCredentialListing, ModelCredentialResult, ModelCredentialPending) that admits a value or token field.",
        "A .passthrough() or loose object on a reply schema that lets unknown secret fields reach the renderer.",
        "A failure constructor that copies a caught exception or provider body into user-visible text."
      ],
      paths: [
        "src/ConfiguredModel.ts",
        "src/AgentTurnJournal.ts",
        "src/Refusal.ts"
      ]
    },
    {
      id: "local-session-capability",
      title: "Journal capabilities are unguessable and never ride a URL",
      threat: "A web page or local process reads another run's turn journal.",
      lookFor: [
        "A token format shorter than 256 bits or a validator regex that admits non-base64url or shorter values.",
        "A journal read token carried in a query string."
      ],
      paths: ["src/AgentTurnJournal.ts"]
    },
    {
      id: "agent-context-prompt-injection",
      title: "Untrusted text in the agent context cannot pose as system instructions",
      threat:
        "A repository, wiki note, card title or fetched page author steers the agent into tool calls the user did not ask for.",
      lookFor: [
        "A wiki note body, repo name, card title or setup step prompt interpolated without the line() newline fold or the quoted `|` prefix.",
        "Fetched page text or upstream prose placed in the prompt without a label marking it as untrusted data."
      ],
      paths: ["src/AgentContext.ts", "src/AgentRoles.ts", "src/UpstreamProse.ts", "src/NativeAgent.ts"]
    },
    {
      id: "card-url-schemes",
      title: "URLs carried on cards and homepages are http(s) or relative before a renderer links them",
      threat:
        "A repository or upstream author puts a javascript: or data: URL on a card that runs script in the app origin when clicked.",
      lookFor: [
        "A url, htmlUrl, avatarUrl, iconUrl, installUrl or streamUrl field typed z.string() with no scheme refinement.",
        "A link schema in RepositoryHome that accepts a scheme other than http or https.",
        "MythicalIssueSchema.url or MythicalPullRequestSchema.url typed bare z.string() and rendered as an issue or pull request link."
      ],
      paths: [
        "src/Cards.ts",
        "src/SubagentCard.ts",
        "src/RepositoryHome.ts",
        "src/Mythical.ts",
        "src/WebUrl.ts"
      ]
    },
    {
      id: "lsp-root-confinement",
      title: "Code-intelligence paths stay inside the repository root",
      threat: "A renderer script reads files outside the repository through a code-intelligence request.",
      lookFor: [
        "A request schema (LspFileRequestSchema, LspPositionRequestSchema) documented as root-relative whose path field admits an absolute path with no host-side segment check named."
      ],
      paths: ["src/LocalLsp.ts"]
    },
    {
      id: "failure-codes-codegen",
      title: "The failure-code generator emits only data, never code, from its source document",
      threat:
        "Whoever controls a --from URL or file, or the vendored plue-failure-codes.json, injects TypeScript that runs in every app build and test.",
      lookFor: [
        "A document field (status, retry_after, fault, code, doc) interpolated into generated TypeScript without JSON.stringify or a numeric type check.",
        "A --from source fetched over plain http or trusted solely by a digest the same document supplies."
      ],
      paths: ["scripts/refresh-failure-codes.mjs", "src/PlueFailureCodes.ts"]
    }
  ]
})

/**
 * Changed contracts against the package README and docs pages. The package has
 * no site API reference page.
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

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({
  cwd,
  role: "app-library",
  knownDeepImports: {
    packages: ["@smthrs/canonical"],
    because: "the contracts stay runtime-free zod (apps/DESIGN.md, \"Dependency law\"), so they import only " +
      "@smthrs/canonical/Record and @smthrs/canonical/Serializer; the @smthrs/canonical root loads Effect. " +
      "test/NativeAgent.test.ts pins those two subpaths."
  }
})

/**
 * Build, lint, formatting, and test gates for the public wire contracts.
 *
 * @since 1.0.0
 * @category packages
 */
export const Package = Smithers.Package({
  targets: {
    check,
    unitTests,
    lint,
    fmt,
    docs,
    docsFiles,
    importRules,
    jevRules,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    ...securityReview
  }
})
