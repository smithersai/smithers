// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SmithersDb } from "../../../db/adapter.js";
import type { SelectOption } from "@opentui/core";
import { formatAge } from "../../format.js";

export function CronList({
  adapter,
  onBack,
}: {
  adapter: SmithersDb;
  onBack: () => void;
}) {
  const [crons, setCrons] = useState<any[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const jobs = await adapter.listCrons(false);
        if (mounted) setCrons(jobs as any[]);
      } catch {}
      if (mounted) setTimeout(poll, 2000);
    }
    poll();
    return () => { mounted = false; };
  }, [adapter]);

  useKeyboard(async (key) => {
    if (key.name === "escape") {
      onBack();
      return;
    }
    
    if (crons.length > 0) {
      if (key.name === "down" || key.name === "j") {
        setSelectedIndex(Math.min(crons.length - 1, selectedIndex + 1));
      } else if (key.name === "up" || key.name === "k") {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
      } else if (key.name === "backspace" || key.name === "delete") {
        const id = crons[selectedIndex].cronId;
        await adapter.deleteCron(id);
        const next = await adapter.listCrons(false);
        setCrons(next as any[]);
        setSelectedIndex(Math.max(0, Math.min(selectedIndex, next.length - 1)));
      }
    }
  });

  const selectedJob = crons[selectedIndex];

  return (
    <box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "row" }}>
      {/* Left List */}
      <box style={{ width: 45, height: "100%", borderRight: true, borderColor: "#34d399", flexDirection: "column" }}>
        <text style={{ color: "gray", marginBottom: 1 }}> Active Cron Triggers: {crons.length} </text>
        {crons.map((c, i) => (
          <text key={c.cronId} style={{ color: i === selectedIndex ? "#a7f3d0" : "white" }}>
            {i === selectedIndex ? "▶ " : "  "}{c.workflowPath.slice(0, 30)}
          </text>
        ))}
      </box>
      
      {/* Right Details */}
      <box style={{ flexGrow: 1, height: "100%", flexDirection: "column", paddingLeft: 1 }}>
        {selectedJob ? (
          <box style={{ flexDirection: "column" }}>
            <text style={{ color: "yellow" }}> Workflow: {selectedJob.workflowPath} </text>
            <text style={{ color: "#93c5fd" }}> Setup: {selectedJob.pattern} </text>
            <text style={{ color: "white", marginTop: 1 }}>
              Status: {selectedJob.enabled ? "ACTIVE" : "PAUSED"}
            </text>
            <text style={{ color: "white" }}>
              Registered: {formatAge(selectedJob.createdAtMs)}
            </text>
            <text style={{ color: "white" }}>
              Last Pired: {selectedJob.lastRunAtMs ? formatAge(selectedJob.lastRunAtMs) : "Never"}
            </text>
            <text style={{ color: "cyan" }}>
              Next Fire: {selectedJob.nextRunAtMs ? formatAge(selectedJob.nextRunAtMs) : "Pending"}
            </text>

            <box style={{ marginTop: 2, flexDirection: "column", borderTop: true, borderColor: "gray", paddingTop: 1 }}>
               <text style={{ color: "red" }}>[Backspace] Kill Trigger</text>
            </box>
            
            {selectedJob.errorJson && (
              <text style={{ color: "red", marginTop: 1 }}>
                Last Error: {selectedJob.errorJson}
              </text>
            )}
          </box>
        ) : (
          <text style={{ color: "gray" }}>No schedules found. Run `smithers cron add`.</text>
        )}
      </box>
    </box>
  );
}
