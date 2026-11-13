import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, markdownDocumentBody } from "../src/index";
import { markdownBlockParser } from "../src/primitives/markdown";

test("complete leading YAML metadata is hidden; rules, code and incomplete metadata stay visible", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const ending of ["---", "..."]) {
      for (const prefix of ["", "\uFEFF"]) {
        const metadata = [prefix + "---", 'title: "Quickstart"', "sidebar:", "  order: 2", ending].join(newline);
        expect(markdownDocumentBody(metadata + newline + "# Quickstart")).toBe("# Quickstart");
        expect(markdownDocumentBody(metadata)).toBe("");
      }
    }
  }
  for (const source of ["text\n---\ntitle: X\n---", "---\ntitle: X", "---\n\n# Heading", "```yaml\n---\ntitle: X\n---\n```"]) {
    expect(markdownDocumentBody(source)).toBe(source);
  }
  const source = "---\ntitle: Quickstart\n---\n# Quickstart";
  expect(renderToStaticMarkup(<Markdown content={source} variant="document" />)).not.toContain("title:");
  expect(renderToStaticMarkup(<Markdown content={source} />)).toContain("title:");
});


test("document metadata is removed only once, before body blocks and quotes are parsed", () => {
  const metadata = "---\ntitle: Hidden metadata\n---\n";
  for (const ending of ["---", "..."]) {
    const body = ["---", "Environment: macOS 15", ending].join("\n");
    for (const prefix of ["# Report\n\n", metadata + "# Report\n\n", metadata]) {
      for (const suffix of ["", "\n\n# Next section"]) {
        const html = renderToStaticMarkup(<Markdown content={prefix + body + suffix} variant="document" />);
        expect(html).toContain("Environment: macOS 15");
        expect(html).not.toContain("Hidden metadata");
      }
    }
    const quote = body.split("\n").map((line) => "> " + line).join("\n");
    const html = renderToStaticMarkup(<Markdown content={metadata + quote} variant="document" />);
    expect(html).toContain("<blockquote");
    expect(html).toContain("Environment: macOS 15");
    expect(html).not.toContain("Hidden metadata");
  }
});


test("standalone block rendering hides only the document's first metadata block", () => {
  const source = "---\ntitle: Hidden metadata\n---\n# Report\n\n---\nEnvironment: macOS 15\n---";
  const html = renderToStaticMarkup(<>{markdownBlockParser.render(source, undefined, "document")}</>);
  expect(html).not.toContain("Hidden metadata");
  expect(html).toContain("Environment: macOS 15");
  const quote = "> ---\n> Environment: macOS 15\n> ---";
  const quoted = renderToStaticMarkup(<>{markdownBlockParser.render(quote, undefined, "document")}</>);
  expect(quoted).toContain("Environment: macOS 15");
});
