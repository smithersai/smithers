# 0163 · Reachable external pages for deployment e2e

2026-11-04 · Accepted for the e2e-webpage ship lane, implementing TEST-1 and
Will's request to prove the external-page journeys against production.

Local runs keep the spec's real HTTPS and HTTP servers. Deployment runs use
public HTTPS fixtures: `https://rust-lang.org/` allows framing, and
`https://developer.mozilla.org/en-US/` refuses it with `X-Frame-Options: DENY`.
No new infrastructure or product-only test route is needed.

Before relying on them, an unauthenticated Playwright request context fetches
the real pages and verifies their successful HTML responses and framing
headers against the deployment's origin. The existing catalog library,
`@smthrs/views`' `WebPage.framing` and `WebPage.preview`, reads those responses.
Every test attaches a receipt containing only the public fixture URL, response
status and relevant headers. A changed policy fails the fixture preflight.

`E2E_WEB_ALLOWS_URL`, `E2E_WEB_REFUSES_URL` and `E2E_WEB_TAB_URL` can replace
the public pages. The allowing page needs a plain-text `h1` to prove that its
real document rendered; the refusing page needs a title, description and HTTPS
icon to retain the card's metadata assertions. Tabs default to the allowing `https://rust-lang.org/learn/`, so an accidental
agent embed produces a webpage and cannot pass the tab-card assertion. The
card title and the destination document title are asserted separately.
The deployed preview service is checked too: the Worker must receive a
successful response with the same metadata and framing. A runner-only 200
is insufficient (Python.org returned 403 to the Worker). The browser checks
that the card icon actually renders, and scrolls the second device's lazy
iframe into sight before reading its document.

Journeys that add views or ask the real agent declare `ownConversation`
before opening any device, keeping deployment writes in the test account's
private branch conversation. Local runs continue to use the local home.

A person's direct tab needs a real opening receipt. Production WebKit opens
the tab without consuming user activation, so the former adapter wrongly
dispatched a fallback card too. The existing app host adapter now obtains a
controlled blank tab synchronously, clears its opener before any outside
page can run, and follows a noreferrer link there. A null handle means a
blocked popup. This is browser-boundary wiring (apps are exempt from SDK-4),
not a new feature or second flow. The existing injected WebHost and durable
fallback remain. The real browser regression waits for the destination URL,
checks null opener and empty referrer, and asserts no view was added.
