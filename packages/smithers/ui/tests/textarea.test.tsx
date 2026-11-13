/** @jsxImportSource react */
// Textarea under happy-dom: real createRoot + act. `code` sets source text; without it, a prose field is untouched.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { smithersUiCss, Textarea } from "../src";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

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

const render = async (element: Parameters<Root["render"]>[0]) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
  return container.querySelector("textarea")!;
};

describe("Textarea", () => {
  test("ships the code selector in the component sheet", () => {
    expect(smithersUiCss).toContain(".sui-textarea[data-code]");
  });

  test("code: disables wrapping, spelling, capitalization and correction", async () => {
    const area = await render(<Textarea code aria-label="Code" defaultValue="export default 1" />);
    expect(area.hasAttribute("data-code")).toBe(true);
    expect(area.getAttribute("spellcheck")).toBe("false");
    expect(area.getAttribute("autocapitalize")).toBe("off");
    expect(area.getAttribute("autocorrect")).toBe("off");
    expect(area.getAttribute("wrap")).toBe("off");
  });

  test("a caller's own props win over code's defaults", async () => {
    const area = await render(<Textarea code wrap="soft" aria-label="Code" />);
    expect(area.getAttribute("wrap")).toBe("soft");
  });

  test("prose: none of code's attributes", async () => {
    const area = await render(<Textarea aria-label="What it should do" />);
    expect(area.getAttribute("data-slot")).toBe("textarea");
    for (const name of ["data-code", "spellcheck", "autocapitalize", "autocorrect", "wrap"]) {
      expect(area.hasAttribute(name)).toBe(false);
    }
  });
});
