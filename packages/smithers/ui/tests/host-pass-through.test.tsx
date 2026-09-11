/** @jsxImportSource react */
// The three library changes apps/app asked for (LIBRARY-CHANGE-REQUESTS §3-§5),
// each proven at the boundary the app reaches for: pass-through attributes on
// the buttons ChatComposer and FileTree render, Tab leaving MarkdownEditor,
// and a GitHub-flavored table rendered as a table.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer, FileTree, Markdown, SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { MarkdownEditor } from "../src/adapters/markdown-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

describe("ChatComposer pass-through attributes", () => {
  test("stamps the host's attributes on the Send and Stop buttons", async () => {
    await render(
      <ChatComposer
        value="hello"
        onValueChange={() => {}}
        onSubmit={() => {}}
        lifecycleStatus="streaming"
        onStop={() => {}}
        submitProps={{ "data-flow": "send" }}
        stopProps={{ "data-flow": "chat.stop" }}
      />,
    );

    // The launch law: every visible affordance names the flow behind it, and
    // the host says so through a prop rather than by reaching into this
    // component's rendered DOM.
    expect(container!.querySelector(".sui-chat-composer-send")?.getAttribute("data-flow")).toBe("send");
    expect(container!.querySelector(".sui-chat-composer-stop")?.getAttribute("data-flow")).toBe("chat.stop");
  });

  test("lets the host correct an attribute the component set", async () => {
    await render(
      <ChatComposer
        value="hello"
        onValueChange={() => {}}
        onSubmit={() => {}}
        submitProps={{ title: "Send to Smithers" }}
      />,
    );
    expect(container!.querySelector(".sui-chat-composer-send")?.getAttribute("title")).toBe("Send to Smithers");
  });
});

describe("FileTree pass-through attributes", () => {
  test("stamps the host's attributes on each leaf, per node", async () => {
    await render(
      <FileTree
        nodes={["src/index.ts", "README.md"]}
        nodeProps={(node) => ({ "data-flow": "world.select", "data-path": node.path })}
      />,
    );

    const leaves = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="file-tree-file"]'));
    expect(leaves.map((leaf) => leaf.getAttribute("data-flow"))).toEqual(["world.select", "world.select"]);
    expect(leaves.map((leaf) => leaf.getAttribute("data-path")).sort()).toEqual(["README.md", "src/index.ts"]);
  });

  test("renders without the hook, exactly as before", async () => {
    await render(<FileTree nodes={["README.md"]} />);
    expect(document.querySelector('[data-slot="file-tree-file"]')?.getAttribute("data-flow")).toBeNull();
  });
});

describe("MarkdownEditor Tab order", () => {
  test("declares that Tab leaves the editor by default", async () => {
    await render(<MarkdownEditor value="# hello" aria-label="World" />);
    const host = document.querySelector('[data-slot="markdown-editor"]');
    // A ProseMirror body binds Tab to indentation, which makes the editor a
    // focus trap a keyboard user cannot leave. The default releases it.
    expect(host?.getAttribute("data-escape-tab-order")).toBe("true");
  });

  test("a surface that wants the editor's own Tab can say so", async () => {
    await render(<MarkdownEditor value="# hello" aria-label="World" escapeTabOrder={false} />);
    expect(document.querySelector('[data-slot="markdown-editor"]')?.getAttribute("data-escape-tab-order")).toBe(
      "false",
    );
  });
});

describe("Markdown tables", () => {
  const TABLE = [
    "| Repo | Issues |",
    "| :--- | ---: |",
    "| smithers | 12 |",
    "| plue | 3 |",
  ].join("\n");

  test("renders a GitHub-flavored table as a table, not as literal pipes", async () => {
    await render(<Markdown content={TABLE} />);

    const table = container!.querySelector("table");
    expect(table).not.toBeNull();
    expect(Array.from(table!.querySelectorAll("th")).map((cell) => cell.textContent)).toEqual(["Repo", "Issues"]);
    expect(Array.from(table!.querySelectorAll("tbody tr")).map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent)
    )).toEqual([["smithers", "12"], ["plue", "3"]]);
    // The delimiter row's colons are alignment, and never text.
    expect(container!.textContent).not.toContain("---");
    expect(container!.textContent).not.toContain("|");
  });

  test("carries the delimiter row's alignment onto every cell of its column", async () => {
    await render(<Markdown content={TABLE} />);
    const heads = Array.from(container!.querySelectorAll<HTMLElement>("th"));
    expect(heads.map((cell) => cell.style.textAlign)).toEqual(["left", "right"]);
    const firstRow = Array.from(container!.querySelectorAll<HTMLElement>("tbody tr td"));
    expect(firstRow.slice(0, 2).map((cell) => cell.style.textAlign)).toEqual(["left", "right"]);
  });

  test("renders inline spans inside cells", async () => {
    await render(<Markdown content={"| Package |\n| --- |\n| `@smthrs/ui` |"} />);
    expect(container!.querySelector("td code")?.textContent).toBe("@smthrs/ui");
  });

  test("fills a ragged row rather than dropping it", async () => {
    await render(<Markdown content={"| A | B |\n| --- | --- |\n| only |"} />);
    const cells = Array.from(container!.querySelectorAll("tbody td"));
    expect(cells.map((cell) => cell.textContent)).toEqual(["only", ""]);
  });

  test("a sentence with a pipe stays a paragraph", async () => {
    await render(<Markdown content={"Run `a | b` to pipe it."} />);
    expect(container!.querySelector("table")).toBeNull();
    expect(container!.querySelector(".sui-md-p")).not.toBeNull();
  });

  test("a header row with no delimiter row stays a paragraph", async () => {
    await render(<Markdown content={"| Repo | Issues |\n| smithers | 12 |"} />);
    expect(container!.querySelector("table")).toBeNull();
  });

  test("a delimiter row whose width disagrees with the header stays a paragraph", async () => {
    await render(<Markdown content={"| A | B |\n| --- |\n| 1 | 2 |"} />);
    expect(container!.querySelector("table")).toBeNull();
  });

  test("a pipe inside a fence stays data", async () => {
    await render(<Markdown content={"```\n| A |\n| --- |\n```"} />);
    expect(container!.querySelector("table")).toBeNull();
    expect(container!.textContent).toContain("| A |");
  });

  test("a table between two paragraphs leaves both standing", async () => {
    await render(<Markdown content={"Before.\n\n| A |\n| --- |\n| 1 |\n\nAfter."} />);
    expect(container!.querySelectorAll(".sui-md-p")).toHaveLength(2);
    expect(container!.querySelector("table")).not.toBeNull();
  });
});
