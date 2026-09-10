/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import * as WorkflowCanvasModule from "../src/canvas/WorkflowCanvas";
import {
  WorkflowCanvas,
  WorkflowConnection,
  WorkflowControls,
  WorkflowEdge,
  WorkflowMinimap,
  WorkflowNode,
  WorkflowNodeContent,
  WorkflowNodeHeader,
  WorkflowNodeStatus,
  WorkflowPanel,
  WorkflowToolbar,
} from "../src/canvas/WorkflowCanvas";
import workflowCanvasProvenance from "../provenance/workflow-canvas.json";

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

async function render(element: ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
  return container;
}

describe("WorkflowCanvas", () => {
  test("renders a labelled group region with the sui-canvas class", async () => {
    const host = await render(<WorkflowCanvas>nodes</WorkflowCanvas>);
    const canvas = host.querySelector("[data-slot='workflow-canvas']")!;
    expect(canvas.getAttribute("role")).toBe("group");
    expect(canvas.getAttribute("aria-label")).toBe("Workflow canvas");
    expect(canvas.classList.contains("sui-canvas")).toBe(true);
    expect(canvas.textContent).toContain("nodes");
  });

  test("honours an aria-label override", async () => {
    const host = await render(<WorkflowCanvas aria-label="Run DAG" />);
    expect(host.querySelector("[data-slot='workflow-canvas']")!.getAttribute("aria-label")).toBe("Run DAG");
  });

  test("injects the composed sheet exactly once and adds no lane element", async () => {
    await render(<WorkflowCanvas />);
    const styles = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(styles.length).toBe(1);
    expect(document.querySelectorAll("style[data-smithers-ui-lane]").length).toBe(0);
    expect(styles[0]!.textContent).toContain(".sui-canvas-node {");
  });
});

describe("WorkflowNode", () => {
  test("renders title, kind badge, and status pill in a card", async () => {
    const host = await render(<WorkflowNode title="Build it" kind="agent" status="running" />);
    const node = host.querySelector("[data-slot='workflow-node']")!;
    expect(node.getAttribute("data-kind")).toBe("agent");
    expect(node.getAttribute("data-status")).toBe("running");
    expect(node.getAttribute("data-selected")).toBe("false");
    expect(node.querySelector(".sui-canvas-node-title")!.textContent).toBe("Build it");
    expect(node.querySelector(".sui-canvas-node-kind")!.textContent).toBe("agent");
    expect(node.querySelector("[data-slot='workflow-node-status']")!.textContent).toContain("Running");
  });

  test("marks the selected ring via data-selected", async () => {
    const host = await render(<WorkflowNode title="x" selected />);
    expect(host.querySelector("[data-slot='workflow-node']")!.getAttribute("data-selected")).toBe("true");
  });

  test("exposes selection in the accessibility tree: options owned by a listbox", async () => {
    const host = await render(
      <WorkflowCanvas role="listbox" aria-multiselectable="true" aria-label="Pick nodes">
        <WorkflowNode title="a" selected />
        <WorkflowNode title="b" selected={false} />
        <WorkflowNode title="c" />
      </WorkflowCanvas>,
    );
    const listbox = host.querySelector("[role='listbox']")!;
    expect(listbox.getAttribute("aria-label")).toBe("Pick nodes");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    // aria-selected is only supported on roles like option; on a generic div
    // it is stripped from the accessibility tree. Nodes in a selection model
    // therefore render as options, and the state must ride that role. Every
    // option must be owned by the listbox — an orphaned role="option" is an
    // invalid ARIA structure.
    const options = listbox.querySelectorAll("[data-slot='workflow-node'][role='option']");
    expect(options.length).toBe(2);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
    // No selection model without the selected prop: stay generic, no state.
    const nodes = [...listbox.querySelectorAll("[data-slot='workflow-node']")];
    expect(nodes[2]!.getAttribute("role")).toBeNull();
    expect(nodes[2]!.getAttribute("aria-selected")).toBeNull();
    // No option escapes listbox ownership.
    for (const option of host.querySelectorAll("[role='option']")) {
      expect(listbox.contains(option)).toBe(true);
    }
  });

  test("renders compound children verbatim when composed", async () => {
    const host = await render(
      <WorkflowNode>
        <WorkflowNodeHeader>
          <span className="custom-head">head</span>
        </WorkflowNodeHeader>
        <WorkflowNodeContent>body</WorkflowNodeContent>
      </WorkflowNode>,
    );
    expect(host.querySelector("[data-slot='workflow-node-header'] .custom-head")!.textContent).toBe("head");
    expect(host.querySelector("[data-slot='workflow-node-content']")!.textContent).toBe("body");
  });

  test("renders correctly under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    const host = await render(<WorkflowNode title="Dark node" status="failed" />);
    expect(host.querySelector("[data-slot='workflow-node']")!.getAttribute("data-status")).toBe("failed");
    expect(host.querySelector("[data-slot='workflow-node-status']")!.textContent).toContain("Failed");
  });
});

describe("WorkflowNodeStatus", () => {
  test("pipes the status string through StatusPill", async () => {
    const host = await render(<WorkflowNodeStatus status="waiting-approval" />);
    const pill = host.querySelector("[data-slot='workflow-node-status']")!;
    expect(pill.textContent).toContain("Waiting for approval");
  });
});

describe("WorkflowEdge", () => {
  test("renders a from -> to legend chip with an optional label and status signifier", async () => {
    const host = await render(<WorkflowEdge from="plan" to="build" label="depends on" status="done" />);
    const edge = host.querySelector("[data-slot='workflow-edge']")!;
    expect(edge.getAttribute("data-status")).toBe("done");
    expect(edge.getAttribute("data-status-class")).toBe("ok");
    expect(edge.querySelector(".sui-canvas-edge-glyph")).not.toBeNull();
    expect(edge.textContent).toContain("plan");
    expect(edge.textContent).toContain("build");
    expect(edge.textContent).toContain("depends on");
  });

  test("status is not color-only: each status class gets a distinct glyph and an sr-only label", async () => {
    const host = await render(
      <>
        <WorkflowEdge from="a" to="b" status="done" />
        <WorkflowEdge from="b" to="c" status="failed" />
        <WorkflowEdge from="c" to="d" status="running" />
      </>,
    );
    const edges = [...host.querySelectorAll("[data-slot='workflow-edge']")];
    const glyphs = edges.map((edge) => edge.querySelector(".sui-canvas-edge-glyph")!.textContent);
    // Distinct shapes per status class — meaning survives without color.
    expect(new Set(glyphs).size).toBe(3);
    for (const glyph of glyphs) expect(glyph!.trim().length).toBeGreaterThan(0);
    const srLabels = edges.map((edge) => edge.querySelector(".sui-sr-only")!.textContent);
    expect(srLabels).toEqual(["Done", "Failed", "Running"]);
  });

  test("spells out the from -> to connector for screen readers", async () => {
    const host = await render(<WorkflowEdge from="plan" to="build" />);
    const edge = host.querySelector("[data-slot='workflow-edge']")!;
    const srOnly = edge.querySelector(".sui-sr-only")!;
    expect(srOnly).not.toBeNull();
    expect(srOnly.textContent).toContain("to");
  });
});

describe("WorkflowConnection", () => {
  test("defaults to pending and carries the connection state", async () => {
    const host = await render(<WorkflowConnection />);
    expect(host.querySelector("[data-slot='workflow-connection']")!.getAttribute("data-status")).toBe("pending");
  });

  test("accepts valid and invalid states", async () => {
    const host = await render(
      <>
        <WorkflowConnection status="valid" />
        <WorkflowConnection status="invalid" />
      </>,
    );
    const statuses = [...host.querySelectorAll("[data-slot='workflow-connection']")].map((el) =>
      el.getAttribute("data-status"),
    );
    expect(statuses).toEqual(["valid", "invalid"]);
  });

  test("exposes the connection state to screen readers instead of hiding it", async () => {
    const host = await render(<WorkflowConnection status="valid" />);
    const connection = host.querySelector("[data-slot='workflow-connection']")!;
    expect(connection.getAttribute("aria-hidden")).toBeNull();
    expect(connection.querySelector(".sui-sr-only")!.textContent).toContain("valid");
  });
});

describe("WorkflowControls", () => {
  test("renders a toolbar with buttons only for the provided callbacks", async () => {
    const calls: string[] = [];
    const host = await render(
      <WorkflowControls onZoomIn={() => calls.push("in")} onFitView={() => calls.push("fit")} />,
    );
    const toolbar = host.querySelector("[data-slot='workflow-controls']")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("Canvas controls");
    const buttons = [...toolbar.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Zoom in", "Fit view"]);
    for (const button of buttons) {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(calls).toEqual(["in", "fit"]);
  });

  test("renders children as extra controls", async () => {
    const host = await render(
      <WorkflowControls>
        <button type="button">custom</button>
      </WorkflowControls>,
    );
    expect(host.querySelector("[data-slot='workflow-controls']")!.textContent).toContain("custom");
  });

  test("roves tabindex across its buttons with arrow and Home/End keys", async () => {
    const host = await render(<WorkflowControls onZoomIn={() => {}} onZoomOut={() => {}} onFitView={() => {}} />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-slot='workflow-controls'] button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);

    buttons[0]!.focus();
    await act(async () => {
      buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1]);

    await act(async () => {
      buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(buttons[2]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, 0]);

    await act(async () => {
      buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1]);

    await act(async () => {
      buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  });

  test("never roves onto disabled controls and drops them from the tab order", async () => {
    const host = await render(
      <WorkflowToolbar>
        <button type="button">one</button>
        <button type="button" disabled>
          two
        </button>
        <button type="button">three</button>
      </WorkflowToolbar>,
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-slot='workflow-toolbar'] button")];
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);

    buttons[0]!.focus();
    await act(async () => {
      buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    // The disabled middle button is skipped: focus lands on "three".
    expect(document.activeElement).toBe(buttons[2]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, 0]);

    await act(async () => {
      buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(buttons[0]);
  });

  test("reassigns the roving tab stop when the current control becomes disabled", async () => {
    const host = await render(
      <WorkflowToolbar>
        <button type="button">one</button>
        <button type="button">two</button>
      </WorkflowToolbar>,
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-slot='workflow-toolbar'] button")];
    buttons[0]!.focus();
    await act(async () => {
      buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(buttons[1]!.tabIndex).toBe(0);

    await act(async () => {
      root!.render(
        <WorkflowToolbar>
          <button type="button">one</button>
          <button type="button" disabled>
            two
          </button>
        </WorkflowToolbar>,
      );
    });
    const after = [...host.querySelectorAll<HTMLButtonElement>("[data-slot='workflow-toolbar'] button")];
    expect(after.map((button) => button.tabIndex)).toEqual([0, -1]);
  });

  test("ignores modifier-key chords so browser/OS shortcuts pass through", async () => {
    const host = await render(<WorkflowControls onZoomIn={() => {}} onZoomOut={() => {}} />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-slot='workflow-controls'] button")];
    buttons[0]!.focus();
    for (const chord of [
      { key: "ArrowRight", ctrlKey: true },
      { key: "ArrowRight", metaKey: true },
      { key: "ArrowRight", altKey: true },
      { key: "End", shiftKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
      await act(async () => {
        buttons[0]!.dispatchEvent(event);
      });
      expect(document.activeElement).toBe(buttons[0]);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1]);
  });

  test("still invokes a caller-supplied onKeyDown alongside roving", async () => {
    let seen = "";
    const host = await render(
      <WorkflowControls
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onKeyDown={(event) => {
          seen = event.key;
        }}
      />,
    );
    const first = host.querySelector<HTMLButtonElement>("[data-slot='workflow-controls'] button")!;
    first.focus();
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(seen).toBe("ArrowDown");
  });
});

describe("WorkflowPanel", () => {
  test("positions the overlay slot via data-position", async () => {
    const host = await render(
      <>
        <WorkflowPanel>a</WorkflowPanel>
        <WorkflowPanel position="bottom-right">b</WorkflowPanel>
      </>,
    );
    const panels = [...host.querySelectorAll("[data-slot='workflow-panel']")];
    expect(panels[0]!.getAttribute("data-position")).toBe("top-left");
    expect(panels[1]!.getAttribute("data-position")).toBe("bottom-right");
  });
});

describe("WorkflowToolbar", () => {
  test("renders a toolbar landmark", async () => {
    const host = await render(<WorkflowToolbar>tools</WorkflowToolbar>);
    const toolbar = host.querySelector("[data-slot='workflow-toolbar']")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.textContent).toContain("tools");
  });

  test("roves tabindex across toolbar buttons with arrow keys", async () => {
    const host = await render(
      <WorkflowToolbar>
        <button type="button">one</button>
        <button type="button">two</button>
      </WorkflowToolbar>,
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-slot='workflow-toolbar'] button")];
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1]);
    buttons[0]!.focus();
    await act(async () => {
      buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0]);
  });
});

describe("WorkflowMinimap", () => {
  test("renders a labelled seam frame the renderer can park a minimap inside", async () => {
    const host = await render(<WorkflowMinimap>map</WorkflowMinimap>);
    const minimap = host.querySelector("[data-slot='workflow-minimap']")!;
    expect(minimap.getAttribute("aria-label")).toBe("Workflow minimap");
    expect(minimap.textContent).toContain("map");
  });
});

describe("workflow-canvas provenance accuracy", () => {
  test("the lane provenance fragment names exactly the components this module exports at runtime", () => {
    const entry = (workflowCanvasProvenance as Array<{ file: string; exports: string[] }>).find(
      (candidate) => candidate.file === "src/canvas/WorkflowCanvas.tsx",
    );
    expect(entry).toBeDefined();
    const declared = new Set(entry!.exports);
    const runtime = new Set(Object.keys(WorkflowCanvasModule));
    expect(runtime).toEqual(declared);
  });
});
