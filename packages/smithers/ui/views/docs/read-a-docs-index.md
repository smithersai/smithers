---
title: "Read a docs index"
description: "Read a docs site's llms.txt index with Docs.parse, find and search its pages, and fetch the index or a page from a server through the same guard as WebPage.check."
---

A repository names its docs in its home: `"docs": "https://vibelang.sh/llms.txt"`
in `.smithers/home.json` ([read a repository's home](read-a-home.md)). The URL
is the docs site's index in the [`llms.txt`](https://llmstxt.org) format: a
Markdown file with a `#` title, a `>` summary, and `##` sections that list
pages as `- [Title](url): description`. `Docs` reads it.

```ts
import { Docs } from "@smthrs/views"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"

const fetched = yield* Docs.fetchText("https://vibelang.sh/llms.txt").pipe(Effect.provide(FetchHttpClient.layer))
if (fetched._tag === "Text") {
  const index = Docs.parse(fetched.text, fetched.url)
  Docs.search(index, "retry")         // [{ title: "Retrying", path: "/error-management/018-retrying.md", … }, …]
  Docs.find(index, "/setup/vite.md")  // { title: "Vite and Vitest", url: "https://vibelang.sh/setup/vite.md", … }
}
```

## Parsing

`Docs.parse(text, indexUrl)` never throws. It answers `{ title, summary?, pages }`:

| Field     | What it is                                                                |
| --------- | ------------------------------------------------------------------------- |
| `title`   | the first `#` heading, `""` when there is none                            |
| `summary` | the first non-empty `>` line before any section                           |
| `pages`   | each listed page in order: `{ title, url, path, description?, section? }` |

- A page's link is resolved against `indexUrl` and kept only on the index's
  own origin, so a server that fetches a page of the index fetches only from
  the host the repository named. `url` drops the query and fragment; `path`
  is its path, which names the page.
- A fenced code block closes only on the same marker character, repeated at
  least as many times as the opening fence, with no trailing text.
- The first page at a path wins; links inside fenced code blocks, and lines
  that aren't `-`, `*` or `+` list items with a link, are skipped.
- At most 1,000 pages (`maximumPages`); titles are cut at 200 characters
  (`maximumTitleLength`) and descriptions and the summary at 300
  (`maximumDescriptionLength`).
- The index is someone else's text: draw it as text, never as markup.

## Searching

`Docs.search(index, query, limit = 5)` answers the pages that match the
query's words, best first. A word counts most in a page's title (as the start
of a word, then anywhere in one), then its description, then its section and
path. A word few pages hold counts for more than one most hold, so the docs
site's own name ranks nothing. Pages that match no word are left out; ties
keep the index's order. Words are two or more letters or digits, without case.
`Docs.find(index, path)` answers the page at a path.

## Fetching

`Docs.fetchText(url, options?)` requests the index or a page from a server and
never fails. It answers `{ _tag: "Text", text, type, url }`, `url` being where
redirects ended, or `{ _tag: "Refused", reason, status? }`:

| `reason`                 | When                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_url`            | not an absolute `http:` or `https:` URL, or one with a user or password                                                                                          |
| `private_host`           | an IP address literal, a single-label name, or a `.localhost`, `.local`, `.internal`, `.home.arpa` or `.lan` name, before anything is sent and on every redirect |
| `redirects`              | more than `maxRedirects` (5), or one to a URL it won't request                                                                                                   |
| `unreachable`, `timeout` | no answer, or none within `timeout` (8 s) for the request and body                                                                                               |
| `status`                 | 400 or above, with `status`                                                                                                                                      |
| `content`                | a body that isn't `text/*` or untyped, holds a NUL or isn't UTF-8                                                                                                |
| `too_large`              | a body over `maxBytes` (1 MiB)                                                                                                                                   |

The guard is `WebPage.check`'s ([check a web page](check-a-web-page.md)):
`privateHosts` lets a test's `127.0.0.1` through. The request asks for
Markdown or plain text and carries no cookie or credential. Its span
`Docs.fetchText` records the outcome and status, never the URL, and the
request records no client span and sends no trace context.

The guard refuses names, not addresses: a public name whose DNS answer is a
private address is the host's to refuse. A Cloudflare Worker's `fetch`
reaches public addresses only; run `fetchText` elsewhere only behind an
egress that does the same.
