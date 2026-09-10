---
title: "Pin a palette"
description: "Ship the tokens for one palette instead of all eight, and keep the primitive and layout rules, using themeCss and workflowUiPrimitiveCss."
sidebar:
  order: 3
---

Every palette costs roughly 2.9 KB of CSS. A host that offers no palette picker
is paying 20 KB to ship seven palettes nobody can select.

## Emit a subset

`themeCss(options)` returns the token rules alone, for whichever palettes you
name:

```ts
import { themeCss } from "@smthrs/ui-styleguide"

const tokens = themeCss({ palettes: ["gruvbox"] })
```

That is 7.7 KB instead of 24.9 KB. Three properties hold whatever you pass:

- **The default palette is always emitted.** Its three rules carry the 61
  theme-invariant tokens and the two font stacks, so the sheet is incomplete
  without them. `themeCss({ palettes: [] })` is the floor at 4.8 KB.
- **Registry order, not your order.** The function walks the registry, so
  `["github", "one"]` and `["one", "github"]` return byte-identical CSS, and a
  repeated key emits once. Order is load bearing in the cascade, and this is
  what keeps a caller from breaking it.
- **An unregistered key throws.** `themeCss({ palettes: ["dracula"] })` raises a
  `RangeError` naming the key and listing the registered ones, rather than
  emitting a sheet that silently themes nothing.

## Keep the primitive rules

`workflowUiPrimitiveCss` is the element and component half of
`workflowUiThemeCss` with no tokens in it, so it composes with whatever subset
you emitted:

```ts
import { themeCss, workflowUiLayoutCss, workflowUiPrimitiveCss } from "@smthrs/ui-styleguide"

export const pinnedStyles = [
  themeCss({ palettes: ["gruvbox"] }),
  workflowUiPrimitiveCss,
  workflowUiLayoutCss
].join("\n")
```

18 KB instead of 35 KB, with the same buttons, badges, tables, and workflow
grid. The primitive block on its own is 8.5 KB and mentions no color literal:
every rule in it resolves through a token, so it themes nothing until a token
sheet precedes it. `workflowUiThemeCss` is that same block joined to
`themeCss()` with a newline, and the package's test suite pins the two
compositions to the same bytes.

## The standalone sheet has no subset form

`standaloneThemeCss()` is prebuilt at module evaluation with all eight palettes,
and it quotes its attribute selectors with `"` while `themeCss()` quotes with
`'`. It has no primitive-only half to compose with. A host that wants a pinned
standalone sheet composes `themeCss(subset)` with its own base element rules.

## Check what you saved

```ts
console.log(themeCss().length, themeCss({ palettes: ["gruvbox"] }).length)
```

```text
24928 7707
```

## Related

- [Embed a stylesheet](./embed-a-stylesheet.md): the full sheet inventory and
  their sizes.
- [Build a palette picker](./build-a-palette-picker.md): if you do want all
  eight after all.
