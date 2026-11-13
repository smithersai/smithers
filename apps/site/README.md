# Smithers docs

The site projects package references from their colocated `docs/` folders.
Edit the package source, or `docs/reference/api/index.mdx` for the package
index. Generated pages live under `src/content/docs/`.

Run from the repository root:

```sh
pnpm docs:sync
pnpm docs:check
pnpm exec smthrs docs //apps/site:docs
```

`pnpm --dir apps/site check:docs` also runs the site documentation contracts,
including the API and LLM inline-comment regression. The publication check
validates every `@smthrs/*` package in each install command.

The cached `//apps/site:build` target includes `docs/app/images/*` alongside
its projected pages and public assets. Replacing, adding or removing a
screenshot invalidates the build inputs; `buildInputsTest` checks their
planned content identity.
