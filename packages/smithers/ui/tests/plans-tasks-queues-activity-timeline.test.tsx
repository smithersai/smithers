/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  ActivityGroup,
  ActivityItem,
  ActivityTimeline,
  type ActivityItemModel,
  type ActivityKind,
} from "../src/agentic/ActivityTimeline";

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

const ALL_KINDS: readonly ActivityKind[] = [
  "message",
  "reasoning",
  "tool",
  "approval",
  "retry",
  "handoff",
  "delegation",
  "checkpoint",
  "signal",
  "output",
  "failure",
];

describe("ActivityTimeline", () => {
  test("items mode renders every activity kind", async () => {
    const items: readonly ActivityItemModel[] = ALL_KINDS.map((kind, index) => ({
      id: `a${index}`,
      kind,
      title: `${kind} happened`,
    }));
    await render(<ActivityTimeline items={items} />);

    const timeline = container!.querySelector('[data-slot="activity-timeline"]')!;
    expect(timeline.tagName).toBe("OL");
    expect(timeline.getAttribute("role")).toBe("list");
    for (const kind of ALL_KINDS) {
      const item = timeline.querySelector(`[data-kind="${kind}"]`);
      expect(item, `kind ${kind}`).not.toBeNull();
      expect(item!.querySelector(".sui-activity-marker")!.textContent!.length).toBeGreaterThan(0);
    }
    expect(timeline.querySelectorAll('[data-slot="activity-item"]').length).toBe(ALL_KINDS.length);
  });

  test("renders status, actor, timestamp, and detail", async () => {
    const timestampMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    await render(
      <ActivityTimeline
        items={[
          {
            id: "t1",
            kind: "tool",
            title: "Ran bash",
            status: "failed",
            actor: "builder",
            timestampMs,
            detail: <span>exit code 1</span>,
          },
        ]}
      />,
    );
    const item = container!.querySelector('[data-slot="activity-item"]')!;
    expect(item.getAttribute("data-status")).toBe("failed");
    expect(item.getAttribute("data-status-class")).toBe("bad");
    expect(item.querySelector(".sui-sr-only")?.textContent).toBe("Failed: ");
    expect(item.querySelector(".sui-activity-actor")?.textContent).toBe("builder");
    const time = item.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe("2026-01-02T03:04:05.000Z");
    expect(time.textContent).toBe("03:04:05");
    expect(item.querySelector(".sui-activity-detail")?.textContent).toBe("exit code 1");
  });

  test("children mode composes ActivityItem and ActivityGroup", async () => {
    await render(
      <ActivityTimeline>
        <ActivityGroup label="Setup">
          <ActivityItem kind="checkpoint" title="Snapshot taken" />
          <ActivityItem kind="signal" title="Resume signal" />
        </ActivityGroup>
        <ActivityItem kind="output" title="Report written">
          <span>report.html</span>
        </ActivityItem>
      </ActivityTimeline>,
    );

    const group = container!.querySelector('[data-slot="activity-group"]')!;
    expect(group.tagName).toBe("LI");
    expect(group.querySelector(".sui-activity-group-label")?.textContent).toBe("Setup");
    expect(group.querySelectorAll('[data-slot="activity-item"]').length).toBe(2);
    expect(container!.querySelectorAll('[data-slot="activity-item"]').length).toBe(3);
    expect(container!.querySelector('[data-kind="output"] .sui-activity-detail')?.textContent).toBe("report.html");
  });

  test("renders under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<ActivityTimeline items={[{ id: "d1", kind: "failure", title: "Boom", status: "failed" }]} />);
    const item = container!.querySelector('[data-slot="activity-item"]')!;
    expect(item.getAttribute("data-kind")).toBe("failure");
    expect(item.querySelector(".sui-activity-marker")?.textContent).toBe("✕");
  });
});
