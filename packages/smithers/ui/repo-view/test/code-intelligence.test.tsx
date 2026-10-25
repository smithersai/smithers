/** @jsxImportSource react */
// What a language server draws on the code view: marks and the cursor as one
// sheet in pierre's shadow root, a hover card under its token, the keyboard
// cursor moving through the symbols pierre drew, a plain click selecting a
// symbol, `RepoView` passing all of it to the shown file, and the Symbols
// pane beside it. Every case renders real pierre in happy-dom and reads the
// DOM a person would see.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CodeFileView,
  codeMarksCss,
  currentCodeViewPool,
  disposeCodeViewPool,
  isSymbolText,
  moveCursor,
  REPO_VIEW_STYLE_ATTR,
  RepoView,
  type RepoViewLocation,
  SymbolsPane,
  type CodeTokenPosition,
} from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => disposeCodeViewPool());

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
  document.querySelectorAll(`style[${REPO_VIEW_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function mount(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

async function rerender(element: ReactElement): Promise<void> {
  const r = root!;
  await act(async () => r.render(element));
}

const host = (): HTMLElement => container!.querySelector<HTMLElement>('[data-slot="code-view"]')!;
const shadow = (): ShadowRoot | null | undefined => host().querySelector("diffs-container")?.shadowRoot;

async function until(satisfied: () => boolean, what: string, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!satisfied()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${deadlineMs / 1000} s (worker pool: ${currentCodeViewPool().state})`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** Waits until pierre has highlighted the code: coloured tokens, each marked with its column. */
const tokens = (): Promise<void> =>
  until(() => shadow()?.querySelector("[data-line] span[style][data-char]") != null, "pierre never highlighted a token");

const token = (line: number, text: string): HTMLElement =>
  Array.from(shadow()!.querySelectorAll<HTMLElement>(`[data-line="${line}"] [data-char]`)).find((span) => span.textContent === text)!;

const marksSheet = (): string => shadow()?.querySelector('style[data-slot="code-view-marks"]')?.textContent ?? "";

beforeAll(async () => {
  const warm = document.createElement("div");
  document.body.appendChild(warm);
  const warmRoot = createRoot(warm);
  await act(async () => warmRoot.render(<CodeFileView name="src/warm-up.ts" contents={"const warm = 1\n"} mode="dark" palette="paper" onTokenSelect={() => {}} />));
  await until(
    () => warm.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span[style][data-char]") != null,
    "the worker pool never highlighted a token",
    150_000,
  );
  await act(async () => warmRoot.unmount());
  warm.remove();
}, 180_000);

const CONTENTS = "import { add } from \"./math\"\nconst total = add(1, 2)\n\nexport const twice = total * 2\n";

describe("the cursor's rules", () => {
  const symbols = [
    { line: 1, column: 10, text: "add" },
    { line: 2, column: 7, text: "total" },
    { line: 2, column: 15, text: "add" },
    { line: 4, column: 14, text: "twice" },
    { line: 4, column: 22, text: "total" },
  ];

  test("with no cursor every key lands on the first symbol at or after the anchor, else the first", () => {
    expect(moveCursor(symbols, undefined, "ArrowDown")).toEqual(symbols[0]);
    expect(moveCursor(symbols, undefined, "ArrowLeft", 3)).toEqual(symbols[3]);
    expect(moveCursor(symbols, undefined, "ArrowRight", 9)).toEqual(symbols[0]);
    expect(moveCursor([], undefined, "ArrowRight")).toBeUndefined();
  });

  test("left and right step through symbols across lines and stay at either end", () => {
    expect(moveCursor(symbols, symbols[1], "ArrowRight")).toEqual(symbols[2]);
    expect(moveCursor(symbols, symbols[2], "ArrowRight")).toEqual(symbols[3]);
    expect(moveCursor(symbols, symbols[4], "ArrowRight")).toEqual(symbols[4]);
    expect(moveCursor(symbols, symbols[1], "ArrowLeft")).toEqual(symbols[0]);
    expect(moveCursor(symbols, symbols[0], "ArrowLeft")).toEqual(symbols[0]);
    // A cursor between symbols moves to the one after it, or the one before.
    expect(moveCursor(symbols, { line: 2, column: 10 }, "ArrowRight")).toEqual(symbols[2]);
    expect(moveCursor(symbols, { line: 2, column: 10 }, "ArrowLeft")).toEqual(symbols[1]);
  });

  test("up and down go to the nearest column on the closest line that has symbols, and stay at either end", () => {
    expect(moveCursor(symbols, symbols[2], "ArrowDown")).toEqual(symbols[3]);
    expect(moveCursor(symbols, { line: 2, column: 21 }, "ArrowDown")).toEqual(symbols[4]);
    expect(moveCursor(symbols, symbols[1], "ArrowUp")).toEqual(symbols[0]);
    expect(moveCursor(symbols, symbols[3], "ArrowDown")).toEqual(symbols[3]);
    expect(moveCursor(symbols, symbols[0], "ArrowUp")).toEqual(symbols[0]);
    // Past every symbol, nothing is below or after.
    expect(moveCursor(symbols, { line: 9, column: 1 }, "ArrowDown")).toBeUndefined();
  });

  test("a symbol is an identifier that isn't a reserved word", () => {
    expect(isSymbolText("total")).toBe(true);
    expect(isSymbolText("$el_2")).toBe(true);
    expect(isSymbolText("const")).toBe(false);
    expect(isSymbolText("(")).toBe(false);
    expect(isSymbolText("2x")).toBe(false);
  });
});

describe("codeMarksCss", () => {
  test("a symbol highlights its token; a problem underlines its tokens, at least one and at most 200, and marks the gutter", () => {
    const css = codeMarksCss(
      [
        { line: 2, column: 15, kind: "symbol" },
        { line: 3, column: 1, end: 4, kind: "error" },
        { line: 4, column: 5, kind: "warning" },
        { line: 5, column: 1, end: 999, kind: "info" },
      ],
      { line: 2, column: 7 },
    );
    expect(css).toContain('[data-line="2"] [data-char="14"]{background:');
    expect(css).toContain('[data-line="3"] [data-char="0"],[data-line="3"] [data-char="1"],[data-line="3"] [data-char="2"]{text-decoration:underline wavy');
    expect(css).not.toContain('[data-line="3"] [data-char="3"]');
    expect(css).toContain('[data-line="4"] [data-char="4"]{text-decoration');
    expect(css).toContain('[data-column-number="3"]{box-shadow');
    expect(css).toContain('[data-line="5"] [data-char="199"]');
    expect(css).not.toContain('[data-line="5"] [data-char="200"]');
    expect(css).toContain('[data-line="2"] [data-char="6"]{outline:2px solid');
    expect(codeMarksCss([], undefined)).toBe("");
  });
});

describe("CodeFileView with a language server", () => {
  test("marks and the cursor land in pierre's shadow root and follow the props", async () => {
    await mount(
      <CodeFileView
        name="src/a.ts"
        contents={CONTENTS}
        mode="dark"
        palette="paper"
        marks={[{ line: 2, column: 15, kind: "symbol" }]}
        cursor={{ line: 2, column: 7 }}
        onCursorMove={() => {}}
      />,
    );
    await tokens();
    await until(() => marksSheet().includes('[data-char="14"]'), "the marks never reached the shadow root");
    expect(marksSheet()).toContain('[data-line="2"] [data-char="6"]{outline');
    await rerender(<CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" marks={[]} onCursorMove={() => {}} />);
    expect(marksSheet()).toBe("");
  }, 90_000);

  test("a hover card sits under its token with its signature, body and problems, and describes the code", async () => {
    await mount(
      <CodeFileView
        name="src/a.ts"
        contents={CONTENTS}
        mode="dark"
        palette="paper"
        onKeyDown={() => {}}
        hover={{
          line: 2,
          column: 15,
          signature: "function add(a: number, b: number): number",
          body: <p>Adds two numbers.</p>,
          problems: [{ severity: "error", message: "Expected 2 arguments." }],
        }}
      />,
    );
    await tokens();
    const card = host().querySelector<HTMLElement>('[data-slot="code-view-hover"]')!;
    await until(() => card.hasAttribute("data-placed"), "the hover card was never placed");
    expect(card.getAttribute("role")).toBe("tooltip");
    expect(host().getAttribute("aria-describedby")).toBe(card.id);
    expect(card.querySelector("pre")?.textContent).toBe("function add(a: number, b: number): number");
    expect(card.textContent).toContain("Adds two numbers.");
    expect(card.querySelector('[data-severity="error"]')?.textContent).toBe("Expected 2 arguments.");
    // A card on a line pierre hasn't drawn waits unplaced; one with only a signature shows only that.
    await rerender(
      <CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" hover={{ line: 99, column: 1, signature: "x" }} />,
    );
    const lone = host().querySelector<HTMLElement>('[data-slot="code-view-hover"]')!;
    expect(lone.hasAttribute("data-placed")).toBe(false);
    expect(lone.querySelector(".sui-code-hover-body")).toBeNull();
    expect(lone.querySelector("ul")).toBeNull();
    await rerender(<CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" />);
    expect(host().querySelector('[data-slot="code-view-hover"]')).toBeNull();
    expect(host().hasAttribute("aria-describedby")).toBe(false);
  }, 90_000);

  test("focus lands the cursor on the first symbol at the anchor; arrows move it; other keys go to onKeyDown", async () => {
    const moves: Array<CodeTokenPosition> = [];
    const keys: Array<string> = [];
    const view = (cursor?: { line: number; column: number }) => (
      <CodeFileView
        name="src/a.ts"
        contents={CONTENTS}
        mode="dark"
        palette="paper"
        line={2}
        cursor={cursor}
        onCursorMove={(at) => moves.push(at)}
        onKeyDown={(event) => keys.push(event.key)}
      />
    );
    await mount(view());
    await tokens();
    expect(host().tabIndex).toBe(0);
    expect(host().getAttribute("aria-label")).toBe("src/a.ts");
    await act(async () => host().focus());
    expect(moves).toEqual([{ line: 2, column: 7, text: "total" }]);
    await rerender(view({ line: 2, column: 7 }));
    const press = (key: string, init: KeyboardEventInit = {}) =>
      act(async () => {
        host().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      });
    await press("ArrowRight");
    expect(moves.at(-1)).toEqual({ line: 2, column: 15, text: "add" });
    await press("ArrowRight", { shiftKey: true });
    await press("Enter");
    expect(keys).toEqual(["ArrowRight", "Enter"]);
    // Focus with a cursor already set moves nothing.
    host().blur();
    await act(async () => host().focus());
    expect(moves).toHaveLength(2);
    // A pointer that focuses the code picks its own token: no cursor lands first.
    await rerender(view());
    host().blur();
    await act(async () => {
      host().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      host().focus();
    });
    expect(moves).toHaveLength(2);
  }, 90_000);

  test("arrows in a file with no symbols move nothing, and without onCursorMove they are the consumer's keys", async () => {
    const keys: Array<string> = [];
    await mount(<CodeFileView name="notes.txt" contents={"( )\n"} mode="dark" palette="paper" onCursorMove={() => keys.push("moved")} />);
    await act(async () => host().focus());
    await act(async () => {
      host().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(keys).toEqual([]);
    await rerender(<CodeFileView name="notes.txt" contents={"( )\n"} mode="dark" palette="paper" onKeyDown={(event) => keys.push(event.key)} />);
    await act(async () => {
      host().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await act(async () => host().focus());
    expect(keys).toEqual(["ArrowDown"]);
  }, 90_000);

  test("a pointer rest survives a parent render and is cancelled when the file changes or unmounts", async () => {
    const rested: Array<CodeTokenPosition> = [];
    const onRest = (at: CodeTokenPosition) => rested.push(at);
    const view = (className: string, name = "src/a.ts") => <CodeFileView name={name} contents={CONTENTS} mode="dark" palette="paper" className={className} restMs={100} onTokenRest={onRest} />;
    await mount(view("before"));
    await tokens();
    token(2, "add").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }));
    await rerender(view("after"));
    await until(() => rested.length === 1, "a parent render cancelled the pending hover", 2_000);
    expect(rested).toEqual([{ line: 2, column: 15, text: "add" }]);
    token(2, "total").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }));
    await rerender(view("replacement", "src/b.ts"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(rested).toHaveLength(1);
    await tokens();
    token(2, "add").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }));
    await act(async () => root!.unmount());
    root = undefined;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(rested).toHaveLength(1);
  }, 90_000);

  test("a plain click selects a token; a click that ends a text selection selects nothing", async () => {
    const selected: Array<CodeTokenPosition> = [];
    await mount(<CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" onTokenSelect={(at) => selected.push(at)} />);
    await tokens();
    token(2, "add").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(selected).toEqual([{ line: 2, column: 15, text: "add" }]);
    // ⌘-click without onTokenActivate is nothing.
    token(2, "add").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }));
    const text = document.createTextNode("selected");
    document.body.appendChild(text);
    window.getSelection()!.selectAllChildren(document.body);
    token(2, "total").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    window.getSelection()!.removeAllRanges();
    text.remove();
    expect(selected).toHaveLength(1);
  }, 90_000);
});

describe("RepoView passes a language server's help to the shown file", () => {
  test("marks reach the file's code view", async () => {
    await mount(
      <RepoView
        name="ms"
        tree={{ state: "ready", paths: ["src/a.ts"] }}
        location={{ kind: "blob", path: "src/a.ts" }}
        file={{ state: "text", contents: CONTENTS, size: CONTENTS.length }}
        href={(location) => `/${location.path}`}
        onNavigate={() => {}}
        code={{ marks: [{ line: 4, column: 14, kind: "warning" }], onCursorMove: () => {} }}
      />,
    );
    await tokens();
    expect(host().tabIndex).toBe(0);
    await until(() => marksSheet().includes('[data-column-number="4"]'), "the marks never reached the file");
  }, 90_000);
});

describe("SymbolsPane", () => {
  const href = (location: RepoViewLocation) => `/x/blob/${location.path}${location.line === undefined ? "" : `?L=${location.line}`}`;
  const rows = () => [...container!.querySelectorAll<HTMLAnchorElement>('[data-slot="symbols-row"]')];

  test("a symbol's definition and its references, grouped by file with counts, each a link to its line", async () => {
    const opened: Array<RepoViewLocation> = [];
    let closed = 0;
    await mount(
      <SymbolsPane
        path="src/a.ts"
        symbol={{
          name: "add",
          definitions: [{ path: "src/math.ts", line: 6, text: "export function add(a: number, b: number) {" }],
          references: [
            { path: "src/a.ts", line: 1, text: "import { add } from \"./math\"" },
            { path: "src/a.ts", line: 2, text: "const total = add(1, 2)" },
            { path: "src/other.ts", line: 2, text: "add(2, 2)" },
          ],
        }}
        href={href}
        onOpen={(location) => opened.push(location)}
        onClose={() => closed++}
      />,
    );
    const pane = container!.querySelector<HTMLElement>('[aria-label="Symbols"]')!;
    expect(pane.querySelector(".sui-symbols-title")?.textContent).toBe("add");
    const references = pane.querySelector<HTMLElement>('[aria-label="References"]')!;
    expect(references.querySelector("h3")?.textContent).toBe("References3");
    expect(pane.querySelector('[aria-label="Definition"] h3')?.textContent).toBe("Definition");
    expect([...references.querySelectorAll(".sui-symbols-file-name")].map((file) => file.textContent)).toEqual(["src/a.ts2", "src/other.ts1"]);
    expect(rows().map((row) => row.getAttribute("href"))).toEqual([
      "/x/blob/src/math.ts?L=6",
      "/x/blob/src/a.ts?L=1",
      "/x/blob/src/a.ts?L=2",
      "/x/blob/src/other.ts?L=2",
    ]);
    await act(async () => rows()[2]!.click());
    expect(opened).toEqual([{ kind: "blob", path: "src/a.ts", line: 2 }]);
    // A modified click is the browser's: the pane opens nothing.
    await act(async () => {
      rows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    });
    expect(opened).toHaveLength(1);
    // ↓ and ↑ move between rows; Escape closes.
    rows()[0]!.focus();
    const key = (key: string) =>
      act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    await key("ArrowDown");
    expect(document.activeElement).toBe(rows()[1]!);
    await key("ArrowUp");
    await key("ArrowUp");
    expect(document.activeElement).toBe(rows()[0]!);
    await key("Tab");
    await key("Escape");
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(closed).toBe(2);
  });

  test("references still loading show no count and no rows", async () => {
    await mount(
      <SymbolsPane path="src/a.ts" symbol={{ name: "add", definitions: undefined, references: undefined }} href={href} onOpen={() => {}} onClose={() => {}} />,
    );
    expect(container!.querySelector('[aria-label="References"] h3')?.textContent).toBe("References");
    expect(rows()).toEqual([]);
  });

  test("without a symbol, the file's outline: indented by depth, filtered by name, each row a link to its line", async () => {
    const opened: Array<RepoViewLocation> = [];
    await mount(
      <SymbolsPane
        path="src/math.ts"
        outline={[
          { name: "add", kind: "fn", line: 6, depth: 0 },
          { name: "Square", kind: "class", line: 10, depth: 0 },
          { name: "area", kind: "method", line: 12, depth: 1 },
        ]}
        href={href}
        onOpen={(location) => opened.push(location)}
        onClose={() => {}}
      />,
    );
    expect(container!.querySelector(".sui-symbols-title")?.textContent).toBe("Symbols");
    expect(rows().map((row) => row.textContent)).toEqual(["fnadd", "classSquare", "methodarea"]);
    expect(rows()[2]!.style.paddingInlineStart).toBe("26px");
    const filter = container!.querySelector<HTMLInputElement>('input[aria-label="Filter symbols"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(filter, "AR");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().map((row) => row.getAttribute("href"))).toEqual(["/x/blob/src/math.ts?L=10", "/x/blob/src/math.ts?L=12"]);
    await act(async () => rows()[1]!.click());
    await act(async () => {
      rows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    expect(opened).toEqual([{ kind: "blob", path: "src/math.ts", line: 12 }]);
  });

  test("an outline still loading shows the filter and no rows; ↓ from the filter reaches the first row", async () => {
    await mount(<SymbolsPane path="src/a.ts" href={href} onOpen={() => {}} onClose={() => {}} />);
    expect(rows()).toEqual([]);
    const filter = container!.querySelector<HTMLInputElement>('input[aria-label="Filter symbols"]')!;
    filter.focus();
    await act(async () => {
      filter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(filter);
    await rerender(<SymbolsPane path="src/a.ts" outline={[{ name: "add", kind: "fn", line: 1, depth: 0 }]} href={href} onOpen={() => {}} onClose={() => {}} />);
    await act(async () => {
      filter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(rows()[0]!);
  });
});
