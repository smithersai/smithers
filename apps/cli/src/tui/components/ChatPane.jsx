// @ts-nocheck
import React, { useEffect, useState } from "react";
import { formatChatBlock, parseChatAttemptMeta, selectChatAttempts } from "../../chat.js";
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; runId: string; focused: boolean; filterNodeId?: string; }} value
 */
export function ChatPane({ adapter, runId, focused, filterNodeId, }) {
    const [chatLines, setChatLines] = useState([]);
    useEffect(() => {
        let mounted = true;
        async function fetchChat() {
            if (!mounted)
                return;
            try {
                const attempts = await adapter.listAttemptsForRun(runId);
                let lines = [];
                for (const attempt of attempts) {
                    if (filterNodeId && attempt.nodeId !== filterNodeId)
                        continue;
                    const meta = parseChatAttemptMeta(attempt.metaJson ?? "");
                    if (!meta.prompt && !attempt.responseText)
                        continue; // Skip empty attempts
                    if (lines.length > 0)
                        lines.push("");
                    lines.push(`=== ${attempt.nodeId} (Attempt ${attempt.attempt}, Iteration ${attempt.iteration}) ===`);
                    if (meta.prompt) {
                        lines.push(`[USER]`);
                        lines.push(...String(meta.prompt).trim().split("\n").map(l => `  ${l}`));
                        lines.push("");
                    }
                    if (attempt.responseText) {
                        lines.push(`[ASSISTANT]`);
                        lines.push(...String(attempt.responseText).trim().split("\n").map(l => `  ${l}`));
                    }
                }
                if (mounted) {
                    setChatLines(lines);
                }
            }
            catch (err) { }
            if (mounted)
                setTimeout(fetchChat, 1000);
        }
        fetchChat();
        return () => {
            mounted = false;
        };
    }, [adapter, runId]);
    return (<scrollbox focused={focused} style={{ width: "100%", height: "100%", paddingLeft: 1, paddingRight: 1 }}>
      <box flexDirection="column">
        {chatLines.map((line, index) => (<text key={index}>{line}</text>))}
        {chatLines.length === 0 && <text>No chat history available.</text>}
      </box>
    </scrollbox>);
}
