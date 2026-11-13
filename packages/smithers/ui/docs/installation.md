---
title: "Installation"
description: "What @smthrs/ui needs from a host application, the entry points you may import, and the one style element every host renders."
sidebar:
  order: 1
---

`@smthrs/ui` 1.x is not published to npm: `npm install @smthrs/ui` installs
0.35.0, the earlier release, which these pages do not describe. The 1.x package
is consumed from source, through the pnpm workspace of the
[smithersai/smithers](https://github.com/smithersai/smithers) repository that
also holds the applications built on it. This page
describes what the package expects from a host either way, so the requirements
and the entry points are readable before you commit to it.

## Requirements

| Requirement                     | Value                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| React                           | `^19.2.8`, as a peer dependency, together with `react-dom ^19.2.8` |
| A bundler that reads TypeScript | The package ships `src/` directly, with no `dist/`                 |
| A CSS-capable host              | None. The stylesheet travels as a JavaScript string                |

The package sets `"files": ["src/"]`, and every condition in its `exports` map
points at a `.ts` or `.tsx` source. Your bundler compiles those sources as part
of your application, so it must handle TSX and the `react-jsx` runtime.

## Add the dependency

Declare the workspace protocol in the host application's `package.json`:

```json
{
  "dependencies": {
    "@smthrs/ui": "workspace:*",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  }
}
```

Then install from the repository root:

```bash
pnpm install
```

Import the package by its scoped name. The unscoped `smthrs` package publishes
only a deprecation notice whose module throws on import, so the scoped
specifier is the only one that resolves to components.

## Entry points

The root barrel is the component library. Every other subpath is either a
narrower slice of the same light surface or an adapter that carries a heavy
third-party renderer. Importing an adapter is a deliberate act, because the
adapter's dependency lands in your bundle.

The complete [entry-point table](./api.md#entry-points) lists every public
specifier, including `@smthrs/ui/adapters/code-editor`. Focused light
subpaths also expose helpers absent from the root. Heavy adapters load only
through their own specifier; see [The adapters boundary](./concepts/adapters.md)
for their measured cost.

The repository views (`RepoView`, `CodeFileView`, `PierreDiffView`,
`MarkdownEditor`) are in `@smthrs/repo-view`, and `TerminalFrame` is in
`@smthrs/terminal-frame`. Add those packages as dependencies and import from
their roots.

## Render the stylesheet once

There is no `.css` file to import. The stylesheet is a JavaScript string, and
`SmithersUiStyles` renders it into a `<style>` element:

```tsx
import { SmithersUiStyles } from "@smthrs/ui"

export function App() {
  return (
    <>
      <SmithersUiStyles />
      {/* the rest of your tree */}
    </>
  )
}
```

Render it exactly once per document. A host page that does not already inline
the theme tokens passes `withTheme` to get them:

```tsx
<SmithersUiStyles withTheme />
```

Every component also injects the sheet itself in the browser as a fallback, so a
forgotten element still produces styled output in a browser. The fallback cannot
help under `renderToStaticMarkup`, where effects never run. For the full model,
read [How styling ships](./concepts/styling.md).

## Verify the install

Render one component and confirm it carries the namespaced class:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { Button, SmithersUiStyles } from "@smthrs/ui"

const html = renderToStaticMarkup(
  <>
    <SmithersUiStyles />
    <Button>Launch</Button>
  </>
)

console.log(html.includes("sui-button")) // true
```

## Next steps

- [Quickstart](./quickstart.md): build a working run panel from three
  components.
- [The adapters boundary](./concepts/adapters.md): what each heavy subpath
  costs before you import it.
- [API reference](./api.md): every public export.
- [`@smthrs/cli`](/api/cli): the `smthrs` command line these surfaces report
  on, and the package the rest of Smithers sits under.

For clipboard-only consumers, use `import { copyText } from "@smthrs/ui/copy"`. This entry point excludes Vault and autosave.
