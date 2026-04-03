import { describe, expect, test } from "bun:test";
import React from "react";
import { renderMdx } from "../src/renderMdx";
import { markdownComponents } from "../src/markdownComponents";

// Create simple MDX-like components (plain React components that accept components prop)
function SimpleMdx({ components }: { components?: Record<string, any> }) {
  const H1 = components?.h1 ?? "h1";
  const P = components?.p ?? "p";
  return (
    <>
      <H1>Hello World</H1>
      <P>This is a paragraph.</P>
    </>
  );
}

function CodeMdx({ components }: { components?: Record<string, any> }) {
  const P = components?.p ?? "p";
  const Code = components?.code ?? "code";
  return (
    <>
      <P>Some text with <Code>inline code</Code> here.</P>
      <Code className="language-js">const x = 1;</Code>
    </>
  );
}

function EmptyMdx() {
  return null;
}

function MultiNewlineMdx({ components }: { components?: Record<string, any> }) {
  const P = components?.p ?? "p";
  return (
    <>
      <P>First</P>
      <P>Second</P>
      <P>Third</P>
    </>
  );
}

describe("renderMdx", () => {
  test("renders headings as markdown", () => {
    const result = renderMdx(SimpleMdx as any);
    expect(result).toContain("# Hello World");
  });

  test("renders paragraphs as plain text", () => {
    const result = renderMdx(SimpleMdx as any);
    expect(result).toContain("This is a paragraph.");
  });

  test("renders inline code with backticks", () => {
    const result = renderMdx(CodeMdx as any);
    expect(result).toContain("`inline code`");
  });

  test("renders fenced code blocks", () => {
    const result = renderMdx(CodeMdx as any);
    expect(result).toContain("```js");
    expect(result).toContain("const x = 1;");
  });

  test("collapses triple+ newlines to double", () => {
    const result = renderMdx(MultiNewlineMdx as any);
    expect(result).not.toMatch(/\n{3,}/);
  });

  test("trims result", () => {
    const result = renderMdx(SimpleMdx as any);
    expect(result).toBe(result.trim());
  });

  test("allows overriding components via props", () => {
    const custom = {
      h1: ({ children }: any) => React.createElement(React.Fragment, null, "CUSTOM: ", children),
    };
    const result = renderMdx(SimpleMdx as any, { components: custom });
    expect(result).toContain("CUSTOM: Hello World");
  });

  test("handles null-returning component", () => {
    const result = renderMdx(EmptyMdx as any);
    expect(result).toBe("");
  });
});
