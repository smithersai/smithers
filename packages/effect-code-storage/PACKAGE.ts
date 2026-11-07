import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
/** Standard package targets for Code Storage over Effect, plus a security review of its credential handling. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/effect-code-storage"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("src/**/*.ts"),
  cwd
})

/** Security review: `security` reviews the diff, `securityAudit` audits the package. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "key-opacity",
      title: "The organization's signing key and every token it signs stay out of telemetry, errors and responses",
      threat: "Anyone who reads the host's traces, logs or an error learns a key or a live token for every repository.",
      lookFor: [
        "The PEM key, the imported CryptoKey or a signed JWT in a span attribute, log annotation, metric attribute or error field.",
        "A token sent in a URL query parameter, where an HTTP client span records url.full, instead of the Authorization header."
      ],
      paths: ["src/CodeStorage.ts", "src/internal/token.ts"]
    },
    {
      id: "least-scope",
      title: "Each token names one repository and only the scope its call needs, and lives at most an hour",
      threat: "A leaked token reads or writes repositories its call never touched, or outlives the call by days.",
      lookFor: [
        "A token without a repo claim, or with git:write or repo:write on a read.",
        "An exp more than 3,600 seconds after iat, or a lifetime a caller can raise past that."
      ],
      paths: ["src/CodeStorage.ts", "src/internal/token.ts"]
    },
    {
      id: "provider-text",
      title: "Code Storage's and GitHub's error text never reaches an error, span or log line",
      threat: "A provider's free-text detail echoes request content into the host's telemetry.",
      lookFor: [
        "A problem body's detail, title or error field, or a response body, copied into CodeStorageError or GitRemoteError."
      ],
      paths: ["src/CodeStorage.ts", "src/GitRemote.ts"]
    },
    {
      id: "bounded-reads",
      title: "Every response body the package reads is bounded",
      threat: "A huge or endless response exhausts a Worker's memory.",
      lookFor: [
        "readFile reading past maxBytes, or trusting a missing Content-Length.",
        "GitRemote.head reading the whole ref advertisement instead of stopping after the first ref line and a fixed byte cap."
      ],
      paths: ["src/CodeStorage.ts", "src/GitRemote.ts"]
    }
  ]
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...securityReview }
})
