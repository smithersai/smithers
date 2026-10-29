/**
 * Targets for smithers.sh: the Astro site with the landing page, the /demo
 * request page, the Starlight documentation under /docs and the release
 * changelogs under /changelogs; and the docs redirect Worker in
 * docs-redirect/, which answers the retired `<slug>.smithers.sh` docs sites.
 *
 * The media the hero plays (public/media) is recorded, not built:
 * `scripts/record-tape.sh` runs real flows through vhs. It needs a provider
 * and a display, so it is not a target; the build ships whatever recordings
 * the tree carries.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { Package as errorsPackage } from "../../packages/errors/PACKAGE.ts"
import { Package as repoTargetsPackage } from "../../packages/repo-targets/PACKAGE.ts"
import { workspacePackages } from "../../packages/repo-targets/scripts/workspace-packages.mjs"
import { Package as chainPackage } from "../../packages/smithers/agent/chain/PACKAGE.ts"
import { Package as evalsPackage } from "../../packages/smithers/agent/evals/PACKAGE.ts"
import { Package as fsPackage } from "../../packages/smithers/agent/fs/PACKAGE.ts"
import { Package as harnessPackage } from "../../packages/smithers/agent/harness/PACKAGE.ts"
import { Package as integrationsPackage } from "../../packages/smithers/agent/integrations/PACKAGE.ts"
import { Package as memoryPackage } from "../../packages/smithers/agent/memory/PACKAGE.ts"
import { Package as modelPackage } from "../../packages/smithers/agent/model/PACKAGE.ts"
import { Package as agentPackage } from "../../packages/smithers/agent/PACKAGE.ts"
import { Package as pluginPackage } from "../../packages/smithers/agent/plugin/PACKAGE.ts"
import { Package as registryPackage } from "../../packages/smithers/agent/registry/PACKAGE.ts"
import { Package as scorersPackage } from "../../packages/smithers/agent/scorers/PACKAGE.ts"
import { Package as stdPackage } from "../../packages/smithers/agent/std/PACKAGE.ts"
import { Package as triggersPackage } from "../../packages/smithers/agent/triggers/PACKAGE.ts"
import { Package as buildCliPackage } from "../../packages/smithers/build/build-cli/PACKAGE.ts"
import { Package as buildPackage } from "../../packages/smithers/build/PACKAGE.ts"
import { Package as targetsPackage } from "../../packages/smithers/build/targets/PACKAGE.ts"
import { Package as controlPackage } from "../../packages/smithers/control/PACKAGE.ts"
import { Package as artifactsPackage } from "../../packages/smithers/flows/artifacts/PACKAGE.ts"
import { Package as canonicalPackage } from "../../packages/smithers/flows/canonical/PACKAGE.ts"
import { Package as capabilityPackage } from "../../packages/smithers/flows/capability/PACKAGE.ts"
import { Package as corePackage } from "../../packages/smithers/flows/core/PACKAGE.ts"
import { Package as cryptoPackage } from "../../packages/smithers/flows/crypto/PACKAGE.ts"
import { Package as databasePackage } from "../../packages/smithers/flows/database/PACKAGE.ts"
import { Package as engineStorePackage } from "../../packages/smithers/flows/engine-store/PACKAGE.ts"
import { Package as enginePackage } from "../../packages/smithers/flows/engine/PACKAGE.ts"
import { Package as flowPackage } from "../../packages/smithers/flows/flow/PACKAGE.ts"
import { Package as jjPackage } from "../../packages/smithers/flows/jj/PACKAGE.ts"
import { Package as journalPackage } from "../../packages/smithers/flows/journal/PACKAGE.ts"
import { Package as kernelPackage } from "../../packages/smithers/flows/kernel/PACKAGE.ts"
import { Package as keysPackage } from "../../packages/smithers/flows/keys/PACKAGE.ts"
import { Package as observabilityPackage } from "../../packages/smithers/flows/observability/PACKAGE.ts"
import { Package as flowsPackage } from "../../packages/smithers/flows/PACKAGE.ts"
import { Package as patternsPackage } from "../../packages/smithers/flows/patterns/PACKAGE.ts"
import { Package as planStorePackage } from "../../packages/smithers/flows/plan-store/PACKAGE.ts"
import { Package as planPackage } from "../../packages/smithers/flows/plan/PACKAGE.ts"
import { Package as platformBrowserPackage } from "../../packages/smithers/flows/platform-browser/PACKAGE.ts"
import { Package as platformBunPackage } from "../../packages/smithers/flows/platform-bun/PACKAGE.ts"
import { Package as platformNodePackage } from "../../packages/smithers/flows/platform-node/PACKAGE.ts"
import { Package as runStorePackage } from "../../packages/smithers/flows/run-store/PACKAGE.ts"
import { Package as sandboxPackage } from "../../packages/smithers/flows/sandbox/PACKAGE.ts"
import { Package as stepCachePackage } from "../../packages/smithers/flows/step-cache/PACKAGE.ts"
import { Package as syncPackage } from "../../packages/smithers/flows/sync/PACKAGE.ts"
import { Package as timeTravelPackage } from "../../packages/smithers/flows/time-travel/PACKAGE.ts"
import { Package as gatewayPackage } from "../../packages/smithers/gateway/PACKAGE.ts"
import { Package as mcpPackage } from "../../packages/smithers/mcp/PACKAGE.ts"
import { Package as migratePackage } from "../../packages/smithers/migrate/PACKAGE.ts"
import { Package as notificationsPackage } from "../../packages/smithers/notifications/PACKAGE.ts"
import { Package as cliPackage } from "../../packages/smithers/PACKAGE.ts"
import { Package as testingPackage } from "../../packages/testing/PACKAGE.ts"
import { Package as mvpPackage } from "../mvp/PACKAGE.ts"

const cwd = "apps/site"

/** The product docs pages and toc.ts that sync-app-docs.mjs projects onto /docs. */
const appDocsInputs = [Smithers.glob("docs/app/pages/*.md"), Smithers.file("docs/app/toc.ts")]

/** The docs screenshots app-docs-integration.mjs publishes at /images/docs/. */
const appDocsImages = Smithers.glob("docs/app/images/*")

const supportDocs = Smithers.Generate({
  summary: "Project the RC support reference and entry pages from colocated docs.",
  script: Smithers.file("scripts/sync-support-docs.mjs"),
  data: [Smithers.glob("docs/**/*")],
  changes: [
    "src/content/docs/docs/reference/api/index.mdx",
    "src/content/docs/docs/installation.mdx",
    "src/content/docs/changelogs/1.0.0-rc.0.mdx"
  ]
})

/**
 * The product docs (docs/app, mvp.md M-35) on smithers.sh/docs: one Starlight
 * page per toc.ts page (`welcome` at /docs/), its Markdown copy at
 * /docs/<slug>.md, and the sidebar astro.config.mjs reads. The screenshots are
 * not projected: the build copies them from docs/app/images (`build`).
 */
const appDocs = Smithers.Generate({
  summary:
    "Project the docs pages, their Markdown copies, and the docs sidebar from apps/site/docs/app; check drift under lint.",
  script: Smithers.file("scripts/sync-app-docs.mjs"),
  data: [...appDocsInputs, appDocsImages, Smithers.file("scripts/docs-text.mjs")],
  changes: ["src/content/docs/docs/*.md", "public/docs/*.md", "src/data/docs-sidebar.json"]
})

/** The pages, docs content, components, layouts, styles, scripts, public assets, Astro config, and tsconfig. */
const sources = [
  Smithers.glob("//apps/site/src/**/*"),
  Smithers.glob("//apps/site/scripts/**/*"),
  Smithers.glob("//apps/site/public/**/*"),
  Smithers.file("//apps/site/astro.config.mjs"),
  Smithers.file("//apps/site/package.json"),
  Smithers.file("//apps/site/tsconfig.json")
]

/** Package metadata used by documentation projections. */
const docsKit = Smithers.Filegroup({
  srcs: [
    Smithers.file("//.smithers/flows/docs-sync/package-docs.mjs"),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs"),
    Smithers.file("//pnpm-workspace.yaml"),
    ...workspacePackages().map(({ dir }) => Smithers.file(`//${dir}/package.json`))
  ],
  cwd
})

/** `astro check`: the pages, components and scripts typecheck against the package tsconfig. */
const check = Smithers.ToolRun({
  command: "pnpm",
  args: ["run", "check"],
  inputs: sources,
  deps: [docsKit],
  cwd
})

/**
 * Build the site and verify its links against the CLI and release changelog.
 * scripts/app-docs-integration.mjs copies the docs screenshots from
 * docs/app/images into dist/images/docs.
 */
const build = Smithers.ToolBuild({
  tool: "astro",
  command: "pnpm",
  args: ["run", "build"],
  inputs: [...sources, Smithers.file("//CHANGELOG.md")],
  outputs: ["dist"],
  deps: [cliPackage.docsSources, docsKit],
  env: {},
  cache: true,
  cwd
})

// --- reference docs pipeline ----------------------------------------------
// Generated reference pages. Each documented package writes its own
// `docs/reference/*.md` (its `referenceDocs` Agent.Diff target); this target
// is the deterministic ingest that copies them into
// src/content/docs/docs/reference/<area>/ with Starlight frontmatter. The
// committed copy is the cache: `smithers-build lint //apps/site:referenceIngest`
// fails on drift, `smithers-build target //apps/site:referenceIngest --write`
// applies. The data edges are the packages' `referencePages` filegroups, not
// their agent targets, so no verb here ever spawns a model.
const referenceIngest = Smithers.Generate({
  summary: "Copy colocated package reference pages into the docs tree; check drift under lint.",
  script: Smithers.file("scripts/ingest-reference.mjs"),
  data: [flowPackage.referencePages, enginePackage.referencePages, targetsPackage.referencePages],
  changes: ["src/content/docs/docs/reference/api/**"]
})
// --- end reference docs pipeline ------------------------------------------

// --- CLI data --------------------------------------------------------------
// The CLI facts the docs quote instead of retyping: verbatim `--help` for
// every verb and subcommand, the version pins, the removed-command anchor
// contract (every `smithers.sh/migration/1.0#<anchor>` the binary links), and
// the migration guide those links land on. The script writes the guide from
// the CLI package's docs/migration.md with one table row per removed command,
// so `smithers-build lint //apps/site:cliData` fails the moment a removed
// verb, a help string, or the guide moves without the site.
const cliData = Smithers.Generate({
  summary:
    "Regenerate CLI help captures, version pins, and the removed-command anchor contract; check drift under lint.",
  script: Smithers.file("scripts/gen-cli-data.mjs"),
  // `cliPackage.docsSources` is the CLI's src tree, README, docs, and
  // package.json by label. A `//packages/smithers/src/**` glob declared here
  // expands to nothing: input globs are package scoped, so a start inside
  // another package yields no files and the edge is vacuous.
  data: [
    cliPackage.docsSources,
    Smithers.file("src/data/migration-paths.json")
  ],
  changes: [
    "src/data/versions.json",
    "src/data/cli-commands.json",
    "src/data/cli-reference-extra.json",
    "src/data/removed-commands.json",
    "src/data/help/**",
    "src/pages/migration/1.0.md"
  ]
})
// --- end CLI data ----------------------------------------------------------

/**
 * The CLI reference at /docs/reference/cli/ and its Markdown copy, rendered
 * from the command manifest and help captures `cliData` writes, with TUI
 * guidance from the CLI package. A help capture that disagrees with the manifest
 * fails the generator rather than publishing.
 */
const cliReferenceInputs = [
  Smithers.file("src/data/cli-commands.json"),
  Smithers.file("src/data/cli-reference-extra.json"),
  Smithers.file("//packages/smithers/docs/reference/cli/tui.md"),
  Smithers.glob("src/data/help/**/*.txt")
]

const cliReference = Smithers.Generate({
  summary:
    "Render the CLI reference page and its Markdown copy from the captured command manifest and help; check drift under lint.",
  script: Smithers.file("scripts/gen-cli-reference.mjs"),
  data: cliReferenceInputs,
  changes: ["src/content/docs/docs/reference/cli.md", "public/docs/reference/cli.md"]
})

/** The CLI reference generator: fixture help and manifest in, Markdown sections out, plus write, check and drift. */
const cliReferenceTest = Smithers.Shell.Test({
  shell: "node --test apps/site/scripts/gen-cli-reference.test.mjs",
  data: [
    Smithers.file("scripts/gen-cli-reference.mjs"),
    Smithers.file("scripts/gen-cli-reference.test.mjs"),
    ...cliReferenceInputs
  ]
})

/** Real docs projections and installed npm consumer regressions. */
const docsRegressionTest = Smithers.Shell.Test({
  shell: "node --test apps/site/scripts/regressions/*.test.mjs",
  data: [
    Smithers.glob("scripts/regressions/*.test.mjs"),
    Smithers.file("scripts/gen-cli-reference.mjs"),
    Smithers.file("scripts/sync-app-docs.mjs"),
    Smithers.file("scripts/docs-text.mjs"),
    Smithers.file("src/data/cli-commands.json"),
    Smithers.file("src/data/cli-reference-extra.json"),
    Smithers.glob("src/data/help/**/*.txt"),
    Smithers.glob("docs/app/**/*.md"),
    Smithers.file("docs/app/toc.ts"),
    Smithers.file("src/styles/starlight.css"),
    Smithers.file("//packages/smithers/flows/docs/quickstart.md"),
    Smithers.file("//packages/smithers/docs/reference/cli/tui.md"),
    Smithers.file("//apps/mvp/src/flows/registry.ts"),
    Smithers.file("//apps/mvp/src/screens/settings/SettingsScreen.tsx")
  ]
})

// --- API reference pages ---------------------------------------------------
// One page per published package, stitched from its colocated docs/api.md by
// scripts/sync-api-docs.mjs. The script discovers packages off disk (a
// public @smthrs/* manifest beside a docs/api.md); this map is the same set
// as declared edges, keyed by the page slug the script writes. Each entry is
// the package's `docsFiles` filegroup (docs/**\/*.md, README, package.json),
// which is what makes `smithers-build lint //apps/site:apiDocs` rerun when a
// package's api.md or description moves. flow, engine, and targets are
// absent on purpose: ingest-reference.mjs owns their pages through
// `referenceIngest`, and the sync script skips those slugs.
const apiPackages = {
  agent: agentPackage,
  artifacts: artifactsPackage,
  build: buildPackage,
  "build-cli": buildCliPackage,
  canonical: canonicalPackage,
  capability: capabilityPackage,
  chain: chainPackage,
  cli: cliPackage,
  control: controlPackage,
  core: corePackage,
  crypto: cryptoPackage,
  database: databasePackage,
  "engine-store": engineStorePackage,
  errors: errorsPackage,
  evals: evalsPackage,
  flows: flowsPackage,
  fs: fsPackage,
  gateway: gatewayPackage,
  harness: harnessPackage,
  integrations: integrationsPackage,
  jj: jjPackage,
  journal: journalPackage,
  kernel: kernelPackage,
  keys: keysPackage,
  mcp: mcpPackage,
  memory: memoryPackage,
  migrate: migratePackage,
  model: modelPackage,
  notifications: notificationsPackage,
  observability: observabilityPackage,
  patterns: patternsPackage,
  plan: planPackage,
  "plan-store": planStorePackage,
  "platform-browser": platformBrowserPackage,
  "platform-bun": platformBunPackage,
  "platform-node": platformNodePackage,
  plugin: pluginPackage,
  registry: registryPackage,
  "run-store": runStorePackage,
  sandbox: sandboxPackage,
  scorers: scorersPackage,
  std: stdPackage,
  "step-cache": stepCachePackage,
  sync: syncPackage,
  testing: testingPackage,
  "time-travel": timeTravelPackage,
  triggers: triggersPackage
}
const apiDocs = Smithers.Generate({
  summary: "Stitch every published package's docs/api.md into a reference page; check drift under lint.",
  script: Smithers.file("scripts/sync-api-docs.mjs"),
  data: Object.values(apiPackages).map((pkg) => pkg.docsFiles),
  changes: Object.keys(apiPackages).map((slug) => `src/content/docs/docs/reference/api/${slug}.mdx`)
})
// --- end API reference pages -----------------------------------------------

/**
 * The compact agent index and full plain-text documentation bundle. Both read
 * the same project.json description as the rendered site and root README, so
 * the machine-facing one-sentence explanation cannot drift either.
 */
const llms = Smithers.Generate({
  summary: "Generate the compact and full LLM documentation bundles; check drift under lint.",
  script: Smithers.file("scripts/generate-llms.mjs"),
  data: [
    Smithers.glob("src/content/docs/**/*.mdx"),
    Smithers.glob("src/content/docs/**/*.md"),
    Smithers.glob("public/docs/**/*.md"),
    Smithers.file("src/data/docs-sidebar.json"),
    Smithers.file("src/data/project.json"),
    Smithers.file("src/data/versions.json"),
    Smithers.glob("src/data/help/**/*.txt"),
    Smithers.file("scripts/docs-text.mjs")
  ],
  changes: ["public/llms.txt", "public/llms-full.txt"]
})

/**
 * Checks documentation text extraction, install guidance, public CLI page
 * selection, and built release URLs, including redirects and migration anchors,
 * and where site copy says a repository's flows live (M-49).
 */
const docsTextTest = Smithers.Shell.Test({
  shell:
    "node --test --test-concurrency=1 apps/site/scripts/docs-text.test.mjs apps/site/scripts/built-site.test.mjs apps/site/scripts/gen-cli-data.test.mjs apps/site/scripts/flows-location.test.mjs",
  data: [
    Smithers.file("scripts/flows-location.test.mjs"),
    Smithers.file("src/data/migration-paths.json"),
    Smithers.file("src/components/HeroStage.astro"),
    Smithers.file("scripts/docs-text.mjs"),
    Smithers.file("scripts/docs-text.test.mjs"),
    Smithers.file("src/content/docs/docs/reference/http-api.mdx"),
    Smithers.file("//packages/smithers/gateway/docs/guides/serve-beyond-loopback.md"),
    Smithers.file("//packages/smithers/flows/sync/src/SyncProtocol.ts"),
    Smithers.file("//packages/smithers/flows/kernel/src/HostServices.ts"),
    Smithers.file("//packages/smithers/agent/registry/src/Discovery.ts"),
    Smithers.file("//packages/smthrs-deprecation/docs/notice.md"),
    Smithers.file("//packages/smithers/migrate/src/flow/MigrateFlow.ts"),
    Smithers.file("//packages/smithers/migrate/src/Scan.ts"),
    Smithers.file("//packages/smithers/flows/flow/src/DurableClock.ts"),
    Smithers.file("scripts/check-built-site.mjs"),
    Smithers.file("scripts/built-site.test.mjs"),
    Smithers.file("//apps/mvp/src/router.tsx"),
    Smithers.file("//apps/mvp/src/features/bugs/contract.ts"),
    Smithers.file("public/robots.txt"),
    Smithers.file("scripts/gen-cli-data.mjs"),
    Smithers.file("scripts/gen-cli-data.test.mjs"),
    cliPackage.docsSources,
    Smithers.file("//packages/smithers/build/build-cli/src/effect-resolution.js")
  ]
})

/**
 * Three generators' `--check` run against a temporary copy of their inputs and
 * must exit 1 naming the stale file; no docs script may call process.exit().
 */
const checkExitTest = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 apps/site/scripts/check-exit.test.mjs",
  data: [
    Smithers.file("scripts/check-exit.test.mjs"),
    ...[
      "check-docs",
      "docs-text",
      "gen-cli-data",
      "gen-cli-reference",
      "generate-llms",
      "generate-project-copy",
      "ingest-reference",
      "sync-api-docs",
      "sync-app-docs",
      "sync-support-docs"
    ].map((name) => Smithers.file(`scripts/${name}.mjs`)),
    Smithers.glob("src/content/docs/docs/**/*"),
    Smithers.glob("src/data/**/*"),
    Smithers.glob("public/docs/**"),
    Smithers.file("public/llms.txt"),
    Smithers.file("public/llms-full.txt"),
    docsKit,
    // The copied tree carries every member manifest and each documented
    // package's docs; explicit files cross package boundaries, a glob cannot.
    ...workspacePackages().map(({ dir }) => Smithers.file(`//${dir}/package.json`)),
    ...[...Object.values(apiPackages), flowPackage, enginePackage, targetsPackage].map((pkg) => pkg.docsFiles)
  ]
})

/**
 * The generated project copy matches its source and retires superseded pages.
 */
const projectCopyTest = Smithers.Shell.Test({
  shell: "node --test apps/site/scripts/generate-project-copy.test.mjs",
  data: [
    Smithers.file("scripts/generate-project-copy.mjs"),
    Smithers.file("scripts/generate-project-copy.test.mjs"),
    Smithers.file("src/data/project.json"),
    Smithers.file("docs/installation.mdx"),
    Smithers.file("//README.md"),
    Smithers.file("//package.json")
  ]
})

/**
 * Installation and app docs commands resolve against the source CLI; planned
 * commands stay ticket-bound; the sidebar and published tree follow toc.ts.
 */
const installPageTest = Smithers.Shell.Test({
  shell: "node --test apps/site/scripts/install-page.test.mjs",
  data: [
    Smithers.file("scripts/install-page.test.mjs"),
    Smithers.file("scripts/sync-app-docs.mjs"),
    Smithers.file("scripts/gen-cli-reference.mjs"),
    Smithers.file("scripts/docs-text.mjs"),
    Smithers.file("src/data/docs-sidebar.json"),
    ...appDocsInputs,
    Smithers.file("src/layouts/Base.astro"),
    Smithers.glob("src/pages/**/*.astro"),
    Smithers.glob("docs/**/*"),
    Smithers.file("public/_redirects"),
    ...["T-INS-04", "T-INS-05", "T-INS-08"].map((name) => Smithers.file(`//.specs/engineering/tickets/${name}.md`)),
    Smithers.file("astro.config.mjs"),
    Smithers.file("src/data/project.json"),
    Smithers.glob("src/content/docs/docs/**/*"),
    cliPackage.docsSources,
    repoTargetsPackage.repositoryInputs
  ]
})

/** The app docs projection: toc.ts parsing, link and screenshot rewrites, the sidebar, and write, check and retirement. */
const appDocsTest = Smithers.Shell.Test({
  shell: "node --test apps/site/scripts/sync-app-docs.test.mjs",
  data: [
    Smithers.file("scripts/sync-app-docs.test.mjs"),
    Smithers.file("scripts/sync-app-docs.mjs"),
    Smithers.file("scripts/docs-text.mjs"),
    Smithers.file("docs/app/toc.ts")
  ]
})

/** Preserve checkout state while recording against an owned detached worktree. */
const recordTapeTest = Smithers.Shell.Test({
  shell: "node --test apps/site/scripts/record-tape.test.mjs",
  data: [
    Smithers.file("scripts/record-tape.sh"),
    Smithers.file("scripts/record-tape.test.mjs"),
    Smithers.file("tapes/cli.tape"),
    Smithers.file("tapes/bin/smithers")
  ]
})

/**
 * Verify the package catalog's publication labels against the release roster:
 * a package the train does not publish cannot be presented as installable, and
 * one it does publish cannot be labelled workspace-private.
 */
const catalogPublicationTest = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 apps/site/scripts/catalog-publication.test.mjs",
  data: [
    Smithers.file("scripts/catalog-publication.mjs"),
    Smithers.file("scripts/catalog-publication.test.mjs"),
    Smithers.file("docs/reference/api/index.mdx"),
    Smithers.glob("src/content/docs/docs/reference/api/*.mdx"),
    Smithers.file("//.smithers/flows/release/pack-release.mjs"),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs"),
    Smithers.file("//pnpm-workspace.yaml"),
    // The roster is checked against what every member manifest declares, so a
    // manifest flipping `private` has to re-run this.
    ...workspacePackages().map(({ dir }) => Smithers.file(`//${dir}/package.json`))
  ]
})

/** The API index must link every published package; keep this in the docs verb. */
const docs = Smithers.DocsParity({
  cwd,
  readme: Smithers.file("README.md"),
  deps: [catalogPublicationTest]
})

/**
 * The collector and resolver behind `//apps/site:smithersLinks`:
 * which smithers.sh URLs a published package ships, and whether the page a URL
 * lands on is about the URL's own path. Fixtures only, so it needs no site
 * build; the contract gate runs the same rules over the real build.
 *
 * @since 1.0.0
 * @category test
 */
const publishedLinksUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//apps/site/scripts/published-links.test.mjs")]),
  srcs: [
    ...sources,
    Smithers.file("//.smithers/flows/release/pack-release.mjs"),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: [],
  cwd
})

/** Verify the support claims against the release workflow and complete workspace inventory. */
const supportMatrixTest = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 apps/site/scripts/support-matrix.test.mjs",
  data: [
    Smithers.file("scripts/support-matrix.test.mjs"),
    Smithers.file("scripts/sync-support-docs.mjs"),
    Smithers.glob("docs/**/*"),
    Smithers.file("src/content/docs/docs/reference/api/index.mdx"),
    Smithers.file("src/content/docs/docs/installation.mdx"),
    Smithers.file("src/content/docs/changelogs/1.0.0-rc.0.mdx"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//.github/workflows/release.yml"),
    Smithers.file("//pnpm-workspace.yaml"),
    ...["pack-release", "packed-export-targets", "publish-release", "release-rehearsal"].map(
      (name) => Smithers.file(`//.smithers/flows/release/${name}.mjs`)
    ),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs"),
    // The shared reader parses every member before selecting public packages.
    // Explicit files cross package boundaries; a site-scoped glob cannot.
    ...workspacePackages().map(({ dir }) => Smithers.file(`//${dir}/package.json`)),
    platformBunPackage.docsFiles,
    Smithers.file("//packages/smithers/flows/README.md")
  ]
})

/** Validate deployment entry points offline. */
const docsRuntimeTests = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 apps/site/scripts/deployment.test.mjs",
  data: [
    Smithers.file("scripts/deployment.test.mjs"),
    Smithers.file("package.json"),
    Smithers.file("docs-redirect/wrangler.jsonc"),
    Smithers.file("//apps/patterns-site/wrangler.jsonc"),
    Smithers.file("//apps/bug-worker/alchemy.run.ts"),
    Smithers.file("//apps/bug-worker/README.md"),
    Smithers.file("//apps/bug-worker/package.json"),
    mvpPackage.deploymentSources,
    cliPackage.docsSources,
    flowPackage.docsSources,
    enginePackage.docsSources,
    agentPackage.lib,
    flowsPackage.lib,
    targetsPackage.lib
  ]
})

const docsLint = Smithers.Shell.Test({
  script: Smithers.file("scripts/check-docs.mjs"),
  data: [
    Smithers.glob("//apps/site/src/content/**/*"),
    Smithers.glob("//apps/site/src/pages/**/*"),
    Smithers.file("//apps/site/src/data/versions.json"),
    Smithers.file("//apps/site/public/_redirects"),
    Smithers.file("//apps/site/scripts/catalog-publication.mjs"),
    Smithers.file("//apps/site/scripts/app-docs-integration.mjs"),
    Smithers.file("//apps/site/scripts/sync-app-docs.mjs"),
    Smithers.file("//apps/site/scripts/docs-text.mjs"),
    Smithers.file("//.smithers/flows/release/pack-release.mjs"),
    // The screenshots a page shows are checked against docs/app/images.
    ...appDocsInputs,
    appDocsImages
  ]
})

/**
 * The docs redirect Worker's sources and what its tests read: the slug roster
 * from the docs-sync generator, which loads the workspace package list on
 * import, and its wrangler config. The map's freshness against the docs is
 * //.smithers/flows:packageDocs (`pnpm docs:check`).
 */
const docsRedirectSources = [
  Smithers.glob("docs-redirect/src/**/*.ts"),
  Smithers.file("docs-redirect/scripts/workerd.mjs"),
  Smithers.file("docs-redirect/wrangler.jsonc"),
  Smithers.file("//.smithers/flows/docs-sync/package-docs.mjs"),
  Smithers.file("//.smithers/flows/docs-sync/package-docs.d.mts"),
  Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs"),
  Smithers.file("//pnpm-workspace.yaml")
]

/**
 * Checks the docs redirect Worker against its own tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const docsRedirectCheck = Smithers.Typecheck({
  srcs: docsRedirectSources,
  deps: [],
  tsconfig: Smithers.file("docs-redirect/tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The docs redirect Worker's suite under Bun: the decision, pass-through and
 * DNS cases, the config, and the bundle run in workerd.
 *
 * @since 1.0.0
 * @category test
 */
// Coverage policy: assertion-only for the Bun Worker suite. Bun's loaded-file
// coverage does not establish the whole production denominator; no percentage
// guarantee is claimed. See packages/repo-targets/contracts/README.md for the exception.
const docsRedirectTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["docs-redirect/src"]),
  srcs: docsRedirectSources,
  deps: [],
  cwd
})

/**
 * Security review for the public site: the /demo intake form, the
 * Cloudflare _headers/_redirects, the docs redirect Worker, the recording
 * script that runs the CLI with provider credentials, and the install and
 * tutorial pages visitors copy into a shell.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: [
    "src/*.ts",
    "src/components/**",
    "src/layouts/**",
    "src/pages/**",
    "docs-redirect/src/**",
    "docs-redirect/wrangler.jsonc",
    "scripts/**",
    "tapes/**",
    "public/_headers",
    "public/_redirects",
    "astro.config.mjs",
    "docs/installation.mdx",
    "src/content/docs/docs/installation.mdx"
  ],
  checks: [
    {
      id: "demo-intake-form",
      title: "The demo form sends only the typed fields to the fixed intake endpoint",
      threat:
        "A visitor's name, work email and message reach a third party, or a script on the page rewrites where the form posts.",
      lookFor: [
        "An intake endpoint taken from a query parameter, env var, or page data instead of the literal bug.smithers.sh URL.",
        "Error handling that renders the server's response body into the page with innerHTML.",
        "The fetch sending credentials or extra headers (cookies, tokens) to the cross-origin intake worker."
      ],
      paths: ["src/pages/demo/**", "scripts/demo-form.test.mjs"]
    },
    {
      id: "redirects",
      title: "Redirects stay on smithers.sh",
      threat:
        "An attacker uses a smithers.sh URL, or a retired `<slug>.smithers.sh` docs host, as an open redirect to a phishing origin.",
      lookFor: [
        "A _redirects rule whose destination is an absolute off-site URL or a splat that forwards a user-controlled host.",
        "A docs-redirect Location built from request text (host suffix, path, query or headers) instead of a value of the generated maps under https://github.com/smithersai/smithers/."
      ],
      paths: [
        "public/_headers",
        "public/_redirects",
        "scripts/check-built-site.mjs",
        "docs-redirect/src/**",
        "docs-redirect/wrangler.jsonc"
      ]
    },
    {
      id: "build-time-secret-exposure",
      title: "No secret or server-only env var is inlined into the built client bundle",
      threat:
        "Anyone who loads smithers.sh reads a provider key, deploy token, or dev API origin baked into static HTML or JS.",
      lookFor: [
        "import.meta.env reads of a non-PUBLIC_ variable in a component or client script.",
        "A vite `define` that embeds process.env values other than the commit sha.",
        "A fixture flag that stays active in a production build."
      ],
      paths: ["astro.config.mjs", "src/**"]
    },
    {
      id: "recording-scripts-credentials",
      title: "The recording script keeps provider credentials and git state on the operator's machine",
      threat:
        "Running record-tape leaks the operator's ChatGPT or API key into a committed recording, or removes a worktree it does not own.",
      lookFor: [
        "A tape or script that echoes env, prints auth files, or types a key that lands in public/media output.",
        "A cleanup trap that runs `rm -rf` or `git worktree remove` on a path not created by mktemp in the same script.",
        "An unquoted variable in a shell command that splits or globs a path with spaces."
      ],
      paths: ["scripts/record-tape.sh", "tapes/**"]
    },
    {
      id: "copyable-install-snippets",
      title: "Install and tutorial snippets that visitors run are safe to paste",
      threat:
        "A visitor who copies a docs command runs an unpinned remote script or leaks a key into shell history or a committed file.",
      lookFor: [
        "A `curl | sh` or `npx` command fetching from a host other than the project's own domains or npm.",
        "A snippet with a real-looking API key or token rather than a placeholder.",
        "A tutorial that writes a key into a source file instead of reading it from the environment."
      ],
      paths: ["docs/installation.mdx", "src/content/docs/docs/installation.mdx"]
    }
  ]
})

/**
 * Build and documentation targets for the public site.
 *
 * @since 1.0.0
 * @category packages
 */
/**
 * Every smithers.sh URL a published package ships or prints lands on a built
 * page about the URL's own path: directly, or through one production redirect
 * that keeps every path segment, with the fragment present on the page.
 * `apps/site/scripts/published-links.mjs` holds the rules; its `--live` mode applies them
 * to production after a deploy.
 *
 * The route oracle is the emitted files under `apps/site/dist`, so the site's
 * build is a dependency rather than a step someone ran first. The edge orders
 * the build ahead of the gate, keys the gate on the build's own key so a
 * content change re-runs it, and puts the build's declared outputs in the
 * gate's sandbox read set.
 *
 * `dist` is deliberately not declared as an input: declared inputs expand at
 * plan time, and on a clean checkout the directory the build has not produced
 * yet expands to nothing, which is both a vacuous edge and no read at all.
 *
 * @since 1.0.0
 * @category test
 */
const smithersLinks = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//apps/site/scripts/smithers-links.test.mjs")]),
  srcs: [
    Smithers.file("//apps/site/scripts/published-links.mjs"),
    Smithers.file("//.smithers/flows/release/pack-release.mjs"),
    Smithers.file("//packages/repo-targets/scripts/workspace-packages.mjs")
  ],
  deps: [build]
})

export const Package = Smithers.Package({
  targets: {
    check,
    build,
    supportDocs,
    appDocs,
    appDocsTest,
    referenceIngest,
    cliData,
    cliReference,
    cliReferenceTest,
    docsRegressionTest,
    apiDocs,
    docsLint,
    docsTextTest,
    checkExitTest,
    projectCopyTest,
    installPageTest,
    recordTapeTest,
    supportMatrixTest,
    publishedLinksUnit,
    smithersLinks,
    catalogPublicationTest,
    docs,
    docsRuntimeTests,
    docsRedirectCheck,
    docsRedirectTests,
    llms,
    ...securityReview
  }
})
