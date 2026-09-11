/**
 * Targets for the shared kit behind every per-package docs site under
 * apps/docs and the Starlight route middleware apps/site mounts.
 *
 * The kit is an implementation the sites import, not a site: it has no
 * build. Its job here is to be a dependency edge. Every projected site's
 * astro.config.mjs calls `defineDocsSite` from starlight.mjs, which installs
 * release-notice.mjs as route middleware, and apps/site imports the same
 * middleware through scripts/docs-notice.mjs. An edit to either file changes
 * the rendered HTML of every site, so each site's `check` and `build` name
 * the `sources` group below and re-key when the kit moves.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/docs/shared"

/**
 * The runtime the sites import: the astro config factory, the release
 * notice middleware, the site manifest, the Alchemy factory, the stylesheet
 * and assets the generator copies, and the manifest that pins their versions.
 * The generator and sync scripts are not members: their outputs are committed
 * and drift-checked, so the copies are the inputs.
 */
const sources = Smithers.Filegroup({
  srcs: [
    Smithers.file("starlight.mjs"),
    Smithers.file("starlight.d.ts"),
    Smithers.file("release-notice.mjs"),
    Smithers.file("manifest.mjs"),
    Smithers.file("manifest.d.ts"),
    Smithers.file("alchemy-site.mjs"),
    Smithers.file("alchemy-site.d.ts"),
    Smithers.file("starlight.css"),
    Smithers.glob("assets/**/*"),
    Smithers.file("package.json")
  ],
  cwd
})

/** The generator emits the declared edges, the content sync round-trips and the Alchemy factory refuses Alchemy 1 env state; all run against fixtures under a temp dir. */
const tests = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 apps/docs/shared/gen-sites.test.mjs apps/docs/shared/sync-content.test.mjs apps/docs/shared/alchemy-site.test.mjs",
  data: [
    Smithers.file("gen-sites.mjs"),
    Smithers.file("gen-sites.test.mjs"),
    Smithers.file("sync-content.mjs"),
    Smithers.file("sync-content.test.mjs"),
    Smithers.file("alchemy-site.mjs"),
    Smithers.file("alchemy-site.test.mjs"),
    Smithers.file("starlight.css"),
    Smithers.glob("assets/**/*")
  ]
})

export const Package = Smithers.Package({
  targets: { sources, tests }
})
