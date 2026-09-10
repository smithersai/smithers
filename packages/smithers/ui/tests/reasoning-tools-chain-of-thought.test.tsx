/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainOfThought, ChainOfThoughtStep } from "../src/agentic/ChainOfThought";
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

describe("ChainOfThought compound mode", () => {
  test("renders composed steps inside the collapsible body", () => {
    const html = renderToStaticMarkup(
      <ChainOfThought defaultOpen title="Plan">
        <ChainOfThoughtStep label="Inspect the repo" status="done" />
        <ChainOfThoughtStep label="Run tests" status="active" />
      </ChainOfThought>,
    );
    expect(html).toContain('data-slot="chain-of-thought"');
    expect(html).toContain("Plan");
    expect(html.match(/data-slot="chain-of-thought-step"/g)?.length).toBe(2);
    expect(html).toContain("Inspect the repo");
    expect(html).toContain("Run tests");
    expect(html).toContain("Complete: ");
    expect(html).toContain("Running: ");
  });

  test("step detail is collapsible with the controlled triple and defaults closed", async () => {
    const changes: boolean[] = [];
    await render(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtStep
          label="Edit files"
          status="done"
          icon={<span data-icon="wrench" />}
          onOpenChange={(open) => changes.push(open)}
        >
          Edited 3 files
        </ChainOfThoughtStep>
      </ChainOfThought>,
    );
    const step = container!.querySelector('[data-slot="chain-of-thought-step"]')!;
    const trigger = step.querySelector<HTMLButtonElement>(".sui-cot-step-trigger")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(step.textContent).not.toContain("Edited 3 files");
    expect(step.querySelector("[data-icon='wrench']")).not.toBeNull();

    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const detail = step.querySelector(".sui-cot-step-detail")!;
    expect(detail.getAttribute("role")).toBe("region");
    expect(detail.id).toBe(trigger.getAttribute("aria-controls"));
    expect(trigger.id).toBeTruthy();
    expect(detail.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(detail.textContent).toContain("Edited 3 files");
  });

  test("controlled step disclosure never self-toggles", async () => {
    await render(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtStep label="Verify" open={false}>
          Hidden detail
        </ChainOfThoughtStep>
      </ChainOfThought>,
    );
    const step = container!.querySelector('[data-slot="chain-of-thought-step"]')!;
    const trigger = step.querySelector<HTMLButtonElement>(".sui-cot-step-trigger")!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(step.textContent).not.toContain("Hidden detail");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtStep label="Dark step" status="pending" />
      </ChainOfThought>,
    );
    expect(html).toContain('data-slot="chain-of-thought-step"');
    expect(html).toContain("Pending: ");
  });

  test("legacy steps-array mode is unchanged", () => {
    const html = renderToStaticMarkup(
      <ChainOfThought steps={[{ id: "a", label: "Legacy", status: "done" }]} defaultOpen />,
    );
    expect(html).toContain("Legacy");
    expect(html).toContain('data-slot="chain-of-thought-step"');
  });
});

describe("ChainOfThought streaming announcements", () => {
  test("a labelled polite live region announces streaming transitions", async () => {
    function Harness({ streaming }: { streaming: boolean }) {
      return (
        <ChainOfThought streaming={streaming} title="Chain of thought">
          <ChainOfThoughtStep label="Step" status="active" />
        </ChainOfThought>
      );
    }
    await render(<Harness streaming={false} />);
    const live = () => container!.querySelector('[data-slot="chain-of-thought-live"]')!;
    expect(live().getAttribute("role")).toBe("status");
    expect(live().getAttribute("aria-live")).toBe("polite");
    expect(live().getAttribute("aria-label")).toBe("Chain of thought status");
    expect(live().className).toContain("sui-sr-only");
    expect(live().textContent).toBe("");

    await act(async () => root!.render(<Harness streaming={true} />));
    expect(live().textContent).toBe("Chain of thought in progress");

    await act(async () => root!.render(<Harness streaming={false} />));
    expect(live().textContent).toBe("Chain of thought complete");
  });
});
