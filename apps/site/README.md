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

`pnpm --dir apps/site check:docs` also runs the site documentation contracts.
