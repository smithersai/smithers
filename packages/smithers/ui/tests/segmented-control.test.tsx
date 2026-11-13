/** @jsxImportSource react */
// SegmentedControl under happy-dom: real createRoot + act, native click and key events, and a host that owns `value`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SegmentedControl,
  type SegmentedControlOption,
  type SegmentedControlProps,
  segmentedControlCss,
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

async function click(el: Element): Promise<void> {
  await act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
}

/** Presses `name` on `el`, returning whether the default action still runs. */
async function key(el: Element, name: string): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  return followed;
}

const OPTIONS: ReadonlyArray<SegmentedControlOption> = [
  { value: "json", label: "JSON", title: "Raw JSON" },
  { value: "table", label: "Table" },
  { value: "tree", label: "Tree", disabled: true },
  { value: "graph", label: "Graph" },
];

const group = () => container!.querySelector<HTMLElement>('[role="radiogroup"]')!;
const radios = () => [...container!.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const radio = (label: string) => radios().find((el) => el.textContent === label)!;
const checked = () => radios().map((el) => el.getAttribute("aria-checked"));
const tabStops = () => radios().map((el) => el.tabIndex);

/** The control at `value`, recording every onValueChange call without changing `value`. */
async function control(value: string, overrides: Partial<SegmentedControlProps> = {}): Promise<Array<string>> {
  const calls: Array<string> = [];
  await render(
    <SegmentedControl
      aria-label="View"
      value={value}
      options={OPTIONS}
      onValueChange={(next) => calls.push(next)}
      {...overrides}
    />,
  );
  return calls;
}

/** A host that owns the value, as an app does. */
function Host({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <SegmentedControl aria-label="View" value={value} options={OPTIONS} onValueChange={setValue} />;
}

describe("SegmentedControl", () => {
  test("is a named radiogroup whose checked radio alone is in the tab order", async () => {
    await control("table");
    expect(group().getAttribute("aria-label")).toBe("View");
    expect(group().getAttribute("data-slot")).toBe("segmented-control");
    expect(radios().map((el) => el.textContent)).toEqual(["JSON", "Table", "Tree", "Graph"]);
    expect(checked()).toEqual(["false", "true", "false", "false"]);
    expect(tabStops()).toEqual([-1, 0, -1, -1]);
    expect(radios().every((el) => el.type === "button")).toBe(true);
    expect(radio("JSON").title).toBe("Raw JSON");
    expect(radio("Tree").disabled).toBe(true);
  });

  test("a value no enabled option has leaves the first enabled radio in the tab order", async () => {
    await control("missing", {
      options: [{ value: "a", label: "A", disabled: true }, ...OPTIONS],
    });
    expect(checked()).toEqual(["false", "false", "false", "false", "false"]);
    expect(tabStops()).toEqual([-1, 0, -1, -1, -1]);
  });

  test("a click checks another option; the checked and disabled ones call nothing", async () => {
    const calls = await control("table");
    await click(radio("Graph"));
    await click(radio("Table"));
    await click(radio("Tree"));
    expect(calls).toEqual(["graph"]);
  });

  test("arrow keys check and focus the next enabled option, skipping disabled and wrapping", async () => {
    const calls = await control("table");
    act(() => radio("Table").focus());
    expect(await key(radio("Table"), "ArrowRight")).toBe(false);
    expect(document.activeElement).toBe(radio("Graph"));
    await key(radio("Graph"), "ArrowRight");
    expect(document.activeElement).toBe(radio("JSON"));
    await key(radio("JSON"), "ArrowLeft");
    await key(radio("Graph"), "ArrowUp");
    await key(radio("Table"), "ArrowDown");
    expect(calls).toEqual(["graph", "json", "graph", "table", "graph"]);
  });

  test("other keys and a lone enabled option change nothing", async () => {
    const calls = await control("a", {
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", disabled: true },
      ],
    });
    expect(await key(radio("A"), "Enter")).toBe(true);
    expect(await key(radio("A"), "Home")).toBe(true);
    expect(await key(radio("A"), "ArrowRight")).toBe(false);
    expect(calls).toEqual([]);
  });

  test("in a host that owns the value, the keys move the check and the tab stop", async () => {
    await render(<Host initial="json" />);
    act(() => radio("JSON").focus());
    await key(radio("JSON"), "ArrowRight");
    expect(checked()).toEqual(["false", "true", "false", "false"]);
    expect(tabStops()).toEqual([-1, 0, -1, -1]);
    expect(document.activeElement).toBe(radio("Table"));
    await key(radio("Table"), "ArrowRight");
    expect(checked()).toEqual(["false", "false", "false", "true"]);
    await click(radio("JSON"));
    expect(checked()).toEqual(["true", "false", "false", "false"]);
  });

  test("takes the host's props and marks size sm", async () => {
    await control("json", { size: "sm", className: "host", id: "view" });
    expect(group().className).toBe("sui-segmented host");
    expect(group().id).toBe("view");
    expect(group().getAttribute("data-size")).toBe("sm");
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toBe(smithersUiCss);
  });

  test("ships the component's rules in the composed sheet", () => {
    expect(smithersUiCss).toContain(segmentedControlCss.trim());
  });
});
