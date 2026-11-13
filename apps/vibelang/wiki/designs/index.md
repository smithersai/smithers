# Designs

Designer handoffs for the features without UI (VL-29), each an `index.html` prototype with the designer's `NOTES.md`.

| Design | Handoff | Implementation |
| --- | --- | --- |
| [Wiki](wiki/NOTES.md) | [HTML](wiki/index.html), [lead notes](wiki/LEAD-NOTES.md) | [0021](../decisions/0021-wiki.md) |
| [Sign-in, roles and promotions](roles/NOTES.md) | [HTML](roles/index.html) | [0019](../decisions/0019-sign-in-and-roles.md) |
| [Mythical history](mythical/NOTES.md) | [HTML](mythical/index.html) | [0020](../decisions/0020-mythical-history.md) |
| [Issues, tasks and VIPs](issues/NOTES.md) | [HTML](issues/index.html) | [0022](../decisions/0022-issues-and-vips.md) |
| [Actions and slash commands](actions/NOTES.md) | [HTML](actions/index.html), [lead notes](actions/LEAD-NOTES.md) | [0023](../decisions/0023-actions.md) |
| [Sandboxes with minutes](sandboxes/NOTES.md) | [HTML](sandboxes/index.html), [lead notes](sandboxes/LEAD-NOTES.md) | [0024](../decisions/0024-sandboxes.md) |
| [Desktop app](desktop/NOTES.md) | [HTML](desktop/index.html) | [0025](../decisions/0025-desktop.md) |
| [Marketing media](media/NOTES.md) | [HTML](media/index.html) | [0026](../decisions/0026-marketing-media.md) |
| [Onboarding theatre walkthrough](onboarding/design.md) | [prototype](onboarding/prototype.html) | [0014](../decisions/0014-agent-tour.md) (VL-31) |

## Rebuilding the media and desktop designs

The shared stylesheet is the checked-in `refs/live-app.css` snapshot captured in both archived pages.
It stays frozen so rebuilding a design reproduces that design, independent of changes to the live app.
From this directory, run `sh media/build.sh` or `node desktop/build.mjs`.
The media builder writes a temporary file beside `index.html` and replaces the page only after every input succeeds;
missing CSS or markup leaves the last good page intact. The desktop builder reads its inputs before writing.
`pnpm test:designs` from the app directory checks both rebuilds byte for byte and checks missing inputs.

## Regenerating screenshots

After installing the app's workspace dependencies, run these commands from the app directory:

```sh
pnpm exec playwright install chromium
node wiki/designs/issues/shots.mjs
node wiki/designs/media/shots.mjs
node wiki/designs/desktop/shots.mjs
```

Each script loads its sibling `index.html` and resolves the existing `@playwright/test` dependency through the package
graph, independent of the working directory. Issues and media write PNGs under their own `shots/`; desktop writes
PNGs beside its page. Desktop accepts a comma-separated screen filter, such as `node wiki/designs/desktop/shots.mjs chat,error`.

`pnpm test:design-shots` runs the screenshot commands in relocated copies with real Chromium. It checks every output
name and viewport, confirms edits to the sibling page appear on regeneration, and checks desktop screen filtering.
