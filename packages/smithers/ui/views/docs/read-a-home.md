---
title: "Read a repository's home"
description: "The sections and blocks a repository declares in .smithers/home.json, who sees each section, how Home.read reads them where the home is shown, and what it refuses."
---

A repository declares its own home, the page that replaces its file tree, in
`.smithers/home.json` on its default branch. The home is data, never code:
sections of blocks of a closed set of kinds, every string bounded and free of
HTML (a `code` block's source excepted, which a page draws as text). Each
section names its audience: who may see it. A page reads the file at a commit
with `Home.read`, keeps the sections its viewer may see with `Home.visible`,
and draws them itself, for example with `RepositoryHome` from `@smthrs/ui`.
Nothing in the file runs, and a button a block names runs only when a person
presses it.

```json
{
  "sections": [
    {
      "title": "Today",
      "audience": "maintainer",
      "blocks": [
        { "type": "action", "flow": "branch.new", "title": "New branch", "key": "b" },
        { "type": "issues" }
      ]
    },
    {
      "blocks": [
        { "type": "hero", "title": "tinyhttp", "tagline": "A small HTTP server.", "install": "npm i tinyhttp" },
        { "type": "prompt", "title": "What should we work on?", "placeholder": "Ask Smithers…" },
        { "type": "markdown", "path": "docs/intro.md", "title": "Intro" }
      ]
    }
  ]
}
```

A file with a bare `blocks` list instead of `sections` is one section for
everyone, as before.

## Sections and audiences

| Field          | What it is                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sections`     | up to 8 sections, in order; a file has `sections` or `blocks`, never both                                                                        |
| `title`        | the section's heading, optional                                                                                                                  |
| `audience`     | `everyone` (the default), `contributor` or `maintainer`                                                                                          |
| `blocks`       | the section's blocks                                                                                                                             |
| `contributors` | at the file's top: `role` (the default), or `anyone` to show the contributors' sections to everyone with the link                                |
| `docs`         | at the file's top, optional: the `https` URL of the docs site's [`llms.txt` index](read-a-docs-index.md), such as `https://vibelang.sh/llms.txt` |

`Home.sees(viewer, section)` says whether an audience may see a section's: a
maintainer sees every section, a contributor every section but a
maintainer's, and everyone else only everyone's. `Home.visible(sections,
viewer)` keeps those, in order. `Home.widen(viewer, contributors)` makes
`everyone` a contributor on a home that says `anyone`. Who a viewer is, and so
their audience, is the host's to decide: the Smithers app counts a Maintainer
or an Admin a maintainer and anyone else with a role on the repository a
contributor.

## Blocks

| `type`     | Fields                                                                                                           | What a page draws                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero`     | `title`, `tagline?`, `text?`, `install?`, `actions?: [{ label, url }]` (1 to 3), `announcement?: { label, url }` | the project's opening: its name, a tagline, a line, its links (the first primary), the command that installs it, and an announcement above the name |
| `code`     | `code`, `file?`, `language?`, `title?`                                                                           | an example's source, as text, named by its file                                                                                                     |
| `cards`    | `cards: [{ title, text?, label?, url? }]` (1 to 12), `title?`, `more?: { label, url }`                           | a grid of cards and a link to the rest                                                                                                              |
| `stats`    | `stats: [{ value, label }]` (1 to 6), `title?`                                                                   | declared facts, a value over its label; never counted by the page                                                                                   |
| `releases` | `releases: [{ name, url, date, summary? }]` (1 to 12), `title?`, `more?`                                         | releases as declared, each with its `YYYY-MM-DD` date                                                                                               |
| `text`     | `title?`, `text`                                                                                                 | a paragraph of plain text                                                                                                                           |
| `links`    | `title?`, `links: [{ label, url }]`                                                                              | links to safe absolute `http` or `https` URLs or origin-relative paths                                                                              |
| `markdown` | `path`, `title?`                                                                                                 | a Markdown file of the repository, read at the home's commit                                                                                        |
| `prompt`   | `flow?`, `title?`, `placeholder?`                                                                                | the way to ask, with the flow that takes the question                                                                                               |
| `app`      | `flow`, `title`, `picture`                                                                                       | one flow's button, when the page has that flow                                                                                                      |
| `action`   | `flow`, `title`, `key?`                                                                                          | a primary button that runs its flow at once, and its one-letter key                                                                                 |
| `flows`    | `title?`                                                                                                         | live: the flows the page offers                                                                                                                     |
| `stack`    | `title?`                                                                                                         | live: the repository's stack of changes                                                                                                             |
| `issues`   | `title?`                                                                                                         | live: the issues and pull requests at a glance                                                                                                      |
| `runs`     | `title?`                                                                                                         | live: recent flow runs                                                                                                                              |
| `view`     | `flow`                                                                                                           | the view a repository flow declares                                                                                                                 |

A live block (`Home.liveKinds`) carries no rows: the page reads them itself,
through its own access checks, so a declaration names a block, never its data.
`picture` is `issue`, `review`, `wiki` or `schedule`. `flow` is a lowercase
name with `.` or `/` between its parts, such as `flow.new` or
`release/notes`. `language` is a lowercase name such as `ts`, `sh` or `vibe`;
`key` is one lowercase letter.

## Reading

```ts
import { Home } from "@smthrs/views"

const home = Home.read(text)
if (home._tag === "Declared") draw(Home.visible(home.sections, Home.widen(viewer, home.contributors)))
else showTheTree(home.reason)
```

`Home.read(text)` never throws. It answers:

- `{ _tag: "Declared", sections, contributors, docs?, skipped }`: the sections to
  draw, in order, each `{ title?, audience, blocks }`. A block whose `type` is
  a string this reader doesn't know is skipped and counted in `skipped`, so a
  home a newer page declares still shows here. Fields a block doesn't declare
  are dropped. A home may declare no blocks.
- `{ _tag: "Invalid", reason }`, and the page shows the tree:
  - `json`: the text is not JSON;
  - `shape`: it is not an object with a `blocks` array or a `sections` array,
    has both, its `contributors` is neither `role` nor `anyone`, or its
    `docs` isn't an `https` URL without a user or password, at most 2,048
    characters;
  - `sections`: it declares more than 8 sections;
  - `section`: a section isn't an object with a `blocks` array, or its title or
    audience breaks its bounds;
  - `blocks`: it declares more than 32 blocks in all, unknown kinds included;
  - `block`: a block of a known kind breaks its bounds. One broken block makes
    the whole home invalid, so a page never draws half a home.

## Bounds

| What                    | Bound                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sections                | 8 (`maximumSections`)                                                                                       |
| Blocks                  | 32 in all (`maximumBlocks`)                                                                                 |
| A list in a block       | 12 cards, releases or links (`maximumEntries`), 6 stats (`maximumStats`), 3 hero actions (`maximumActions`) |
| A short line            | a tagline, a card's text, a release's summary, an install command: 280 characters, one line                 |
| A code block            | 4,096 characters, no NUL; `<` allowed, since source code holds it                                           |
| A title or a link label | 1 to 120 characters, one line (`maximumTitleLength`)                                                        |
| A text block            | 1 to 4,096 characters (`maximumTextLength`)                                                                 |
| A link                  | absolute `http://` or `https://`, or a path starting with one `/`; 2,048 characters (`maximumUrlLength`)    |
| A Markdown path         | relative, no empty, `.` or `..` segment, no `\`, `%`, `:`, `?`, `#` or control character, 1,024 characters  |
| Every string            | no HTML: no tag, closing tag, comment or processing instruction (`htmlPattern`); `a < b` is fine            |

Link targets reject protocol-relative URLs (`//example.com`), script schemes,
backslashes, control characters, spaces, quotes and malformed URL escapes. A
path such as `/docs?language=ts#intro` stays on the page's origin. The top-level
`docs` field still requires an absolute HTTPS URL without credentials.

## Who writes the file

A person commits it, or `@smthrs/targets` projects a one-section home from
`.smithers/FACTORY.ts` (`Smithers.Factory.Home` and the `Smithers.Home`
constructors). The writer uses this module's schemas, so the format has one
copy.

Flow names are limited to 120 characters. Calendar dates include years 0000–0099, with Gregorian leap-year validation.
