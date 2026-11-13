/** @jsxImportSource react */
// CommandPalette under happy-dom: real createRoot + act, the Radix Dialog in its portal, native key and pointer
// events. The palette holds no state, so each test either records the callbacks or runs a host that owns the state.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CommandPalette,
  type CommandPaletteItem,
  type CommandPaletteProps,
  commandPaletteCss,
  Kbd,
  smithersUiCss,
  SMITHERS_UI_STYLE_ATTR,
} from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container ??= document.createElement("div");
  document.body.appendChild(container);
  root ??= createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
  // Radix arms its outside-pointer listener on the next tick.
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

/** Presses `name` on `el`, returning whether the default action still runs. */
async function key(el: Element, name: string): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  return followed;
}

/** Clicks `el` like a browser, returning whether mousedown's default (moving focus) still runs. */
async function click(el: Element): Promise<boolean> {
  let focuses = true;
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    focuses = el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  return focuses;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ITEMS: ReadonlyArray<CommandPaletteItem> = [
  { id: "flow", label: "@smthrs/flow", detail: "packages/flow", badge: "pkg" },
  { id: "flow-make", label: "Flow.make", detail: "@smthrs/flow" },
  { id: "flow-run", label: "Flow.run" },
];

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const input = () => dialog()!.querySelector<HTMLInputElement>('[role="combobox"]')!;
const listbox = () => dialog()!.querySelector<HTMLElement>('[role="listbox"]')!;
const options = () => [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')];
const selected = () => options().map((el) => el.getAttribute("aria-selected"));

type Call = ["query", string] | ["highlight", number] | ["choose", string] | ["close"];

/** The palette open over ITEMS with every callback recorded, over `overrides`. */
async function palette(overrides: Partial<CommandPaletteProps> = {}): Promise<Array<Call>> {
  const calls: Array<Call> = [];
  await render(
    <CommandPalette
      open
      query="flow"
      onQueryChange={(query) => calls.push(["query", query])}
      items={ITEMS}
      highlighted={1}
      onHighlight={(index) => calls.push(["highlight", index])}
      onChoose={(id) => calls.push(["choose", id])}
      onClose={() => calls.push(["close"])}
      {...overrides}
    />,
  );
  return calls;
}

/** A host that owns the query, the highlight and the open state, as an app does. */
function Host({ chosen }: { chosen: Array<string> }) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const items = ITEMS.filter((item) => item.id.includes(query));
  return (
    <CommandPalette
      open={open}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setHighlighted(0);
      }}
      items={items}
      highlighted={highlighted}
      onHighlight={setHighlighted}
      onChoose={(id) => {
        chosen.push(id);
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
    />
  );
}

describe("CommandPalette", () => {
  test("closed, it renders nothing", async () => {
    await palette({ open: false });
    expect(dialog()).toBeNull();
  });

  test("open, it is a named modal dialog with a combobox over a listbox, focused in the input", async () => {
    await palette({ placeholder: "Jump to an export" });
    expect(dialog()!.getAttribute("data-slot")).toBe("command-palette");
    expect(dialog()!.className).toBe("sui-command-palette");
    const title = document.getElementById(dialog()!.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Command palette");
    expect(dialog()!.hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelector(".sui-dialog-overlay")).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("flow");
    expect(input().placeholder).toBe("Jump to an export");
    expect(input().getAttribute("aria-label")).toBe("Command palette");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(input().getAttribute("aria-controls")).toBe(listbox().id);
    expect(listbox().getAttribute("aria-label")).toBe("Command palette");
    expect(selected()).toEqual(["false", "true", "false"]);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    expect(new Set(options().map((el) => el.id)).size).toBe(3);
  });

  test("each row shows its badge, label and detail; a footer and a name are the host's", async () => {
    await palette({
      "aria-label": "Search exports",
      className: "host",
      footer: (
        <span>
          <Kbd>↵</Kbd> open
        </span>
      ),
    });
    const parts = (row: HTMLElement) =>
      [...row.children].map((el) => [el.className.replace("sui-command-palette-", ""), el.textContent]);
    expect(parts(options()[0]!)).toEqual([
      ["badge", "pkg"],
      ["label", "@smthrs/flow"],
      ["detail", "packages/flow"],
    ]);
    expect(parts(options()[2]!)).toEqual([["label", "Flow.run"]]);
    expect(dialog()!.querySelector(".sui-command-palette-footer")!.textContent).toBe("↵ open");
    expect(dialog()!.className).toBe("sui-command-palette host");
    expect(input().getAttribute("aria-label")).toBe("Search exports");
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)!.textContent).toBe("Search exports");
  });

  test("typing calls onQueryChange with the new query", async () => {
    const calls = await palette();
    await type(input(), "flow.m");
    expect(calls).toEqual([["query", "flow.m"]]);
  });

  test("ArrowDown and ArrowUp call onHighlight with the next index, and keep the caret still", async () => {
    const calls = await palette();
    expect(await key(input(), "ArrowDown")).toBe(false);
    expect(await key(input(), "ArrowUp")).toBe(false);
    expect(calls).toEqual([
      ["highlight", 2],
      ["highlight", 0],
    ]);
  });

  test("the arrows clamp at each edge and from out of range", async () => {
    const seen: Array<number> = [];
    for (const [highlighted, arrow] of [
      [2, "ArrowDown"],
      [0, "ArrowUp"],
      [7, "ArrowUp"],
      [7, "ArrowDown"],
      [-1, "ArrowDown"],
      [-1, "ArrowUp"],
    ] as const) {
      await palette({ highlighted, onHighlight: (index) => seen.push(index) });
      await key(input(), arrow);
    }
    expect(seen).toEqual([2, 0, 2, 2, 0, 0]);
  });

  test("with no items the arrows call nothing and the list is not expanded", async () => {
    const calls = await palette({ items: [], highlighted: 0 });
    expect(await key(input(), "ArrowDown")).toBe(false);
    expect(await key(input(), "Enter")).toBe(true);
    expect(calls).toEqual([]);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("Enter chooses the highlighted item; out of range it chooses nothing", async () => {
    const calls = await palette();
    expect(await key(input(), "Enter")).toBe(false);
    expect(calls).toEqual([["choose", "flow-make"]]);
    const none = await palette({ highlighted: 3 });
    expect(selected()).toEqual(["false", "false", "false"]);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(await key(input(), "Enter")).toBe(true);
    expect(none).toEqual([]);
  });

  test("Enter while an input method is composing chooses nothing", async () => {
    const calls = await palette();
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
      );
    });
    expect(calls).toEqual([]);
  });

  test("a click on a row chooses it and leaves focus in the input", async () => {
    const calls = await palette();
    expect(await click(options()[2]!)).toBe(false);
    expect(calls).toEqual([["choose", "flow-run"]]);
    expect(document.activeElement).toBe(input());
  });

  test("Escape and a click on the backdrop call onClose", async () => {
    const calls = await palette();
    await key(input(), "Escape");
    expect(calls).toEqual([["close"]]);
    const backdrop = await palette();
    await click(document.querySelector(".sui-dialog-overlay")!);
    expect(backdrop).toEqual([["close"]]);
  });

  test("in a host that owns the state, the keys move the highlight and Enter chooses and closes", async () => {
    const chosen: Array<string> = [];
    await render(<Host chosen={chosen} />);
    expect(selected()).toEqual(["true", "false", "false"]);
    await key(input(), "ArrowDown");
    await key(input(), "ArrowDown");
    await key(input(), "ArrowDown");
    expect(selected()).toEqual(["false", "false", "true"]);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
    await type(input(), "flow-");
    expect(options().map((el) => el.textContent)).toEqual(["Flow.make@smthrs/flow", "Flow.run"]);
    expect(selected()).toEqual(["true", "false"]);
    await key(input(), "ArrowDown");
    await key(input(), "Enter");
    expect(chosen).toEqual(["flow-run"]);
    expect(dialog()).toBeNull();
  });

  test("the sheet places a 640px panel 12vh down with a 46px bottom-ruled input and a brand-tinted highlight", async () => {
    await palette();
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toBe(smithersUiCss);
    expect(smithersUiCss).toContain(commandPaletteCss.trim());
    const rule = (selector: string) => commandPaletteCss.match(new RegExp(`${selector} \\{[^}]+\\}`))![0];
    const panel = rule("\\.sui-command-palette");
    for (const decl of [
      "top:12vh",
      "max-width:640px",
      "border-radius:var(--r-3, 12px)",
      "background:var(--surface,",
      "box-shadow:var(--shadow-3,",
    ]) {
      expect(panel).toContain(decl);
    }
    const field = rule("\\.sui-command-palette-input");
    expect(field).toContain("height:46px");
    expect(field).toContain("border:0");
    expect(field).toContain("border-bottom:1px solid var(--border,");
    expect(rule("\\.sui-command-palette-option\\[aria-selected='true'\\]")).toContain("background:var(--brand-soft,");
  });
});

for (const arrow of ["ArrowDown", "ArrowUp"]) {
  test(`${arrow} during IME composition leaves candidate selection to the input method`, async () => {
    const calls = await palette();
    const event = new KeyboardEvent("keydown", { key: arrow, bubbles: true, cancelable: true, isComposing: true });
    await act(async () => { input().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
}


for (const ime of [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, keyCode: 229 }]) {
  for (const name of ["Enter", "ArrowDown", "ArrowUp"]) {
    test(`palette leaves ${name} to IME confirmation: ${JSON.stringify(ime)}`, async () => {
      const calls = await palette();
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...ime });
      await act(async () => { input().dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
      expect(calls).toEqual([]);
      expect(input().value).toBe("flow");
      expect(await key(input(), "Enter")).toBe(false);
      expect(calls).toEqual([["choose", "flow-make"]]);
    });
  }
}
