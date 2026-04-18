// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { ChatPane } from "./ChatPane.jsx";
import { LogsPane } from "./LogsPane.jsx";
import { FramesPane } from "./FramesPane.jsx";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; runId: string; nodeId: string | null; // null means "Global Run" onBack: () => void; }} value
 */
export function NodeDetailView({ adapter, runId, nodeId, onBack, }) {
    const [runData, setRunData] = useState(null);
    const [nodeData, setNodeData] = useState(null);
    const [attempts, setAttempts] = useState([]);
    const [events, setEvents] = useState([]);
    const [rawOutput, setRawOutput] = useState(null);
    const [scorerResults, setScorerResults] = useState([]);
    const [tab, setTab] = useState("output");
    useEffect(() => {
        let mounted = true;
        let timeout;
        async function fetchDetails() {
            if (!mounted)
                return;
            try {
                const run = await adapter.getRun(runId);
                const fetchedAttempts = await adapter.listAttemptsForRun(runId);
                const fetchedEvents = await adapter.listEvents(runId, -1, 10000);
                let fetchedNode = null;
                let fetchedRawOutput = null;
                if (nodeId) {
                    const nodes = await adapter.listNodes(runId);
                    fetchedNode = nodes.find(n => n.nodeId === nodeId) || null;
                    if (fetchedNode?.outputTable) {
                        fetchedRawOutput = await adapter.getRawNodeOutput(fetchedNode.outputTable, runId, nodeId);
                    }
                }
                let fetchedScores = [];
                try {
                    fetchedScores = await adapter.listScorerResults(runId, nodeId ?? undefined);
                }
                catch { }
                if (mounted) {
                    setRunData(run);
                    setNodeData(fetchedNode);
                    setAttempts(fetchedAttempts);
                    setEvents(fetchedEvents);
                    setRawOutput(fetchedRawOutput);
                    setScorerResults(fetchedScores ?? []);
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
    }, [adapter, runId, nodeId]);
    const isGlobal = nodeId === null;
    useKeyboard((key) => {
        if (key.name === "escape" || (key.name === "c" && key.ctrl) || key.name === "backspace") {
            onBack();
            return;
        }
        if (key.name === "r" && !isGlobal && latestAttempt) {
            Bun.spawn([
                "bun", "run", "src/index.js", "revert",
                "--runId", runId,
                "--nodeId", nodeId,
                "--attempt", latestAttempt.attempt.toString(),
                "--iteration", latestAttempt.iteration.toString()
            ], { stdout: "ignore", stderr: "ignore" }).unref();
            return;
        }
        const tabList = ["input", "output", "frames", "chat", "logs", "scores"];
        if (key.name === "left" || key.name === "h") {
            setTab((prev) => tabList[(tabList.indexOf(prev) - 1 + tabList.length) % tabList.length]);
            return;
        }
        if (key.name === "right" || key.name === "l") {
            setTab((prev) => tabList[(tabList.indexOf(prev) + 1) % tabList.length]);
            return;
        }
        if (key.name === "1")
            setTab("input");
        if (key.name === "2")
            setTab("output");
        if (key.name === "3")
            setTab("frames");
        if (key.name === "4")
            setTab("chat");
        if (key.name === "5")
            setTab("logs");
        if (key.name === "6")
            setTab("scores");
    });
    if (!runData) {
        return <text style={{ margin: 1 }}>Loading inspection data...</text>;
    }
    /**
   * @param {string} [jsonStr]
   */
    function safePretty(jsonStr) {
        if (!jsonStr)
            return "None";
        try {
            return JSON.stringify(JSON.parse(jsonStr), null, 2);
        }
        catch {
            return jsonStr.substring(0, 10000); // RAW String output
        }
    }
    const targetAttempts = isGlobal ? [] : attempts.filter((a) => a.nodeId === nodeId).sort((a, b) => b.attempt - a.attempt);
    const latestAttempt = targetAttempts.length > 0 ? targetAttempts[0] : null;
    let inputData = isGlobal ? runData.configJson : "Inputs are dynamically constructed. No static properties were captured for this task frame.";
    if (!isGlobal && latestAttempt?.metaJson) {
        try {
            const meta = JSON.parse(latestAttempt.metaJson);
            const { inputPrompt, systemPrompt, agentId, model, config, approvalMode, ...rest } = meta;
            let str = "[ Agent Configuration ]\n";
            if (agentId || model)
                str += `Agent: ${agentId ?? "unknown"}  |  Model: ${model ?? "default"}\n`;
            if (approvalMode)
                str += `Approval Mode: ${approvalMode}\n`;
            if (config) {
                try {
                    str += `Config: ${JSON.stringify(config)}\n`;
                }
                catch {
                    str += `Config: ${String(config)}\n`;
                }
            }
            if (systemPrompt)
                str += `\n[ System Prompt ]\n${systemPrompt}\n`;
            if (inputPrompt)
                str += `\n[ Input Prompt ]\n${inputPrompt}\n`;
            if (Object.keys(rest).length)
                str += `\n[ Other Meta Options ]\n${JSON.stringify(rest, null, 2)}`;
            inputData = str;
        }
        catch (err) {
            inputData = `Failed to parse metadata: ${err.message}\nRaw JSON:\n${latestAttempt.metaJson}`;
        }
    }
    let outputData = "No output text available yet.";
    if (isGlobal) {
        if (runData.errorJson) {
            outputData = `ERROR:\n${runData.errorJson}`;
        }
        else if (runData.status === "finished") {
            outputData = "Run completed successfully (no global errorJson stacktrace was captured).\n\nPress [Enter] to inspect individual task payloads.";
        }
        else if (runData.status === "failed") {
            outputData = "Workflow failed (no global errorJson stacktrace was captured).\n\nPress [Enter] to inspect and determine which individual task node crashed.";
        }
        else {
            outputData = "Workflow is still active or pending execution...";
        }
    }
    else {
        if (latestAttempt?.errorJson) {
            outputData = `ERROR:\n${latestAttempt.errorJson}`;
        }
        else if (rawOutput) {
            try {
                const cleanOutput = { ...rawOutput };
                delete cleanOutput.run_id;
                delete cleanOutput.node_id;
                delete cleanOutput.iteration;
                // Attempt to parse internal stringified JSON fields for display
                for (const [k, v] of Object.entries(cleanOutput)) {
                    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
                        try {
                            cleanOutput[k] = JSON.parse(v);
                        }
                        catch { }
                    }
                }
                outputData = JSON.stringify(cleanOutput);
            }
            catch {
                outputData = JSON.stringify(rawOutput);
            }
        }
        else {
            outputData = latestAttempt?.responseText ?? "No output text available yet.";
        }
    }
    let tokensStr = "";
    if (!isGlobal && nodeId) {
        const usageEvent = events.find((e) => e.type === "TokenUsageReported" && e.nodeId === nodeId && e.attempt === latestAttempt?.attempt);
        if (usageEvent) {
            try {
                const payload = JSON.parse(usageEvent.payloadJson);
                tokensStr = ` \n    Tokens: ${payload.inputTokens} IN | ${payload.outputTokens} OUT | ${payload.cacheReadTokens ?? 0} CACHE`;
            }
            catch { }
        }
    }
    else if (isGlobal) {
        let tIn = 0, tOut = 0, tCache = 0;
        for (const e of events) {
            if (e.type === "TokenUsageReported") {
                try {
                    const p = JSON.parse(e.payloadJson);
                    tIn += (p.inputTokens ?? 0);
                    tOut += (p.outputTokens ?? 0);
                    tCache += (p.cacheReadTokens ?? 0);
                }
                catch { }
            }
        }
        tokensStr = ` \n    Total Run Tokens: ${tIn} IN | ${tOut} OUT | ${tCache} CACHE`;
    }
    let bodyContent = null;
    if (tab === "input") {
        bodyContent = (<scrollbox style={{ width: "100%", height: "100%", paddingLeft: 1 }}>
        <text>{safePretty(inputData)}</text>
      </scrollbox>);
    }
    else if (tab === "output") {
        bodyContent = (<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
        <scrollbox style={{ flexGrow: 1, width: "100%", paddingLeft: 1 }}>
          <text>{safePretty(outputData)}</text>
        </scrollbox>
        {tokensStr && (<box style={{ width: "100%", height: 2, borderTop: true, borderColor: "gray" }}>
            <text style={{ color: "yellow" }}>{tokensStr}</text>
          </box>)}
      </box>);
    }
    else if (tab === "frames") {
        bodyContent = (<FramesPane adapter={adapter} runId={runId} focused={true} filterNodeId={nodeId ?? undefined} nodeAttempt={latestAttempt ?? undefined}/>);
    }
    else if (tab === "chat") {
        bodyContent = (<ChatPane adapter={adapter} runId={runId} focused={true} filterNodeId={nodeId ?? undefined}/>);
    }
    else if (tab === "logs") {
        bodyContent = (<LogsPane adapter={adapter} runId={runId} focused={true}/>);
    }
    else if (tab === "scores") {
        let scoresText = "No scorer results available.";
        if (scorerResults.length > 0) {
            const lines = scorerResults.map((r) => {
                const scoreVal = typeof r.score === "number" ? r.score.toFixed(2) : String(r.score);
                return `  ${r.scorerName ?? r.scorer_name ?? "unknown"}: ${scoreVal}  ${r.reason ?? ""}`;
            });
            scoresText = `Scorer Results (${scorerResults.length}):\n\n${lines.join("\n")}`;
        }
        bodyContent = (<scrollbox style={{ width: "100%", height: "100%", paddingLeft: 1 }}>
        <text>{scoresText}</text>
      </scrollbox>);
    }
    /**
   * @param {string} num
   * @param {string} label
   * @param {string} expectedTab
   */
    const getTabLabel = (num, label, expectedTab) => {
        return tab === expectedTab ? `[(${num}) ${label}]` : ` (${num}) ${label} `;
    };
    const header = `Task Inspector: ${isGlobal ? "Entire Run" : nodeId}`;
    const tabs = `${getTabLabel("1", "Input", "input")} | ${getTabLabel("2", "Output", "output")} | ${getTabLabel("3", "Frames", "frames")} | ${getTabLabel("4", "Chat", "chat")} | ${getTabLabel("5", "Logs", "logs")} | ${getTabLabel("6", "Scores", "scores")}`;
    const escLabel = !isGlobal && latestAttempt ? "[R] Revert State | [Esc] Back" : "[Esc] Back";
    try {
        return (<box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "column" }}>
          <box style={{ width: "100%", height: 3, border: true, borderColor: "#3b82f6", flexDirection: "row", justifyContent: "space-between" }}>
            <text style={{ color: "white", paddingLeft: 1, fontWeight: "bold" }}>{header}</text>
            <text style={{ color: "#93c5fd", paddingRight: 1 }}>{tabs}  {escLabel}</text>
          </box>

          <box style={{ flexGrow: 1, width: "100%", border: true, borderColor: "#60a5fa", flexDirection: "column" }}>
            {bodyContent}
          </box>
        </box>);
    }
    catch (err) {
        require("fs").writeFileSync("/tmp/tui-crash.log", err?.stack || err?.message || String(err));
        throw err;
    }
}
