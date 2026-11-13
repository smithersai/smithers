# Maintaining public setup docs

The public site keeps the app's own docs, one install page, the HTTP and CLI references, and the migration guide every published 1.0 package links. Pricing stays held for Will's rewrite. Retained library references move into package docs under #3478.

| Page | Source | Projection |
| --- | --- | --- |
| App docs, `/docs/` and `/docs/<slug>/` | `apps/site/docs/app/pages/<slug>.md`, ordered by `apps/site/docs/app/toc.ts` | `src/content/docs/docs/<slug>.md` (`welcome` is `index.md`), the Markdown copy `public/docs/<slug>.md`, and the sidebar `src/data/docs-sidebar.json`, written by `scripts/sync-app-docs.mjs` |
| Install | `docs/installation.mdx` | `src/content/docs/docs/installation.mdx` |
| HTTP reference | `src/content/docs/docs/reference/http-api.mdx` | None |
| CLI reference, `/docs/reference/cli/` | `src/data/cli-commands.json` and `src/data/help/`, captured from `packages/smithers/src/Cli.ts` by `scripts/gen-cli-data.mjs` | `src/content/docs/docs/reference/cli.md` and the Markdown copy `public/docs/reference/cli.md`, written by `scripts/gen-cli-reference.mjs` |
| 0.x migration guide, `/migration/1.0` | `packages/smithers/docs/migration.md` | `src/pages/migration/1.0.md`, written by `scripts/gen-cli-data.mjs` with the removed-command table |

Edit the docs pages or the install source, then run:

```bash
node apps/site/scripts/sync-app-docs.mjs
node apps/site/scripts/sync-support-docs.mjs
node apps/site/scripts/generate-llms.mjs
```

After a CLI change, recapture its help, then render the CLI reference:

```bash
node apps/site/scripts/gen-cli-data.mjs
node apps/site/scripts/gen-cli-reference.mjs
node apps/site/scripts/generate-llms.mjs
```

Screenshots publish at `/images/docs/<id>.light.webp` and `.dark.webp` straight from `apps/site/docs/app/images`: `scripts/app-docs-integration.mjs` serves them in `astro dev` and copies them into the build. A page shows one with a block image, `![Alt text](images/<id>.webp)`; the projection renders both variants in a framed figure, and Starlight's `light:sl-hidden` and `dark:sl-hidden` classes show the one that matches the theme. The Markdown copy keeps alt-text escapes intact. Fenced code examples stay verbatim in both projections, including tilde fences and longer fences containing shorter ones.

Keep Will's generated description unchanged. `generate-project-copy.mjs` refreshes its marker block from `src/data/project.json`; the README copy belongs to Will.

Every public install section carries an availability label. Verify commands against `packages/smithers/src/Cli.ts`; planned host commands are bound to engineering tickets in `scripts/install-page.test.mjs`.

The retirement inventory is `docs/retired-pages.json`. Retired pages must be absent, with both URL forms redirected to `/docs/installation/`. Only held pricing links may rely on those redirects; retained guides must link to instructions that teach the named operation.

CLI prerequisites live in `packages/smithers/docs/installation.md`; library linking lives in `packages/smithers/flows/flow/docs/installation.md`. Use relative links within a package and absolute GitHub blob URLs across packages.

Run the source checks:

```bash
node apps/site/scripts/check-docs.mjs
node --test apps/site/scripts/install-page.test.mjs apps/site/scripts/generate-project-copy.test.mjs apps/site/scripts/sync-app-docs.test.mjs apps/site/scripts/gen-cli-reference.test.mjs
```
