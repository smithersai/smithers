/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { AgentTask, AgentTaskContent, AgentTaskGroup, AgentTaskTrigger } from "../src/agentic/AgentTask";
import { TaskItem, TaskItemFile } from "../src/agentic/TaskItem";

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

describe("AgentTask", () => {
  test("defaults closed and opens via the trigger with region wiring", async () => {
    await render(
      <AgentTask title="Research API" status="running">
        <AgentTaskTrigger />
        <AgentTaskContent>
          <TaskItem label="Read docs" status="completed" />
        </AgentTaskContent>
      </AgentTask>,
    );

    const trigger = container!.querySelector('[data-slot="agent-task-trigger"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Research API");
    expect(trigger.textContent).toContain("Running");
    expect(container!.querySelector('[data-slot="agent-task-content"]')).toBeNull();
    expect(container!.querySelector('[data-slot="agent-task"]')?.getAttribute("data-state")).toBe("closed");

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = container!.querySelector('[data-slot="agent-task-content"]')!;
    expect(content.getAttribute("role")).toBe("region");
    expect(content.getAttribute("id")).toBe(trigger.getAttribute("aria-controls"));
    expect(content.getAttribute("aria-labelledby")).toBe(trigger.getAttribute("id"));
    expect(content.textContent).toContain("Read docs");
  });

  test("honors controlled open and still reports gestures", async () => {
    const changes: boolean[] = [];
    await render(
      <AgentTask title="Fixed" open={false} onOpenChange={(open) => changes.push(open)}>
        <AgentTaskTrigger />
        <AgentTaskContent>Never mounted</AgentTaskContent>
      </AgentTask>,
    );
    const trigger = container!.querySelector('[data-slot="agent-task-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="agent-task-content"]')).toBeNull();
  });

  test("groups tasks in a list and renders under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(
      <AgentTaskGroup>
        <AgentTask title="One" status="pending">
          <AgentTaskTrigger />
          <AgentTaskContent>One body</AgentTaskContent>
        </AgentTask>
        <AgentTask title="Two" status="failed">
          <AgentTaskTrigger />
          <AgentTaskContent>Two body</AgentTaskContent>
        </AgentTask>
      </AgentTaskGroup>,
    );
    expect(container!.querySelector('[data-slot="agent-task-group"]')?.getAttribute("role")).toBe("list");
    expect(container!.querySelectorAll('[data-slot="agent-task"]').length).toBe(2);
  });
});

describe("TaskItem extensions", () => {
  test("appends children after the label", async () => {
    await render(
      <TaskItem label="Write files" status="running">
        <TaskItemFile name="src/index.ts" />
      </TaskItem>,
    );
    const item = container!.querySelector('[data-slot="task-item"]')!;
    const label = item.querySelector(".sui-taskitem-label")!;
    const chip = item.querySelector('[data-slot="task-item-file"]')!;
    expect(chip.textContent).toContain("src/index.ts");
    expect(label.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("TaskItemFile renders an optional leading icon", async () => {
    await render(<TaskItemFile name="README.md" icon={<svg data-testid="file-icon" />} />);
    const chip = container!.querySelector('[data-slot="task-item-file"]')!;
    expect(chip.textContent).toContain("README.md");
    const icon = chip.querySelector(".sui-taskitem-file-icon")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelector("svg")).not.toBeNull();
  });

  test("TaskItem without children keeps the legacy DOM", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<TaskItem label="Legacy" status="pending" files={["a.ts"]} elapsedSeconds={3} />);
    const item = container!.querySelector('[data-slot="task-item"]')!;
    expect(item.querySelector(".sui-taskitem-label")?.textContent).toBe("Legacy");
    expect(item.querySelector('[data-slot="task-item-files"]')?.textContent).toContain("a.ts");
    expect(item.querySelector(".sui-taskitem-elapsed")?.textContent).toBe("3s");
  });
});
