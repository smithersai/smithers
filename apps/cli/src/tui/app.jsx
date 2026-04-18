// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { RunsList } from "./components/RunsList.jsx";
import { WorkflowLauncher } from "./components/WorkflowLauncher.jsx";
import { RunDetailView } from "./components/RunDetailView.jsx";
import { NodeDetailView } from "./components/NodeDetailView.jsx";
import { AskModal } from "./components/AskModal.jsx";
import { SqliteBrowser } from "./components/SqliteBrowser.jsx";
import { CronList } from "./components/CronList.jsx";
import { MetricsPane } from "./components/MetricsPane.jsx";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

const TABS = [
    { id: "runs", label: "Runs", access: "r" },
    { id: "ask", label: "Agent Console", access: "a" },
    { id: "crons", label: "Triggers", access: "t" },
    { id: "metrics", label: "Telemetry", access: "m" },
    { id: "sqlite", label: "Data Grid", access: "s" },
];
/**
 * @param {{ adapter: SmithersDb; onExit: () => void; }} value
 */
export function TuiApp({ adapter, onExit, }) {
    const [view, setView] = useState("runs");
    const [selectedRunId, setSelectedRunId] = useState(null);
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const activeTabId = (view === "detail" || view === "node" || view === "launcher") ? "runs" : view;
    useKeyboard(async (key) => {
        // Tab switching
        if (key.name === "left" || key.name === "right") {
            // only accept left/right at the root view so we don't clobber text inputs
            if (view === "runs" || view === "crons" || view === "metrics") {
                const currentIndex = TABS.findIndex((t) => t.id === activeTabId);
                if (key.name === "right") {
                    const next = TABS[(currentIndex + 1) % TABS.length];
                    setView(next.id);
                }
                else {
                    const prev = TABS[(currentIndex - 1 + TABS.length) % TABS.length];
                    setView(prev.id);
                }
                return;
            }
        }
        if (key.name === "s" && view !== "sqlite" && view !== "ask") {
            setView("sqlite");
            return;
        }
        if (key.name === "t" && view !== "crons" && view !== "ask") {
            setView("crons");
            return;
        }
        if (key.name === "m" && view !== "metrics" && view !== "ask") {
            setView("metrics");
            return;
        }
        if (view === "runs") {
            if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
                onExit();
            }
            if (key.name === "n") {
                setView("launcher");
            }
            if (key.name === "a") {
                setView("ask");
            }
        }
        else if (view === "detail") {
            if (key.name === "escape") {
                setView("runs");
            }
            else if (key.name === "c" && key.ctrl) {
                onExit();
            }
        }
        else if (view === "node") {
            if (key.name === "escape") {
                setView("detail");
            }
            else if (key.name === "c" && key.ctrl) {
                onExit();
            }
        }
        else if (view === "launcher") {
            if (key.name === "escape") {
                setView("runs");
            }
            else if (key.name === "c" && key.ctrl) {
                onExit();
            }
        }
        else if (view === "ask") {
            if (key.name === "escape") {
                setView("runs");
            }
            else if (key.name === "c" && key.ctrl) {
                onExit();
            }
        }
    });
    return (<box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "column" }}>
      {/* Global Tab Header */}
      <box style={{ width: "100%", height: 3, borderBottom: true, borderColor: "gray", flexDirection: "row", paddingLeft: 1 }}>
        {TABS.map((tab) => {
            const isActive = activeTabId === tab.id;
            return (<text key={tab.id} style={{ color: isActive ? "#a7f3d0" : "gray", marginRight: 3 }}>
              {isActive ? "▶ " : "  "}[{tab.access.toUpperCase()}] {tab.label}
            </text>);
        })}
      </box>

      {view === "runs" && (<box style={{ flexGrow: 1, width: "100%", height: "100%", border: true, borderColor: "#34d399", flexDirection: "column" }} title="Smithers Runs - [Enter] View Details | [N] New Run | [Esc] Exit">
          <RunsList adapter={adapter} focused={view === "runs"} onChange={setSelectedRunId} onSubmit={(runId) => {
                setSelectedRunId(runId);
                setView("detail");
            }}/>
        </box>)}

      {view === "detail" && selectedRunId && (<RunDetailView adapter={adapter} runId={selectedRunId} onBack={() => setView("runs")} onSelectNode={(nodeId) => {
                setSelectedNodeId(nodeId);
                setView("node");
            }}/>)}

      {view === "node" && selectedRunId && (<NodeDetailView adapter={adapter} runId={selectedRunId} nodeId={selectedNodeId} onBack={() => setView("detail")}/>)}

      {view === "launcher" && (<WorkflowLauncher onClose={() => setView("runs")}/>)}
      {view === "ask" && (<AskModal onClose={() => setView("runs")}/>)}
      {view === "sqlite" && (<box style={{ flexGrow: 1, width: "100%", height: "100%", border: true, borderColor: "#34d399", flexDirection: "column" }} title="Smithers DB - [Esc] Return to Runs | [Tab] Switch Panes | [Up/Down] Query Table">
          <SqliteBrowser adapter={adapter} onBack={() => setView("runs")}/>
        </box>)}
      {view === "crons" && (<box style={{ flexGrow: 1, width: "100%", height: "100%", border: true, borderColor: "#34d399", flexDirection: "column" }} title="Smithers Schedule Triggers - [Esc] Return to Runs | [Up/Down] Select | [Del] Remove">
          <CronList adapter={adapter} onBack={() => setView("runs")}/>
        </box>)}
      {view === "metrics" && (<box style={{ flexGrow: 1, width: "100%", height: "100%", border: true, borderColor: "#34d399", flexDirection: "column" }} title="Smithers Telemetry (Prometheus Rollup) - [Esc] Return to Runs">
          <MetricsPane adapter={adapter} onBack={() => setView("runs")}/>
        </box>)}
    </box>);
}
