/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "../src/agentic/Queue";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function QueueFixture(props: { onOpenChange?: (open: boolean) => void; open?: boolean }) {
  return (
    <Queue>
      <QueueSection open={props.open} onOpenChange={props.onOpenChange}>
        <QueueSectionTrigger>
          <QueueSectionLabel label="Pending reviews" count={2} icon={<svg data-testid="section-icon" />} />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            <QueueItem completed>
              <QueueItemIndicator />
              <QueueItemContent>Write tests</QueueItemContent>
              <QueueItemDescription>Cover the new queue family</QueueItemDescription>
            </QueueItem>
            <QueueItem status="running">
              <QueueItemIndicator />
              <QueueItemContent>Ship release</QueueItemContent>
            </QueueItem>
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}

describe("Queue", () => {
  test("renders a labeled region with an open-by-default section", async () => {
    await render(<QueueFixture />);
    const queue = container!.querySelector('[data-slot="queue"]')!;
    expect(queue.getAttribute("role")).toBe("region");
    expect(queue.getAttribute("aria-label")).toBe("Queue");

    const trigger = container!.querySelector('[data-slot="queue-section-trigger"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const label = container!.querySelector('[data-slot="queue-section-label"]')!;
    expect(label.textContent).toContain("Pending reviews");
    expect(label.querySelector(".sui-queue-section-count")?.textContent).toBe("2");
    expect(label.querySelector(".sui-queue-section-icon svg")).not.toBeNull();

    const content = container!.querySelector('[data-slot="queue-section-content"]')!;
    expect(content.getAttribute("role")).toBe("region");
    expect(content.getAttribute("id")).toBe(trigger.getAttribute("aria-controls"));
    expect(content.getAttribute("aria-labelledby")).toBe(trigger.getAttribute("id"));
    expect(container!.querySelector('[data-slot="queue-list"]')?.getAttribute("role")).toBe("list");
    expect(container!.querySelectorAll('[data-slot="queue-item"]').length).toBe(2);
  });

  test("section trigger toggles the body and reports onOpenChange", async () => {
    const changes: boolean[] = [];
    await render(<QueueFixture onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector('[data-slot="queue-section-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(changes).toEqual([false]);
    expect(container!.querySelector('[data-slot="queue-section-content"]')).toBeNull();
    expect(container!.querySelector('[data-slot="queue-section"]')?.getAttribute("data-state")).toBe("closed");
  });

  test("controlled open never self-manages", async () => {
    const changes: boolean[] = [];
    await render(<QueueFixture open onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector('[data-slot="queue-section-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(changes).toEqual([false]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="queue-section-content"]')).not.toBeNull();
  });

  test("completed:true alone maps to the completed status with strikethrough content", async () => {
    await render(<QueueFixture />);
    const items = container!.querySelectorAll('[data-slot="queue-item"]');
    const done = items[0]!;
    expect(done.getAttribute("data-status")).toBe("completed");
    expect(done.getAttribute("data-status-class")).toBe("ok");
    expect(done.getAttribute("data-completed")).toBe("true");
    expect(done.querySelector('[data-slot="queue-item-content"]')?.getAttribute("data-completed")).toBe("true");
    const indicator = done.querySelector('[data-slot="queue-item-indicator"]')!;
    expect(indicator.textContent).toContain("✓");
    expect(indicator.querySelector(".sui-sr-only")?.textContent).toBe("Complete: ");
    expect(done.querySelector('[data-slot="queue-item-description"]')?.textContent).toBe("Cover the new queue family");
  });

  test("status wins over completed when both are given", async () => {
    await render(
      <QueueList>
        <QueueItem completed status="failed">
          <QueueItemIndicator />
          <QueueItemContent>Attempted</QueueItemContent>
        </QueueItem>
      </QueueList>,
    );
    const item = container!.querySelector('[data-slot="queue-item"]')!;
    expect(item.getAttribute("data-status")).toBe("failed");
    expect(item.getAttribute("data-status-class")).toBe("bad");
    expect(item.getAttribute("data-completed")).toBe("false");
    expect(item.querySelector('[data-slot="queue-item-content"]')?.getAttribute("data-completed")).toBe("false");
    const indicator = item.querySelector('[data-slot="queue-item-indicator"]')!;
    expect(indicator.textContent).not.toContain("✓");
    expect(indicator.querySelector(".sui-sr-only")?.textContent).toBe("Failed: ");
  });

  test("indicator props override the surrounding item context", async () => {
    await render(
      <QueueList>
        <QueueItem status="running">
          <QueueItemIndicator status="completed" />
          <QueueItemContent>Mixed</QueueItemContent>
        </QueueItem>
      </QueueList>,
    );
    const indicator = container!.querySelector('[data-slot="queue-item-indicator"]')!;
    expect(indicator.textContent).toContain("✓");
    expect(container!.querySelector('[data-slot="queue-item"]')?.getAttribute("data-status")).toBe("running");
  });

  test("renders under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<QueueFixture />);
    expect(container!.querySelector('[data-slot="queue"]')).not.toBeNull();
    expect(container!.querySelectorAll('[data-slot="queue-item"]').length).toBe(2);
  });
});
