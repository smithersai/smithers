/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Reasoning, SMITHERS_UI_STYLE_ATTR } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root!.render(element));
}

describe("Reasoning", () => {
  test("renders disclosure anatomy and duration formats", () => {
    const short = renderToStaticMarkup(<Reasoning duration={8}>Thinking</Reasoning>);
    expect(short).toContain('data-slot="reasoning"');
    expect(short).toContain('data-state="closed"');
    expect(short).toContain("Thought for 8s");
    expect(short).not.toContain("Thinking");

    const long = renderToStaticMarkup(<Reasoning duration={72}>Thinking</Reasoning>);
    expect(long).toContain("Thought for 1m 12s");
  });

  test("starts open while streaming and auto-collapses when streaming ends", async () => {
    const changes: boolean[] = [];
    await render(
      <Reasoning streaming onOpenChange={(open) => changes.push(open)}>
        Thinking
      </Reasoning>,
    );
    expect(container!.querySelector('[data-slot="reasoning"]')!.getAttribute("data-state")).toBe("open");
    expect(container!.querySelector('[data-slot="reasoning-body"]')).not.toBeNull();
    expect(changes).toEqual([]);

    await render(
      <Reasoning streaming={false} onOpenChange={(open) => changes.push(open)}>
        Thinking
      </Reasoning>,
    );
    expect(container!.querySelector('[data-slot="reasoning"]')!.getAttribute("data-state")).toBe("closed");
    expect(container!.querySelector('[data-slot="reasoning-body"]')).toBeNull();
    expect(changes).toEqual([false]);
  });

  test("stops reacting to streaming after a user toggle", async () => {
    const changes: boolean[] = [];
    const onOpenChange = (open: boolean) => changes.push(open);
    await render(
      <Reasoning streaming onOpenChange={onOpenChange}>
        Thinking
      </Reasoning>,
    );
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="reasoning-trigger"]')!;
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(container!.querySelector('[data-slot="reasoning-body"]')).not.toBeNull();

    await render(
      <Reasoning streaming={false} onOpenChange={onOpenChange}>
        Thinking
      </Reasoning>,
    );
    expect(container!.querySelector('[data-slot="reasoning-body"]')).not.toBeNull();
    expect(changes).toEqual([false, true]);
  });

  test("controlled disclosure never self-toggles", async () => {
    const changes: boolean[] = [];
    const onOpenChange = (open: boolean) => changes.push(open);
    await render(
      <Reasoning open streaming onOpenChange={onOpenChange}>
        Thinking
      </Reasoning>,
    );
    await render(
      <Reasoning open streaming={false} onOpenChange={onOpenChange}>
        Thinking
      </Reasoning>,
    );
    expect(container!.querySelector('[data-slot="reasoning"]')!.getAttribute("data-state")).toBe("open");
    expect(changes).toEqual([]);

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-slot="reasoning-trigger"]')!.click();
    });
    expect(changes).toEqual([false]);
    expect(container!.querySelector('[data-slot="reasoning"]')!.getAttribute("data-state")).toBe("open");
  });
});
