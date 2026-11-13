/**
 * Targets for `@smthrs/repo-view`, the heavy views of a repository.
 *
 * Like `@smthrs/ui`, whose components it composes, the package ships its
 * sources directly, types against `@types/bun` and tests with `bun test`, so
 * it declares the gates it can honor instead of taking the synthesized
 * `BuildAndCheckTypeScriptPackage` (`PackageDefaults` skips a directory
 * holding a `PACKAGE.ts`): a `vibelang --noEmit` typecheck, the Bun suite, which
 * fails below 100% line and function coverage (`bunfig.toml`), and browser
 * probes in real Chromium.
 */
import { SdkRules } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui/repo-view"

/** The view sources the suite drives, the VibeLang grammar included. */
const sources = [
  Smithers.glob("//packages/smithers/ui/repo-view/src/**/*.ts"),
  Smithers.glob("//packages/smithers/ui/repo-view/src/**/*.tsx"),
  Smithers.glob("//packages/smithers/ui/repo-view/src/**/*.json")
]

/**
 * `@smthrs/ui`'s sources and the `@smthrs/views` sources it builds on, as
 * their `sourceFiles` labels: the views compose its components and read its
 * tokens, so a change there re-runs this suite. A selector, not an import of
 * ui's PACKAGE.ts; this package declares no `sourceFiles` of its own, so the
 * selector never reaches back here.
 */
const uiSources = Smithers.Target.subtree("//packages/smithers/ui/...", "sourceFiles")

/**
 * Checks every source against the package tsconfig. The package publishes its
 * `src/` tree directly, so this is the only gate between a type error and a
 * consumer's build.
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
 * The suite: everything under `test/`, run by Bun against happy-dom, each
 * file in a fresh module registry (`--isolate`), at 100% line and function
 * coverage of `src/`.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["./test"], { isolate: true }),
  srcs: [
    ...sources,
    Smithers.file("bunfig.toml"),
    Smithers.glob("//packages/smithers/ui/repo-view/test/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/repo-view/test/**/*.tsx"),
    Smithers.glob("//packages/smithers/ui/repo-view/test/**/*.snap"),
    // test/docs-contracts.test.ts holds the docs' examples and stated contracts to the code.
    Smithers.glob("//packages/smithers/ui/repo-view/docs/**/*.md"),
    Smithers.file("README.md"),
    Smithers.file("package.json")
  ],
  deps: [uiSources],
  cwd
})

/**
 * Browser probes: `HtmlPreview` in real Chromium, where a page that navigates
 * itself must request nothing and a page that reloads itself must stop. Needs
 * Playwright's Chromium (`pnpm exec playwright install chromium`).
 *
 * @since 0.1.0
 * @category test
 */
const browserProbes = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["browser"]),
  srcs: [
    ...sources,
    Smithers.glob("//packages/smithers/ui/repo-view/browser/**/*.tsx")
  ],
  deps: [uiSources],
  cwd
})

/** The package's documentation as a file group: `docs/**`, the README and package.json. */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/**
 * Security review. The views render repository content, which anyone who can
 * push to a repository controls: file text, Markdown, patches and the links
 * inside them.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "repository-content-as-text",
      title: "Repository content reaches the DOM only as text, highlighted tokens or Milkdown's schema nodes",
      threat: "A file, a README or a patch injects HTML or script into the signed-in user's page.",
      lookFor: [
        "dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML, or document.write fed from file contents, a patch or Markdown.",
        "Milkdown Crepe, or pierre's File or CodeView, configured to render raw HTML nodes from document content.",
        "The read-only Markdown view parsing an HTML node as anything but text."
      ],
      paths: ["src/**"]
    },
    {
      id: "repository-links",
      title: "A link inside a repository document navigates within the repository or leaves it to the browser",
      threat: "A README link runs script in the app's origin or sends the reader somewhere other than where it says.",
      lookFor: [
        "resolveLink turning a link with a scheme, a protocol-relative link or one that climbs above the root into in-app navigation.",
        "A navigation that skips isPlainNavigationClick, so a modified click no longer opens a new tab.",
        "An href built from document content without passing through the host's `href`."
      ],
      paths: ["src/RepoView.tsx", "src/paths.ts", "src/MarkdownEditor.tsx"]
    },
    {
      id: "static-style-injection",
      title: "Injected style sheets are static strings",
      threat: "A host or document value breaks out of a `<style>` element to restyle or overlay the page, or loads a remote url().",
      lookFor: [
        "repoViewCss or markdownEditorCss built from props or document content rather than module constants.",
        "PierreDiffView's `unsafeCSS` or CodeFileView's pierre options fed from repository content."
      ],
      paths: ["src/styles.tsx", "src/MarkdownEditor.tsx", "src/PierreDiffView.tsx", "src/CodeFileView.tsx"]
    }
  ]
})

/**
 * Will's SDK-wide rules (apps/mvp/docs/rules.md). The package renders React,
 * so only root imports, dead code and tests are held to them. `jevRules` is
 * manual.
 */
const { importRules, jevRules } = SdkRules({ cwd, role: "components", tests: ["test/**/*.test.{ts,tsx}"] })

export const Package = Smithers.Package({
  targets: {
    browserProbes,
    check,
    docsFiles,
    importRules,
    jevRules,
    unitTests,
    ...securityReview
  }
})
