// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; runId: string; focused: boolean; filterNodeId?: string; nodeAttempt?: any; }} value
 */
export function FramesPane({ adapter, runId, focused, filterNodeId, nodeAttempt, }) {
    const [frames, setFrames] = useState([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    useEffect(() => {
        let mounted = true;
        async function fetchFrames() {
            if (!mounted)
                return;
            try {
                // limit(500) to ensure we get a chunk safely, reverse to ASCENDING chronological order
                const data = await adapter.listFrames(runId, 500);
                if (mounted && data.length > 0) {
                    const ascData = data.slice().reverse();
                    setFrames(ascData);
                    if (frames.length === 0) {
                        setSelectedIndex(ascData.length - 1); // default to newest frame (bottom)
                    }
                }
            }
            catch (err) { }
            if (mounted)
                setTimeout(fetchFrames, 2000); // Polling for live updates
        }
        fetchFrames();
        return () => {
            mounted = false;
        };
    }, [adapter, runId]);
    let displayFrames = frames;
    if (filterNodeId && nodeAttempt && frames.length > 0) {
        const sMs = nodeAttempt.startedAtMs ?? 0;
        const fMs = nodeAttempt.finishedAtMs;
        const beforeF = frames.slice().reverse().find(f => f.createdAtMs <= sMs) || frames[0];
        const afterF = fMs ? (frames.find(f => f.createdAtMs >= fMs) || frames[frames.length - 1]) : frames[frames.length - 1];
        displayFrames = frames.map(f => {
            if (f.frameNo === beforeF.frameNo && f.frameNo === afterF.frameNo) {
                return { ...f, uiLabel: "Frame (Active)" };
            }
            if (f.frameNo === beforeF.frameNo)
                return { ...f, uiLabel: "Frame (Before)" };
            if (f.frameNo === afterF.frameNo)
                return { ...f, uiLabel: "Frame (After)" };
            return f;
        });
    }
    useKeyboard((key) => {
        if (!focused || displayFrames.length === 0)
            return;
        if (key.name === "up" || key.name === "k") {
            setSelectedIndex((s) => Math.max(0, s - 1));
        }
        if (key.name === "down" || key.name === "j") {
            setSelectedIndex((s) => Math.min(s + 1, displayFrames.length - 1));
        }
    });
    if (displayFrames.length === 0) {
        return <text style={{ paddingLeft: 1 }}>No frame history available...</text>;
    }
    // Bound check in case selectedIndex drifted
    const validIndex = Math.max(0, Math.min(selectedIndex, displayFrames.length - 1));
    const selectedFrame = displayFrames[validIndex];
    // Recursive formatter to convert `xmlJson` into a JSX code block
    /**
   * @param {any} node
   * @param {number} [indent]
   * @returns {string}
   */
    function formatJsxNode(node, indent = 0) {
        if (!node || typeof node !== "object")
            return "";
        const space = "  ".repeat(indent);
        if (node.kind === "text") {
            const escaped = String(node.text || "").replace(/\n/g, `\n${space}`);
            return `${space}${escaped}`;
        }
        if (node.kind === "element" && typeof node.tag === "string") {
            let propsStr = "";
            if (node.props && typeof node.props === "object") {
                for (const [k, v] of Object.entries(node.props)) {
                    if (typeof v === "string")
                        propsStr += ` ${k}="${v.replace(/"/g, '&quot;')}"`;
                    else
                        propsStr += ` ${k}={${JSON.stringify(v)}}`;
                }
            }
            const tag = node.tag;
            const isTargetNode = filterNodeId && node.props?.id === filterNodeId;
            const colorPrefix = isTargetNode ? "👉 " : "";
            if (!Array.isArray(node.children) || node.children.length === 0) {
                return `${space}${colorPrefix}<${tag}${propsStr} />`;
            }
            let res = `${space}${colorPrefix}<${tag}${propsStr}>\n`;
            for (const child of node.children) {
                res += formatJsxNode(child, indent + 1) + "\n";
            }
            res += `${space}</${tag}>`;
            return res;
        }
        // Fallback if neither text nor element
        return `${space}${JSON.stringify(node)}`;
    }
    let xmlString = "Empty Frame";
    try {
        if (selectedFrame?.xmlJson) {
            const parsed = typeof selectedFrame.xmlJson === "string" ? JSON.parse(selectedFrame.xmlJson) : selectedFrame.xmlJson;
            xmlString = formatJsxNode(parsed);
        }
    }
    catch (err) {
        xmlString = `[Format Error: ${err?.message}]\n\n${selectedFrame?.xmlJson ?? "Parse error"}`;
    }
    return (<box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "row" }}>
      {/* Left Sidebar: Frame List */}
      <box style={{
            width: 30,
            height: "100%",
            borderRight: true,
            borderColor: "#34d399",
            flexDirection: "column",
        }} title={`Timeline [Up/Down]`}>
        <scrollbox style={{ width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1 }}>
          {displayFrames.map((frame, i) => {
            const isSelected = validIndex === i;
            const label = frame.uiLabel ? `${frame.uiLabel}` : `Frame ${frame.frameNo}`;
            return (<text key={frame.frameNo + label} style={{ color: isSelected ? "green" : "white" }}>
                {isSelected ? "▶ " : "  "}{label}
              </text>);
        })}
        </scrollbox>
      </box>

      {/* Right Content: XML/JSX Dump */}
      <box style={{ flexGrow: 1, height: "100%", flexDirection: "column" }}>
        <scrollbox style={{ width: "100%", height: "100%", paddingLeft: 1 }}>
          <text style={{ color: "#d8b4e2" }}>{xmlString}</text>
        </scrollbox>
      </box>
    </box>);
}
