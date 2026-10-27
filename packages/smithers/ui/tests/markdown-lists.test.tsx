import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/index";

test("document list continuations remain inside their item for bullets and numbers", () => {
  for (const [marker, tag] of [["-", "ul"], ["1.", "ol"]]) {
    const source = `${marker} First **line**\n  with continuation\nand a lazy line.\n${marker} Second\n  \`code\` continues.\n\nAfter.`;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Markdown content={source} variant="document" />);
    expect([...host.querySelectorAll(`${tag} > li`)].map(li => li.textContent)).toEqual([
      "First line with continuation and a lazy line.", "Second code continues.",
    ]);
    expect(host.querySelector("li strong")?.textContent).toBe("line");
    expect(host.querySelector("li code")?.textContent).toBe("code");
    expect(host.querySelector("p")?.textContent).toBe("After.");
    const chat = document.createElement("div");
    chat.innerHTML = renderToStaticMarkup(<Markdown content={source} />);
    expect(chat.querySelector("li")?.textContent).toBe("First line");
  }
});

test("a new block ends a document list", () => {
  for (const next of [
    "# Heading", "```ts\nconst x = 1\n```", "> Quote", "<!-- comment -->", "<p>HTML</p>",
    "![Logo](logo.svg)", "| a | b |\n| --- | --- |\n| 1 | 2 |", "1. Ordered",
  ]) {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Markdown content={`- Bullet\n${next}`} variant="document" />);
    expect(host.querySelector("ul > li")?.textContent).toBe("Bullet");
  }
});
