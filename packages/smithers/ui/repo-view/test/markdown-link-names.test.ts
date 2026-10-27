import { expect, test } from "bun:test";
import { markdownLinkNames } from "../src/markdownLinkNames";
import { markdownHtml } from "../src/markdownHtml";

test("image-only links use alt, link title, image title, or their destination", () => {
  const host = document.createElement("div");
  host.innerHTML = '<a href="/a"><img alt=" Alt "></a><a href="/b" title=" Package "><img></a><a href="/c"><img title=" Brand "></a><a href="https://www.npmjs.com/package/vibelang"><img alt=""></a><a href="#license"><img></a><a href="/"><img></a>';
  markdownLinkNames(host);
  expect([...host.querySelectorAll("a")].map(link => link.getAttribute("aria-label"))).toEqual(["Alt", "Package", "Brand", "vibelang", "license", "Link"]);
  markdownLinkNames(host);
  expect(host.querySelector("a")?.getAttribute("aria-label")).toBe("Alt");
});

test("text and already named links retain their names; non-image links stay unchanged", () => {
  const host = document.createElement("div");
  host.innerHTML = '<a href="/x" aria-label="Chosen"><img alt="Other"></a><a href="/y">Text<img alt="Other"></a><a href="/z"></a><a><img></a>';
  markdownLinkNames(host);
  expect([...host.querySelectorAll("a")].map(link => link.getAttribute("aria-label"))).toEqual(["Chosen", null, null, null]);
});

test("HTML badges are named after sanitization", () => {
  const html = markdownHtml('<a href="/package" title="Package"><img src="/badge.svg" alt=""></a>');
  expect(html.querySelector("a")?.getAttribute("aria-label")).toBe("Package");
});
