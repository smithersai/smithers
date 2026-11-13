/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR, TaskItem } from "../src/index";

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

describe("TaskItem", () => {
  test("renders shared-vocabulary status text, file badges, and elapsed time", async () => {
    await render(
      <TaskItem
        label={<strong>Run checks</strong>}
        status="running"
        files={["src/Plan.tsx", "tests/plan.test.tsx"]}
        elapsedSeconds={72}
      />,
    );

    const item = container!.querySelector('[data-slot="task-item"]')!;
    expect(item.getAttribute("data-status")).toBe("running");
    expect(item.querySelector(".sui-sr-only")?.textContent).toBe("Running: ");
    expect(item.querySelector(".sui-taskitem-dot")?.getAttribute("aria-hidden")).toBe("true");
    expect(item.querySelector('[data-slot="task-item-files"]')?.textContent).toContain("src/Plan.tsx");
    expect(item.querySelector(".sui-taskitem-elapsed")?.textContent).toBe("1m 12s");
  });

  test("uses the exact seconds format below one minute", async () => {
    await render(<TaskItem label="Wait" status="pending" elapsedSeconds={8.4} />);
    expect(container!.querySelector(".sui-taskitem-elapsed")?.textContent).toBe("8s");
  });

});
