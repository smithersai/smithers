import { expect, test } from "bun:test";
import { markdownAlerts } from "../src/markdownAlerts";
import { markdownHtml, joinMarkdownHtml, type MarkdownNode } from "../src/markdownHtml";

test("all five GitHub alerts have a named title and keep their body", () => {
  for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
    const tree: MarkdownNode = { type: "root", children: [{ type: "blockquote", children: [
      { type: "paragraph", children: [{ type: "text", value: `[!${kind}]\nBody` }] },
    ] }] };
    markdownAlerts(tree);
    joinMarkdownHtml(tree);
    const quote = tree.children![0]!;
    const title = markdownHtml(quote.children![0]!.children![0]!.value!);
    expect(title.querySelector("strong")?.dataset.kind).toBe(kind.toLowerCase());
    expect(title.textContent).toBe(kind[0] + kind.slice(1).toLowerCase());
    expect(quote.children![1]!.children![0]!.value).toBe("Body");
  }
});

test("unknown, inline, late, lowercase and nested markers remain quotes", () => {
  for (const value of ["[!OTHER]\nBody", "[!WARNING] inline", "Before\n[!NOTE]", "[!tip]\nBody", undefined]) {
    const tree: MarkdownNode = { type: "root", children: [{ type: "blockquote", children: [
      { type: "paragraph", children: [{ type: "text", value }] },
    ] }] };
    const before = JSON.stringify(tree);
    markdownAlerts(tree);
    expect(JSON.stringify(tree)).toBe(before);
  }
  for (const tree of [
    { type: "root" },
    { type: "root", children: [{ type: "paragraph" }] },
    { type: "root", children: [{ type: "blockquote" }] },
    { type: "root", children: [{ type: "blockquote", children: [{ type: "paragraph", children: [{ type: "inlineCode", value: "[!NOTE]" }] }] }] },
    { type: "root", children: [{ type: "blockquote", children: [{ type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "[!NOTE]" }] }] }] }] },
  ] satisfies MarkdownNode[]) {
    const before = JSON.stringify(tree);
    markdownAlerts(tree);
    expect(JSON.stringify(tree)).toBe(before);
  }
  expect(markdownHtml('<strong data-github-alert="invalid">plain</strong><span data-github-alert="note">plain</span>').querySelector("[data-kind]")).toBeNull();
});
