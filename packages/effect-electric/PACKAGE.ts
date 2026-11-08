import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
/** Standard package targets for Electric over Effect, plus a security review of the shape proxy. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import { Package as tanstackDb } from "../effect-tanstack-db/PACKAGE.ts"

const cwd = "packages/effect-electric"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [tanstackDb.lib],
  sources: Input.glob("{src,examples}/**/*.ts"),
  testProgram: Smithers.file("//packages/effect-electric/scripts/test-services.mjs"),
  testData: ["scripts/test-services.yaml"],
  cwd
})

/** Security review: `security` reviews the diff, `securityAudit` audits the package. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "shape-allowlist",
      title: "The shape proxy forwards only the protocol allowlist and host-chosen shape parameters",
      threat:
        "A browser widens what it reads from Electric by sending table, where, params, columns or replica itself.",
      lookFor: [
        "A browser query parameter outside the protocol allowlist reaching the upstream URL.",
        "The host's table, where or params appended before the browser's, or the browser's value winning a duplicate."
      ],
      paths: ["src/ShapeProxy.vibe"]
    },
    {
      id: "secret-opacity",
      title: "Electric's secret never reaches a log line, span attribute, metric or response",
      threat: "Anyone who reads the host's telemetry or a proxied response learns the Electric secret.",
      lookFor: [
        "The secret appended as a plain string where an HTTP client span records url.full.",
        "A log annotation, span attribute or response header carrying the secret or the upstream URL."
      ],
      paths: ["src/ShapeProxy.vibe"]
    }
  ]
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...securityReview }
})
