// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; onBack: () => void; }} value
 */
export function MetricsPane({ adapter, onBack, }) {
    const [stats, setStats] = useState({
        runsTotal: 0,
        runsFinished: 0,
        nodesTotal: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCache: 0,
        series: []
    });
    useEffect(() => {
        let mounted = true;
        async function fetchStats() {
            try {
                const [runStats] = await adapter.rawQuery(`SELECT count(*) as total, sum(case when status='finished' then 1 else 0 end) as finished FROM _smithers_runs`);
                const [nodeStats] = await adapter.rawQuery(`SELECT count(*) as total FROM _smithers_nodes`);
                const [tokenStats] = await adapter.rawQuery(`
          SELECT 
            sum(cast(json_extract(payload_json, '$.inputTokens') as integer)) as tIn,
            sum(cast(json_extract(payload_json, '$.outputTokens') as integer)) as tOut,
            sum(cast(json_extract(payload_json, '$.cacheReadTokens') as integer)) as tCache
          FROM _smithers_events 
          WHERE type = 'TokenUsageReported'
        `);
                // Last 24hr timeseries
                const nowMs = Date.now();
                const oneDayAgo = nowMs - (24 * 60 * 60 * 1000);
                const series = await adapter.rawQuery(`
          SELECT 
            strftime('%H:00', datetime(timestamp_ms/1000, 'unixepoch', 'localtime')) as hr,
            sum(cast(json_extract(payload_json, '$.inputTokens') as integer) + cast(json_extract(payload_json, '$.outputTokens') as integer)) as totalTokens
          FROM _smithers_events 
          WHERE type = 'TokenUsageReported' AND timestamp_ms > ${oneDayAgo}
          GROUP BY hr
          ORDER BY timestamp_ms ASC
          LIMIT 24
        `);
                if (mounted) {
                    setStats({
                        runsTotal: runStats?.total || 0,
                        runsFinished: runStats?.finished || 0,
                        nodesTotal: nodeStats?.total || 0,
                        tokensIn: tokenStats?.tIn || 0,
                        tokensOut: tokenStats?.tOut || 0,
                        tokensCache: tokenStats?.tCache || 0,
                        series: series || []
                    });
                }
            }
            catch (err) {
                // fail silently for telemetry
            }
        }
        fetchStats();
        const interval = setInterval(fetchStats, 5000);
        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, [adapter]);
    useKeyboard((key) => {
        if (key.name === "escape") {
            onBack();
        }
    });
    // Render Sparkline
    const maxTokens = Math.max(1, ...stats.series.map((s) => s.totalTokens || 0));
    const blocks = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const sparkline = stats.series.map((s) => {
        const val = s.totalTokens || 0;
        const idx = Math.floor((val / maxTokens) * (blocks.length - 1));
        return blocks[idx];
    }).join("");
    const labels = stats.series.map((s) => s.hr).join(" ");
    return (<box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1 }}>
      <text style={{ color: "cyan", marginBottom: 1 }}> 📊 Smithers Global Telemetry (Prometheus Rollup) </text>
      
      <box style={{ flexDirection: "row", marginBottom: 2 }}>
        <box style={{ width: 30, flexDirection: "column", borderRight: true, borderColor: "gray" }}>
           <text style={{ color: "white" }}> Lifetime Runs: </text>
           <text style={{ color: "green" }}> {stats.runsTotal} ({stats.runsFinished} completed) </text>
        </box>
        <box style={{ width: 30, flexDirection: "column", borderRight: true, borderColor: "gray", paddingLeft: 1 }}>
           <text style={{ color: "white" }}> Total Nodes Executed: </text>
           <text style={{ color: "yellow" }}> {stats.nodesTotal} tasks </text>
        </box>
        <box style={{ width: 40, flexDirection: "column", paddingLeft: 1 }}>
           <text style={{ color: "white" }}> LLM Token Throughput: </text>
           <text style={{ color: "magenta" }}> IN: {stats.tokensIn} | OUT: {stats.tokensOut} </text>
        </box>
      </box>

      <text style={{ color: "gray", marginTop: 1 }}> Token Usage (Last 24 Hours) </text>
      <box style={{ height: 6, width: "100%", flexDirection: "column", marginTop: 1, border: true, borderColor: "#34d399", paddingLeft: 1 }}>
        <text style={{ color: "cyan", marginTop: 1 }}> {sparkline || "No token telemetry to graph"} </text>
        <text style={{ color: "gray" }}> {labels} </text>
      </box>

    </box>);
}
