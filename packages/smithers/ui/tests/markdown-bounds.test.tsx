/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";
import { ItemConversation } from "../src/item-conversation/ItemConversation";
import { Markdown, markdownBlockParser } from "../src/primitives/markdown";

const render = (content: string) => renderToStaticMarkup(<Markdown content={content} variant="document" />);
const count = (html: string, tag: string) => (html.match(new RegExp(`<${tag}(?:>| )`, "g")) ?? []).length;
const quote = (depth: number) => "> ".repeat(depth) + "leaf";
const html = (tag: string, depth: number, closed = true) =>
  `<${tag}>`.repeat(depth) + "leaf" + (closed ? `</${tag}>`.repeat(depth) : "");

describe("Markdown traversal bounds", () => {
  test("the reported 20 KB comment renders without overflowing", () => {
    const content = quote(10_000);
    expect(() => markdownBlockParser.render(content, undefined, "document")).not.toThrow();
    expect(render(content)).toContain("leaf");
  });

  test("100,000 nested quotes keep the remaining source in a paragraph", () => {
    const started = performance.now();
    const result = render(quote(100_000));
    expect(count(result, "blockquote")).toBe(16);
    expect(result).toContain(`<p class="sui-md-p">${"&gt; ".repeat(100_000 - 16)}leaf</p>`);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 35_000);

  test.each(["b", "strong", "i", "em", "code", "a"])("100,000 nested <%s> tags stay bounded", (tag) => {
    const started = performance.now();
    for (const closed of [false, true]) {
      const result = render(html(tag, 100_000, closed));
      expect(result).toContain("leaf");
      const renderedTag = tag === "b" ? "strong" : tag === "i" ? "em" : tag === "a" ? null : tag;
      if (renderedTag) expect(count(result, renderedTag)).toBe(16);
    }
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 35_000);

  test("100,000 block HTML tags and unmatched closing tags stay bounded", () => {
    const started = performance.now();
    expect(render("<div>".repeat(100_000) + "leaf" + "</section>".repeat(100_000))).toContain("leaf");
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 35_000);

  test.each(["- ", "1. ", "["])("100,000 repeated %s markers stay bounded", (marker) => {
    const started = performance.now();
    const result = render(marker.repeat(100_000) + "leaf");
    expect(result).toContain("leaf");
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 35_000);

  test("unclosed brackets preserve ordinary inline formatting in both variants", () => {
    for (const variant of ["chat", "document"] as const) {
      const result = renderToStaticMarkup(<Markdown content={"[".repeat(100_000) + "**leaf**"} variant={variant} />);
      expect(result).toContain("<strong>leaf</strong>");
    }
  });

  test.each(["](x", "]()", "] invalid ](x)", "] invalid [leaf](https://smithers.sh)"])(
    "malformed bracket suffix %s stays bounded in both variants",
    (suffix) => {
      for (const variant of ["chat", "document"] as const) {
        const started = performance.now();
        const result = renderToStaticMarkup(<Markdown content={"[".repeat(100_000) + suffix + " leaf"} variant={variant} />);
        expect(result).toContain("leaf");
        expect(performance.now() - started).toBeLessThan(30_000);
      }
    },
    35_000,
  );

  test("links retain nested brackets and restart after overlapping code and emphasis", () => {
    for (const variant of ["chat", "document"] as const) {
      const result = renderToStaticMarkup(<Markdown content={"[a[b](https://smithers.sh) `[code` [leaf](https://smithers.sh) **[bold** [last](https://smithers.sh)"} variant={variant} />);
      expect(result).toContain('>a[b</a>');
      expect(result).toContain('>[code</code>');
      expect(result).toContain('>leaf</a>');
      expect(result).toContain('<strong>[bold</strong>');
      expect(result).toContain('>last</a>');
    }
  });

  test("empty image URLs, nested image labels and incomplete badges retain their behavior", () => {
    expect(render("[![leaf]()")).toContain("[leaf");
    expect(render("![![leaf](src)](href)")).toContain('leaf](href)');
    expect(render("[![](src)](href)")).not.toContain("<a");
    expect(render("[![leaf]()](href)")).toContain('href="href">leaf</a>');
    expect(render("[![leaf]()]()")).toContain("[leaf]()");
  });

  test.each([15, 16, 17])("quote and HTML depth %s keep formatting within the budget", (depth) => {
    expect(count(render(quote(depth)), "blockquote")).toBe(Math.min(depth, 16));
    expect(count(render(html("b", depth)), "strong")).toBe(Math.min(depth, 16));
  });

  test("overflow closings do not consume retained formatting or following blocks", () => {
    const result = render("<b>".repeat(17) + "leaf</b> tail" + "</b>".repeat(16) + " outside\n\n<b>next</b>");
    expect(result).toContain("leaf tail</strong>");
    expect(result).toContain("</strong> outside</p>");
    expect(result).toContain('<p class="sui-md-p"><strong>next</strong></p>');
    expect(count(result, "strong")).toBe(17);
    const quoted = render("> ".repeat(16) + "<b>".repeat(100) + "leaf" + "</b>".repeat(100) + "\n\n> sibling");
    expect(count(quoted, "blockquote")).toBe(17);
    expect(count(quoted, "strong")).toBe(16);
    expect(quoted).toContain('<blockquote class="sui-md-blockquote"><p class="sui-md-p">sibling</p></blockquote>');
  });

  test("block context closes independently and inline overflow resets at paragraphs", () => {
    const blocks = render('<div align="center">'.repeat(17) + "leaf</div> tail" + "</div>".repeat(16) + " outside");
    expect(blocks).toContain('<p class="sui-md-p" style="text-align:center">tail</p>');
    expect(blocks).toContain('<p class="sui-md-p">outside</p>');
    const inline = render("<b>".repeat(17) + "leaf<br> tail<div>next</div>");
    expect(inline).toContain("leaf<br/> tail");
    expect(inline).toContain('<p class="sui-md-p">next</p>');
  });

  test("a retained block ancestor closes overflow children before a following heading", () => {
    const result = render("<ul>" + "<li>item".repeat(20) + "</ul><h2>Title</h2>");
    expect(result).toContain('role="heading" aria-level="2">Title</div>');
  });

  test("closing a centered ancestor clears overflow paragraph context", () => {
    const result = render('<div align="center">' + "<p>".repeat(17) + "leaf</div>after");
    expect(result).toContain('<p class="sui-md-p">after</p>');
  });

  test("closing a retained link leaves the following text outside overflow formatting", () => {
    const result = render('<a href="https://smithers.sh">' + "<b>".repeat(20) + "leaf</a> tail");
    expect(result).toContain("</a> tail</p>");
    expect(count(result, "strong")).toBe(15);
  });

  test("a block overflow ancestor closes descendants before the retained ancestor", () => {
    const result = render('<div align="center">' + "<section>".repeat(15) + "<article><div>leaf</article></div>after");
    expect(result).toContain('<p class="sui-md-p">after</p>');
  });

  test("an inline overflow ancestor closes descendants before the retained ancestor", () => {
    const result = render('<a href="https://smithers.sh">' + "<b>".repeat(15) + "<em><a>leaf</em></a> after");
    expect(result).toContain("</a> after</p>");
  });

  test("omitted block end tags do not hide a following heading", () => {
    const result = render("<p>one".repeat(17) + "<h2>Title</h2>");
    expect(result).toContain('role="heading" aria-level="2">Title</div>');
  });

  test("100,000 alternating quote and list markers do not restart quote depth", () => {
    const started = performance.now();
    const result = render("> - ".repeat(100_000) + "leaf");
    expect(result).toContain("leaf");
    expect(count(result, "blockquote")).toBe(1);
    expect(count(result, "ul")).toBe(1);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 35_000);

  test("nested quote and HTML variations retain their text with bounded structure", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 256 }),
      fc.integer({ min: 0, max: 256 }),
      fc.constantFrom("b", "em", "code"),
      fc.boolean(),
      (quotes, tags, tag, closed) => {
        const result = render("> ".repeat(quotes) + html(tag, tags, closed));
        expect(result).toContain("leaf");
        expect(count(result, "blockquote")).toBe(Math.min(quotes, 16));
        expect(count(result, tag === "b" ? "strong" : tag)).toBe(quotes > 16 ? 0 : Math.min(tags, 16));
      },
    ), { numRuns: 50, seed: 5028 });
  });

  test("the conversation draws a hostile comment and the comment after it", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <ItemConversation title="Visible conversation" number={1} state="open" body="Visible body" comments={[
          { id: "deep-quote", author: "reader", body: quote(100_000) },
          { id: "deep-html", author: "reader", body: html("b", 100_000) },
          { id: "after", author: "reader", body: "Visible following comment" },
        ]} />,
      ));
      expect(container.querySelector("article")).not.toBeNull();
      expect(container.textContent).toContain("Visible conversation");
      expect(container.textContent).toContain("Visible body");
      expect(container.textContent).toContain("Visible following comment");
      expect(container.querySelectorAll("blockquote")).toHaveLength(16);
      expect(container.querySelectorAll(".sui-md strong")).toHaveLength(16);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
