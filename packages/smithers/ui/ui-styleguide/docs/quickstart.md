---
title: "Quickstart"
description: "Generate a self-contained themed HTML page with a working palette picker and light/dark override, using standaloneThemeCss and the palette registry."
sidebar:
  order: 2
---

This quickstart writes one HTML file that carries the whole house theme inline,
with a palette picker and a light/dark override that both work. It uses no
bundler and no framework. By the end you will have seen both selection axes
change a live document.

It is the pattern to reach for whenever the deliverable is one HTML file that
has to theme itself with no assets to serve: a report, a share link, a static
landing page.

## Prerequisites

- A project that can import `@smthrs/ui-styleguide`. See
  [Installation](./installation.md).
- Node.js 26.4.0 or later, for `--experimental-strip-types`.

## Write the generator

Create `build-page.ts`:

```ts
import { writeFileSync } from "node:fs"
import { DEFAULT_THEME_KEY, standaloneThemeCss, themeRegistry } from "@smthrs/ui-styleguide"

const options = Object.values(themeRegistry)
  .map((theme) => `<option value="${theme.key}">${theme.label}</option>`)
  .join("")

const page = `<!doctype html>
<html lang="en" data-palette="${DEFAULT_THEME_KEY}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Styleguide demo</title>
<style>
${standaloneThemeCss()}
main { max-width: 60ch; margin: 0 auto; padding: var(--sp-8) var(--sp-4); }
.controls { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-6); }
select { min-height: var(--ctl-h); border: 1px solid var(--border-solid); border-radius: var(--r-1); background: var(--surface); color: var(--text); padding: 0 var(--sp-2); }
</style>
</head>
<body>
<main>
  <div class="controls">
    <select id="palette">${options}</select>
    <select id="mode">
      <option value="">Follow the system</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </div>
  <h1>Every color here is a token</h1>
  <p>Body copy uses <code>--text</code>; this inline code uses <code>--inline-code-bg</code>.</p>
  <pre><code>const ratio = contrastRatio("#403f53", "#FBFBFB")</code></pre>
</main>
<script>
  const root = document.documentElement
  const palette = document.getElementById("palette")
  const mode = document.getElementById("mode")
  palette.value = root.dataset.palette
  palette.addEventListener("change", () => { root.dataset.palette = palette.value })
  mode.addEventListener("change", () => {
    if (mode.value === "") delete root.dataset.theme
    else root.dataset.theme = mode.value
  })
</script>
</body>
</html>`

writeFileSync("styleguide-demo.html", page)
```

Three things here are the whole API surface you need:

- `standaloneThemeCss()` is the complete sheet for HTML rendered outside a
  Smithers UI shell: every palette's tokens, plus base rules for `body`, `a`,
  `code`, `pre`, `table`, and `hr`.
- `themeRegistry` is the eight palettes as data. `theme.label` is the
  human-readable name a picker shows; `theme.key` is the `data-palette` value.
- `DEFAULT_THEME_KEY` is `"night-owl"`, the palette the bare `:root` rule
  carries.

## Run it

```bash
node --experimental-strip-types build-page.ts
```

```text
$ ls -l styleguide-demo.html
-rw-r--r--  1 you  staff  27875 styleguide-demo.html
```

Open the file in a browser.

## What to try

- **Change the palette.** Pick Gruvbox. Every color on the page moves, because
  every rule names a token and the selected palette redefines the tokens.
- **Change the mode.** Pick Dark, then Light. This is a second, independent
  axis: the palette selection does not change.
- **Leave the mode on "Follow the system"** and change your operating system
  appearance. The page follows, because the default state is
  `prefers-color-scheme` with no `data-theme` stamp at all.

## What just happened

`standaloneThemeCss()` emitted 24 CSS rules of nothing but custom-property
declarations: three for the default palette (light, `prefers-color-scheme:
dark`, and explicit `data-theme="dark"`) and three more for each of the seven
others, each prefixed with `[data-palette='<key>']`. The base element rules
below them reference `var(--bg)`, `var(--text)`, and `var(--r-1)` and never
mention a color.

The two `<select>` elements write `data-palette` and `data-theme` on `<html>`.
That is the entire selection mechanism. There is no JavaScript in this package
and no theme provider to mount.

## Next steps

- [Theming](./theming.md): why the emitted rule order is load bearing, and what
  it means for any override you write.
- [Embed a stylesheet](./guides/embed-a-stylesheet.md): the three sheets this
  package exports and which one a given host wants.
- [Override a token](./guides/override-a-token.md): the specificity rule your
  override has to satisfy.
- [Token reference](./reference/tokens.md): all 92 custom properties.
