# @smthrs/ui-css

Framework-free CSS shared by the Smithers React components and any other UI,
including Foldkit. This private source package depends only on
`@smthrs/ui-styleguide`; it needs no React, Radix, DOM types or CSS loader.
It imports in browsers, Cloudflare Workers, Node and Bun without side effects.

Add `"@smthrs/ui-css": "workspace:*"` and import from the package root:

```ts
import { smithersUiCss, tokens, cn } from "@smthrs/ui-css";

const css = smithersUiCss();
const classes = cn("sui-button", "sui-button-default", { "is-active": true });
```

Inject `css` once in your host's style element or stylesheet. It is byte-for-byte
what `<SmithersUiStyles />` from `@smthrs/ui` renders by default. Use the same
`sui-*` classes and component markup to get the same styling in another framework.
The package supplies styles, not interactive behavior or accessibility semantics.
Chat message columns shrink to the transcript width while preserving user and
assistant alignment. A long code block can scroll within its bubble without
widening the page; its host supplies the code block's overflow behavior.
Set the style element's `data-smithers-ui` attribute (named by
`SMITHERS_UI_STYLE_ATTR`) when sharing a page with React so its fallback
recognizes the sheet.

`uiCss` is the same complete stylesheet as a string. The root also exports every
individual CSS fragment (such as `buttonCss`, `commandPaletteCss`, `chatTimelineCss`
and `vaultCss`) and CSS id constant, `tokens` / `SmithersUiTokens`, `cn` /
`ClassValue`, `DataAttributes`, `LOADING_DELAY_MS`, `SMITHERS_UI_STYLE_ATTR`,
`REDUCED_MOTION_MEDIA_QUERY` and the shared status vocabulary.
`xtermBaseCss` remains an independent sheet, as in `@smthrs/ui`.

For a standalone host, prepend `workflowUiThemeCss` from `@smthrs/ui-styleguide`
to supply the theme tokens and global element styles. Token fallbacks reproduce
the default light palette; theme tokens enable all shared light/dark palettes.
`smithersUiCss()` itself preserves the default React sheet, without that optional
prefix or any host-specific extra CSS.

`@smthrs/ui` re-exports its existing CSS and helper API, including its historical
**string** named `smithersUiCss`. Only this framework-free package exposes the
new **function** with that name.

Run `pnpm check` and `pnpm test` here. The Bun suite enforces 100% coverage of
this package, including the moved CSS contracts and class-name behavior.
