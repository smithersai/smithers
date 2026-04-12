// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; runId: string; focused: boolean; onInspectNode?: (node: any) => void; }} value
 */
export function DetailsPane({ adapter, runId, focused, onInspectNode, }) {
    const [nodes, setNodes] = useState([]);
    const [runData, setRunData] = useState(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    useEffect(() => {
        let mounted = true;
        let timeout;
        async function fetchDetails() {
            if (!mounted)
                return;
            try {
                const run = await adapter.getRun(runId);
                const fetchedNodes = await adapter.listNodes(runId);
                if (mounted) {
                    setRunData(run);
                    setNodes(fetchedNodes);
                    setSelectedIndex((prev) => Math.min(prev, Math.max(0, fetchedNodes.length - 1)));
                }
            }
            catch (err) { }
            if (mounted)
                timeout = setTimeout(fetchDetails, 1000);
        }
        fetchDetails();
        return () => {
            mounted = false;
            clearTimeout(timeout);
        };
    }, [adapter, runId]);
    useKeyboard((key) => {
        if (!focused)
            return;
        if (key.name === "down" || key.name === "j") {
            setSelectedIndex((s) => Math.min(s + 1, Math.max(0, nodes.length - 1)));
        }
        if (key.name === "up" || key.name === "k") {
            setSelectedIndex((s) => Math.max(0, s - 1));
        }
        if (key.name === "enter" || key.name === "return") {
            if (nodes[selectedIndex] && onInspectNode) {
                onInspectNode(nodes[selectedIndex]);
            }
        }
    });
    if (!runData) {
        return <text style={{ margin: 1 }}>Loading details...</text>;
    }
    return (<scrollbox focused={focused} style={{ width: "100%", height: "100%", padding: 1 }}>
      <box flexDirection="column">
        <text>
          <strong>Status:</strong>{" "}
          <span fg={runData.status === "finished"
            ? "green"
            : runData.status === "failed"
                ? "red"
                : runData.status === "running"
                    ? "#34d399"
                    : "yellow"}>
            {runData.status}
          </span>
        </text>
        <text>
          <strong>Input Payload:</strong>
        </text>
        <text>{runData.inputData ? runData.inputData.substring(0, 100) + "..." : "None"}</text>

        {runData.outputData && (<>
            <box style={{ height: 1 }}/>
            <text>
              <strong>Final Output:</strong>
            </text>
            <text>{runData.outputData.substring(0, 100) + "..."}</text>
          </>)}

        <box style={{ height: 1 }}/>
        <text style={{ color: focused ? "yellow" : "white" }}>
          <strong>Nodes [Press Enter on Node to Inspect]:</strong>
        </text>
        
        {nodes.map((node, i) => {
            const isSelected = focused && selectedIndex === i;
            return (<text key={`${node.runId}-${node.nodeId}-${node.iteration}`} style={{ color: isSelected ? "green" : "white" }}>
              {isSelected ? "▶ " : "  "}{node.nodeId}: {node.state} (Att: {node.attempts ?? 0}, Iter: {node.iteration})
            </text>);
        })}
      </box>
    </scrollbox>);
}
