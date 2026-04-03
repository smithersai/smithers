import React from "react";
import { progressBar, summarizeNode } from "../../shared/format.js";
import { useAppStore } from "../state/store.js";

type InspectorProps = {
  focused: boolean;
  overlay?: boolean;
  quietHarbor: boolean;
};

export function Inspector({ focused, overlay = false, quietHarbor }: InspectorProps) {
  const activeRunId = useAppStore((state) => state.activeRunId);
  const runSummaries = useAppStore((state) => state.runSummaries);
  const runNodes = useAppStore((state) => state.runNodes);
  const selectedFeedEntryId = useAppStore((state) => state.selectedFeedEntryId);
  const activeRun = activeRunId ? runSummaries[activeRunId] : null;
  const nodes = activeRunId ? runNodes[activeRunId] ?? [] : [];

  return (
    <box
      style={{
        width: overlay ? "100%" : quietHarbor ? 28 : 38,
        height: overlay ? 10 : "100%",
        flexDirection: "column",
        borderLeft: !overlay && !quietHarbor,
        border: overlay,
        borderColor: focused ? "#63b3ed" : "#4a5568",
        paddingLeft: 1,
        paddingTop: 1,
      }}
    >
      <text style={{ color: "#718096" }}>
        Inspector • {activeRun ? `Run ${activeRun.runId.slice(0, 8)}` : selectedFeedEntryId ? `Entry ${selectedFeedEntryId}` : "No selection"}
      </text>
      {activeRun ? (
        <box style={{ flexDirection: "column", paddingTop: 1 }}>
          <text style={{ color: "#e2e8f0", bold: true }}>
            {activeRun.workflowName}
          </text>
          <text style={{ color: "#a0aec0" }}>
            {activeRun.status}  {activeRun.currentNodeLabel ?? activeRun.currentNodeId ?? "starting"}
          </text>
          <text style={{ color: "#48bb78" }}>
            {progressBar(activeRun.completedSteps ?? 0, activeRun.totalSteps ?? 0)}
          </text>
          {nodes.slice(0, overlay ? 4 : 8).map((node) => (
            <text key={`${node.nodeId}-${node.iteration}`} style={{ color: "#cbd5e0" }}>
              {summarizeNode(node)}
            </text>
          ))}
        </box>
      ) : (
        <box style={{ flexDirection: "column", paddingTop: 1 }}>
          <text style={{ color: "#718096" }}>
            Select a run or feed item to inspect it.
          </text>
        </box>
      )}
    </box>
  );
}
