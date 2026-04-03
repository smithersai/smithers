// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SmithersDb } from "../../../db/adapter.js";
import type { SelectOption } from "@opentui/core";
import { formatAge } from "../../format.js";
import { basename } from "node:path";

export function RunsList({
  adapter,
  focused,
  onChange,
  onSubmit,
}: {
  adapter: SmithersDb;
  focused: boolean;
  onChange: (runId: string) => void;
  onSubmit: (runId: string) => void;
}) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterMode, setFilterMode] = useState<"all" | "pending">("all");
  const [selectedRunStats, setSelectedRunStats] = useState<any>(null);

  useEffect(() => {
    let mounted = true;

    async function pollRuns() {
      if (!mounted) return;
      try {
        const fetchedRuns = await adapter.listRuns(20, filterMode === "pending" ? "waiting-approval" : undefined);
        if (mounted) {
          setRuns(fetchedRuns);
          if (fetchedRuns.length > 0 && selectedIndex === 0) {
            // Auto select the first run initially if nothing was selected
            // But we don't want to call onSelect constantly, so we'll just let the list render.
          }
        }
      } catch (err) {}
      if (mounted) setTimeout(pollRuns, 1000);
    }

    pollRuns();
    return () => {
      mounted = false;
    };
  }, [adapter, selectedIndex, filterMode]);

  useEffect(() => {
    if (runs.length > 0) {
      onChange(runs[selectedIndex]?.runId ?? runs[0].runId);
    }
  }, [runs, selectedIndex, onChange]);

  const selectedRun = runs[selectedIndex];

  useEffect(() => {
    let mounted = true;
    if (!selectedRun) {
      setSelectedRunStats(null);
      return;
    }
    
    async function fetchStats() {
      try {
        const events = await adapter.listEvents(selectedRun.runId, -1, 10000);
        const nodes = await adapter.listNodes(selectedRun.runId);
        
        let tIn = 0, tOut = 0, tCache = 0;
        for (const e of (events as any[])) {
          if (e.type === "TokenUsageReported") {
            try {
              const p = JSON.parse(e.payloadJson);
              tIn += (p.inputTokens ?? 0);
              tOut += (p.outputTokens ?? 0);
              tCache += (p.cacheReadTokens ?? 0);
            } catch {}
          }
        }
        
        const sMs = selectedRun.startedAtMs || selectedRun.createdAtMs;
        const durationMs = selectedRun.finishedAtMs && sMs
          ? selectedRun.finishedAtMs - sMs
          : sMs ? Date.now() - sMs : 0;
          
        if (mounted) {
          setSelectedRunStats({
            tokensIn: tIn,
            tokensOut: tOut,
            tokensCache: tCache,
            durationMs,
            nodeCount: (nodes as any[]).length,
          });
        }
      } catch {}
    }
    fetchStats();
    return () => { mounted = false; };
  }, [adapter, selectedRun?.runId]);

  useKeyboard((key) => {
    if (!focused) return;
    
    if (key.name === "p" || key.name === "P") {
      setFilterMode((m) => m === "all" ? "pending" : "all");
      setSelectedIndex(0);
      return;
    }

    if (runs[selectedIndex]) {
      const runId = runs[selectedIndex].runId;
      const status = runs[selectedIndex].status;

      if (key.name === "enter" || key.name === "return") {
        onSubmit(runId);
        return;
      }
      if (key.name === "y" && status === "waiting-approval") {
        Bun.spawn(["bun", "run", "src/cli/index.ts", "approve", runId], { stdout: "ignore", stderr: "ignore" }).unref();
        return;
      }
      if (key.name === "d" && status === "waiting-approval") {
        Bun.spawn(["bun", "run", "src/cli/index.ts", "deny", runId], { stdout: "ignore", stderr: "ignore" }).unref();
        return;
      }
      if (key.name === "c" && status === "running") {
        Bun.spawn(["bun", "run", "src/cli/index.ts", "cancel", runId], { stdout: "ignore", stderr: "ignore" }).unref();
        return;
      }
      if (key.name === "r" && (status === "failed" || status === "cancelled")) {
        const path = runs[selectedIndex].workflowPath;
        if (path) {
          Bun.spawn(["bun", "run", "src/cli/index.ts", "up", path, "--resume", "--runId", runId, "-d"], { stdout: "ignore", stderr: "ignore" }).unref();
        }
        return;
      }
    }
    if (key.name === "k") {
      Bun.spawn(["bun", "run", "src/cli/index.ts", "down"], { stdout: "ignore", stderr: "ignore" }).unref();
      return;
    }
  });

  const options: SelectOption[] = runs.map((run) => {
    const workflowName = run.workflowName ?? (run.workflowPath ? basename(run.workflowPath) : "—");
    const started = run.startedAtMs ? formatAge(run.startedAtMs) : run.createdAtMs ? formatAge(run.createdAtMs) : "—";
    
    return {
      name: `${workflowName} (${run.status})`,
      description: `${run.runId.slice(-6)} - ${started}`,
      value: run.runId,
    };
  });

  if (runs.length === 0) {
    return <text style={{ margin: 1 }}>No runs found.</text>;
  }

  let truncatedOutput = selectedRun?.errorJson;
  if (!truncatedOutput) {
    if (selectedRun?.status === "finished") {
      truncatedOutput = "Run completed successfully without generic failure traces.\nPress [Enter] to inspect individual task payloads.";
    } else if (selectedRun?.status === "failed") {
      truncatedOutput = "Workflow failed, but no global error stack trace was captured. Press [Enter] to inspect which individual node crashed.";
    } else {
      truncatedOutput = "Workflow is still active or pending execution...";
    }
  }

  if (truncatedOutput.length > 500) {
    const head = truncatedOutput.substring(0, 200);
    const tail = truncatedOutput.substring(truncatedOutput.length - 200);
    truncatedOutput = `${head}\n\n... [ TRUNCATED ${truncatedOutput.length - 400} CHARACTERS ] ...\n\n${tail}`;
  }

  return (
    <box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "row" }}>
      {/* Left List */}
      <box style={{ width: 40, height: "100%", borderRight: true, borderColor: "#34d399", flexDirection: "column" }}>
        <select
          style={{ width: "100%", height: "100%" }}
          options={options}
          focused={focused}
          onChange={(index) => {
            setSelectedIndex(index);
          }}
          textColor="#E2E8F0"
          selectedTextColor="#34d399"
          selectedBackgroundColor="#1f2937"
          descriptionColor="#9ca3af"
          selectedDescriptionColor="#a7f3d0"
          showScrollIndicator
          wrapSelection
        />
      </box>
      
      {/* Right Preview */}
      <box style={{ flexGrow: 1, height: "100%", flexDirection: "column", paddingLeft: 1 }}>
        <text style={{ color: "yellow" }}>State: {selectedRun?.status}</text>
        {selectedRunStats && (
            <text style={{ color: "#a855f7", marginTop: 1 }}>
              ⏱️ {(selectedRunStats.durationMs / 1000).toFixed(1)}s  |  🧩 {selectedRunStats.nodeCount} Tasks  |  🪙 {selectedRunStats.tokensIn} IN, {selectedRunStats.tokensOut} OUT, {selectedRunStats.tokensCache} CACHE
            </text>
        )}
        <text style={{ color: "gray", marginTop: 1 }}>--- Run Status / Error Summary ---</text>
        <scrollbox style={{ flexGrow: 1, width: "100%", marginTop: 1 }}>
          <text>{truncatedOutput}</text>
        </scrollbox>

        {/* Action Footer */}
        <box style={{ width: "100%", height: 3, borderTop: true, borderColor: "gray", flexDirection: "column" }}>
            <text style={{ color: "#93c5fd" }}>{filterMode === "all" ? "[P] Filter: Show Pending Approvals Only" : "[P] Filter: Show All Workflows"}</text>
            {selectedRun?.status === "waiting-approval" && <text style={{ color: "green" }}>[Y] Approve  |  [D] Deny Human Task</text>}
            {selectedRun?.status === "running" && <text style={{ color: "red" }}>[C] Safely Cancel/Halt Workflow  |  [K] Kill All Active Workflows</text>}
            {(selectedRun?.status === "failed" || selectedRun?.status === "cancelled") && <text style={{ color: "yellow" }}>[R] Resume from latest checkpoint</text>}
        </box>
      </box>
    </box>
  );
}
