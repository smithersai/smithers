---
title: "Default targets"
description: "Why every package needs an explicit Package map, and how to share declarations with macros."
---

The current CLI does not consume `PackageDefaults` exports or synthesize
targets for directories containing only `package.json`. The declaration and
expansion helpers exist in `@smthrs/targets`, but the loader and target index
do not wire them into discovery. Exporting a declaration does not add any
labels.

Every package that should participate in queries, builds, or CI needs a
`PACKAGE.ts` or `PACKAGE.vibe` exporting a `Package` map. A directory without
one contributes no targets to `//packages/...`; an exact label for a target
there fails with `unknown_label`.

## Share declarations explicitly

Use an ordinary macro and call it from each package declaration. This example
uses the [local helper](../reference/targets/standard-package.md); create it in
your repository first.

```ts
// packages/core/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { buildAndCheckPackage } from "../../package-targets.ts"

export const Package = S.Package({
  targets: buildAndCheckPackage({ deps: [], cwd: "packages/core" })
})
```

The returned keys become labels such as `//packages/core:lib` and
`//packages/core:test`. Pass sibling target values in `deps` when the package
needs them; no dependency edges are inferred from `package.json`.

## Package default labels

Automatic package discovery and a package's default label are separate.
A bare label such as `//packages/core` requires an explicit `default` map key.
Use `S.Alias(lib)` when both `lib` and `default` should address the same work.
See [Labels](../concepts/labels.md#package-defaults).

## Next

- [Writing macros](writing-macros.md)
- [Workspace structure](../workspace/structure.md)
- [Labels](../concepts/labels.md)
