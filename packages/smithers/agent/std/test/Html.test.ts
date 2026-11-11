import { execFileSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { toMarkdown, toText } from "../src/internal/Html.ts"

describe("Html", () => {
  it("drops non-content elements and comments before decoding entities", () => {
    const html = [
      "<HEAD><title>Hidden</title></HEAD>",
      "<script>danger()</script><style>.secret {}</style>",
      "<!-- hidden -->",
      "<p>Visible &amp; &#x1F600; &#39;quoted&#39;</p>"
    ].join("")
    expect(toText(html)).toBe("Visible & 😀 'quoted'")
  })

  it("preserves unknown and inherited-property entities in text and Markdown", () => {
    const html = "<p>ordinary &amp; &unknown; &constructor; &toString; &__proto__; &AMP;</p>"
    const expected = "ordinary & &unknown; &constructor; &toString; &__proto__; &"
    expect(toText(html)).toBe(expected)
    expect(toMarkdown(html)).toBe(expected)
  })

  it("renders headings, emphasis, links, and list items in Markdown", () => {
    const markdown = toMarkdown(
      "<h2>Guide</h2><p><a href=\"https://example.test\">Read &amp; learn</a> <strong>today</strong></p>" +
        "<ul><li>First</li><li><em>Second</em></li></ul>"
    )
    expect(markdown).toContain("## Guide")
    expect(markdown).toContain("[Read & learn](https://example.test) **today**")
    expect(markdown).toContain("- First")
    expect(markdown).toContain("- *Second*")
  })

  it("looks past malformed closing-tag prefixes and accepts whitespace before the close", () => {
    const html = "<p>before</p><SCRIPT>hidden</scripted>still hidden</script \t>after"
    expect(toText(html)).toBe("before\nafter")
    expect(toMarkdown(html)).toBe("before\nafter")
  })

  it("drops an unclosed skipped element even when its closing marker ends at EOF", () => {
    for (const html of ["visible<script>hidden</script", "visible<style>hidden</style \t"]) {
      expect(toText(html)).toBe("visible")
      expect(toMarkdown(html)).toBe("visible")
    }
  })

  it("preserves invalid numeric entities and decodes Unicode boundary values", () => {
    const html = `<p>&#0; &#x10FFFF; &#xD800; &#xDFFF; &#1114112; &#${"9".repeat(400)};</p>`
    const expected = html.slice(3, -4).replace("&#0;", "\u0000").replace("&#x10FFFF;", "\u{10ffff}")
    expect(toText(html)).toBe(expected)
    expect(toMarkdown(html)).toBe(expected)
  })

  it.each([
    ["<b>one</b><b>two</b><b><b>tail", "one two tail", "**one****two**tail"],
    ["<h1>one</h1><h6>six</h6><h1><h1>tail", "one\nsix\ntail", "# one\n\n###### six\n\ntail"],
    ["<em>one</em><i>two</i><strong>three</strong>", "one two three", "*one**two***three**"],
    ["before<!-- hidden -->after<!--unclosed", "beforeafter<!--unclosed", "beforeafter<!--unclosed"],
    ["<a>plain</a><a href=\"one\" href='two'>link</a>", "plain link", "plain[link](two)"],
    ["<a><a href=\"x\">nested</a>", "nested", "[nested](x)"],
    ["<a<a>plain</a>", "plain", "plain"],
    ["<a href=\"first\" href=\"late>link</a>\">tail", "link \">tail", "[link](first)\">tail"],
    ["<a href=\"x>y\">link</a>", "y\">link", "[link](x>y)"],
    ["<a href=\"first\" href=\"x>y\">link</a>", "y\">link", "[link](x>y)"],
    ["<a href=\"\">empty</a>", "empty", "empty"],
    ["<a href=\"first\" href=\"unclosed>link</a>", "link", "[link](first)"],
    ["<a href=\"first\" href=\"late>link</a>\"", "link \"", "[link](first)\""],
    ["<a href=\"late>link</a>\"", "link \"", "link\""],
    ["<a href=\"href=\"last\">link</a>", "link", "[link](last)"],
    ["a \t\n b\n\n\n c", "a\nb\n\nc", "a\n b\n\n c"],
    ["before<br>after", "before\nafter", "before\nafter"],
    ["<b", "<b", "<b"],
    ["<p", "<p", "<p"],
    ["a &quot;b&quot; &apos;c&apos; &nbsp; &#65; &#X41;", "a \"b\" 'c' A A", "a \"b\" 'c'   A A"]
  ])("preserves rendering of %s", (html, text, markdown) => {
    expect(toText(html!)).toBe(text)
    expect(toMarkdown(html!)).toBe(markdown)
  })

  it("renders generated complete and incomplete formatting elements", () => {
    let seed = 4901
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % bound
    }
    const tags = ["b", "strong", "i", "em", "h1", "h2", "h3", "h4", "h5", "h6", "a"]
    for (let run = 0; run < 1_000; run++) {
      const tag = tags[next(tags.length)]!
      const count = next(30) + 1
      const label = `sample${run}`
      const closed = next(2) === 0
      const open = tag === "a" ? `<a href="target${run}">` : `<${tag}>`
      const html = `${open.repeat(count)}${label}${closed ? `</${tag}>` : ""}`
      expect(toText(html)).toBe(label)
      const formatted = tag === "a" ?
        `[${label}](target${run})`
        : tag[0] === "h" ?
        `${"#".repeat(Number(tag[1]))} ${label}`
        : tag === "b" || tag === "strong" ?
        `**${label}**`
        : `*${label}*`
      expect(toMarkdown(html)).toBe(closed ? formatted : label)
    }
  })

  it("renders many unclosed skipped elements within a bounded time", { timeout: 45_000 }, () => {
    const html = `${"<script>".repeat(20_000)}${"x".repeat(2_000_000)}`
    const started = performance.now()
    const output = toText(html)
    const elapsed = performance.now() - started

    expect(typeof output).toBe("string")
    expect(elapsed).toBeLessThan(2_000)
  })
})

describe("hostile HTML", () => {
  it.each(["<", "<!--", "<b>", "<strong>", "<em>", "<i>", "<h1>", "<a href=\"x\">"])(
    "renders a 5 MiB page of unclosed %s within a bounded time",
    { timeout: 15_000 },
    (opener) => {
      // A parent-process timeout can interrupt a synchronous conversion that
      // would otherwise prevent Vitest and a flow deadline from firing.
      const result = execFileSync(process.execPath, [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict"
          import { toMarkdown, toText } from ${JSON.stringify(new URL("../src/internal/Html.ts", import.meta.url).href)}
          const opener = process.argv[1]
          const repeated = opener.repeat(Math.floor(5 * 1024 * 1024 / opener.length))
          const tail = "Visible &amp; text"
          const expected = (opener === "<" || opener === "<!--" ? repeated : "") + "Visible & text"
          for (const render of [toText, toMarkdown]) {
            assert.equal(render(repeated + tail), expected)
          }
          process.stdout.write("rendered")
        `,
        opener
      ], { timeout: 5_000, encoding: "utf8" })
      expect(result).toBe("rendered")
    }
  )
})
