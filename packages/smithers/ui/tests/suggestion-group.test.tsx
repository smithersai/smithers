/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Suggestion, SuggestionGroup } from "../src/agentic/Suggestion";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

/**
 * The scroll behavior of the suggestion rail, which nothing drove: the wheel
 * translation, the arrow-key step, and the reduced-motion branch of
 * `scrollByPx` were all unexercised, so the rail's only tested behavior was
 * that it renders.
 *
 * happy-dom has no layout, so `scrollBy` is stubbed to record the argument the
 * component asks for. That is the seam under test: WHICH scroll API the
 * component calls, and with what, is the decision reduced-motion changes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;
let originalMatchMedia: typeof window.matchMedia | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia;
    originalMatchMedia = undefined;
  }
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

function setReducedMotion(reduce: boolean): void {
  originalMatchMedia ??= window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

type ScrollCalls = { by: ScrollToOptions[]; };

function instrument(rail: HTMLElement): ScrollCalls {
  const calls: ScrollCalls = { by: [] };
  rail.scrollBy = ((options: ScrollToOptions) => {
    calls.by.push(options);
  }) as HTMLElement["scrollBy"];
  rail.scrollLeft = 0;
  return calls;
}

async function renderRail(): Promise<{ rail: HTMLElement; calls: ScrollCalls; }> {
  await render(
    <SuggestionGroup>
      <Suggestion suggestion="one" />
      <Suggestion suggestion="two" />
    </SuggestionGroup>,
  );
  const rail = container!.querySelector<HTMLElement>('[data-slot="suggestion-group"]')!;
  return { rail, calls: instrument(rail) };
}

async function wheel(rail: HTMLElement, deltaX: number, deltaY: number): Promise<void> {
  const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
  await act(async () => {
    rail.dispatchEvent(event);
  });
}

async function arrow(rail: HTMLElement, key: string): Promise<void> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    rail.dispatchEvent(event);
  });
}

describe("SuggestionGroup scrolling", () => {
  test("a vertical wheel gesture scrolls the rail horizontally", async () => {
    const { rail } = await renderRail();
    await wheel(rail, 0, 120);
    expect(rail.scrollLeft).toBe(120);
  });

  test("a wheel gesture that is already horizontal is left to the browser", async () => {
    const { rail } = await renderRail();
    await wheel(rail, 200, 30);
    expect(rail.scrollLeft).toBe(0);
  });

  test("a host onWheel still runs after the translation", async () => {
    const seen: number[] = [];
    await render(
      <SuggestionGroup onWheel={(event) => seen.push(event.deltaY)}>
        <Suggestion suggestion="one" />
      </SuggestionGroup>,
    );
    const rail = container!.querySelector<HTMLElement>('[data-slot="suggestion-group"]')!;
    instrument(rail);
    await wheel(rail, 0, 45);
    expect(rail.scrollLeft).toBe(45);
    expect(seen).toEqual([45]);
  });

  test("ArrowRight and ArrowLeft step the rail by one screenful of chips", async () => {
    setReducedMotion(false);
    const { rail, calls } = await renderRail();
    await arrow(rail, "ArrowRight");
    await arrow(rail, "ArrowLeft");
    expect(calls.by).toEqual([
      { left: 160, behavior: "smooth" },
      { left: -160, behavior: "smooth" },
    ]);
    expect(rail.scrollLeft).toBe(0);
  });

  test("an unrelated key does not scroll", async () => {
    setReducedMotion(false);
    const { rail, calls } = await renderRail();
    await arrow(rail, "ArrowDown");
    expect(calls.by).toEqual([]);
  });

  test("reduced motion sets scrollLeft directly instead of asking for a smooth scroll", async () => {
    setReducedMotion(true);
    const { rail, calls } = await renderRail();
    await arrow(rail, "ArrowRight");
    expect(calls.by).toEqual([]);
    expect(rail.scrollLeft).toBe(160);
  });

  test("a host onKeyDown still runs after the arrow handling", async () => {
    setReducedMotion(true);
    const seen: string[] = [];
    await render(
      <SuggestionGroup onKeyDown={(event) => seen.push(event.key)}>
        <Suggestion suggestion="one" />
      </SuggestionGroup>,
    );
    const rail = container!.querySelector<HTMLElement>('[data-slot="suggestion-group"]')!;
    instrument(rail);
    await arrow(rail, "ArrowRight");
    expect(rail.scrollLeft).toBe(160);
    expect(seen).toEqual(["ArrowRight"]);
  });
});
