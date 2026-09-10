/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Checkpoint,
  CHECKPOINT_ACTION_KINDS,
  type CheckpointActionKind,
  CheckpointActions,
  CheckpointIcon,
  CheckpointMetadata,
  CheckpointTrigger,
} from "../src/approvals/Checkpoint";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";
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

const model = {
  id: "cp-1",
  label: "Before refactor",
  frameNo: 12,
  timestampMs: Date.UTC(2026, 0, 2, 3, 4, 5),
  messageCount: 8,
};

describe("Checkpoint", () => {
  test("renders the default anatomy: icon, label, metadata", async () => {
    await render(<Checkpoint checkpoint={model} />);
    expect(container!.querySelector("[data-slot='checkpoint-icon']")).not.toBeNull();
    expect(container!.textContent).toContain("Before refactor");
    expect(container!.textContent).toContain("frame 12");
    expect(container!.textContent).toContain("8 messages");
    expect(container!.querySelector("time")!.getAttribute("dateTime")).toBe("2026-01-02T03:04:05.000Z");
  });

  test("current marks the live position for sighted and screen-reader users", async () => {
    await render(
      <>
        <Checkpoint checkpoint={model} current />
        <Checkpoint checkpoint={{ id: "cp-2", label: "Earlier" }} />
      </>,
    );
    const rows = container!.querySelectorAll("[data-slot='checkpoint']");
    expect(rows[0]!.getAttribute("data-current")).toBe("true");
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(rows[1]!.getAttribute("data-current")).toBe("false");
    expect(rows[1]!.getAttribute("aria-current")).toBeNull();
  });

  test("falls back to the id when no label is set", async () => {
    await render(<Checkpoint checkpoint={{ id: "cp-9" }} />);
    expect(container!.textContent).toContain("cp-9");
  });

  test("compound children render verbatim", async () => {
    await render(
      <Checkpoint checkpoint={model}>
        <CheckpointIcon />
        <CheckpointMetadata />
      </Checkpoint>,
    );
    expect(container!.textContent).not.toContain("Before refactor");
    expect(container!.querySelector("[data-slot='checkpoint-metadata']")).not.toBeNull();
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<Checkpoint checkpoint={model} />);
    expect(container!.querySelector(".sui-checkpoint")).not.toBeNull();
  });
});

describe("CheckpointTrigger", () => {
  test("renders a ghost sm button with the default label", async () => {
    await render(<CheckpointTrigger />);
    const button = container!.querySelector<HTMLButtonElement>("[data-slot='checkpoint-trigger']")!;
    expect(button.className).toContain("sui-button-ghost");
    expect(button.className).toContain("sui-button-sm");
    expect(button.textContent).toContain("Checkpoint");
  });

  test("self-provides tooltip context when tooltip content is requested", async () => {
    await render(<CheckpointTrigger tooltip="Inspect this checkpoint" />);
    expect(container!.querySelector("[data-slot='checkpoint-trigger']")).not.toBeNull();
  });
});

describe("CheckpointActions", () => {
  test("exposes exactly the rc.0 time-travel library operations", async () => {
    expect(CHECKPOINT_ACTION_KINDS).toEqual(["fork", "replay", "rewind"]);
    await render(
      <Checkpoint checkpoint={model}>
        <CheckpointActions onAction={() => {}} />
      </Checkpoint>,
    );
    const kinds = [...container!.querySelectorAll("[data-slot='checkpoint-action']")].map((el) =>
      el.getAttribute("data-action")
    );
    expect(kinds).toEqual(["fork", "replay", "rewind"]);
    expect(container!.querySelector("[role='group']")!.getAttribute("aria-label")).toBe("Checkpoint actions");
  });

  test("fires onAction with the clicked kind", async () => {
    const fired: CheckpointActionKind[] = [];
    await render(<CheckpointActions actions={["replay", "rewind"]} onAction={(kind) => fired.push(kind)} />);
    const rewind = container!.querySelector("[data-action='rewind']")!;
    await act(async () => {
      rewind.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fired).toEqual(["rewind"]);
  });

  test("busy disables every action and spins the busy one", async () => {
    await render(<CheckpointActions actions={["replay", "fork"]} busy="fork" onAction={() => {}} />);
    const buttons = container!.querySelectorAll<HTMLButtonElement>("[data-slot='checkpoint-action']");
    buttons.forEach((button) => expect(button.disabled).toBe(true));
    expect(container!.querySelector("[data-action='fork'] [data-slot='spinner']")).not.toBeNull();
    expect(container!.querySelector("[data-action='replay'] [data-slot='spinner']")).toBeNull();
  });

  test("disabled greys individual kinds", async () => {
    await render(<CheckpointActions actions={["replay", "rewind"]} disabled={["rewind"]} onAction={() => {}} />);
    expect(container!.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(true);
    expect(container!.querySelector<HTMLButtonElement>("[data-action='replay']")!.disabled).toBe(false);
  });
});
