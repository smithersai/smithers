/** @jsxImportSource react */
// GeneratedChip under happy-dom: real createRoot + act, the Popover's portal in document.body. A plain chip for a file
// marked only by its header; a chip that opens its flow, last run and sources, real links a plain click hands the host.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GeneratedChip, SMITHERS_UI_STYLE_ATTR } from "../src/index";
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

async function click(el: Element, init: MouseEventInit = {}): Promise<boolean> {
  let followed = true;
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ...init }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
    followed = el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
  return followed;
}

const rows = () =>
  [...document.querySelectorAll('[aria-label="Generated"] li')].map((li) => [
    li.querySelector(".sui-generated-label")!.textContent,
    li.querySelector("code")!.textContent,
    li.querySelector("a")?.getAttribute("href") ?? null,
  ]);

describe("GeneratedChip", () => {
  test("a file marked only by its header: a plain chip, nothing to open", async () => {
    await render(<GeneratedChip />);
    const chip = container!.querySelector('[data-slot="generated-chip"]')!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toBe("Generated");
  });

  test("pressed, it names the flow, its last run and its sources; a plain click navigates in place", async () => {
    const went: Array<string> = [];
    await render(
      <GeneratedChip
        flow={{ label: "docs/build", href: "/o/r/blob/main/.smithers/flows/docs/build/flow.ts" }}
        run={{ label: "r-1", href: "/app/runs/r-1" }}
        sources={[{ label: "src/api.ts", href: "/o/r/blob/main/src/api.ts" }, { label: "src/gone.ts" }]}
        onNavigate={(href) => went.push(href)}
      />,
    );
    const chip = container!.querySelector<HTMLButtonElement>('button[data-slot="generated-chip"]')!;
    expect(chip.textContent).toBe("Generated");
    await click(chip);
    expect(rows()).toEqual([
      ["Flow", "docs/build", "/o/r/blob/main/.smithers/flows/docs/build/flow.ts"],
      ["Last run", "r-1", "/app/runs/r-1"],
      ["Source", "src/api.ts", "/o/r/blob/main/src/api.ts"],
      ["Source", "src/gone.ts", null],
    ]);
    const source = document.querySelector<HTMLAnchorElement>('a[href="/o/r/blob/main/src/api.ts"]')!;
    expect(await click(source)).toBe(false);
    expect(went).toEqual(["/o/r/blob/main/src/api.ts"]);
    // A modified click stays the browser's.
    expect(await click(source, { metaKey: true })).toBe(true);
    expect(went).toHaveLength(1);
  });

  test("a link whose scheme could run script shows as its plain label", async () => {
    await render(<GeneratedChip flow={{ label: "flow", href: "java\tscript:alert(1)" }} sources={[{ label: "src", href: "javascript:alert(1)" }, { label: "ok", href: "/ok" }]} />);
    await click(container!.querySelector('button[data-slot="generated-chip"]')!);
    expect([...document.querySelectorAll(".sui-generated-row")].map((row) => row.querySelector("a")?.getAttribute("href") ?? null)).toEqual([null, null, "/ok"]);
    expect(document.querySelector('[href*="script"]')).toBeNull();
  });

  test("without a host to navigate, its links are plain links", async () => {
    await render(<GeneratedChip flow={{ label: "x", href: "/x" }} />);
    await click(container!.querySelector('button[data-slot="generated-chip"]')!);
    expect(await click(document.querySelector('a[href="/x"]')!)).toBe(true);
  });
});
