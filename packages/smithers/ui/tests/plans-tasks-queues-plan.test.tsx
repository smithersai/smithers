/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanStep,
  PlanTitle,
  PlanTrigger,
} from "../src/agentic/Plan";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("Plan compound anatomy", () => {
  test("every compound part rejects orphan rendering", () => {
    const parts: ReadonlyArray<readonly [string, ReactElement]> = [
      ["PlanHeader", <PlanHeader />],
      ["PlanTitle", <PlanTitle />],
      ["PlanDescription", <PlanDescription />],
      ["PlanTrigger", <PlanTrigger />],
      ["PlanContent", <PlanContent />],
      ["PlanStep", <PlanStep label="Orphan" />],
      ["PlanAction", <PlanAction />],
      ["PlanFooter", <PlanFooter />],
    ];

    for (const [part, element] of parts) {
      expect(() => renderToStaticMarkup(element)).toThrow(`${part} must render inside <Plan>`);
    }
  });

  test("renders header, title, description, trigger, content, steps, action, and footer", async () => {
    await render(
      <Plan>
        <PlanHeader>
          <PlanTrigger>Toggle</PlanTrigger>
          <PlanTitle>Migration plan</PlanTitle>
          <PlanAction aria-label="Rerun plan">Rerun</PlanAction>
        </PlanHeader>
        <PlanDescription>Three steps</PlanDescription>
        <PlanContent>
          <ol>
            <PlanStep label="Inspect" status="done" />
            <PlanStep label="Implement" status="active">
              <span>Editing files</span>
            </PlanStep>
          </ol>
        </PlanContent>
        <PlanFooter>Updated just now</PlanFooter>
      </Plan>,
    );

    expect(container!.querySelector('[data-slot="plan"]')?.getAttribute("data-state")).toBe("open");
    expect(container!.querySelector('[data-slot="plan-title"]')?.textContent).toBe("Migration plan");
    expect(container!.querySelector('[data-slot="plan-description"]')?.textContent).toBe("Three steps");
    expect(container!.querySelector('[data-slot="plan-action"]')?.tagName).toBe("BUTTON");
    expect(container!.querySelector('[data-slot="plan-footer"]')?.textContent).toBe("Updated just now");
    const trigger = container!.querySelector('[data-slot="plan-trigger"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = container!.querySelector('[data-slot="plan-content"]')!;
    expect(content.getAttribute("role")).toBe("region");
    expect(content.getAttribute("id")).toBe(trigger.getAttribute("aria-controls"));
    expect(container!.querySelectorAll('[data-slot="plan-step"]').length).toBe(2);
    expect(container!.querySelector('[data-slot="plan-step"][data-status="complete"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="plan-step"][data-status="running"]')).not.toBeNull();
  });

  test("trigger collapses the compound body and reports onOpenChange", async () => {
    const changes: boolean[] = [];
    await render(
      <Plan onOpenChange={(open) => changes.push(open)}>
        <PlanHeader>
          <PlanTrigger>Toggle</PlanTrigger>
          <PlanTitle>Plan</PlanTitle>
        </PlanHeader>
        <PlanContent>
          <ol>
            <PlanStep label="Only" />
          </ol>
        </PlanContent>
      </Plan>,
    );
    const trigger = container!.querySelector('[data-slot="plan-trigger"]') as HTMLButtonElement;

    await act(async () => trigger.click());
    expect(changes).toEqual([false]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="plan-content"]')).toBeNull();
    expect(container!.querySelector('[data-slot="plan"]')?.getAttribute("data-state")).toBe("closed");
  });

  test("controlled open never self-manages", async () => {
    const changes: boolean[] = [];
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Plan
          open={open}
          onOpenChange={(next) => {
            changes.push(next);
            setOpen(next);
          }}
        >
          <PlanHeader>
            <PlanTrigger>Toggle</PlanTrigger>
          </PlanHeader>
          <PlanContent>Body</PlanContent>
        </Plan>
      );
    }
    await render(<Harness />);
    expect(container!.querySelector('[data-slot="plan-content"]')).toBeNull();
    const trigger = container!.querySelector('[data-slot="plan-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="plan-content"]')?.textContent).toBe("Body");
  });

  test("PlanStep detail disclosure uses the controlled triple and defaults closed", async () => {
    await render(
      <Plan>
        <PlanContent>
          <ol>
            <PlanStep label="Deploy" status="failed">
              <span>Rollback notes</span>
            </PlanStep>
          </ol>
        </PlanContent>
      </Plan>,
    );
    const step = container!.querySelector('[data-slot="plan-step"]')!;
    expect(step.getAttribute("data-status")).toBe("failed");
    expect(step.getAttribute("data-status-class")).toBe("bad");
    expect(step.getAttribute("data-state")).toBe("closed");
    expect(container!.querySelector('[data-slot="plan-step-detail"]')).toBeNull();

    const toggle = container!.querySelector('[data-slot="plan-step-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-label")).toBe("Details: Deploy");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="plan-step-detail"]')?.textContent).toBe("Rollback notes");
  });

  test("PlanStep without detail renders no toggle", async () => {
    await render(
      <Plan>
        <PlanContent>
          <ol>
            <PlanStep label="Plain" />
          </ol>
        </PlanContent>
      </Plan>,
    );
    expect(container!.querySelector('[data-slot="plan-step-toggle"]')).toBeNull();
    expect(container!.querySelector('[data-status="pending"]')).not.toBeNull();
  });

  test("renders the compound anatomy under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(
      <Plan streaming>
        <PlanHeader>
          <PlanTrigger>Toggle</PlanTrigger>
          <PlanTitle>Nightly</PlanTitle>
        </PlanHeader>
        <PlanContent>
          <ol>
            <PlanStep label="One" />
          </ol>
        </PlanContent>
      </Plan>,
    );
    expect(container!.querySelector('[data-slot="plan"]')?.getAttribute("data-streaming")).toBe("true");
    expect(container!.querySelector('[data-slot="plan-title"]')?.getAttribute("data-shimmer")).toBe("true");
  });
});
