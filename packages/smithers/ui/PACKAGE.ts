/**
 * Targets for the private Smithers component kit.
 *
 * `@smthrs/ui` ships its sources directly and uses Bun for its tests.
 *
 * Its presence here is what this file is for. The root `packageDefaults`
 * synthesizes `BuildAndCheckTypeScriptPackage` — a dual `dist/esm` and `dist/cjs` library
 * build, a vitest
 * suite at 100% coverage, eslint, and dprint — for every `packages/*`
 * directory that ships no `PACKAGE.ts` of its own. This package satisfies none of
 * that: it ships its sources directly, types against `@types/bun`, and tests
 * with `bun test`. Declaring the targets it can honor opts it out of the
 * synthesis (`PackageDefaults` skips a directory holding a `PACKAGE.ts`) and puts
 * its real gates in the graph instead of targets that cannot pass.
 *
 * Two of the four standard gates are honored here: the `bun test` suite and a
 * `vibelang --noEmit` typecheck over `src/`. The eslint and dprint halves are NOT
 * declared, because this package carries neither an `eslint.config.js` nor a
 * `dprint.json` and both tools are per-package devDependencies elsewhere in the
 * workspace; wiring them requires package tooling that this target does not
 * provide.
 */
import { SdkRules } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui"

/** The component sources the suite drives. */
const sources = [
  Smithers.glob("//packages/smithers/ui/src/**/*.ts"),
  Smithers.glob("//packages/smithers/ui/src/**/*.tsx")
]

/**
 * What generated views are built from beyond `src/`: the script that
 * generates the presentation bundle and the frame runtime.
 */
const generatedViewInputs = [Smithers.file("//packages/smithers/ui/scripts/build-views.mjs")]

/**
 * The `@smthrs/views` sources the realm and the bridge come from, as that
 * package's `sourceFiles` label. A selector, not an import of its PACKAGE.ts:
 * that file reaches the root PACKAGE.ts.
 */
const viewsSources = Smithers.Target.subtree("//packages/smithers/ui/views/...", "sourceFiles")

/**
 * Checks every component source against the package tsconfig.
 *
 * The package publishes its `src/` tree directly (`files: ["src/"]`, every
 * export condition points at a `.ts`/`.tsx` source), so this typecheck is the
 * only thing standing between a type error and a consumer's build. Root
 * `pnpm run check` reaches it through the package's own `check` script.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The component suite: everything under `tests/`, run by Bun against a
 * happy-dom registrator, which is how this package has always tested.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    ...sources,
    ...generatedViewInputs,
    Smithers.glob("//packages/smithers/ui/tests/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/tests/**/*.tsx")
  ],
  deps: [viewsSources],
  cwd
})

/**
 * Browser probes for generated views: real Chromium through Playwright. A
 * hostile view's HTML, a hostile frame runtime, the bridge, and the sanitizer
 * fuzzed with Chromium's parser, each checked against the parent page's DOM,
 * storage, the network, navigation and inline handlers. Needs Playwright's
 * Chromium (`pnpm exec playwright install chromium`).
 *
 * @since 1.0.0
 * @category test
 */
const browserProbes = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["browser"]),
  srcs: [
    ...sources,
    ...generatedViewInputs,
    Smithers.glob("//packages/smithers/ui/browser/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/browser/**/*.tsx")
  ],
  deps: [viewsSources],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** Every named root export needs documentation, including erased props types. */
const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  cwd,
  deps: [
    Smithers.Shell.Test({
      shell: "node --test packages/smithers/ui/scripts/reference-docs.test.mjs",
      data: [
        Smithers.file("scripts/reference-docs.test.mjs"),
        ...sources,
        Smithers.glob("src/**/*.vibe"),
        Smithers.glob("docs/**/*.md")
      ]
    })
  ]
})

/**
 * The component sources as a file group, for the packages that compose these
 * components (`@smthrs/repo-view`, `@smthrs/terminal-frame`), reached by
 * `Smithers.Target.subtree("//packages/smithers/ui/...", "sourceFiles")`. A
 * glob in another package cannot reach them; a label can.
 */
const sourceFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("src/**/*.tsx")],
  cwd
})

/** Complete React source input for the reproducible Solid projection. */
const solidCodegenInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*"), Smithers.file("package.json")],
  cwd
})

/**
 * Security review for the component kit. The kit renders model output, tool
 * results, run artifacts, and caller-supplied URLs inside the product UI, so
 * its checks target DOM sinks, link and frame sources, injected CSS, secret
 * display, and the command lines composed from forms and composer text.
 * `ui-styleguide/` is a nested package with its own review and lies outside
 * the default `src/**` include.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "href-scheme-filter",
      title: "Every rendered anchor href passes safeHref before reaching the DOM",
      threat: "A model, tool result, or synced calendar event plants a javascript: or data: link that runs script in the signed-in user's app session when clicked.",
      lookFor: [
        "An <a href={...}> or onNavigate/onLinkClick call fed from source.href, event.href, resource.href, registryUrl, source.url, or a markdown link without safeHref.",
        "A safeHref change that stops rejecting C0 control characters or that allows a scheme beyond http, https, and mailto.",
        "A target=\"_blank\" anchor without rel=\"noreferrer\" or rel=\"noopener\"."
      ],
      paths: [
        "src/internal/safeHref.ts",
        "src/primitives/markdown.tsx",
        "src/agentic/Sources.tsx",
        "src/agentic/InlineCitation.tsx",
        "src/calendar/Calendar.tsx",
        "src/approvals/ApprovalCard.tsx",
        "src/artifacts/PackageInfo.tsx",
        "src/vault/wikilinks.ts"
      ]
    },
    {
      id: "web-preview-sandbox",
      title: "WebPreview frames only http(s) or same-origin paths and never grants allow-scripts with allow-same-origin",
      threat: "Agent-controlled preview content escapes the iframe sandbox and reads the user's session cookies or app origin storage.",
      lookFor: [
        "sanitizePreviewSrc accepting javascript:, data:, blob:, file:, protocol-relative //host, or /\\host after tab/CR/LF stripping.",
        "The iframe src or sandbox attribute placed before the {...props} spread so a runtime caller can override it.",
        "resolveSandboxTokens returning both allow-scripts and allow-same-origin, or accepting a token outside the known set."
      ],
      paths: ["src/sandbox/WebPreview.tsx"]
    },
    {
      id: "no-raw-html-sinks",
      title: "Untrusted text reaches the DOM only as React text children",
      threat: "Model output, stack traces, diffs, terminal streams, or vault notes inject HTML or script into the user's app page.",
      lookFor: [
        "dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML, or document.write fed from props or model data instead of a module constant.",
        "The markdown primitive, CodeBlock, StackTrace, Snippet, or agent-output renderers switching to an HTML string renderer."
      ],
      paths: [
        "src/primitives/**",
        "src/agentic/**",
        "src/artifacts/**",
        "src/adapters/**",
        "src/vault/**",
        "src/chat/**",
        "src/canvas/**"
      ]
    },
    {
      id: "untrusted-image-src",
      title: "Model- or tool-supplied image URLs never load arbitrary remote origins",
      threat: "A prompt-injected model or tool result sets an image or favicon URL that makes the viewer's browser send run data or their IP to an attacker host on render, with no click.",
      lookFor: [
        "An <img src> fed from ToolCall part.src, Sources or InlineCitation faviconUrl without passing src/internal/safeImageSrc.ts.",
        "Attachment thumbnailUrl/AttachmentPreview src (src/chat/Attachment.tsx) and MessageAvatar src (src/chat/Message.tsx) are still unguarded <img> sinks: accepted because the host supplies them (uploads, avatars), but a caller wiring model or tool output into them reopens the fetch-on-render leak.",
        "A markdown image node rendered as <img> with the document-supplied URL.",
        "An img src accepting javascript:, file:, or a remote http(s) URL where only data:, blob:, or same-origin should reach it."
      ],
      paths: [
        "src/agentic/ToolCall.tsx",
        "src/agentic/Sources.tsx",
        "src/agentic/InlineCitation.tsx",
        "src/chat/Attachment.tsx",
        "src/chat/Message.tsx",
        "src/primitives/markdown.tsx"
      ]
    },
    {
      id: "chart-css-injection",
      title: "Chart config keys and colors cannot break out of the generated <style> block",
      threat: "A caller-supplied chart config breaks out of the injected stylesheet to restyle or overlay app UI, or loads a remote url() that tracks the viewer.",
      lookFor: [
        "ChartStyle emitting a key or id that fails CSS_IDENTIFIER, or a color that SAFE_CSS_COLOR does not admit.",
        "SAFE_CSS_COLOR widening so a value such as url(https://...) or image-set(...) reaches fill/stroke.",
        "Any other style injection (styles.tsx, terminal.tsx) built from props rather than static CSS."
      ],
      paths: ["src/adapters/chart.tsx", "src/styles.tsx", "src/adapters/terminal.tsx"]
    },
    {
      id: "secret-display",
      title: "Masked secrets never appear in the DOM, labels, or logs",
      threat: "A shoulder-surfer, screen recorder, or DOM-reading extension reads a user's API key or environment secret shown while masked.",
      lookFor: [
        "SecretField rendering value, a length-derived mask, or the value inside an aria-label/title/data attribute while revealed is false.",
        "EnvironmentVariable rendering a credential-shaped value as plain text: a name CREDENTIAL_NAME misses (including the whole-word PW/PWD/SK/PAT/OTP/TOTP/PIN abbreviations) or a user:password@ URL value, leading whitespace included, CREDENTIAL_URL misses.",
        "A write-only flow-form field that reaches assembleArgs, a draft, or a console call instead of being dropped by publicFormPayload."
      ],
      paths: ["src/artifacts/SecretField.tsx", "src/artifacts/EnvironmentVariables.tsx", "src/flow-form.ts", "src/internal/useCopyFeedback.ts"]
    },
    {
      id: "command-line-assembly",
      title: "Composer text and form values cannot smuggle extra flow names, flags, or sourceCard tokens",
      threat: "Prefilled or model-suggested form text runs a different flow, adds a --flag, or rebinds sourceCard so a run acts on another card than the user chose.",
      lookFor: [
        "assembleArgs joining a text value containing spaces, --name, or sourceCard= unquoted so the flow grammar reads it as a separate token.",
        "assembleLine writing a value positionalRead would place in another field (a multi-word value short of the final slot, JSON with whitespace, a value behind an unset slot, an optional value a required slot would take) instead of withholding it.",
        "assembleLine returning a flow args builder's line without withholding a value it writes unquoted with a --flag or sourceCard= token, or one the flow's partial does not read back.",
        "A caller that re-parses an assembled line as text (search actions) offering it with a non-empty withheld, or a display echo dropping withheld fields instead of using displayLine.",
        "splitRunSource or runSearchPayload trusting a sourceCard or run id taken from user-typed args instead of the recorded card.",
        "parseCommand or COMMAND_NAME widening so punctuation or a typo after / executes a side-effecting flow instead of becoming a prompt."
      ],
      paths: ["src/command-line.ts", "src/run-command.ts", "src/flow-form.ts", "src/flow-arguments.ts"]
    },
    {
      id: "untrusted-parse-bounds",
      title: "Parsers of agent output, schemas, diffs, and JSON stay bounded on hostile input",
      threat: "A model or tool emits deeply nested, cyclic, or huge output that freezes or crashes the user's app tab.",
      lookFor: [
        "Recursion in parseAgentOutput, formatPartialJson, or SchemaDisplay without the MAX_*_DEPTH, property, or seen-set guards.",
        "A regex over agent text or diffs with nested quantifiers that backtracks catastrophically.",
        "diff-paginate or diff-hunks materializing an unbounded hunk or line list for one render."
      ],
      paths: ["src/agentic/**", "src/artifacts/SchemaDisplay.tsx", "src/diff*.ts", "src/diff-hunks.tsx", "src/vault/**"]
    },
    {
      id: "generated-view-frame",
      title: "A generated view's HTML is shown only through the sandboxed frame, its pinned runtime and its sanitizer",
      threat:
        "Model-authored view HTML runs script, reads the app's DOM, storage or cookies, loads from the network, or navigates, in the signed-in user's session.",
      lookFor: [
        "GeneratedView rendering view HTML outside the iframe, or an iframe sandbox with allow-same-origin, allow-forms, allow-popups, allow-modals or allow-top-navigation, or an `allow` delegation.",
        "A srcdoc not built by ViewCsp.frameDocument, a runtime other than the hashed one, or view HTML written into the srcdoc.",
        "The handshake answering a message whose source is not this mount's contentWindow or whose nonce differs, or a later message that skips Bridge.receive.",
        "sanitize keeping an element or attribute that runs, loads or navigates: script, iframe, a, meta, base, link, style, on*, href, a non-data:image src, srcset, action, formaction, xlink:href, or a style with url().",
        "The frame runtime reading document.body or other document properties after view content is inserted (DOM clobbering), or sending an interaction for an untrusted event."
      ],
      paths: ["src/generated-view/**", "src/presentation/**", "src/internal/frameMount.ts"]
    },
    {
      id: "attachment-intake",
      title: "Prompt attachments enforce accept, size, and count limits and revoke their object URLs",
      threat: "A pasted or dropped file bypasses the configured type or size limit, or leaked object URLs keep file bytes readable after removal.",
      lookFor: [
        "The paste or drop path in PromptInput skipping fileMatchesAccept, maxFileSizeBytes, maxFiles, or disabled checks that the picker path applies.",
        "An object URL created for a non-image type or never revoked on removal or unmount."
      ],
      paths: ["src/prompt/PromptInput.tsx"]
    }
  ]
})

/**
 * Will's SDK-wide rules (apps/mvp/docs/rules.md). The package renders React,
 * so only root imports, dead code and tests are held to them. `jevRules` is
 * manual.
 */
const { importRules, jevRules } = SdkRules({ cwd, role: "components", tests: ["tests/**/*.test.{ts,tsx}"] })

export const Package = Smithers.Package({
  targets: {
    solidCodegenInputs,
    check,
    docs,
    docsFiles,
    sourceFiles,
    importRules,
    jevRules,
    unitTests,
    browserProbes,
    ...securityReview
  }
})
