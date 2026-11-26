import { describe, expect, it } from "vitest"
import {
  approvalRequestKey,
  focusTargetFromElement,
  isTypingOutsideApproval,
  readDocumentFocusTarget,
  resolveApprovalFocus,
} from "./approvalGuard"

describe("approvalGuard", () => {
  it("produces a canonical shared key for run and queue approval surfaces", () => {
    expect(approvalRequestKey("run-1", 2, "exec-a")).toBe("run-1@v2:exec-a")
    expect(approvalRequestKey("run-1", 3, "exec-a")).not.toBe(approvalRequestKey("run-1", 2, "exec-a"))
  })

  it("holds focus when an approval arrives while typing in another editor", () => {
    const decision = resolveApprovalFocus({
      runId: "run-approval",
      version: 1,
      execution: "exec-1",
      activeTarget: { tagName: "textarea", isContentEditable: false, closestRunId: null },
    })
    expect(decision).toEqual({
      action: "hold",
      key: "run-approval@v1:exec-1",
      reason: "typing_elsewhere",
    })
  })

  it("allows focus when typing inside the same approval card or when editor is idle", () => {
    expect(
      resolveApprovalFocus({
        runId: "run-approval",
        version: 1,
        execution: "exec-1",
        activeTarget: { tagName: "TEXTAREA", isContentEditable: false, closestRunId: "run-approval" },
      }),
    ).toEqual({ action: "focus", key: "run-approval@v1:exec-1", reason: "idle_editor" })

    expect(
      resolveApprovalFocus({
        runId: "run-approval",
        version: 1,
        execution: "exec-1",
        activeTarget: { tagName: "DIV", isContentEditable: false, closestRunId: null },
      }),
    ).toEqual({ action: "focus", key: "run-approval@v1:exec-1", reason: "idle_editor" })

    expect(isTypingOutsideApproval(null, "run-approval")).toBe(false)
    expect(isTypingOutsideApproval({ isContentEditable: true, closestRunId: "other-run" }, "run-approval")).toBe(true)
  })

  it("focuses on explicit click even while another input had focus", () => {
    const decision = resolveApprovalFocus({
      runId: "run-approval",
      version: 1,
      execution: "exec-1",
      activeTarget: { tagName: "INPUT", isContentEditable: false, closestRunId: null },
      force: true,
    })
    expect(decision).toEqual({
      action: "focus",
      key: "run-approval@v1:exec-1",
      reason: "explicit",
    })
  })

  it("suppresses stale focus after a second tab resolves or permission refuses the request", () => {
    const key = approvalRequestKey("run-approval", 2, "exec-2")
    expect(
      resolveApprovalFocus({
        runId: "run-approval",
        version: 2,
        execution: "exec-2",
        activeTarget: null,
        force: true,
        resolvedKeys: new Set([key]),
      }),
    ).toEqual({ action: "ignore", key, reason: "resolved" })

    expect(
      resolveApprovalFocus({
        runId: "run-approval",
        version: 2,
        execution: "exec-2",
        activeTarget: null,
        force: true,
        refusedKeys: new Set([key]),
      }),
    ).toEqual({ action: "ignore", key, reason: "refused" })

    // A newer item version on the same run is not suppressed by the previous resolved key.
    expect(
      resolveApprovalFocus({
        runId: "run-approval",
        version: 3,
        execution: "exec-3",
        activeTarget: null,
        resolvedKeys: new Set([key]),
      }),
    ).toEqual({ action: "focus", key: "run-approval@v3:exec-3", reason: "idle_editor" })
  })

  it("reads null safely in headless environments and extracts host run ID when an active element exists", () => {
    expect(readDocumentFocusTarget()).toBeNull()
    expect(focusTargetFromElement(null)).toBeNull()
    expect(
      focusTargetFromElement({
        tagName: "TEXTAREA",
        isContentEditable: false,
        closest: () => ({ getAttribute: () => "run-42" }),
      }),
    ).toEqual({
      tagName: "TEXTAREA",
      isContentEditable: false,
      closestRunId: "run-42",
    })
    expect(
      focusTargetFromElement({
        tagName: "DIV",
        isContentEditable: true,
      }),
    ).toEqual({
      tagName: "DIV",
      isContentEditable: true,
      closestRunId: null,
    })
  })
})
