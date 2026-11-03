import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
/** Standard package targets for the secrets egress, plus a security review of its secret handling. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/smithers/flows/secrets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("src/**/*.{ts,vibe}"),
  cwd
})

/** Security review: `security` reviews the diff, `securityAudit` audits the package. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "value-opacity",
      title: "A secret's value never reaches a span, log line, metric, error or audit entry",
      threat:
        "Anyone who reads the host's telemetry, a failure or the audit learns a credential the guest was never given.",
      lookFor: [
        "A value, a substituted header or the outgoing request in a span attribute, log annotation, metric attribute, Egress error or audit Entry.",
        "The HTTP client's own span left on, or an HttpClientError (which holds the substituted request) kept in a failure or cause.",
        "The response body's stream error passed through instead of replaced by Broken."
      ],
      paths: ["src/Egress.ts", "src/Binding.vibe"]
    },
    {
      id: "audience-binding",
      title: "A value is substituted only into a request for one of its own hosts and methods, over HTTPS",
      threat: "A guest sends a placeholder to a host it controls and receives the value.",
      lookFor: [
        "Substitution before every found placeholder is checked against its secret's hosts and methods.",
        "A host compared other than exactly (suffix, case, port, userinfo, a Host header instead of the URL).",
        "A placeholder in the URL or the body substituted, or substitution over plain HTTP."
      ],
      paths: ["src/Egress.ts"]
    },
    {
      id: "redirects",
      title: "The egress never follows a redirect",
      threat: "An allowed host redirects to another, and the client resends the substituted headers there.",
      lookFor: [
        "A request sent without `redirect: \"manual\"` on a Fetch client, or with HttpClient.followRedirects."
      ],
      paths: ["src/Egress.ts"]
    },
    {
      id: "scrub-coverage",
      title: "Every echo of a revealed value in the answer's headers and body is scrubbed, across chunks",
      threat: "An allowed host echoes the value back, and the guest reads it.",
      lookFor: [
        "A form missing for some alignment or alphabet, or a match lost at a chunk boundary.",
        "Range or If-Range forwarded when a value is bound, letting the guest fetch an echo in slices too short to match.",
        "A compressed answer passed through, whose bytes the scrubber can't see."
      ],
      paths: ["src/Scrub.vibe", "src/Egress.ts"]
    },
    {
      id: "header-injection",
      title: "A value can't split a header or exceed the bounds",
      threat: "A stored value with CR or LF injects a header or a request into the upstream connection.",
      lookFor: [
        "A value put in a header without valueProblem, or a control character it misses.",
        "Headers over maximumHeaderBytes or placeholders over maximumPlaceholders accepted."
      ],
      paths: ["src/Binding.vibe", "src/Egress.ts"]
    }
  ]
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...securityReview }
})
