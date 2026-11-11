/**
 * Whether a page shows in a frame, read from its response headers as a
 * browser reads them, and the card's preview read from its head. The checks
 * that request a page run against a real HTTP server in
 * `WebPageCheck.test.ts`.
 */
import * as Schema from "effect/Schema"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { WebPage } from "../src/index.ts"

const APP = "https://app.smithers.sh"
const PAGE = "https://docs.example.com/guide"

/** How a browser treats `PAGE`, answering with `headers`, in a frame held by `ancestors`. */
const framed = (headers: Record<string, string>, ancestors: ReadonlyArray<string> = [APP], page = PAGE) =>
  WebPage.framing(headers, { page, ancestors })

const allowed = { framing: "allowed" }
const refusedBy = (reason: string) => ({ framing: "refused", reason })

describe("WebPage.framing: X-Frame-Options", () => {
  it("allows a page with no framing headers", () => {
    expect(framed({})).toEqual(allowed)
  })

  it("refuses DENY in any case and spacing, and SAMEORIGIN unless every ancestor is the page's origin", () => {
    for (const value of ["DENY", "deny", " Deny "]) {
      expect(framed({ "x-frame-options": value })).toEqual(refusedBy("x_frame_options"))
    }
    expect(framed({ "x-frame-options": "SAMEORIGIN" })).toEqual(refusedBy("x_frame_options"))
    expect(framed({ "x-frame-options": "sameorigin" }, ["https://docs.example.com"])).toEqual(allowed)
    expect(framed({ "x-frame-options": "sameorigin" }, ["https://docs.example.com", APP])).toEqual(
      refusedBy("x_frame_options")
    )
  })

  it("allows ALLOWALL and values browsers don't know, such as ALLOW-FROM", () => {
    expect(framed({ "x-frame-options": "ALLOWALL" })).toEqual(allowed)
    expect(framed({ "x-frame-options": `ALLOW-FROM ${APP}` })).toEqual(allowed)
    expect(framed({ "x-frame-options": "" })).toEqual(allowed)
  })

  it("reads repeated headers, joined by commas, as one set: a repeat is one value, a conflict refuses", () => {
    expect(framed({ "x-frame-options": "DENY, deny" })).toEqual(refusedBy("x_frame_options"))
    expect(framed({ "x-frame-options": "SAMEORIGIN, DENY" }, ["https://docs.example.com"])).toEqual(
      refusedBy("x_frame_options")
    )
    expect(framed({ "x-frame-options": "ALLOWALL, other" })).toEqual(refusedBy("x_frame_options"))
    expect(framed({ "x-frame-options": "DENY," })).toEqual(refusedBy("x_frame_options"))
    expect(framed({ "x-frame-options": "one, other" })).toEqual(allowed)
  })

  it("finds a header in any case, as a plain record may spell it", () => {
    expect(framed({ "X-Frame-Options": "DENY" })).toEqual(refusedBy("x_frame_options"))
  })
})

describe("WebPage.framing: Content-Security-Policy frame-ancestors", () => {
  const csp = (policy: string, ancestors: ReadonlyArray<string> = [APP], page = PAGE) =>
    framed({ "content-security-policy": policy }, ancestors, page)

  it("refuses 'none' and an empty list", () => {
    expect(csp("frame-ancestors 'none'")).toEqual(refusedBy("frame_ancestors"))
    expect(csp("default-src 'self'; frame-ancestors")).toEqual(refusedBy("frame_ancestors"))
    expect(csp("FRAME-ANCESTORS 'NONE'")).toEqual(refusedBy("frame_ancestors"))
  })

  it("overrides X-Frame-Options whenever a policy has the directive, either way", () => {
    expect(framed({ "content-security-policy": "frame-ancestors *", "x-frame-options": "DENY" })).toEqual(allowed)
    expect(framed({ "content-security-policy": "frame-ancestors 'self'", "x-frame-options": "ALLOWALL" })).toEqual(
      refusedBy("frame_ancestors")
    )
    // A policy without the directive leaves X-Frame-Options in charge.
    expect(framed({ "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" })).toEqual(
      refusedBy("x_frame_options")
    )
  })

  it("matches *, schemes and their secure upgrades", () => {
    expect(csp("frame-ancestors *")).toEqual(allowed)
    expect(csp("frame-ancestors https:")).toEqual(allowed)
    expect(csp("frame-ancestors http:")).toEqual(allowed)
    expect(csp("frame-ancestors ws:")).toEqual(allowed)
    expect(csp("frame-ancestors wss:")).toEqual(allowed)
    expect(csp("frame-ancestors ftp:")).toEqual(refusedBy("frame_ancestors"))
    expect(csp("frame-ancestors https:", ["http://localhost:1337"], "http://127.0.0.1:4000/")).toEqual(
      refusedBy("frame_ancestors")
    )
    expect(csp("frame-ancestors *", ["chrome-extension://abc"])).toEqual(refusedBy("frame_ancestors"))
  })

  it("matches 'self' only for the page's own origin", () => {
    expect(csp("frame-ancestors 'self'")).toEqual(refusedBy("frame_ancestors"))
    expect(csp("frame-ancestors 'self'", ["https://docs.example.com"])).toEqual(allowed)
  })

  it("matches host sources by scheme, host, wildcard, port and path", () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      [APP, true],
      ["app.smithers.sh", true],
      ["APP.Smithers.SH", true],
      ["*.smithers.sh", true],
      ["https://*", true],
      ["https://app.smithers.sh:443", true],
      ["https://app.smithers.sh:*", true],
      ["http://app.smithers.sh:80", true],
      ["http://app.smithers.sh", true],
      ["https://app.smithers.sh/", true],
      ["*.app.smithers.sh", false],
      ["smithers.sh", false],
      ["https://app.smithers.sh:8443", false],
      ["https://app.smithers.sh/app", false],
      ["wss://app.smithers.sh", true],
      ["ftp://app.smithers.sh", false],
      ["https://other.example", false],
      ["'unsafe-inline'", false],
      ["'nonce-abc'", false],
      ["'sha256-abc='", false],
      ["https://[::1]", false],
      ["https://app.smithers.sh?query", false]
    ]
    for (const [source, matches] of cases) {
      expect([source, csp(`frame-ancestors ${source}`)]).toEqual([
        source,
        matches ? allowed : refusedBy("frame_ancestors")
      ])
    }
  })

  it("takes the ancestor's port: an explicit port matches only that port, none only the default", () => {
    const local = ["https://localhost:1443"]
    expect(csp("frame-ancestors https://localhost", local)).toEqual(refusedBy("frame_ancestors"))
    expect(csp("frame-ancestors https://localhost:1443", local)).toEqual(allowed)
    expect(csp("frame-ancestors localhost:1443", local)).toEqual(allowed)
    expect(csp("frame-ancestors https://localhost:80", local)).toEqual(refusedBy("frame_ancestors"))
    expect(csp("frame-ancestors http://example.test:8080", ["http://example.test:8080"], "http://other.test/")).toEqual(
      allowed
    )
    expect(csp("frame-ancestors http://example.test:80", ["http://example.test"], "http://other.test/")).toEqual(
      allowed
    )
  })

  it("a source without a scheme takes the page's: an http page's source doesn't match an https ancestor's... upgrade aside", () => {
    // The page is http:, so a bare host matches http: ancestors and their https: upgrade.
    expect(csp("frame-ancestors app.smithers.sh", [APP], "http://localhost/")).toEqual(allowed)
    // The page is https:, so a bare host doesn't match an http: ancestor.
    expect(csp("frame-ancestors example.test", ["http://example.test"])).toEqual(refusedBy("frame_ancestors"))
  })

  it("every ancestor must match, and every enforced policy with the directive must admit them", () => {
    expect(csp("frame-ancestors https://views.smithers.sh", ["https://views.smithers.sh", APP])).toEqual(
      refusedBy("frame_ancestors")
    )
    expect(csp(`frame-ancestors https://views.smithers.sh ${APP}`, ["https://views.smithers.sh", APP])).toEqual(allowed)
    expect(csp("frame-ancestors *, frame-ancestors 'none'")).toEqual(refusedBy("frame_ancestors"))
    expect(csp("frame-ancestors *, default-src 'none'")).toEqual(allowed)
  })

  it("a repeated directive in one policy is ignored after its first", () => {
    expect(csp("frame-ancestors *; frame-ancestors 'none'")).toEqual(allowed)
    expect(csp(";;  ; frame-ancestors\t'none' ;")).toEqual(refusedBy("frame_ancestors"))
  })

  it("never reads a report-only policy", () => {
    expect(framed({ "content-security-policy-report-only": "frame-ancestors 'none'" })).toEqual(allowed)
  })
})

describe("WebPage.framing: mixed content", () => {
  it("refuses an http: page under an https: ancestor, unless the page is on this machine", () => {
    expect(framed({}, [APP], "http://example.com/")).toEqual(refusedBy("insecure"))
    for (const page of ["http://localhost:4000/", "http://a.localhost/", "http://127.0.0.2/", "http://[::1]:8080/"]) {
      expect([page, framed({}, [APP], page)]).toEqual([page, allowed])
    }
    expect(framed({}, ["http://localhost:1337"], "http://example.com/")).toEqual(allowed)
  })
})

describe("WebPage.content", () => {
  it("refuses an attachment, a PDF and an octet stream, in any case and with parameters", () => {
    expect(WebPage.content({})).toBe(true)
    expect(WebPage.content({ "content-type": "text/html; charset=utf-8" })).toBe(true)
    expect(WebPage.content({ "content-disposition": "inline; filename=a.pdf" })).toBe(true)
    expect(WebPage.content({ "content-disposition": "attachment" })).toBe(false)
    expect(WebPage.content({ "Content-Disposition": "Attachment; filename=\"a.zip\"" })).toBe(false)
    expect(WebPage.content({ "content-type": "application/pdf" })).toBe(false)
    expect(WebPage.content({ "content-type": "Application/PDF; name=a" })).toBe(false)
    expect(WebPage.content({ "content-type": "application/octet-stream" })).toBe(false)
  })
})

describe("WebPage.preview", () => {
  const page = (head: string, url = PAGE) =>
    WebPage.preview(`<!doctype html><html><head>${head}</head><body></body></html>`, url)

  it("reads og:title over <title>, and og:description over description over twitter:description", () => {
    expect(page(`<title>Plain</title><meta property="og:title" content="Open Graph">`)).toMatchObject({
      title: "Open Graph"
    })
    expect(page(`<title>Plain</title>`).title).toBe("Plain")
    expect(
      page(`<meta name="twitter:description" content="T"><meta name="description" content="D">`).description
    ).toBe("D")
    expect(page(`<meta name="twitter:description" content="T">`).description).toBe("T")
    expect(
      page(`<meta name="description" content="D"><meta property="og:description" content="OG">`).description
    ).toBe("OG")
  })

  it("decodes entities once, collapses whitespace and drops empty text", () => {
    expect(page(`<title>  A &amp;amp; B &#39;c&#x27; &#x1F600; &bogus; &zz; &#0; &#xD800;\n\n d </title>`).title).toBe(
      "A &amp; B 'c' 😀 &bogus; &zz; &#0; &#xD800; d"
    )
    expect(page(`<meta name=description content='Tom &lt;3 &quot;Jerry&quot;&nbsp;!'>`).description).toBe(
      "Tom <3 \"Jerry\" !"
    )
    expect(page(`<title> \n </title><meta name="description" content="  ">`)).toEqual({
      icon: "https://docs.example.com/favicon.ico"
    })
  })

  it("cuts a long title and description with an ellipsis without splitting a code point", () => {
    const long = page(`<title>${"é".repeat(500)}</title><meta name="description" content="${"🙂".repeat(500)}">`)
    expect([...long.title!]).toHaveLength(WebPage.MAX_TITLE)
    expect(long.title!.endsWith("é…")).toBe(true)
    expect(long.description).toBe(`${"🙂".repeat(149)}…`)
    expect(Schema.is(WebPage.Preview)(long)).toBe(true)
    const exact = page(`<title>${"a".repeat(WebPage.MAX_TITLE)}</title>`)
    expect(exact.title).toBe("a".repeat(WebPage.MAX_TITLE))
  })

  it.each(
    [
      ["title", WebPage.MAX_TITLE],
      ["description", WebPage.MAX_DESCRIPTION]
    ] as const
  )("bounds %s by its schema's UTF-16 length and keeps whole code points", (field, max) => {
    const cases = [
      ["a".repeat(max), "a".repeat(max)],
      ["a".repeat(max - 2) + "🙂", "a".repeat(max - 2) + "🙂"],
      ["a".repeat(max - 1) + "🙂", "a".repeat(max - 1) + "…"],
      ["a".repeat(max - 2) + "🙂x", "a".repeat(max - 2) + "…"],
      ["🙂".repeat(max), "🙂".repeat((max - 2) / 2) + "…"],
      ["🙂 " + "a".repeat(max), "🙂 " + "a".repeat(max - 4) + "…"],
      ["a".repeat(max - 2) + " " + "🙂", "a".repeat(max - 2) + "…"],
      ["&#x1F642;".repeat(max), "🙂".repeat((max - 2) / 2) + "…"]
    ]
    for (const [input, expected] of cases) {
      const found = page(`<meta property="og:${field}" content="${input}">`)
      expect(found[field]).toBe(expected)
      expect(Schema.is(WebPage.Preview)(found)).toBe(true)
      const checked = { framing: "allowed", status: 200, ...found }
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(WebPage.Checked))(JSON.stringify(checked))).toEqual(
        checked
      )
    }
  })

  it("keeps title, description and icon offsets after Unicode case expansion", () => {
    for (const prefix of ["", "İ", "<meta name=\"keywords\" content=\"İİİ\">", "<!-- İ -->"]) {
      expect(
        page(
          `${prefix}<TiTlE>İstanbul Rehberi</tItLe><META NAME="description" CONTENT="Gezi İ">` +
            `<LINK REL="icon" HREF="/i.png">`
        )
      ).toEqual({
        title: "İstanbul Rehberi",
        description: "Gezi İ",
        icon: "https://docs.example.com/i.png"
      })
    }
  })

  it("skips mixed-case raw text and stops at the head boundary after Unicode case expansion", () => {
    const hidden = `<meta name="description" content="Hidden"><link rel="icon" href="/hidden.png">`
    const raw = ["script", "style", "noscript", "template", "textarea", "xmp"].map((name) =>
      `<${name.toUpperCase()}>İ${hidden}</${name.toUpperCase()}>`
    ).join("")
    for (const end of ["</HeAd>", "<BoDy>"]) {
      expect(
        WebPage.preview(`İ${raw}<TiTlE>İstanbul</TiTlE><!-- İ -->${end}${hidden}`, PAGE)
      ).toEqual({ title: "İstanbul", icon: "https://docs.example.com/favicon.ico" })
    }
  })

  it("returns schema-valid previews for arbitrary Unicode heads", () => {
    const text = fc.oneof(
      fc.string({ unit: "binary", maxLength: 500 }),
      fc.array(fc.constantFrom("🙂", "İ", "a", "é", " ", "&#x1F642;"), { minLength: 100, maxLength: 400 })
        .map((parts) => parts.join(""))
    )
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\"", "&quot;")
    fc.assert(
      fc.property(text, text, (title, description) => {
        const found = page(
          `<title>${escape(title)}</title><meta name="description" content="${escape(description)}">`
        )
        expect(Schema.is(WebPage.Preview)(found)).toBe(true)
        expect(Schema.is(WebPage.Checked)({ framing: "allowed", status: 200, ...found })).toBe(true)
      }),
      { numRuns: 300, seed: 4932 }
    )
  })

  it("takes the first icon link, else an apple-touch-icon, resolved against the page, https only", () => {
    expect(page(`<link rel="apple-touch-icon" href="/apple.png"><link rel="shortcut icon" href="favicon.png">`).icon)
      .toBe(
        "https://docs.example.com/favicon.png"
      )
    expect(page(`<link rel="icon" href="/a.png"><link rel="icon" href="/b.png">`).icon).toBe(
      "https://docs.example.com/a.png"
    )
    expect(page(`<link rel="apple-touch-icon" href="https://cdn.example.com/t.png">`).icon).toBe(
      "https://cdn.example.com/t.png"
    )
    expect(page(`<link rel="mask-icon" href="/mask.svg">`).icon).toBe("https://docs.example.com/favicon.ico")
    expect(page(`<link rel="icon">`).icon).toBe("https://docs.example.com/favicon.ico")
    expect(page(`<link href="/style.css"><link rel="stylesheet" href="/s.css">`).icon).toBe(
      "https://docs.example.com/favicon.ico"
    )
  })

  it("an icon that isn't https, names a user, or is too long falls back to /favicon.ico", () => {
    for (
      const href of [
        "http://docs.example.com/a.png",
        "data:image/png;base64,AAAA",
        "https://user:pass@docs.example.com/a.png",
        `https://docs.example.com/${"a".repeat(WebPage.MAX_ICON_URL)}`,
        "https://[bad"
      ]
    ) {
      expect([href, page(`<link rel="icon" href="${href}">`).icon]).toEqual([
        href,
        "https://docs.example.com/favicon.ico"
      ])
    }
  })

  it("resolves the icon against <base href>, and ignores a base that isn't a URL", () => {
    expect(page(`<base href="https://static.example.com/assets/"><link rel="icon" href="i.png">`).icon).toBe(
      "https://static.example.com/assets/i.png"
    )
    expect(page(`<base href="http://[bad"><link rel="icon" href="i.png">`).icon).toBe("https://docs.example.com/i.png")
    expect(page(`<base target="_top"><link rel="icon" href="i.png">`).icon).toBe("https://docs.example.com/i.png")
  })

  it("an http page with no https icon has none", () => {
    expect(page(`<title>Local</title>`, "http://localhost:4000/")).toEqual({ title: "Local" })
    expect(page(`<link rel="icon" href="https://localhost:4000/i.png">`, "http://localhost:4000/").icon).toBe(
      "https://localhost:4000/i.png"
    )
  })

  it("reads only the head: nothing after </head> or <body>", () => {
    expect(WebPage.preview(`<title>Head</title></head><title>Body</title>`, PAGE).title).toBe("Head")
    expect(
      WebPage.preview(`<meta name="description" content="Head"><body><meta name="description" content="x">`, PAGE)
    ).toMatchObject({ description: "Head" })
    expect(WebPage.preview(`<BODY><title>Late</title>`, PAGE).title).toBeUndefined()
  })

  it("skips comments, scripts, styles and templates whole, and closing tags", () => {
    const html = `<!-- <title>Comment</title> --><script>const s = "<title>Script</title>"</script>` +
      `<style>a::after { content: "<meta name=description content=Style>" }</style>` +
      `<template><title>Template</title></template></div><title>Real</title>`
    expect(WebPage.preview(html, PAGE)).toEqual({ title: "Real", icon: "https://docs.example.com/favicon.ico" })
  })

  it("parses quoted, unquoted and valueless attributes, self-closing tags, and keeps a repeated name's first value", () => {
    expect(
      WebPage.preview(
        `<meta property=og:title content=Unquoted /><meta name="description" content='One' content="Two" hidden>`,
        PAGE
      )
    ).toMatchObject({ title: "Unquoted", description: "One" })
    // A meta with no content, or no name, is skipped; a repeated key keeps its first content.
    expect(
      WebPage.preview(
        `<meta name="description"><meta content="orphan"><meta name="description" content="First">` +
          `<meta name="description" content="Second">`,
        PAGE
      ).description
    ).toBe("First")
  })

  it("stops at an unclosed comment, script or tag, and reads an unclosed title to the end", () => {
    expect(WebPage.preview(`<title>A</title><!-- never closed <title>B</title>`, PAGE).title).toBe("A")
    expect(WebPage.preview(`<script>never closed <title>B</title>`, PAGE).title).toBeUndefined()
    expect(WebPage.preview(`<title>A</title><meta name="description" content="never closed`, PAGE).description)
      .toBeUndefined()
    expect(WebPage.preview(`<title>Cut short`, PAGE).title).toBe("Cut short")
    expect(WebPage.preview(`1 < 2 <title>After text</title>`, PAGE).title).toBe("After text")
    expect(WebPage.preview(``, PAGE)).toEqual({ icon: "https://docs.example.com/favicon.ico" })
  })

  it("is linear in hostile input", () => {
    const hostile = [
      "<a".repeat(200_000),
      `${"<1".repeat(200_000)}>`,
      `${"<a ".repeat(100_000)}>`,
      `<meta ${"a=".repeat(100_000)}>`,
      "<!--".repeat(100_000),
      `<title>${"&amp;".repeat(100_000)}`,
      `${"<script>".repeat(50_000)}</script>`,
      `${"<!-- -->".repeat(50_000)}<title>Last</title>`
    ]
    for (const html of hostile) {
      const started = performance.now()
      WebPage.preview(html, PAGE)
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })
})
