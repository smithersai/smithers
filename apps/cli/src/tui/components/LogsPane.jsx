// @ts-nocheck
import React, { useEffect, useState } from "react";
import { formatEventLine } from "../../format.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; runId: string; focused: boolean; }} value
 */
export function LogsPane({ adapter, runId, focused, }) {
    const [logs, setLogs] = useState([]);
    useEffect(() => {
        let mounted = true;
        let lastSeq = -1;
        async function fetchLogs() {
            if (!mounted)
                return;
            try {
                const events = await adapter.listEvents(runId, lastSeq, 200);
                if (mounted && events.length > 0) {
                    const run = await adapter.getRun(runId);
                    const baseMs = run?.startedAtMs ?? run?.createdAtMs ?? Date.now();
                    const newLines = events.map((e) => formatEventLine(e, baseMs));
                    lastSeq = events[events.length - 1].seq;
                    setLogs((prev) => {
                        const updated = [...prev, ...newLines];
                        // keep the last 200 lines to avoid scrollbox lag
                        return updated.slice(-200);
                    });
                }
            }
            catch (err) { }
            if (mounted)
                setTimeout(fetchLogs, 500);
        }
        fetchLogs();
        return () => {
            mounted = false;
        };
    }, [adapter, runId]);
    return (<scrollbox focused={focused} style={{ width: "100%", height: "100%", paddingLeft: 1, paddingRight: 1 }}>
      <box flexDirection="column">
        {logs.map((log, index) => (<text key={index}>{log}</text>))}
        {logs.length === 0 && <text>Loading events...</text>}
      </box>
    </scrollbox>);
}
