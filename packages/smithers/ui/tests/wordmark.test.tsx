import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Wordmark, WORDMARK } from "../src/wordmark/Wordmark";
import { smithersUiCss } from "../src/uiCss";

describe("Wordmark", () => {
  test("keeps every row the same width", () => {
    expect(new Set(WORDMARK.map((row) => [...row].length)).size).toBe(1);
  });

  test("casts the bottom shadow only under ink", () => {
    const above = [...WORDMARK[WORDMARK.length - 2]];
    const floating = [...WORDMARK[WORDMARK.length - 1]].flatMap((cell, column) =>
      cell !== " " && above[column] === " " ? [column] : [],
    );
    expect(floating).toEqual([]);
  });

  test("renders one row per line, hidden from assistive technology", () => {
    const html = renderToStaticMarkup(<Wordmark className="extra" />);
    expect(html).toStartWith('<svg class="sui-wordmark extra" aria-hidden="true"');
    expect(html).toMatch(/viewBox="0 0 \d+ 108"/);
    // A decorative graphic must not depend on the browser's minimum font size.
    expect(html).not.toMatch(/<(?:pre|text|span)\b/);
    expect(html).toContain("<path");
    expect(html.match(/class="sui-wordmark-row"/g)).toHaveLength(WORDMARK.length);
    expect(html).toContain("--sui-wordmark-row:5");
    expect(html).not.toContain('d="undefined"');
    expect(renderToStaticMarkup(<Wordmark />)).toContain('class="sui-wordmark"');
  });

  test("ships its styles in the component sheet", () => {
    expect(smithersUiCss).toContain(".sui-wordmark {");
    expect(smithersUiCss).toContain("@keyframes sui-wordmark-scan");
  });
});
