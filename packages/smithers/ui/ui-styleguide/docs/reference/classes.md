---
title: "Class reference"
description: "The element rules and CSS classes the workflow, layout, and standalone sheets ship, and the tokens each one paints with."
sidebar:
  order: 3
---

Two of the exported sheets carry rules as well as tokens. Nothing here needs a
component library: these are plain classes on plain elements. Every rule
resolves its colors through [tokens](./tokens.md) and its metrics through the
geometry scale.

## Base elements

`workflowUiThemeCss` styles these without a class:

| Selector                        | What it sets                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `*`                             | `box-sizing: border-box`, and a thin themed scrollbar.                        |
| `body`                          | `--bg`, `--text`, `--fs-3`, `--lh-body`, 320px minimum width, no margin.       |
| `h1`, `h2`, `h3`                | `--fs-5`, `--fs-4`, `--fs-3` at weight 650 on `--lh-tight`.                    |
| `p`                             | `--muted` at line height 1.45.                                                 |
| `button, input, textarea, select` | `font: inherit`, so controls do not fall back to the user agent font.        |
| `pre`                           | No margin, `overflow: auto`, capped at the container width.                    |
| `code`, `.mono`                 | `--font-mono`.                                                                 |

`standaloneThemeCss()` covers a different set, for documents that are prose
rather than an app shell: `body`, `h1` through `h3`, `a` in `--brand`, inline
`code` on `--surface-2`, `pre` on `--code-bg`, `table` with `--border` rules,
and `hr`. Its `code` and `pre` rules are guarded with
`:not(:where(.pierre-diff *))` so they never reach into an embedded Pierre diff.

## Controls

Four class names are one control shape: `.button`, `.primary`, `.secondary`,
and `.danger`. All four share the base rule, the `:focus-visible` ring, and the
`:disabled` dimming, so a bare `<button class="danger">` behaves exactly like a
compounded `<button class="button primary">`.

| Class                    | Rest                                     | Hover and press                                    |
| ------------------------ | ---------------------------------------- | -------------------------------------------------- |
| `.button`, `.secondary`  | `--panel` fill, `--line` border.         | `--hover`, then a 6 percent `--text` mix.           |
| `.primary`               | `--brand-soft` fill, `--brand` text, weight 650. | Same fill; `--brand-border-strong` and a deeper shadow. |
| `.danger`                | `--panel` fill, `--danger` text and border. | `--danger-soft` fill; `--danger-border-strong` on press. |

The tinted controls move their border and elevation rather than deepening the
fill, because the fill is already at the audited 10 percent ceiling. See
[The contrast budget](../concepts/contrast-budget.md).

All four take `min-height: var(--ctl-h)` (32px), `--r-1` corners, and
`box-shadow: var(--shadow-1)`. `:focus-visible` sets `--ring-border` and a 3px
`--ring` glow; the same rule covers `.icon-button`, `.tab`, `.run-row`,
`.doc-link`, `.segmented`, and every text input. `:disabled` sets
`cursor: not-allowed` and 45 percent opacity.

Primary and danger controls retain the 3px focus glow while hovered or pressed.
Primary hover and both pressed states compose the glow with their elevation
shadow, including when hover and press coincide.

## Inputs

`.input`, `.textarea`, `.prompt`, `textarea.prompt`, `select`, and
`input[type='text' | 'search' | 'number']` all take a `--line` border, `--r-1`
corners, `--panel` fill, and `--text`. Single-line controls get
`min-height: var(--ctl-h)`; textareas get 88px minimum height, vertical resize,
and 1.45 line height. Placeholders use `--text-placeholder`.

`.field` is the label-and-control wrapper: a grid with a 6px gap. `.label`, a
`.field label`, and a `.field span` render as uppercase `--fs-1` in `--muted` at
weight 650 with 0.05em tracking.

## Pills, badges, and chips

`.pill`, `.badge`, and `.chip` share a shape: inline flex, 22px minimum height,
`--r-full` corners, `--fs-1`, and truncation with an ellipsis.

- `.pill` is brand tinted: `--brand-soft` on `--brand-border` with `--brand`
  text. `.pill.muted` and `.chip` are the neutral form on `--surface-2`.
- `.badge` is uppercase at weight 650 in the UI font, and takes a status
  modifier.

The status vocabulary is shared with [`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui), and a parity test
there keeps the two aligned:

| Modifier                                                   | Color       |
| ---------------------------------------------------------- | ----------- |
| `.ok`, `.finished`, `.success`                              | `--success` |
| `.warn`, `.waiting`                                         | `--warning` |
| `.running`, `.run`                                          | `--brand`   |
| `.info`                                                     | `--info`    |
| `.bad`, `.failed`                                           | `--danger`  |
| `.cancelled`, `.canceled`, `.skipped`, `.pending`, `.queued` | `--muted`   |

The last row is deliberate: a user cancel is not a failure, and work that has
not started is not a warning.

## Containers

| Class                                   | What it is                                                                |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `.card`, `.panel`, `.kpi`, `.stat`, `.slot` | `--surface` on `--border`, `--r-2` corners, `--shadow-2`.               |
| `.card`, `.panel`, `.slot`              | Plus 14px padding.                                                         |
| `.card-head`, `.panel-title`, `.section-head` | A flex row with the title left and actions right.                    |
| `.section-head`                         | Uppercase `--fs-1` in `--muted`.                                            |
| `.empty`                                | Centered `--muted` text with `--sp-6` padding, for an empty state.          |
| `.alert`                                | A `--surface` notice on `--border`. `.alert.err` and `.error-text` turn it `--danger`. |

## Chrome and layout helpers

`.top` and `.topbar` are the application header: a flex row on
`--surface-glass-strong` with a `blur(18px) saturate(180%)` backdrop filter and
a `--border` bottom rule. Below 760px it stacks vertically.

`.title` and `.title-group` hold the leading identity; `.toolbar` and `.actions`
push controls to the right and wrap. `.run-row` is a selectable list row: it
takes `--hover` on hover and, when `.active` or `.is-active`, a `--brand-border`
edge plus a 2px `--brand` inset stripe.

`.table` is a full-width collapsed table with `--border` bottom rules; `.table
th` is uppercase `--fs-1` in `--muted`.

## Code and logs

| Class                              | What it is                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `.code`, `.source`, `pre.code`     | A block of `--code-text` on `--code-bg` in `--font-mono` at `--fs-1`.          |
| `.plus`, `.minus`                  | `--success` and `--danger` foregrounds, for diff counts.                        |
| `.livelog`                         | A scrolling log viewport on `--code-bg`.                                        |
| `.livelog-line`                    | One wrapping row inside it.                                                     |
| `.livelog-event`                   | The event name, in `--brand`.                                                   |
| `.livelog-node`                    | The node id, in `--warning`.                                                    |
| `.livelog-detail`                  | The remaining text, in `--code-text`.                                           |

Both containers set an explicit foreground rather than inheriting `--text`,
because `--code-text` is not an alias of `--text` in every palette.

## The workflow shell

`workflowUiLayoutCss` adds the run-monitoring layout. It is 2 KB and entirely
grid definitions.

| Class                                | What it is                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `.workflow-shell`                    | Full-viewport grid: a fixed header row over a scrolling content row.     |
| `.workflow-content`                  | The scrolling column, `--sp-4` by 18px padded, 14px gaps.                |
| `.workflow-launch`                   | A prompt field beside a submit button.                                   |
| `.workflow-dashboard`                | A run list column (240px to 320px) beside a detail column.               |
| `.workflow-runs`                     | The run list itself.                                                     |
| `.workflow-run-row`                  | One run: id and meta left, status right. `.active` gets a `--brand` stripe. |
| `.workflow-run-main`                 | The stacked id and meta block.                                           |
| `.workflow-run-id`                   | Monospace, truncated to one line.                                        |
| `.workflow-run-meta`                 | `--muted` at `--fs-1`.                                                   |
| `.workflow-detail`                   | Two equal panel columns.                                                 |
| `.workflow-tree`, `.workflow-events` | Panels with a 220px floor and a 52vh ceiling.                            |

Two breakpoints: at 980px the dashboard and detail collapse to one column and
the panels cap at 360px; at 620px the content padding tightens and the launch
button goes full width.

## Motion

`reducedMotionCss` is one document-wide rule under
`@media (prefers-reduced-motion: reduce)`. It flattens every animation and
transition on every element, including late-injected adapter styles, so no
component needs its own media query. It is already composed into
`workflowUiThemeCss` and `standaloneThemeCss()`, always last, so it wins over
the transitions above it.

## Related

- [Token reference](./tokens.md): the properties these rules read.
- [Embed a stylesheet](../guides/embed-a-stylesheet.md): which sheet carries
  which of these rules.
