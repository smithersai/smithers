# @smthrs/repo-view

The heavy views of a repository for Smithers UIs: the repository browser
(`RepoView`), one file highlighted by Shiki (`CodeFileView`), a highlighted
diff (`PierreDiffView`) and the Milkdown Markdown editor (`MarkdownEditor`).
They live apart from `@smthrs/ui` so a page that shows no code never loads
`@pierre/diffs`, Shiki or Milkdown.

```tsx
import { RepoView } from "@smthrs/repo-view";
```

Import from the package root only. Shiki's grammars and themes, the VibeLang
grammar and the editor's Milkdown modules load on first use, so a bundler that
splits at dynamic imports keeps them out of the first chunk;
`test/bundle.test.ts` checks it.

`@smthrs/repo-view` is `private: true` and workspace-only, like `@smthrs/ui`,
whose components and theme tokens it builds on.

## Documentation

- [`docs/README.md`](./docs/README.md): what each view does and where to start.
- [`docs/guides/use-the-repository-views.md`](./docs/guides/use-the-repository-views.md):
  load the views lazily, show a repository, a patch, a file or a Markdown document.
- [`docs/api.md`](./docs/api.md): every export.
- [`docs/reference/contracts.md`](./docs/reference/contracts.md): the Markdown editor's failure codes.

## Development

```sh
pnpm test    # bun test --isolate test, at 100% line and function coverage
pnpm check   # vibelang -p tsconfig.json --noEmit
```
