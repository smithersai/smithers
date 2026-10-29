/**
 * Targets for `@smthrs/terminal-frame`, a shell's terminal in a sandboxed
 * frame.
 *
 * Like `@smthrs/ui`, the package ships its sources directly, types against
 * `@types/bun` and tests with `bun test`, so it declares the gates it can
 * honor instead of taking the synthesized `BuildAndCheckTypeScriptPackage`
 * (`PackageDefaults` skips a directory holding a `PACKAGE.ts`): a
 * `vibelang --noEmit` typecheck, the Bun suite at 100% line and function coverage
 * (`bunfig.toml`), and browser probes in real Chromium.
 */
import { SdkRules } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui/terminal-frame"

/** The frame's sources, and the script that generates its runtime from them. */
const sources = [
  Smithers.glob("//packages/smithers/ui/terminal-frame/src/**/*.ts"),
  Smithers.glob("//packages/smithers/ui/terminal-frame/src/**/*.tsx"),
  Smithers.file("//packages/smithers/ui/terminal-frame/scripts/build-runtime.mjs")
]

/**
 * `@smthrs/ui`'s sources and the `@smthrs/views` sources (`ViewCsp`) the
 * frame builds on, as their `sourceFiles` labels. A selector, not an import of
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
 * coverage of `src/`. It also fails when the committed runtime is stale.
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
    Smithers.glob("//packages/smithers/ui/terminal-frame/test/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/terminal-frame/test/**/*.tsx")
  ],
  deps: [uiSources],
  cwd
})

/**
 * Browser probes: the frame in real Chromium under its own CSP. Needs
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
    Smithers.glob("//packages/smithers/ui/terminal-frame/browser/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/terminal-frame/browser/**/*.tsx")
  ],
  deps: [uiSources],
  cwd
})

/** The package's documentation as a file group: `docs/**`, the README and package.json. */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** Security review: a shell's output is untrusted, and the frame stands between it and the person's page. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "terminal-frame",
      title:
        "A shell's output reaches xterm.js only inside the sandboxed terminal frame, and the frame reaches the page only through its port",
      threat:
        "Escape sequences or links in a shell's output run script in, read from, or navigate the signed-in user's page, or a stale or foreign frame types into a shell.",
      lookFor: [
        "TerminalFrame rendering xterm in the page, or an iframe sandbox other than allow-scripts, or an `allow` delegation.",
        "A srcdoc not built by ViewCsp.frameDocument with the hashed terminal runtime, or a policy that admits a network directive beyond 'none' or data:.",
        "The handshake answering a message whose source is not this mount's contentWindow or whose nonce differs, or a second terminal/initialize.",
        "terminal/input reaching onInput while readOnly, or the frame posting input while readOnly.",
        "A link opened by the frame itself, or by the page without decodeFrameMessage's http(s) check and the person's activation, or without noopener and noreferrer.",
        "A clipboard (OSC 52) addon or any other xterm addon loaded in the frame runtime."
      ],
      paths: ["src/**"]
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
    check,
    docsFiles,
    importRules,
    jevRules,
    unitTests,
    browserProbes,
    ...securityReview
  }
})
