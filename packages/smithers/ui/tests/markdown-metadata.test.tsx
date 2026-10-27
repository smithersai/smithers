import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, markdownDocumentBody } from "../src/index";

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
