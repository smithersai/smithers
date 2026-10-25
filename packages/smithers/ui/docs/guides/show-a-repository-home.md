---
title: "Show a repository home"
description: "Draw the sections a repository declares in .smithers/home.json with RepositoryHome: a landing page's hero, code, cards, stats and releases, the live issues, stack, runs and flows, actions with their keys, and who each section is for."
---

A repository declares its home in `.smithers/home.json`. `Home.read` from
`@smthrs/views` checks the file and answers its sections, each for an
audience: everyone, contributors or maintainers. `RepositoryHome` draws the
sections you give it. A home is data: the component runs nothing on arrival,
and a button acts only when a person presses it.

```tsx
import { Home } from "@smthrs/views"
import { RepositoryHome } from "@smthrs/ui"

const home = Home.read(homeJsonText)

{home._tag === "Declared" ? (
  <RepositoryHome
    aria-label="maya/tinyhttp home"
    sections={Home.visible(home.sections, Home.widen(audience, home.contributors))}
    files={{ "README.md": { state: "text", text: readme } }}
    askHref={(flow) => `/maya/tinyhttp?ask=1${flow === undefined ? "" : `&flow=${encodeURIComponent(flow)}`}`}
    onAsk={(flow) => router.navigate({ to: "/maya/tinyhttp", search: { ask: 1, flow } })}
    offered={(flow) => catalog.has(flow)}
    live={{ stack: { entries, total: entries.length, href: "/maya/tinyhttp/stack" } }}
    onNavigate={(href) => router.navigate({ href })}
    onRun={(flow) => run(flow)}
    running={runningFlows}
  />
) : null}
```

Pass only the sections the viewer may see: the component draws every section
it is given. Who the viewer is, and so their audience, is your host's to
decide, on the server where a section's data is private.

When `Home.read` answers `Invalid`, show the file tree with one line, such as
`Home is invalid`. When nothing draws, `RepositoryHome` renders nothing, so
show the tree then too.

## Sections

Each section with something to draw is a `<section>` with
`data-slot="repository-home-section"` and `data-audience`, named by its title.
A section with a title, or one for contributors or maintainers, has a heading:
the title as an `<h2>`, and a label, `Contributors` or `Maintainers`, so the
people who see it know others don't. Action blocks that lead a section with a
heading sit in it, to the right.

## What each block draws

Each drawn block is a `div` with `data-slot="repository-home-block"` and
`data-kind` set to the block's `type`. A block's `title`, when present, is an
`<h3>`.

| Block | Draws |
| --- | --- |
| `hero` | The project's name as a large `<h2>`, its tagline, a line, up to three links (the first primary), the install command with Copy, and an announcement above the name. External links open in a new tab. |
| `code` | A `<figure>` named by its file (else its language, else `Code`) with Copy and the source as text, colored for `ts`, `tsx`, `js`, `jsx` and `vibe`. A `hero` and the `code` block right after it share two columns on a wide home. |
| `cards` | A grid of cards, each a link when it has a URL, with its label, title (`<h4>`) and line, and a link to the rest. |
| `stats` | A `<dl>`: each stat's label is the term and its value the description, drawn value over label. |
| `releases` | A list: each release's name links to its page, with its line and its date as a `<time>`. |
| `text` | Its text in a paragraph, line breaks kept. Always text, never markup. |
| `links` | Links that open in a new tab with `rel="noopener noreferrer"`. A URL that isn't absolute `http` or `https` is not drawn. |
| `markdown` | The file at `path` from `files`, as a document. |
| `prompt` | A band with its title and a link to `askHref`, named by `placeholder`, or `Ask Smithers`. |
| `app` | A link styled as an outline button to `askHref`, labelled by `title`, with `data-picture` set to its picture. Adjacent app blocks share one wrapping row. |
| `action` | A primary `<button>` that calls `onRun(flow)`, with its key in a `<kbd>` and `aria-keyshortcuts`. Drawn only with `onRun` and when `offered(flow)`. |
| `issues`, `stack`, `runs`, `flows` | The rows you pass in `live`; nothing without them. |
| `view` | Nothing yet. |

## Live blocks

The live blocks carry no rows in the file: you read them under your own access
checks and pass them in `live`.

| `live` | Draws |
| --- | --- |
| `issues: { proposed, accepted, notAccepted, triage, pulls, href }` | Four counts that link to `href` (Proposed warns when above zero), then panels Needs triage and Pull requests waiting. |
| `stack: { entries, total, href? }` | A panel of the stack's rows. Adjacent `stack` and `runs` blocks share one grid. |
| `runs: { entries, total, failed, href? }` | A panel of runs; its count says how many failed. |
| `flows: [{ flow, name, title }]` | A button per flow to `askHref`; a plain click calls `onAsk(flow)`. |
| `{ notice }` for `issues`, `stack` or `runs` | The block's heading and that one line, such as `Not synced` or `Sign in`. |

A row (`RepositoryHomeEntry`) is `{ key, label?, title, href, status?, at? }`:
its handle, its title linking to `href`, a `StatusPill` for `status`, and how
long ago `at` was. An `href` in the app calls `onNavigate` on a plain click;
an `http` or `https` one opens in a new tab.

## Props

| Prop | Meaning |
| --- | --- |
| `sections` | The sections to draw, in order: the ones the viewer may see. |
| `files` | Each markdown block's file by its repository path: `{ state: "loading" }`, `{ state: "text", text }` or `{ state: "failed" }`. |
| `askHref` | A URL or `(flow: string \| undefined) => string`. Use the resolver to put the selected flow in the host's route for native navigation and opening another tab. Without it, prompt, app and flow blocks aren't drawn. |
| `onAsk` | Called on a plain click on a prompt, app or flow button, with its flow, or `undefined` for a prompt without one. The click's default is prevented, so your router navigates. Without it, the buttons are plain links. |
| `offered` | Whether this page has an app or action block's flow. Without it, neither is drawn. |
| `live` | The live blocks' rows. |
| `onNavigate` | Called on a plain click on a link in the app, such as a row or a count. Without it, they are plain links. |
| `onCopy` | Copies an install command or a code block, your way. Without it, the browser's clipboard. |
| `onRun` | Runs an action block's flow. Without it, no action block is drawn. |
| `running` | The action flows running now: their buttons are disabled and their keys do nothing. |

Other props go to the outer `<section>` (`data-slot="repository-home"`).

Copy buttons show and announce `Copy failed` when copying fails, without the
host's diagnostic. A successful retry clears the failure and says `Copied`.

## Markdown files

`RepositoryHome` reads no file itself. Read each markdown block's `path` at
the home's commit and pass what you have in `files`:

- A path missing from `files`, or `loading`, shows a spinner named
  `Loading <path>`.
- `text` renders with `Markdown variant="document"`.
- `failed` shows one status line, `Couldn't read <path>`.

## Narrow layouts

The hero's decoration stays within its column. Install commands wrap in full
beside Copy, whose target is at least 32 pixels high; example source retains
its own horizontal scroll area. Neither widens the document at phone widths.

## Keyboard

Every prompt, app and flow button and every link is a real link, so Tab
reaches it and Enter follows it. With `onAsk` or `onNavigate`, a plain click
or Enter calls it instead of following the link. A click with ⌘, Ctrl, Shift
or Alt, or with the middle button, keeps the browser's own behavior, such as
opening a new tab.

An action's `key` presses it from anywhere on the page while the person isn't
typing in a field: never with ⌘, Ctrl, Alt or Shift, never a repeat, never a
key another handler took.

## Related

- [API reference](../api.md#repository-home): the props and exports.
- [Show a run](./show-a-run.md): the run pages a home's flows lead to.
