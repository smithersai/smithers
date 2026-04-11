// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SmithersDb } from "../../../db/adapter.js";

export function RunDetailView({
  adapter,
  runId,
  onBack,
  onSelectNode,
}: {
  adapter: SmithersDb;
  runId: string;
  onBack: () => void;
  onSelectNode: (nodeId: string | null) => void;
}) {
  const [runData, setRunData] = useState<any>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [attempts, setAttempts] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [branchInfo, setBranchInfo] = useState<any>(null);
  const [childBranches, setChildBranches] = useState<any[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0); // 0 = Run itself, 1+ = nodes

  useEffect(() => {
    let mounted = true;
    let timeout: NodeJS.Timeout;
    async function fetchDetails() {
      if (!mounted) return;
      try {
        const run = await adapter.getRun(runId);
        const fetchedNodes = await adapter.listNodes(runId);
        const fetchedAttempts = await adapter.listAttemptsForRun(runId);
        const fetchedEvents = await adapter.listEvents(runId, -1, 10000);
        // Time Travel: fetch branch info
        let fetchedBranchInfo = null;
        let fetchedChildBranches: any[] = [];
        try {
          const { getBranchInfo, listBranches } = await import("../../../time-travel/fork.js");
          fetchedBranchInfo = await getBranchInfo(adapter, runId) ?? null;
          fetchedChildBranches = await listBranches(adapter, runId) ?? [];
        } catch {}
        if (mounted) {
          setRunData(run);
          setNodes(fetchedNodes);
          setAttempts(fetchedAttempts);
          setEvents(fetchedEvents);
          setBranchInfo(fetchedBranchInfo);
          setChildBranches(fetchedChildBranches);
          setSelectedIndex((prev) => Math.min(prev, fetchedNodes.length));
        }
      } catch (err) {}
      if (mounted) timeout = setTimeout(fetchDetails, 1000);
    }
    fetchDetails();
    return () => {
      mounted = false;
      clearTimeout(timeout);
    };
  }, [adapter, runId]);

  useKeyboard((key) => {
    if (key.name === "escape" || (key.name === "c" && key.ctrl) || key.name === "backspace") {
      onBack();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((s) => Math.min(s + 1, nodes.length));
    }
    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((s) => Math.max(0, s - 1));
    }
    if (key.name === "enter" || key.name === "return") {
      onSelectNode(selectedIndex === 0 ? null : nodes[selectedIndex - 1]?.nodeId);
    }
    if (key.name === "h" && selectedIndex > 0) {
      const targetNode = nodes[selectedIndex - 1]?.nodeId;
      if (targetNode && (runData?.status === "running" || runData?.status === "waiting-approval")) {
        Bun.spawn(
          [
            "smithers-ctl",
            "terminal",
            "--cwd",
            process.cwd(),
            "--command",
            `bun run src/cli/index.ts hijack ${runId} --target ${targetNode}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        ).unref();
      }
    }
  });

  if (!runData) {
    return <text style={{ margin: 1 }}>Loading run details for {runId}...</text>;
  }

  const isGlobal = selectedIndex === 0;
  const selectedNode = isGlobal ? null : nodes[selectedIndex - 1];

  let outputData = "No output text available yet.";
  if (isGlobal) {
    if (runData.errorJson) {
      outputData = `ERROR:\n${runData.errorJson}`;
    } else if (runData.status === "finished") {
      outputData = "Run completed successfully (no global errorJson stacktrace was captured).\n\nPress [Enter] to inspect individual task payloads.";
    } else if (runData.status === "failed") {
      outputData = "Workflow failed (no global errorJson stacktrace was captured).\n\nPress [Enter] to inspect and determine which individual task node crashed.";
    } else {
      outputData = "Workflow is still active or pending execution...";
    }
  } else {
    const nodeAttempts = attempts.filter((a) => a.nodeId === selectedNode?.nodeId).sort((a, b) => b.attempt - a.attempt);
    const latestAttempt = nodeAttempts[0];
    outputData = latestAttempt?.errorJson ? `ERROR:\n${latestAttempt.errorJson}` : latestAttempt?.responseText ?? "No output text available yet.";
  }

  let truncatedOutput = outputData;
  if (truncatedOutput.length > 500) {
    const head = truncatedOutput.substring(0, 200);
    const tail = truncatedOutput.substring(truncatedOutput.length - 200);
    truncatedOutput = `${head}\n\n... [ TRUNCATED ${truncatedOutput.length - 400} CHARACTERS ] ...\n\n${tail}`;
  }

  // Calculate tokens
  let tokensStr = "";
  if (!isGlobal && selectedNode) {
    const usageAttempts = attempts.filter((a) => a.nodeId === selectedNode.nodeId).sort((a, b) => b.attempt - a.attempt);
    const usageAttempt = usageAttempts[0];
    const usageEvent = events.find(
      (e) => e.type === "TokenUsageReported" && e.nodeId === selectedNode.nodeId && e.attempt === usageAttempt?.attempt
    );
    if (usageEvent) {
      try {
        const payload = JSON.parse(usageEvent.payloadJson);
        tokensStr = `Tokens: ${payload.inputTokens} IN | ${payload.outputTokens} OUT | ${payload.cacheReadTokens ?? 0} CACHE`;
      } catch {}
    }
  } else if (isGlobal) {
    let tIn = 0, tOut = 0, tCache = 0;
    for (const e of events) {
      if (e.type === "TokenUsageReported") {
        try {
          const p = JSON.parse(e.payloadJson);
          tIn += (p.inputTokens ?? 0);
          tOut += (p.outputTokens ?? 0);
          tCache += (p.cacheReadTokens ?? 0);
        } catch {}
      }
    }
    tokensStr = `Total Run Tokens: ${tIn} IN | ${tOut} OUT | ${tCache} CACHE`;
  }

  return (
    <box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "row" }}>
      {/* Left Sidebar: Nodes Tree */}
      <box
        style={{
          width: 40,
          height: "100%",
          border: true,
          borderColor: "#34d399",
          flexDirection: "column",
        }}
        title={`Run Tasks [Esc to Return]`}
      >
        <scrollbox style={{ width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1 }}>
          <text style={{ color: isGlobal ? "green" : "white" }}>
            {isGlobal ? "▶ " : "  "}[ Entire Run ]
          </text>
          {nodes.map((node, i) => {
            const isSelected = selectedIndex === i + 1;
            return (
              <text
                key={`${node.runId}-${node.nodeId}-${node.iteration}`}
                style={{ color: isSelected ? "green" : "white" }}
              >
                {isSelected ? "▶ " : "  "}{node.nodeId}: {node.state}
              </text>
            );
          })}
        </scrollbox>
      </box>

      {/* Right Area: Preview Pane */}
      <box
        style={{
          flexGrow: 1,
          height: "100%",
          border: true,
          borderColor: "#4bc5a3",
          flexDirection: "column",
          paddingLeft: 1
        }}
        title={`Preview: ${isGlobal ? "Entire Run" : selectedNode?.nodeId} [Hit Enter to Deep Inspect]`}
      >
        <text style={{ color: "yellow" }}>State: {isGlobal ? runData.status : selectedNode?.state}</text>
        {isGlobal && branchInfo && (
          <text style={{ color: "magenta" }}>
            Fork: from {branchInfo.parentRunId?.slice(0, 12)} frame {branchInfo.parentFrameNo}{branchInfo.branchLabel ? ` [${branchInfo.branchLabel}]` : ""}
          </text>
        )}
        {isGlobal && childBranches.length > 0 && (
          <text style={{ color: "cyan" }}>
            Branches: {childBranches.length} fork{childBranches.length !== 1 ? "s" : ""} ({childBranches.map((b: any) => b.branchLabel || b.runId?.slice(0, 8)).join(", ")})
          </text>
        )}
        {tokensStr && <text style={{ color: "cyan" }}>{tokensStr}</text>}
        <text style={{ color: "gray", marginTop: 1 }}>--- Terminal Output Snippet ---</text>
        <scrollbox style={{ flexGrow: 1, width: "100%", marginTop: 1 }}>
          <text>{truncatedOutput}</text>
        </scrollbox>
      </box>
    </box>
  );
}
