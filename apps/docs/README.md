# Package documentation sites

The 48 entries in `shared/manifest.mjs` each have an Astro Starlight site on
their own subdomain: `@smthrs/flow` documents at `flow.smithers.sh`,
`@smthrs/agent` at `agent.smithers.sh`, and so on. The main site in `apps/site`
is separate. This fleet has no standalone build, build-cli, or targets site;
their aggregate API pages are on smithers.sh under `/docs/reference/api/`.

**Do not edit anything in this directory by hand.** Every site here is
generated, and every page in it is stitched from the package it documents.

## Where the content actually lives

A package's documentation is colocated with its source, in `<pkg>/docs/`.
That tree is the only thing an author writes. `shared/sync-content.mjs`
copies it into `apps/docs/<slug>/src/content/docs/`, completing frontmatter
and rewriting links to site routes on the way.

The committed copy under `src/content/docs/` is a cache, not a source. It is
committed so a site builds from a clean checkout without running the
generator first, and CI fails on drift between the two.

`shared/AUTHORING.md` is the contract for writing those docs: file placement,
frontmatter, the link forms, and how the sidebar is computed. Read it before
adding a page.

## Where the scaffolding comes from

`shared/manifest.mjs` is the roster: one `[slug, npm name, package dir]` row
per site. Everything else is derived from it.

`shared/gen-sites.mjs` writes each site's `package.json`, `astro.config.mjs`,
`tsconfig.json`, `PACKAGE.ts`, and `alchemy.run.ts` from that roster. To
change how every site is configured, edit the generator and rerun it; to
change one site, you almost certainly want the generator too.

```bash
node apps/docs/shared/gen-sites.mjs           # write the scaffolding
node apps/docs/shared/gen-sites.mjs --check    # fail if it drifted
```

Adding a package's site is one row in `manifest.mjs`, a generator run, and a
`pnpm install` to enrol the new workspace member.

## Everyday commands

From the repo root:

```bash
pnpm run docs:sync     # restitch every site from its package's docs/
pnpm run docs:check    # the drift gate: scaffolding and content both current
pnpm run docs:build    # astro build for every site
pnpm run docs:deploy   # alchemy deploy for every configured site
```

One site at a time, by its slug:

```bash
pnpm --filter @smithers/docs-flow sync:docs
pnpm --filter @smithers/docs-flow build
pnpm --filter @smithers/docs-flow check:docs
pnpm --filter @smithers/docs-flow dev
```

Through the build graph, which is what CI runs:

```bash
pnpm exec smithers-build ci '//apps/docs/...'
```

Each site's `PACKAGE.ts` declares `check`, `build`, and `contentSync`.
`contentSync` takes the source package's `docsFiles` filegroup as a labelled
input rather than a glob, because input globs are package scoped and a glob
declared in `apps/docs/<slug>` could never reach the package it documents.

## Deploying

Each site declares an Alchemy 2 `Cloudflare.Website.StaticSite` stack serving
its `dist/` directory. `makeDocsSiteStack` derives everything from the slug:
Worker `smithers-docs-<slug>-smithers-docs-<slug>-williamcory` (the name
Alchemy 1 gave every live site) and hostname `<slug>.smithers.sh`. State lives
in the account's shared `alchemy-state-store`, and every script pins stage
`prod`, so any machine plans against the same record. Deploying needs
`CLOUDFLARE_API_TOKEN` and `ALCHEMY_PASSWORD` from your secret store.

```bash
pnpm --filter @smithers/docs-core run plan   # one site, read-only
pnpm docs:deploy                             # every site
```

The first Alchemy 2 run takes over the Workers Alchemy 1 created with
`pnpm docs:deploy --adopt`; a new manifest row gets a new Worker. Without the
flag, a name or hostname held by another Worker fails the deploy. The release
workflow runs `pnpm docs:deploy` on every release tag.

The main site defaults to the dedicated physical Worker
`smithers-site-v1`, matching `apps/site/wrangler.jsonc`. Its logical Alchemy
stack and resource identifiers remain `smithers-site`. The existing physical
`smithers-site` Worker serves `jjhub.tech` and must retain that separate site.
`SMITHERS_SITE_WORKER_NAME` overrides the main site's physical name and is
required when `SMITHERS_SITE_DOMAIN` selects a preview domain. Review all
account-wide domain assignments before overriding a physical Worker name:
Alchemy reconciles its complete domain list, including domains in other zones.
Both configurations disable workers.dev URLs and use 404-page asset handling.

`node --test apps/site/scripts/deployment.test.mjs` checks every stack offline:
names, hostnames, state, and scripts.

## Slugs come from the manifest

`@smthrs/patterns` documents at `smithers-patterns.smithers.sh`, and
`@smthrs/sync` at `smithers-sync.smithers.sh`. The manifest is the authority
on every deployed slug; nothing derives a hostname from a package name or
adds a site for a package absent from that roster.

## Relationship to smithers.sh

`apps/site` is the product site, and it mirrors each package's `docs/api.md`
into an aggregate API reference under `/docs/reference/api/`. That is a
reference index; the package's own site is its complete documentation. Each
aggregate page links out to it.
