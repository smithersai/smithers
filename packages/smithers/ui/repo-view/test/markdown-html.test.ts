import { expect, test } from "bun:test";
import { markdownHtml, joinMarkdownHtml, type MarkdownNode } from "../src/markdownHtml";

test("README HTML preserves centered preformatted logos and inline emphasis; comments vanish", () => {
  const dom = markdownHtml('<!-- generated --><pre align="center"> a  b\n c</pre><p align="CENTER"><strong>Build</strong></p>');
  expect(dom.querySelector("pre")?.textContent).toBe(" a  b\n c");
  expect(dom.querySelector("pre")?.style.textAlign).toBe("center");
  expect(dom.querySelector("p")?.style.textAlign).toBe("center");
  expect(dom.querySelector("strong")?.textContent).toBe("Build");
  expect(dom.textContent).not.toContain("generated");
});

test("the HTML policy drops executable content, styles, events and unsafe schemes", () => {
  const dom = markdownHtml('<script>bad()</script><style>body{display:none}</style><iframe src="x"></iframe><a href="java&#115;cript:bad()" onclick="bad()" style="color:red">bad</a><img src="data:text/html,bad" onerror="bad()" alt="Logo"><custom>kept</custom><p align="justify">text</p>');
  expect(dom.querySelector("script,style,iframe,svg,[onclick],[onerror],[style]")).toBeNull();
  expect(dom.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(dom.querySelector("img")?.hasAttribute("src")).toBe(false);
  expect(dom.querySelector("img")?.alt).toBe("Logo");
  expect(dom.textContent).toBe("badkepttext");
  expect(dom.querySelector("custom")).toBeNull();
  expect(markdownHtml("<svg><script>bad()</script></svg>").textContent).toBe("");
});

test("safe links and images preserve titles, relative URLs and text", () => {
  const dom = markdownHtml('<a href="../docs" title="Docs">Docs</a><a href="https://example.com">Site</a><a href="mailto:a@example.com">Mail</a><img src="/logo.svg" alt="Logo" title="Brand"><span alt="ignored">text</span>');
  expect([...dom.querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual(["../docs", "https://example.com", "mailto:a@example.com"]);
  expect(dom.querySelector("a")?.title).toBe("Docs");
  expect(dom.querySelector("img")?.getAttribute("src")).toBe("/logo.svg");
  expect(dom.querySelector("span")?.hasAttribute("alt")).toBe(false);
});

test("split HTML tags surround Markdown marks without losing or executing their content", () => {
  const tree: MarkdownNode = { type: "root", children: [{ type: "paragraph", children: [
    { type: "html", value: "<b>" }, { type: "text", value: 'a & < "' }, { type: "html", value: "</b>" },
    { type: "strong", children: [{ type: "text", value: "strong" }] },
    { type: "emphasis", children: [{ type: "text", value: "em" }] },
    { type: "delete", children: [{ type: "text", value: "gone" }] },
    { type: "inlineCode", value: "<code>" }, { type: "break" },
    { type: "link", url: "/docs", title: "Docs", children: [{ type: "text", value: "link" }] },
    { type: "image", url: "/logo.svg", alt: "Logo", title: "Brand" },
    { type: "unknown", children: [{ type: "text", value: "unknown" }] },
    { type: "unknown" }, { type: "text" }, { type: "html" }, { type: "inlineCode" }, { type: "link" }, { type: "image" },
  ] }, { type: "heading", children: [{ type: "text", value: "unchanged" }] }, { type: "text", value: "leaf" }] };
  joinMarkdownHtml(tree);
  const dom = markdownHtml(tree.children![0]!.children![0]!.value!);
  expect(dom.querySelector("b")?.textContent).toBe('a & < "');
  expect(dom.querySelector("strong")?.textContent).toBe("strong");
  expect(dom.querySelector("em")?.textContent).toBe("em");
  expect(dom.querySelector("del")?.textContent).toBe("gone");
  expect(dom.querySelector("code")?.textContent).toBe("<code>");
  expect(dom.querySelector("br")).not.toBeNull();
  expect(dom.querySelector("a")?.getAttribute("href")).toBe("/docs");
  expect(dom.querySelector("img")?.alt).toBe("Logo");
  expect(dom.textContent).toContain("unknown");
});

test("raw HTML keeps links and images on the repository's host: no //host, no \\\\host, no mailto image", () => {
  const external = ["//evil.example/x", "\\\\evil.example/x", "/\\evil.example/x", "\\/evil.example/x", " //evil.example", "/\t/evil.example", "\u0001//evil.example"];
  for (const url of external) {
    const dom = markdownHtml(`<a href="${url}">a</a><img src="${url}" alt="i">`);
    expect([url, dom.querySelector("a")?.hasAttribute("href")]).toEqual([url, false]);
    expect([url, dom.querySelector("img")?.hasAttribute("src")]).toEqual([url, false]);
  }
  const mail = markdownHtml('<a href="mailto:a@example.com">m</a><img src="mailto:a@example.com" alt="m">');
  expect(mail.querySelector("a")?.getAttribute("href")).toBe("mailto:a@example.com");
  expect(mail.querySelector("img")?.hasAttribute("src")).toBe(false);
  const kept = markdownHtml('<a href="/docs">d</a><img src="https://example.com/logo.svg" alt="l"><img src="./logo.svg" alt="r">');
  expect(kept.querySelector("a")?.getAttribute("href")).toBe("/docs");
  expect([...kept.querySelectorAll("img")].map(img => img.getAttribute("src"))).toEqual(["https://example.com/logo.svg", "./logo.svg"]);
});
