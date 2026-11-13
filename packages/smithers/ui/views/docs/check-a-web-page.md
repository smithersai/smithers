---
title: "Check a web page before framing it"
description: "Ask from a server whether an outside page shows in a frame, with WebPage.check, and read the title, description and icon a card shows in its place."
---

A page that refuses framing, with `X-Frame-Options` or a Content Security
Policy `frame-ancestors`, leaves the frame blank or shows the browser's error,
and the page that holds the frame can't read why. `WebPage.check` asks first,
from a server: it requests the page as a frame would and answers how the
browser would treat it.

```ts
import { WebPage } from "@smthrs/views"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"

const checked = yield* WebPage.check("https://docs.example.com/guide", {
  ancestors: ["https://app.example.com"]
}).pipe(Effect.provide(FetchHttpClient.layer))

// { framing: "allowed", status: 200, title: "Guide", description: "…", icon: "https://docs.example.com/favicon.ico" }
// { framing: "refused", reason: "x_frame_options", status: 200, title: "…" }
// { framing: "unknown", reason: "timeout" }
```

Frame the page only when `framing` is `allowed`. Show a card from the
preview for anything else; `refused` and `unknown` are both a card, and the
reason says why.

## What it answers

| `framing` | `reason`          | When                                                                                                           |
| --------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `allowed` |                   | The final response would show in a frame held by `ancestors`                                                   |
| `refused` | `frame_ancestors` | An enforced policy's `frame-ancestors` doesn't admit every ancestor                                            |
| `refused` | `x_frame_options` | No `frame-ancestors`, and `X-Frame-Options` is `DENY`, `SAMEORIGIN` from another origin, or conflicting values |
| `refused` | `insecure`        | The page ends on `http:` under an `https:` ancestor (mixed content), unless it is on this machine              |
| `refused` | `content`         | A PDF, an octet stream or an attachment: a sandboxed frame without `allow-downloads` shows none of them        |
| `unknown` | `status`          | The page answered 400 or above                                                                                 |
| `unknown` | `invalid_url`     | Not an absolute `https:` or `http:` URL without a user or password                                             |
| `unknown` | `private_host`    | A host the guard never requests (below)                                                                        |
| `unknown` | `redirects`       | More than `maxRedirects`, or a redirect to a URL the check won't follow                                        |
| `unknown` | `timeout`         | No response within `timeout`                                                                                   |
| `unknown` | `unreachable`     | The request failed                                                                                             |

`status` is the final response's status whenever there was one. `framing`
and `content` are exported too, so a host that already holds a response's
headers can judge them without a request.

The rules follow the browser's: every enforced `Content-Security-Policy`
with `frame-ancestors` must match every ancestor (`*`, schemes and their
secure upgrade, `'self'`, hosts with `*.` wildcards, ports and `*` ports),
and when any policy has the directive, `X-Frame-Options` is ignored. A
report-only policy and a `<meta>` policy never refuse framing, so neither is
read. Pass every origin that holds the frame, the framing page's first; when
a frame sits inside another frame, each must be admitted. An empty ancestor
list returns `unknown` with reason `invalid_url`.

## The preview

For an HTML page, `check` reads the head, up to `</head>`, `maxBytes` or
`headTimeout`, whichever comes first, and `WebPage.preview` reads:

- `title`: `og:title`, else `<title>`, at most 200 UTF-16 code units;
- `description`: `og:description`, else `description`, else
  `twitter:description`, at most 300 UTF-16 code units;
- `icon`: the first `rel="icon"` link, else the first `apple-touch-icon`,
  resolved against `<base href>` or the page; `/favicon.ico` for an `https:`
  page with neither. Only an `https:` URL with no user or password is kept.

Text is decoded and its whitespace collapsed. Long text ends in an ellipsis
without splitting a Unicode code point, within the same limits as the
`Preview` and `Checked` schemas. Tag names are case-insensitive; Unicode
text keeps its original spelling. Comments and the contents of
scripts, styles and templates are skipped. The scan is linear in its input,
so a hostile page can't slow it down.

## The guard

The URL is someone else's choice, so every hop is guarded before anything is
sent:

- `https:` or `http:` only, with no user or password;
- named hosts only: an IP address literal in any spelling (the URL parser
  writes `2130706433` and `0x7f.1` as `127.0.0.1`), `localhost`, a
  single-label name, and `.localhost`, `.local`, `.internal`, `.home.arpa` and
  `.lan` names are `private_host`, unless `privateHosts` names the host;
- the check follows redirects itself, at most `maxRedirects` (5), guarding
  each, and judges the page it ends on;
- one deadline, `timeout` (8 seconds), for the final response's headers,
  every redirect included, and `headTimeout` (3 seconds) for the head;
- at most `maxBytes` (256 KiB) of an HTML body, and nothing of any other;
- no cookies and no credentials; `Sec-Fetch-Dest: iframe` and a declared
  `User-Agent`, so a site that answers frames differently answers this one
  the same way.

A public name whose DNS answer is a private address is the platform's to
refuse: run the check where egress is mediated, such as a Cloudflare Worker,
whose fetch reaches public addresses only. Name development hosts, such as
`localhost` and `127.0.0.1`, in `privateHosts` only in development.

The client must leave a `3xx` to the check. Effect's `FetchHttpClient` does,
with the `redirect: "manual"` the check provides around each request, over
any `RequestInit` the caller set.

## What it records

One span, `WebPage.check`, with `web_page.framing`, `web_page.reason`,
`http.response.status_code` and `web_page.redirects`. Never the URL, its
host or its path.

## Related

- [API reference](api.md#webpage)
- `@smthrs/ui`'s `WebPageView` and `WebLinkCard`, which show the frame and the
  card.
