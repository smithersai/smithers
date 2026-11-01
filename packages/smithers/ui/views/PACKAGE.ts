import {
  BuildAndCheckTypeScriptPackage,
  ReviewDocsAgainstCode,
  ReviewJsdocAgainstCode,
  SdkRules
} from "@smthrs/repo-targets"
/** Standard package targets for generated views, its import rules, and a security review of the realm and frame. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import { Package as harnessPackage } from "../../agent/harness/PACKAGE.ts"
import { Package as cryptoPackage } from "../../flows/crypto/PACKAGE.ts"
import { Package as flowPackage } from "../../flows/flow/PACKAGE.ts"

const cwd = "packages/smithers/ui/views"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [harnessPackage.lib, cryptoPackage.lib, flowPackage.lib],
  sources: Input.glob("{src,examples}/**/*.{ts,vibe}"),
  cwd
})

/** Changed public APIs against the package README and every docs page. */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  context: [Smithers.file("README.md"), Smithers.glob("docs/**/*.md")]
})

/** Changed exports against their own JSDoc. */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd })

/**
 * Will's SDK-wide rules (apps/mvp/docs/rules.md). The library runs in a
 * browser, a Worker, Node and Bun, imports Smithers packages from their roots,
 * and returns Effects it never runs. Run the deterministic half with
 * `pnpm exec smithers-build test //packages/smithers/ui/views:importRules`;
 * `jevRules` is manual.
 */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

/**
 * The library's sources as a file group, for `@smthrs/ui`, whose generated
 * views bundle the realm and the bridge from them. A glob in another package
 * cannot reach them; a label can.
 */
const sourceFiles = Smithers.Filegroup({ srcs: [Smithers.glob("src/**/*.{ts,vibe}")], cwd })

/** Security review: `security` reviews the diff, `securityAudit` audits the package. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "realm-authority",
      title: "A view module reaches nothing but the four view modules, and every value crosses as a JSON string",
      threat:
        "A model-written view reads the host's memory, network, storage or clock, or changes what a later view renders.",
      lookFor: [
        "A host function installed in the QuickJS context, or a host object or handle passed into the realm instead of a JSON string.",
        "A `require` name in Presentation.ts beyond react, react/jsx-runtime, @smthrs/ui and smithers:view, or a module object that is not frozen.",
        "`Date`, `Math.random`, `Proxy`, `WeakRef` or `FinalizationRegistry` left in the realm, or `install` publishing before `harden` freezes the global.",
        "`install` hardening less than `require` and every module behind it, or a runtime kept for a second render or interaction instead of closed after its call."
      ],
      paths: ["src/PresentationRealm.ts", "src/Presentation.ts", "src/internal/harden.ts"]
    },
    {
      id: "realm-limits",
      title: "Time, steps, memory, stack, HTML, state and props bound every render",
      threat: "A looping, allocating or recursing view hangs or crashes the tab or Worker that renders it.",
      lookFor: [
        "A render or reduce path that evaluates code without `arm` resetting the deadline and step budget.",
        "A stack bound large enough for the host's own stack to overflow first, or a broken runtime disposed after a host overflow.",
        "A runtime reused after a time, step, memory or stack limit instead of replaced."
      ],
      paths: ["src/PresentationRealm.ts"]
    },
    {
      id: "telemetry-content-free",
      title: "A failed check or render exports only reasons, limits and counts",
      threat:
        "A view throws its props, state or event, and the message reaches a span, a log line or a metric despite the frame's network isolation.",
      lookFor: [
        "A realm span opened with plain `Effect.withSpan` instead of `SpanFailure.withSpan`, or a span attribute other than `realm.reason` and `realm.limit`.",
        "Module, thrown or input text written into `RealmError.message` or any field other than the redacted `detail`.",
        "Module text written into `ViewCodeError.message` or any field other than the redacted `detail` and `problems`.",
        "A metric attribute other than `limit`."
      ],
      paths: ["src/PresentationRealm.ts", "src/ViewCode.ts"]
    },
    {
      id: "frame-policy",
      title: "The frame admits only the hashed runtime and loads nothing from the network",
      threat: "A view's HTML runs script, loads a remote resource, submits a form or navigates the page.",
      lookFor: [
        "A `sandbox` value with allow-same-origin, allow-forms, allow-popups, allow-top-navigation or allow-modals.",
        "A CSP directive that admits a scheme, a host, 'unsafe-inline' script or 'unsafe-eval', or drops script-src-attr 'none'.",
        "frameDocument writing view content, or a runtime or style sheet that can close its own element early."
      ],
      paths: ["src/ViewCsp.vibe"]
    },
    {
      id: "bridge-admission",
      title: "The page acts only on decoded, bounded, declared and rate-limited frame messages",
      threat:
        "A frame sends an undeclared event, an oversized payload or a flood of interactions that the page turns into questions or state.",
      lookFor: [
        "receive admitting an event `Interactions.lookup` does not find, or matching an inherited property name.",
        "Values over maxValuesBytes, or more than maxInteractionsPerSecond in a window, admitted.",
        "acceptInitialize accepting a nonce that does not match exactly."
      ],
      paths: ["src/Bridge.vibe", "src/Interactions.vibe"]
    }
  ]
})

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
    sourceFiles,
    test,
    ...securityReview
  }
})
