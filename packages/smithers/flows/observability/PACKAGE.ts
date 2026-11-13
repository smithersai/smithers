import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/smithers/flows/observability"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("{src,examples}/**/*.{ts,vibe}"),
  examples: [{
    page: Input.file("docs/quickstart.md"),
    example: Input.file("examples/quickstart.vibe"),
    test: Input.file("test/quickstart.test.vibe")
  }],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "collector-endpoint-validation",
      title: "Every exporter endpoint is decoded by Endpoint.decode before any request is built",
      threat:
        "A misconfigured or attacker-influenced endpoint sends traces, logs, and exporter auth headers to a host the operator never named.",
      lookFor: [
        "An exporter URL built from options.baseUrl or options.endpoint without passing through Endpoint.decode first.",
        "isAbsoluteHttpUrl accepting a value with userinfo, query, fragment, backslash, or a code unit at or below 0x20 that new URL repairs.",
        "signalUrl or normalize producing a URL whose host differs from the decoded endpoint's host."
      ],
      paths: ["src/Endpoint.ts", "src/Otlp.ts", "src/NodeOtel.ts"]
    },
    {
      id: "exporter-header-secrecy",
      title: "Exporter auth headers never reach logs, metrics, errors, or the journal",
      threat:
        "Anyone who can read ambient logs, the journal, or collector data obtains the vendor token passed in Otlp headers.",
      lookFor: [
        "The otlp_export_discarded warning or any refusal message including request headers, the request URL, or options.headers.",
        "InvalidExporterEndpoint or InvalidResourceConfiguration messages that embed the rejected raw value instead of only its path."
      ],
      paths: ["src/Otlp.ts", "src/Endpoint.ts", "src/Resource.ts", "src/internal/schemaIssuePath.ts"]
    },
    {
      id: "ambient-env-isolation",
      title: "Exported resources carry only validated explicit attributes, never ambient OTEL_* environment",
      threat:
        "A process environment variable such as OTEL_RESOURCE_ATTRIBUTES leaks host secrets or unbounded metadata into every export request.",
      lookFor: [
        "An Otlp.layerJson or NodeSdk.layer call not wrapped with ConfigProvider.layer(ConfigProvider.fromUnknown({})).",
        "A new code path that reads process.env or Resource.layerFromEnv.",
        "NodeOtel's OTLP*Exporter constructors, which read OTEL_EXPORTER_OTLP_*_HEADERS, TIMEOUT, and CLIENT_CERTIFICATE/KEY straight from process.env and bypass the ConfigProvider isolation, left undocumented or without explicit overrides."
      ],
      paths: ["src/Otlp.ts", "src/NodeOtel.ts", "src/BrowserOtel.ts", "src/Otel.ts", "src/Resource.ts"]
    },
    {
      id: "journal-forwarding-bounds",
      title: "Journal forwarding snapshots before offering to a bounded nonblocking queue",
      threat:
        "A hostile log event bypasses journal redaction or stalls the host through an unbounded forwarding queue.",
      lookFor: [
        "A forwarding path that skips Telemetry.snapshot before Queue.offerUnsafe.",
        "A full queue blocking the logger callback instead of discarding and counting the record.",
        "A worker delivery failure or defect that drops records without incrementing droppedLogRecords."
      ],
      paths: ["src/JournalLogger.ts"]
    },
    {
      id: "relay-input-boundary",
      title: "Untrusted OTLP JSON stays bounded, validated and redacted before a server logger receives it",
      threat: "A public telemetry route accepts oversized or hostile input and leaks client secrets into server logs.",
      lookFor: [
        "A request read or JSON traversal that bypasses maxBodyBytes, maxNesting or maxRecords.",
        "An off-allowlist record, raw attribute, log body or exception escaping relay redaction.",
        "A malformed input or rejected record returning its raw payload in an error or diagnostic."
      ],
      paths: ["src/OtlpRelay.ts"]
    },
    {
      id: "export-redaction-boundary",
      title: "Every exported signal is redacted after transformation and before size checks and transport",
      threat: "Credentials in spans, exception events, log messages or metric attributes reach an external collector.",
      lookFor: [
        "A transform result or fallback that bypasses ExportRedaction.redact at the encoded boundary.",
        "Exception messages, stack traces, span status messages or nested OTLP values skipped by redaction.",
        "A redaction failure that forwards the original payload instead of a safe fallback."
      ],
      paths: ["src/Otlp.ts", "src/internal/exportRedaction.ts"]
    },
    {
      id: "console-logger-redaction",
      title: "Every installed logger sees only redacted messages, causes and annotations",
      threat: "A credential printed in a failure reaches a console or caller-supplied logger in clear text.",
      lookFor: [
        "A built-in or caller-supplied sink installed without RedactedLogger.wrap.",
        "Structured or pretty formatting that reads the raw event before redaction.",
        "A failure path that prints the raw value while constructing a fallback log line."
      ],
      paths: ["src/Logger.ts"]
    },
    {
      id: "failure-label-privacy",
      title: "Failure counts and recent history carry bounded labels without private request or log content",
      threat:
        "User text, credentials or URL identifiers leak into metric labels and recent history or create unbounded series.",
      lookFor: [
        "A LogFailures label or Recent entry built from a raw error message or unbounded annotation.",
        "A label set or recent-history buffer exceeding its configured cap.",
        "FetchFailures logging a full URL, path, query or request body instead of a caller-supplied route template."
      ],
      paths: ["src/LogFailures.ts", "src/FetchFailures.ts"]
    },
    {
      id: "export-request-bounds",
      title: "Resource and transport limits keep every export request bounded",
      threat:
        "A caller-supplied resource or a stalled collector makes every export oversized or pins unbounded in-flight requests, denying telemetry and memory to the host.",
      lookFor: [
        "encodedResourceBytes under-counting a value shape so a resource over maximumResourceBytes decodes.",
        "boundedClient forwarding a request over maxRequestBytes or queueing past maxInFlight instead of discarding.",
        "A request body type for which contentLength is undefined so the size check is skipped."
      ],
      paths: ["src/Otlp.ts", "src/Resource.ts"]
    },
    {
      id: "docs-copyable-secrets",
      title: "Docs examples carry placeholder credentials and send tokens only over https",
      threat:
        "A user copying a docs snippet commits a real token or sends a bearer token to a plaintext http collector.",
      lookFor: [
        "A literal token, key, or password in docs other than a YOUR_TOKEN style placeholder.",
        "An example pairing an authorization header with an http:// baseUrl."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...securityReview }
})
