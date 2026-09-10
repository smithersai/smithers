/** @jsxImportSource react */
import { describe, expect, test, afterEach } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Calendar } from "../src/calendar/Calendar";
import { calendarCss } from "../src/calendar/calendarCss";
import { OutlineView } from "../src/vault/OutlineView";
import { vaultCss } from "../src/vault/vaultCss";
import { agentsCss } from "../src/agents/agentsCss";
import { approvalsCss } from "../src/approvals/approvalsCss";
import { artifactsCss } from "../src/artifacts/artifactsCss";
import { canvasCss } from "../src/canvas/canvasCss";
import { conversationFoundationCss } from "../src/chat/conversationFoundationCss";
import { plansTasksQueuesCss } from "../src/agentic/plansTasksQueuesCss";
import { promptAttachmentsCss } from "../src/prompt/promptAttachmentsCss";
import { reasoningToolsCss } from "../src/agentic/reasoningToolsCss";
import { sandboxCss } from "../src/sandbox/sandboxCss";
import { sourcesCitationsCss } from "../src/agentic/sourcesCitationsCss";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";
import { smithersUiCss } from "../src/uiCss";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every fragment a lane component used to inject a second time. */
const LANE_FRAGMENTS: ReadonlyArray<readonly [string, string]> = [
  ["conversation-foundation", conversationFoundationCss],
  ["prompt-attachments", promptAttachmentsCss],
  ["reasoning-tools", reasoningToolsCss],
  ["plans-tasks-queues", plansTasksQueuesCss],
  ["approvals-checkpoints", approvalsCss],
  ["sources-citations", sourcesCitationsCss],
  ["agent-identity-context", agentsCss],
  ["coding-artifacts", artifactsCss],
  ["sandbox-previews", sandboxCss],
  ["workflow-canvas", canvasCss],
  ["calendar", calendarCss],
  ["vault", vaultCss],
];

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function mount(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

describe("stylesheet injection", () => {
  test("the composed sheet carries every lane fragment", () => {
    for (const [id, css] of LANE_FRAGMENTS) {
      expect([id, smithersUiCss.includes(css.trim())]).toEqual([id, true]);
    }
  });

  test("a calendar mounts exactly one style element and no lane element", async () => {
    await mount(<Calendar events={[]} now={new Date(2026, 6, 27, 12, 0).getTime()} />);
    expect(document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).length).toBe(1);
    expect(document.querySelectorAll("style[data-smithers-ui-lane]").length).toBe(0);
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(calendarCss.trim());
  });

  test("a vault view mounts exactly one style element and no lane element", async () => {
    await mount(<OutlineView markdown={"# Title\n\n## Section"} />);
    expect(document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).length).toBe(1);
    expect(document.querySelectorAll("style[data-smithers-ui-lane]").length).toBe(0);
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(vaultCss.trim());
  });
});
