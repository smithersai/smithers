/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainOfThought, chainOfThoughtStepStatus, SMITHERS_UI_STYLE_ATTR } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const steps = [
  { id: "queued", label: "Inspect", status: "pending" as const },
  { id: "work", label: "Implement", status: "active" as const, detail: "Editing files" },
  { id: "done", label: "Verify", status: "done" as const },
];

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root!.render(element));
}

describe("ChainOfThought", () => {
  test("maps step states through the shared vocabulary", () => {
    expect(chainOfThoughtStepStatus(undefined)).toBe("pending");
    expect(chainOfThoughtStepStatus("pending")).toBe("pending");
    expect(chainOfThoughtStepStatus("active")).toBe("running");
    expect(chainOfThoughtStepStatus("done")).toBe("complete");
  });

  test("renders ordered steps with accessible status text", () => {
    const html = renderToStaticMarkup(<ChainOfThought steps={steps} defaultOpen />);
    expect(html).toContain("<ol");
    expect(html).toContain("Pending: ");
    expect(html).toContain("Running: ");
    expect(html).toContain("Complete: ");
    expect(html).toContain("Editing files");
    expect(html.match(/sui-cot-step-dot/g)?.length).toBe(3);
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
  });


  test("follows streaming until the user toggles", async () => {
    const changes: boolean[] = [];
    const onOpenChange = (open: boolean) => changes.push(open);
    await render(<ChainOfThought steps={steps} streaming onOpenChange={onOpenChange} />);
    expect(container!.querySelector('[data-slot="chain-of-thought-body"]')).not.toBeNull();

    await render(<ChainOfThought steps={steps} streaming={false} onOpenChange={onOpenChange} />);
    expect(container!.querySelector('[data-slot="chain-of-thought-body"]')).toBeNull();
    expect(changes).toEqual([false]);

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-slot="chain-of-thought-trigger"]')!.click();
    });
    await render(<ChainOfThought steps={steps} streaming onOpenChange={onOpenChange} />);
    expect(container!.querySelector('[data-slot="chain-of-thought-body"]')).not.toBeNull();
    expect(changes).toEqual([false, true]);
  });
});
