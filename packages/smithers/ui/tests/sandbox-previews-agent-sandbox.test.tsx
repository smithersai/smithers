/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Sandbox,
  SandboxActions,
  SandboxContent,
  SandboxHeader,
  SandboxStatus,
  sandboxStateToStatus,
  type SandboxState,
} from "../src/sandbox/AgentSandbox";
import { sandboxCss } from "../src/sandbox/sandboxCss";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

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

describe("sandboxStateToStatus", () => {
  test("maps every sandbox state into the shared vocabulary", () => {
    const states: readonly SandboxState[] = [
      "provisioning",
      "ready",
      "disconnected",
      "suspended",
      "failed",
      "destroyed",
    ];
    expect(states.map(sandboxStateToStatus)).toEqual(["pending", "ready", "waiting", "paused", "failed", "cancelled"]);
  });
});

describe("Sandbox", () => {
  test("renders open by default with identity and mapped status", async () => {
    await render(<Sandbox state="ready" workspace="/tmp/ws" repository="acme/app" />);

    const rootEl = container!.querySelector('[data-slot="agent-sandbox"]')!;
    expect(rootEl.getAttribute("data-state")).toBe("open");
    expect(rootEl.getAttribute("data-sandbox-state")).toBe("ready");
    expect(container!.querySelector('[data-slot="agent-sandbox-repository"]')?.textContent).toBe("acme/app");
    expect(container!.querySelector('[data-slot="agent-sandbox-workspace"]')?.textContent).toBe("/tmp/ws");
    const status = container!.querySelector('[data-slot="agent-sandbox-status"]')!;
    expect(status.getAttribute("data-status")).toBe("ready");
    expect(status.textContent).toContain("Ready");
  });

  test("collapses via the trigger with aria wiring and reports requested state", async () => {
    const changes: boolean[] = [];
    await render(<Sandbox state="ready" onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector('[data-slot="agent-sandbox-trigger"]') as HTMLButtonElement;
    const content = container!.querySelector('[data-slot="agent-sandbox-content"]')!;

    expect(trigger.type).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(content.id);
    expect(content.getAttribute("role")).toBe("region");
    expect(content.getAttribute("aria-labelledby")).toBe(trigger.id);

    await act(async () => trigger.click());
    expect(changes).toEqual([false]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="agent-sandbox-content"]')).toBeNull();
  });

  test("honors controlled open state without self-managing", async () => {
    const changes: boolean[] = [];
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Sandbox
          state="ready"
          open={open}
          onOpenChange={(next) => {
            changes.push(next);
            setOpen(next);
          }}
        />
      );
    }
    await render(<Harness />);
    expect(container!.querySelector('[data-slot="agent-sandbox-content"]')).toBeNull();

    const trigger = container!.querySelector('[data-slot="agent-sandbox-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="agent-sandbox-content"]')).not.toBeNull();
  });

  test("non-ready states render an honest EmptyState instead of fabricated output", async () => {
    await render(<Sandbox state="failed" />);
    const empty = container!.querySelector('[data-slot="agent-sandbox-content"] [data-slot="empty-state"]')!;
    expect(empty.textContent).toContain("Sandbox failed");
    expect(empty.textContent).toContain("failed to start");
  });

  test("children content wins over the state EmptyState", async () => {
    await render(
      <Sandbox state="ready">
        <SandboxHeader />
        <SandboxContent>
          <pre>real output only</pre>
        </SandboxContent>
      </Sandbox>,
    );
    expect(container!.querySelector('[data-slot="agent-sandbox-content"]')?.textContent).toBe("real output only");
    expect(container!.querySelector('[data-slot="empty-state"]')).toBeNull();
  });

  test("retry shows only for failed; reconnect only for disconnected/suspended", async () => {
    await render(
      <Sandbox state="disconnected">
        <SandboxActions onRetry={() => {}} onReconnect={() => {}} />
      </Sandbox>,
    );
    expect(container!.querySelector('[data-slot="agent-sandbox-retry"]')).toBeNull();
    expect(container!.querySelector('[data-slot="agent-sandbox-reconnect"]')).not.toBeNull();
  });

  test("actions invoke callbacks and render under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    let retries = 0;
    await render(
      <Sandbox state="failed">
        <SandboxActions
          onRetry={() => {
            retries += 1;
          }}
        />
      </Sandbox>,
    );
    const retry = container!.querySelector('[data-slot="agent-sandbox-retry"]') as HTMLButtonElement;
    expect(container!.querySelector('[data-slot="agent-sandbox-actions"]')?.getAttribute("role")).toBe("group");
    await act(async () => retry.click());
    expect(retries).toBe(1);
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(sandboxCss.trim());
  });

  test("SandboxStatus maps suspended to a paused pill with the sandbox label", async () => {
    await render(<SandboxStatus state="suspended" />);
    const pill = container!.querySelector('[data-slot="agent-sandbox-status"]')!;
    expect(pill.getAttribute("data-status")).toBe("paused");
    expect(pill.getAttribute("data-sandbox-state")).toBe("suspended");
    expect(pill.textContent).toContain("Suspended");
  });

  test("ships the Sandbox compound API", async () => {
    await render(
      <Sandbox state="ready" workspace="/tmp/ws">
        <SandboxHeader>
          <SandboxStatus state="ready" />
        </SandboxHeader>
        <SandboxContent>
          <pre>frozen anatomy works</pre>
        </SandboxContent>
      </Sandbox>,
    );
    expect(container!.querySelector('[data-slot="agent-sandbox-content"]')?.textContent).toBe("frozen anatomy works");
  });

  test("announces lifecycle changes through a polite live region without announcing mount", async () => {
    let setState!: (state: SandboxState) => void;
    function Harness() {
      const [state, setSandboxState] = useState<SandboxState>("provisioning");
      setState = setSandboxState;
      return <Sandbox state={state} />;
    }
    await render(<Harness />);
    const live = container!.querySelector('[data-slot="agent-sandbox-live"]')!;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.className).toContain("sui-sr-only");
    expect(live.textContent).toBe("");

    await act(async () => setState("ready"));
    expect(live.textContent).toBe("Sandbox ready");

    await act(async () => setState("failed"));
    expect(live.textContent).toBe("Sandbox failed");

    await act(async () => setState("destroyed"));
    expect(live.textContent).toBe("Sandbox destroyed");
  });
});
