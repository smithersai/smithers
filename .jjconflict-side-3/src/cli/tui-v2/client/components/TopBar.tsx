import React from "react";
import { useAppStore } from "../state/store.js";

export function TopBar() {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const workspaces = useAppStore((state) => state.workspaces);
  const runSummaries = useAppStore((state) => state.runSummaries);
  const approvals = useAppStore((state) => state.approvals);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
    workspaces[0];
  const activeRunCount = Object.values(runSummaries).filter((run) =>
    ["running", "waiting-approval"].includes(run.status),
  ).length;
  const approvalCount = Object.values(approvals).reduce(
    (count, next) => count + next.length,
    0,
  );

  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row", paddingLeft: 1 }}>
      <text style={{ bold: true, color: "#e2e8f0" }}>Smithers</text>
      <text style={{ color: "#718096" }}>  repo: </text>
      <text style={{ color: "#cbd5e0" }}>
        {activeWorkspace?.repoRoot.split("/").pop() ?? "repo"}
      </text>
      <text style={{ color: "#718096" }}>  workspace: </text>
      <text style={{ color: "#cbd5e0" }}>{activeWorkspace?.title ?? "control-plane"}</text>
      <text style={{ color: "#718096" }}>  profile: </text>
      <text style={{ color: "#63b3ed" }}>{activeWorkspace?.providerProfileId ?? "smithers"}</text>
      <text style={{ color: "#718096" }}>  mode: </text>
      <text style={{ color: "#63b3ed" }}>{activeWorkspace?.mode ?? "operator"}</text>
      <text style={{ color: "#a0aec0" }}>
        {"  "}
        {activeRunCount} runs
        {"  "}
        {approvalCount} approval
        {approvalCount === 1 ? "" : "s"}
        {"   "}
        Ctrl+O actions
      </text>
    </box>
  );
}
