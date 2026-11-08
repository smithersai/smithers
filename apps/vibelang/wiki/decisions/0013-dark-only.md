# 0013. Dark only, for now

Will, 2026-11-07 (ruling VL-27). Supersedes the light theme that decisions 0001 and 0008 assumed.

## Why

The splash's media are VibeLang's marketing videos and cards (VL-19): `contract.mp4`, its poster, `agent-loop.mp4`,
`magic-move.mp4` and the `card-*.png` and `token-bars.png` pictures. All were rendered on dark backgrounds, and no
light versions exist, on vibelang.sh or anywhere else. In light mode a dark video sat on a light page. Will: "they
should be light mode in light mode and dark mode in dark mode for all the pictures and stuff", then "Do the opposite
for now and just make vibelang dark mode only".

## What it means

- `index.html` sets `data-theme="dark"` and `color-scheme: dark`. The Smithers theme (`@smthrs/ui-styleguide`) reads
  `data-theme`, so every page is dark whatever the visitor's system prefers.
- The light wordmark (`logo-light.svg`) and the light-mode CSS were deleted, not kept switched off.
- The browser tests keep their `light` project: it is a visitor whose system prefers light, and `e2e/chat.spec.ts`
  checks that the page is still dark.

## Undoing it

Light mode comes back once every picture and video has a light version, rendered from the same source as the dark one
(not recolored), and the page picks each asset by theme. Restore the light wordmark and CSS from the commit that made
this change, drop `data-theme="dark"`, and make the browser tests check each theme's assets.
