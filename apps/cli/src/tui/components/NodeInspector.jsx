// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { ChatPane } from "./ChatPane.jsx";
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; runId: string; node: any; onClose: () => void; }} value
 */
export function NodeInspector({ adapter, runId, node, onClose, }) {
    const [tab, setTab] = useState("snapshot");
    useKeyboard((key) => {
        if (key.name === "escape" || (key.name === "c" && key.ctrl) || key.name === "backspace") {
            onClose();
        }
        if (key.name === "1")
            setTab("snapshot");
        if (key.name === "2")
            setTab("chat");
    });
    return (<box style={{
            width: "90%",
            height: "90%",
            border: true,
            borderColor: "magenta",
            position: "absolute",
            top: "5%",
            left: "5%",
            flexDirection: "column",
            backgroundColor: "black",
        }} title={`[Esc to Close] Node Inspector: ${node.nodeId} | ${tab === "snapshot" ? "[(1) Snapshot]  (2) Chat" : " (1) Snapshot  [(2) Chat]"}`}>
      {tab === "snapshot" ? (<scrollbox style={{ width: "100%", height: "100%", flexDirection: "column", padding: 1 }}>
          <text style={{ color: "yellow" }}>
            <strong>Input Data:</strong>
          </text>
          <text>{node.inputData ? JSON.stringify(JSON.parse(node.inputData), null, 2) : "None"}</text>
          <box style={{ height: 1 }}/>
          <text style={{ color: "yellow" }}>
            <strong>Output Data:</strong>
          </text>
          <text>{node.outputData ? JSON.stringify(JSON.parse(node.outputData), null, 2) : "None"}</text>
          <box style={{ height: 1 }}/>
          <text style={{ color: "yellow" }}>
            <strong>Metadata:</strong>
          </text>
          <text>{`Iteration: ${node.iteration}  |  Attempts: ${node.attempts ?? 0}  |  State: ${node.state}`}</text>
        </scrollbox>) : (<box style={{ flexGrow: 1, width: "100%", height: "100%" }}>
          <ChatPane adapter={adapter} runId={runId} focused={true} filterNodeId={node.nodeId}/>
        </box>)}
    </box>);
}
