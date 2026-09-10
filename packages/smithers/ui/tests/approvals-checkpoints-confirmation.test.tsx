/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  approvalStateLabel,
  approvalStateToStatus,
  type ApprovalState,
} from "../src/approvals/Confirmation";
import { approvalsCss } from "../src/approvals/approvalsCss";
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
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const current = root;
  await act(async () => current.render(element));
}

function fullConfirmation(state: ApprovalState) {
  return (
    <Confirmation state={state}>
      <ConfirmationTitle>Deploy to production?</ConfirmationTitle>
      <ConfirmationRequest>Request body</ConfirmationRequest>
      <ConfirmationActions>
        <ConfirmationAction decision="approve" />
        <ConfirmationAction decision="deny" />
      </ConfirmationActions>
      <ConfirmationAccepted />
      <ConfirmationRejected />
    </Confirmation>
  );
}

describe("approvalStateToStatus", () => {
  test("maps every approval state onto the shared vocabulary", () => {
    expect(approvalStateToStatus("synchronizing")).toBe("pending");
    expect(approvalStateToStatus("requested")).toBe("waiting-approval");
    expect(approvalStateToStatus("approving")).toBe("running");
    expect(approvalStateToStatus("denying")).toBe("running");
    expect(approvalStateToStatus("approved")).toBe("ok");
    expect(approvalStateToStatus("denied")).toBe("denied");
    expect(approvalStateToStatus("expired")).toBe("stale");
    expect(approvalStateToStatus("unavailable")).toBe("missing");
    expect(approvalStateToStatus("failed-submission")).toBe("error");
  });
});

describe("approvalStateLabel", () => {
  test("is distinct for all nine approval states", () => {
    const states: readonly ApprovalState[] = [
      "synchronizing",
      "requested",
      "approving",
      "denying",
      "approved",
      "denied",
      "expired",
      "unavailable",
      "failed-submission",
    ];
    const labels = states.map(approvalStateLabel);
    expect(new Set(labels).size).toBe(states.length);
    expect(approvalStateLabel("synchronizing")).toBe("Synchronizing approval");
    expect(approvalStateLabel("requested")).toBe("Waiting for approval");
    expect(approvalStateLabel("approving")).toBe("Approving");
    expect(approvalStateLabel("denying")).toBe("Denying");
    expect(approvalStateLabel("approved")).toBe("Approved");
    expect(approvalStateLabel("denied")).toBe("Denied");
    expect(approvalStateLabel("expired")).toBe("Approval expired");
    expect(approvalStateLabel("unavailable")).toBe("Approval unavailable");
    expect(approvalStateLabel("failed-submission")).toBe("Approval submission failed");
  });
});

describe("Confirmation", () => {
  test("requested shows request and actions, hides resolutions", async () => {
    await render(fullConfirmation("requested"));
    expect(container!.querySelector("[data-slot='confirmation-request']")).not.toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")).not.toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")!.getAttribute("role")).toBe("group");
    expect(container!.querySelector("[data-slot='confirmation-accepted']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-rejected']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation']")!.getAttribute("data-state")).toBe("requested");
  });

  test.each(["synchronizing", "approving", "denying"] as const)(
    "%s shows the request but not the actions",
    async (state) => {
      await render(fullConfirmation(state));
      expect(container!.querySelector("[data-slot='confirmation-request']")).not.toBeNull();
      expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
    },
  );

  test.each(["approving", "denying"] as const)(
    "%s disables its actions and the busy guard cannot be overridden",
    async (state) => {
      await render(
        <Confirmation state={state}>
          <ConfirmationAction decision="approve" />
          <ConfirmationAction decision="deny" disabled={false} />
        </Confirmation>,
      );
      const buttons = container!.querySelectorAll<HTMLButtonElement>("[data-slot='confirmation-action']");
      expect(buttons).toHaveLength(2);
      buttons.forEach((button) => expect(button.disabled).toBe(true));
    },
  );

  test("requested leaves explicitly-enabled actions enabled", async () => {
    await render(fullConfirmation("requested"));
    const buttons = container!.querySelectorAll<HTMLButtonElement>("[data-slot='confirmation-action']");
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => expect(button.disabled).toBe(false));
  });

  test("approved shows only the accepted resolution", async () => {
    await render(fullConfirmation("approved"));
    expect(container!.querySelector("[data-slot='confirmation-accepted']")!.textContent).toContain("Approved");
    expect(container!.querySelector("[data-slot='confirmation-request']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
  });

  test("denied shows only the rejected resolution", async () => {
    await render(fullConfirmation("denied"));
    expect(container!.querySelector("[data-slot='confirmation-rejected']")!.textContent).toContain("Denied");
  });

  test("failed-submission re-enables the actions for retry", async () => {
    await render(fullConfirmation("failed-submission"));
    expect(container!.querySelector("[data-slot='confirmation-actions']")).not.toBeNull();
    const buttons = container!.querySelectorAll<HTMLButtonElement>("[data-slot='confirmation-action']");
    buttons.forEach((button) => expect(button.disabled).toBe(false));
  });

  test("restores keyboard focus after a failed decision and focuses the result after success", async () => {
    await render(fullConfirmation("requested"));
    const approve = container!.querySelector<HTMLButtonElement>("[data-decision='approve']")!;
    approve.focus();
    expect(document.activeElement).toBe(approve);

    await render(fullConfirmation("approving"));
    await render(fullConfirmation("failed-submission"));
    expect(document.activeElement).toBe(container!.querySelector("[data-decision='approve']"));

    await render(fullConfirmation("denying"));
    await render(fullConfirmation("denied"));
    expect(document.activeElement).toBe(container!.querySelector("[data-slot='confirmation']"));
  });

  test("failed-submission shows visible failure feedback, not color only", async () => {
    await render(fullConfirmation("failed-submission"));
    const note = container!.querySelector("[data-slot='confirmation-note']");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Submission failed");
    expect(note!.className).toContain("sui-confirm-failure");
  });

  test.each(["synchronizing", "requested", "approving", "denying", "approved", "denied"] as const)(
    "%s renders no failure note",
    async (state) => {
      await render(fullConfirmation(state));
      expect(container!.querySelector(".sui-confirm-failure")).toBeNull();
    },
  );

  test.each(["expired", "unavailable"] as const)("%s renders a muted note and no actions", async (state) => {
    await render(fullConfirmation(state));
    expect(container!.querySelector("[data-slot='confirmation-note']")).not.toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-request']")).toBeNull();
  });

  test("announces the state label in a polite live region", async () => {
    await render(fullConfirmation("requested"));
    const live = container!.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    expect(live!.textContent).toBe("Waiting for approval");
  });

  test("the live region follows every state transition with a distinct label", async () => {
    await render(fullConfirmation("requested"));
    const live = () => container!.querySelector("[aria-live='polite']")!.textContent;
    const transitions: ReadonlyArray<[ApprovalState, string]> = [
      ["requested", "Waiting for approval"],
      ["approving", "Approving"],
      ["approved", "Approved"],
      ["requested", "Waiting for approval"],
      ["denying", "Denying"],
      ["denied", "Denied"],
      ["failed-submission", "Approval submission failed"],
      ["expired", "Approval expired"],
      ["unavailable", "Approval unavailable"],
      ["synchronizing", "Synchronizing approval"],
    ];
    for (const [state, label] of transitions) {
      await render(fullConfirmation(state));
      expect(live()).toBe(label);
    }
  });

  test("ConfirmationAction fires onDecide with its decision", async () => {
    const decisions: string[] = [];
    await render(
      <Confirmation state="requested">
        <ConfirmationActions>
          <ConfirmationAction decision="approve" onDecide={(d) => decisions.push(d)} />
          <ConfirmationAction decision="deny" onDecide={(d) => decisions.push(d)} />
        </ConfirmationActions>
      </Confirmation>,
    );
    const approve = container!.querySelector<HTMLButtonElement>("[data-decision='approve']")!;
    const deny = container!.querySelector<HTMLButtonElement>("[data-decision='deny']")!;
    expect(approve.textContent).toContain("Approve");
    expect(deny.textContent).toContain("Deny");
    await act(async () => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      deny.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(decisions).toEqual(["approve", "deny"]);
  });

  test("decision controls are native buttons in logical DOM order", async () => {
    await render(fullConfirmation("requested"));
    const controls = [...container!.querySelectorAll<HTMLButtonElement>("[data-slot='confirmation-action']")];
    expect(controls.map((control) => control.dataset.decision)).toEqual(["approve", "deny"]);
    for (const control of controls) {
      expect(control.tagName).toBe("BUTTON");
      expect(control.type).toBe("button");
      expect(control.tabIndex).toBe(0);
    }
  });

  test("renders under data-theme=dark with the composed sheet injected", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(fullConfirmation("requested"));
    expect(container!.querySelector(".sui-confirm")).not.toBeNull();
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(approvalsCss.trim());
  });
});
