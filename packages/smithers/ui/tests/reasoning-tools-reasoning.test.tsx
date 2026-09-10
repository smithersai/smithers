/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Reasoning, ReasoningContent, ReasoningSummary, ReasoningTrigger } from "../src/agentic/Reasoning";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("Reasoning composed anatomy", () => {
  test("composed mode renders children verbatim and the trigger drives the content region", async () => {
    await render(
      <Reasoning composed>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Provider summary text</ReasoningContent>
      </Reasoning>,
    );
    const rootEl = container!.querySelector('[data-slot="reasoning"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="reasoning-trigger"]')!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.type).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(rootEl.getAttribute("data-state")).toBe("closed");
    expect(container!.querySelector('[data-slot="reasoning-content"]')).toBeNull();
    expect(trigger.textContent).toContain("Thinking");

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = container!.querySelector('[data-slot="reasoning-content"]')!;
    expect(content.getAttribute("role")).toBe("region");
    expect(content.textContent).toContain("Provider summary text");
    expect(content.id).toBe(trigger.getAttribute("aria-controls"));
  });

  test("composed mode honors controlled open", () => {
    const html = renderToStaticMarkup(
      <Reasoning composed open>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Visible</ReasoningContent>
      </Reasoning>,
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Visible");
    expect(html).toContain('role="region"');
  });

  test("legacy mode DOM is unchanged without composed", () => {
    const html = renderToStaticMarkup(<Reasoning duration={8}>Thinking</Reasoning>);
    expect(html).toContain('data-slot="reasoning-trigger"');
    expect(html).toContain("Thought for 8s");
    expect(html).not.toContain('data-slot="reasoning-content"');
  });
});

describe("Reasoning streaming announcements", () => {
  test("a labelled polite live region announces streaming transitions", async () => {
    function Harness({ streaming }: { streaming: boolean }) {
      return <Reasoning streaming={streaming}>Summary text</Reasoning>;
    }
    await render(<Harness streaming={false} />);
    const live = () => container!.querySelector('[data-slot="reasoning-live"]')!;
    expect(live().getAttribute("role")).toBe("status");
    expect(live().getAttribute("aria-live")).toBe("polite");
    expect(live().getAttribute("aria-label")).toBe("Reasoning status");
    expect(live().className).toContain("sui-sr-only");
    expect(live().textContent).toBe("");

    await act(async () => root!.render(<Harness streaming={true} />));
    expect(live().textContent).toBe("Reasoning in progress");

    await act(async () => root!.render(<Harness streaming={false} />));
    expect(live().textContent).toBe("Reasoning complete");
  });

  test("composed mode renders the same live region", () => {
    const html = renderToStaticMarkup(
      <Reasoning composed title="Thinking">
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Visible</ReasoningContent>
      </Reasoning>,
    );
    expect(html).toContain('data-slot="reasoning-live"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Thinking status"');
  });
});

describe("ReasoningSummary", () => {
  test("renders the default Thinking label over provider-disclosed summary text", () => {
    const html = renderToStaticMarkup(<ReasoningSummary text="Searched the docs, then answered" />);
    expect(html).toContain('data-slot="reasoning-summary"');
    expect(html).toContain("Thinking");
    expect(html).toContain("Searched the docs, then answered");
    expect(html).toContain('data-streaming="false"');
  });

  test("supports a custom label and shimmer while streaming", () => {
    const html = renderToStaticMarkup(<ReasoningSummary text="Working through it" streaming label="Reasoning" />);
    expect(html).toContain("Reasoning");
    expect(html).toContain('data-streaming="true"');
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(<ReasoningSummary text="Dark summary" />);
    expect(html).toContain("sui-reasoning-summary");
  });
});
