import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AttachAgentCard,
  AudienceSwitch,
  CauseChip,
  CauseTrail,
  ForkBadge,
  FrameScrubber,
  PaneFrame,
  PlanTree,
  StateMachineView,
  WaitlistCard,
  WorkflowExecutionView,
  type CauseReceiptData,
} from "../src/index";

const SAMPLE_CAUSE: CauseReceiptData = {
  outputRef: "out_cause_1",
  runId: "run_9f8e7d6c5b4a",
  nodeId: "plan-tree/update",
  journalSeq: 42,
  origin: {
    kind: "plan",
    page: "M1-core",
    blockId: "b1",
    rev: "161fb3f9",
    label: "M1 Core Plan",
  },
};

let host: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(element: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(element);
  });
  return host;
}

function rerender(element: React.ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

function click(el: Element | null | undefined): void {
  expect(el).toBeTruthy();
  act(() => {
    (el as HTMLElement).click();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = undefined;
  }
  host?.remove();
  host = undefined;
});

describe("workbench components", () => {
  test("PaneFrame renders 3-tier controls, keyboard shortcuts, and origin badge", () => {
    const events: string[] = [];
    const container = mount(
      <PaneFrame
        paneId="plan"
        title="Plan Tree"
        size="inline"
        origin="core"
        onInspect={() => events.push("inspect")}
        onMaximize={() => events.push("maximize")}
        actionStrip={<button type="button">Approve</button>}
      >
        <div>Body content</div>
      </PaneFrame>,
    );

    const frame = container.querySelector('[data-slot="pane-frame"]') as HTMLElement;
    expect(frame.getAttribute("data-pane-size")).toBe("inline");
    expect(container.textContent).toContain("Core");
    expect(container.textContent).toContain("Approve");

    click(container.querySelector('button[aria-label="Inspect Plan Tree"]'));
    click(container.querySelector('button[aria-label="Maximize Plan Tree"]'));

    act(() => {
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });
    expect(events).toEqual(["inspect", "maximize", "maximize"]);

    rerender(
      <PaneFrame
        paneId="plan"
        title="Plan Tree"
        size="full"
        origin="core"
        onRestore={() => events.push("restore")}
      >
        <div>Body content</div>
      </PaneFrame>,
    );
    expect(frame.getAttribute("data-pane-size")).toBe("full");
    act(() => {
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(events).toEqual(["inspect", "maximize", "maximize", "restore"]);
  });

  test("CauseChip and CauseTrail expose provenance and reveal exact receipt", () => {
    const revealed: CauseReceiptData[] = [];
    const container = mount(
      <div>
        <CauseChip receipt={SAMPLE_CAUSE} onReveal={(r) => revealed.push(r)} />
        <CauseTrail receipt={SAMPLE_CAUSE} onRevealPlan={(r) => revealed.push(r)} onRevealRun={(id) => revealed.push({ ...SAMPLE_CAUSE, runId: id })} />
      </div>,
    );

    expect(container.textContent).toContain("M1 Core Plan");
    expect(container.textContent).toContain("run_9f8e");
    expect(container.textContent).not.toContain(";");
    expect(container.textContent).not.toContain("—");
    expect(container.textContent).not.toContain("jjhub");

    click(container.querySelector('[data-slot="cause-chip"]'));
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.outputRef).toBe("out_cause_1");
  });

  test("PlanTree renders nested hierarchy, source pointers, toggles assumptions, and escapes markup", () => {
    const toggled: Array<[string, string]> = [];
    const selected: string[] = [];
    const hostileTitle = '<img src=x onerror=alert(1)> Root Node';

    const container = mount(
      <PlanTree
        selectedId="n2"
        onSelect={(id) => selected.push(id)}
        onToggleAssumption={(nid, aid) => toggled.push([nid, aid])}
        nodes={[
          {
            id: "n1",
            title: hostileTitle,
            milestone: "M1",
            status: "in_progress",
            depth: 0,
            sources: ["apps/mvp/worker/attach/Attach.ts"],
            assumptions: [
              { id: "a1", text: "Sync converges without must-refetch", verified: true },
              { id: "a2", text: "Lean proves all transitions", verified: false },
            ],
            cause: SAMPLE_CAUSE,
          },
          {
            id: "n2",
            title: "Child Leaf",
            milestone: "M1",
            status: "done",
            depth: 1,
          },
        ]}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(hostileTitle);
    expect(container.textContent).toContain("apps/mvp/worker/attach/Attach.ts");
    expect(container.textContent).toContain("Assumptions 1/2");
    expect(container.querySelector('[data-slot="plan-tree-branch"] [data-node-id="n2"]')).toBeTruthy();

    const childButton = container.querySelector('[data-node-id="n2"] [data-slot="plan-tree-select"]') as HTMLButtonElement;
    expect(childButton.getAttribute("aria-pressed")).toBe("true");
    click(childButton);
    expect(selected).toEqual(["n2"]);

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    click(checkboxes[1]);
    expect(toggled).toEqual([["n1", "a2"]]);

    // Static rendering without onSelect omits button
    rerender(
      <PlanTree
        nodes={[{ id: "n1", title: "Static Node", milestone: "M0", status: "pending", depth: 0 }]}
      />,
    );
    expect(container.querySelector('[data-slot="plan-tree-select"]')).toBeNull();
    expect(container.querySelector('[data-slot="plan-tree-title"]')?.textContent).toBe("Static Node");
  });

  test("AttachAgentCard blocks unidentified consent, renders scope independently, and uses group pressed buttons", () => {
    const events: string[] = [];
    // Missing repoSlug must disable approval and still show agentLabel + branch
    const container = mount(
      <AttachAgentCard
        mode="local-stdio"
        state="consent_pending"
        promptText="Run smthrs attach --intent att_123"
        agentLabel="Claude Code"
        branch="main"
        onModeChange={(m) => events.push(`mode:${m}`)}
        onCopyPrompt={(t) => {
          events.push(`copy:${t}`);
        }}
        onApproveConsent={() => events.push("approve")}
      />,
    );

    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("Missing agent or repository scope");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="group"][aria-label="MCP transport"]')).toBeTruthy();

    const buttons = Array.from(container.querySelectorAll("button"));
    const approveBtn = buttons.find((b) => b.textContent?.includes("Approve access")) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    click(approveBtn);
    expect(events).toEqual([]);

    // Supply complete scope -> approval enabled and consent summary explicit
    rerender(
      <AttachAgentCard
        mode="local-stdio"
        state="consent_pending"
        promptText="Run smthrs attach --intent att_123"
        repoSlug="evmts/voltaire"
        branch="main"
        agentLabel="Claude Code"
        onModeChange={(m) => events.push(`mode:${m}`)}
        onApproveConsent={() => events.push("approve")}
      />,
    );

    expect(container.textContent).toContain("Allow Claude Code on evmts/voltaire (main)");
    const updatedButtons = Array.from(container.querySelectorAll("button"));
    const hostedBtn = updatedButtons.find((b) => b.textContent?.includes("Hosted MCP"));
    const enabledApproveBtn = updatedButtons.find((b) => b.textContent?.includes("Approve access")) as HTMLButtonElement;
    expect(enabledApproveBtn.disabled).toBe(false);
    click(hostedBtn);
    click(enabledApproveBtn);
    expect(events).toEqual(["mode:remote-http", "approve"]);
  });

  test("WaitlistCard validates URLs, submits via form, uses Smithers placeholder, and isolates multi-card IDs", () => {
    let submitted = 0;
    let url = "javascript:alert(1)";
    const container = mount(
      <div>
        <WaitlistCard
          repoUrl={url}
          status="idle"
          onRepoUrlChange={(v) => {
            url = v;
          }}
          onWorkflowNoteChange={() => {}}
          onSubmit={() => {
            submitted += 1;
          }}
        />
        <WaitlistCard
          repoUrl="https://github.com/evmts/voltaire"
          status="idle"
          onRepoUrlChange={() => {}}
          onSubmit={() => {
            submitted += 10;
          }}
        />
      </div>,
    );

    const cards = container.querySelectorAll('[data-slot="waitlist-card"]');
    expect(cards).toHaveLength(2);
    const input0 = cards[0]!.querySelector('input[type="url"]') as HTMLInputElement;
    const input1 = cards[1]!.querySelector('input[type="url"]') as HTMLInputElement;
    expect(input0.id).not.toBe(input1.id);
    expect(cards[0]!.querySelector(`label[for="${input0.id}"]`)).toBeTruthy();
    expect(cards[1]!.querySelector(`label[for="${input1.id}"]`)).toBeTruthy();

    const workflowInput = cards[0]!.querySelector('input[type="text"]') as HTMLInputElement;
    expect(workflowInput.placeholder).toBe(".smithers/workflows/ci.vibe");

    const badBtn = cards[0]!.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(badBtn.disabled).toBe(true);
    const badForm = cards[0]!.querySelector("form") as HTMLFormElement;
    act(() => {
      badForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toBe(0);

    const goodForm = cards[1]!.querySelector("form") as HTMLFormElement;
    act(() => {
      goodForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toBe(10);
  });

  test("ForkBadge sanitizes unsafe hrefs and AudienceSwitch only renders downward roles", () => {
    const roles: string[] = [];
    const container = mount(
      <div>
        <ForkBadge
          forkOrg="smithersai"
          upstreamRepo="Effect-TS/effect"
          upstreamHref="javascript:alert(1)"
        />
        <ForkBadge
          forkOrg="smithersai"
          upstreamRepo="Effect-TS/effect"
          upstreamHref="https://github.com/Effect-TS/effect"
        />
        <AudienceSwitch
          maxRole="contributor"
          activeRole="contributor"
          onChange={(r) => roles.push(r)}
        />
      </div>,
    );

    const badges = container.querySelectorAll('[data-slot="fork-badge"]');
    expect(badges[0]!.querySelector("a")).toBeNull();
    expect(badges[0]!.textContent).toContain("Upstream: Effect-TS/effect");

    const safeAnchor = badges[1]!.querySelector("a") as HTMLAnchorElement;
    expect(safeAnchor.getAttribute("href")).toBe("https://github.com/Effect-TS/effect");
    expect(safeAnchor.textContent).toContain("github.com/Effect-TS/effect");

    expect(container.textContent).not.toContain("Maintainer");
    expect(container.textContent).toContain("Contributor");
    expect(container.textContent).toContain("Visitor");
    const visitorBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Visitor"),
    );
    click(visitorBtn);
    expect(roles).toEqual(["visitor"]);
  });

  test("FrameScrubber handles empty history, aria-valuetext, and bracket shortcuts", () => {
    const events: string[] = [];
    const container = mount(
      <FrameScrubber
        totalFrames={0}
        currentFrame={0}
        isLive={false}
        onStepBack={() => events.push("back")}
        onStepForward={() => events.push("forward")}
        onSeek={(f) => events.push(`seek:${f}`)}
        onReturnLive={() => events.push("live")}
      />,
    );

    expect(container.textContent).toContain("No frames");
    expect(container.textContent).not.toContain("Frame 1 of 1");
    const emptyRange = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(emptyRange.disabled).toBe(true);
    expect(emptyRange.getAttribute("aria-valuetext")).toBe("No frames");

    rerender(
      <FrameScrubber
        totalFrames={10}
        currentFrame={3}
        isLive={false}
        onStepBack={() => events.push("back")}
        onStepForward={() => events.push("forward")}
        onSeek={(f) => events.push(`seek:${f}`)}
        onReturnLive={() => events.push("live")}
      />,
    );
    const scrubber = container.querySelector('[data-slot="frame-scrubber"]') as HTMLElement;
    const range = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(container.textContent).toContain("Frame 4 of 10");
    expect(range.getAttribute("aria-valuetext")).toBe("Frame 4 of 10");

    act(() => {
      scrubber.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true }));
      scrubber.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true }));
    });
    expect(events).toEqual(["back", "forward"]);
  });

  test("StateMachineView and WorkflowExecutionView use ordinary lists with accessible selection and replay", () => {
    const events: string[] = [];
    const container = mount(
      <div>
        <StateMachineView
          name="PlanTreeState"
          revision="161fb3f993a2"
          verdict="proved"
          selectedTransitionId="t1"
          onSelectTransition={(id) => events.push(`t:${id}`)}
          transitions={[
            {
              id: "t1",
              from: "pending",
              event: "start",
              to: "in_progress",
              verdict: "proved",
              theoremName: "plan_start_valid",
            },
          ]}
          onVerifyProof={() => events.push("verify")}
        />
        <WorkflowExecutionView
          workflowTag="ci/fast-check"
          sourcePath=".smithers/workflows/fast-check.vibe"
          selectedNodeId="s1"
          onSelectNode={(id) => events.push(`node:${id}`)}
          onReplayFromNode={(id) => events.push(`replay:${id}`)}
          nodes={[
            {
              id: "s1",
              label: "Typecheck affected packages",
              kind: "action",
              status: "completed",
              durationMs: 420,
              cause: SAMPLE_CAUSE,
            },
          ]}
        />
      </div>,
    );

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(container.textContent).toContain("Lean proved");
    expect(container.textContent).toContain("plan_start_valid");
    expect(container.textContent).toContain("ci/fast-check");

    const transitionBtn = container.querySelector('[data-transition-id="t1"] button') as HTMLButtonElement;
    expect(transitionBtn.getAttribute("aria-pressed")).toBe("true");
    click(transitionBtn);

    const nodeBtn = container.querySelector('[data-node-id="s1"] button') as HTMLButtonElement;
    click(nodeBtn);
    const replayBtn = container.querySelector('button[aria-label="Replay step Typecheck affected packages"]');
    click(replayBtn);

    expect(events).toEqual(["t:t1", "node:s1", "replay:s1"]);
  });
});
