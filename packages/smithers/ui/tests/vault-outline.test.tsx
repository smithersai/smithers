/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OutlineView, parseOutline } from "../src/vault/OutlineView";

const MD = [
  "# Title", // line 1
  "",
  "Some body text.",
  "## First section", // line 4
  "```",
  "# not a heading",
  "```",
  "### Nested detail", // line 8
  "## Second section ##", // line 9
].join("\n");

describe("parseOutline", () => {
  test("extracts ATX headings with depth and 1-based lines", () => {
    expect(parseOutline(MD)).toEqual([
      { depth: 1, text: "Title", line: 1 },
      { depth: 2, text: "First section", line: 4 },
      { depth: 3, text: "Nested detail", line: 8 },
      { depth: 2, text: "Second section", line: 9 },
    ]);
  });

  test("ignores headings inside fenced code", () => {
    expect(parseOutline("```\n# hidden\n```").length).toBe(0);
    expect(parseOutline("~~~\n# hidden\n~~~").length).toBe(0);
  });

  test("a heading with no space after the hashes is not a heading", () => {
    expect(parseOutline("#nope")).toEqual([]);
  });
});

/**
 * The parser used to carry a boolean it toggled on any ``` or ~~~ line, so a
 * shorter or differently-marked run closed a block it never opened and the real
 * closer reopened one. Every heading after that point was inverted: code became
 * outline entries and the document's own headings vanished. It now reads the
 * same fence tracker the wikilink scanner does (`src/vault/fence.ts`).
 */
describe("outline fences close only on their own marker", () => {
  test("a shorter backtick run inside a longer fence does not end it", () => {
    const markdown = ["````markdown", "```", "# inside code", "````", "# real heading"].join("\n");
    expect(parseOutline(markdown)).toEqual([{ depth: 1, text: "real heading", line: 5 }]);
  });

  test("a tilde line inside a backtick fence does not end it", () => {
    const markdown = ["```", "~~~", "# inside code", "```", "# real heading"].join("\n");
    expect(parseOutline(markdown)).toEqual([{ depth: 1, text: "real heading", line: 5 }]);
  });

  test("a backtick line inside a tilde fence does not end it", () => {
    const markdown = ["~~~", "```", "# inside code", "~~~", "# real heading"].join("\n");
    expect(parseOutline(markdown)).toEqual([{ depth: 1, text: "real heading", line: 5 }]);
  });

  test("a closing fence may be longer than the opener but not shorter", () => {
    expect(parseOutline(["```", "# inside code", "````", "# real heading"].join("\n"))).toEqual([
      { depth: 1, text: "real heading", line: 4 },
    ]);
  });

  test("an info string keeps a fence open and is not a closer", () => {
    const markdown = ["```ts", "# inside code", "```ts", "# still inside", "```", "# real heading"].join("\n");
    expect(parseOutline(markdown)).toEqual([{ depth: 1, text: "real heading", line: 6 }]);
  });

  test("an unterminated fence runs to the end of the document", () => {
    const markdown = ["# Title", "```", "# inside code", "# also inside"].join("\n");
    expect(parseOutline(markdown)).toEqual([{ depth: 1, text: "Title", line: 1 }]);
  });

  test("an indented fence still opens and closes a block", () => {
    const markdown = ["  ```", "  # inside code", "  ```", "# real heading"].join("\n");
    expect(parseOutline(markdown)).toEqual([{ depth: 1, text: "real heading", line: 4 }]);
  });
});

describe("OutlineView", () => {
  test("renders an aria tree with indented treeitems", () => {
    const html = renderToStaticMarkup(<OutlineView markdown={MD} />);
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Document outline"');
    expect(html.match(/role="treeitem"/g)).toHaveLength(4);
    expect(html).toContain('aria-level="3"');
    expect(html).toContain("Nested detail");
    expect(html).not.toContain("not a heading");
  });

  test("renders the empty copy when there are no headings", () => {
    const html = renderToStaticMarkup(<OutlineView markdown={"plain text\nno headings"} />);
    expect(html).toContain("No headings");
    expect(html).not.toContain('role="treeitem"');
  });

  test("clicking a heading reports its 1-based line", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const lines: number[] = [];
    try {
      await act(async () => {
        root.render(<OutlineView markdown={MD} onHeadingClick={(line) => lines.push(line)} />);
      });
      const items = container.querySelectorAll<HTMLElement>('[role="treeitem"]');
      expect(items).toHaveLength(4);
      await act(async () => {
        items[2]!.click();
      });
      expect(lines).toEqual([8]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("arrow keys move a roving tab stop between treeitems", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<OutlineView markdown={MD} onHeadingClick={() => {}} />);
      });
      const items = () => Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
      // One tab stop into the tree: first item only.
      expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);

      await act(async () => {
        items()[0]!.focus();
        items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[1]);
      expect(items().map((el) => el.tabIndex)).toEqual([-1, 0, -1, -1]);

      await act(async () => {
        items()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[0]);
      expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);

      // Wrap-around at both ends, plus Home/End.
      await act(async () => {
        items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[3]);
      await act(async () => {
        items()[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[0]);
      await act(async () => {
        items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[3]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("Enter is not hijacked, so native button activation still fires the click handler", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<OutlineView markdown={MD} onHeadingClick={() => {}} />);
      });
      const first = container.querySelector<HTMLElement>('[role="treeitem"]')!;
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => {
        first.focus();
        first.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("OutlineView pass-through attributes", () => {
  test("stamps the host's attributes on each heading, per heading", () => {
    const html = renderToStaticMarkup(
      <OutlineView
        markdown={"# One\n\n## Two"}
        headingProps={(heading) => ({ "data-flow": "wiki.heading", "data-line": heading.line })}
      />,
    );
    expect(html.match(/data-flow="wiki\.heading"/g)).toHaveLength(2);
    expect(html).toContain('data-line="1"');
    expect(html).toContain('data-line="3"');
  });

  test("the roving tab stop stays the component's, whatever the host passes", () => {
    const html = renderToStaticMarkup(
      <OutlineView markdown={"# One\n\n## Two"} headingProps={() => ({ tabIndex: 5 })} />,
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(html).not.toContain('tabindex="5"');
  });
});
