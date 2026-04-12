import { formatTimestamp } from "./format.js";
/** @typedef {import("./chat.ts").chat} chat */

/** @typedef {import("./chat.ts").ChatAttemptMeta} ChatAttemptMeta */
/** @typedef {import("./chat.ts").ChatAttemptRow} ChatAttemptRow */
/** @typedef {import("./chat.ts").ChatOutputEvent} ChatOutputEvent */
/** @typedef {import("./chat.ts").ParsedNodeOutputEvent} ParsedNodeOutputEvent */

/**
 * @param {string | null} [metaJson]
 * @returns {ChatAttemptMeta}
 */
export function parseChatAttemptMeta(metaJson) {
    if (!metaJson)
        return {};
    try {
        const parsed = JSON.parse(metaJson);
        if (!parsed || typeof parsed !== "object")
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
/**
 * @param {Pick<ChatAttemptRow, "nodeId" | "iteration" | "attempt">} attempt
 */
export function chatAttemptKey(attempt) {
    return `${attempt.nodeId}:${attempt.iteration}:${attempt.attempt}`;
}
/**
 * @param {ChatOutputEvent} event
 * @returns {ParsedNodeOutputEvent | null}
 */
export function parseNodeOutputEvent(event) {
    if (event.type !== "NodeOutput")
        return null;
    try {
        const payload = JSON.parse(event.payloadJson);
        if (!payload || typeof payload !== "object")
            return null;
        const text = typeof payload.text === "string" ? payload.text : "";
        const stream = payload.stream === "stderr" ? "stderr" : "stdout";
        if (!text)
            return null;
        return {
            seq: event.seq,
            timestampMs: event.timestampMs,
            nodeId: String(payload.nodeId ?? ""),
            iteration: Number(payload.iteration ?? 0),
            attempt: Number(payload.attempt ?? 1),
            stream,
            text,
        };
    }
    catch {
        return null;
    }
}
/**
 * @param {ChatAttemptRow} attempt
 * @param {ReadonlySet<string>} outputAttemptKeys
 * @returns {boolean}
 */
export function isAgentAttempt(attempt, outputAttemptKeys) {
    const meta = parseChatAttemptMeta(attempt.metaJson);
    if (meta.kind === "agent")
        return true;
    if (attempt.responseText?.trim())
        return true;
    return outputAttemptKeys.has(chatAttemptKey(attempt));
}
/**
 * @param {ChatAttemptRow[]} attempts
 * @param {ReadonlySet<string>} outputAttemptKeys
 * @param {boolean} includeAll
 * @returns {ChatAttemptRow[]}
 */
export function selectChatAttempts(attempts, outputAttemptKeys, includeAll) {
    const agentAttempts = attempts
        .filter((attempt) => isAgentAttempt(attempt, outputAttemptKeys))
        .sort((a, b) => {
        if (a.startedAtMs !== b.startedAtMs)
            return a.startedAtMs - b.startedAtMs;
        if (a.nodeId !== b.nodeId)
            return a.nodeId.localeCompare(b.nodeId);
        if (a.iteration !== b.iteration)
            return a.iteration - b.iteration;
        return a.attempt - b.attempt;
    });
    if (includeAll)
        return agentAttempts;
    const latest = agentAttempts[agentAttempts.length - 1];
    return latest ? [latest] : [];
}
/**
 * @param {ChatAttemptRow} attempt
 * @returns {string}
 */
export function formatChatAttemptHeader(attempt) {
    const meta = parseChatAttemptMeta(attempt.metaJson);
    const title = meta.label?.trim() || attempt.nodeId;
    const agentBits = [meta.agentId, meta.agentModel].filter(Boolean).join(" · ");
    const parts = [
        title,
        `attempt ${attempt.attempt}`,
        attempt.iteration > 0 ? `iteration ${attempt.iteration}` : null,
        attempt.state,
        agentBits || null,
    ].filter(Boolean);
    return `=== ${parts.join(" · ")} ===`;
}
/**
 * @param {{ baseMs: number; timestampMs: number; role: "user" | "assistant" | "stderr"; attempt: Pick<ChatAttemptRow, "nodeId" | "iteration" | "attempt">; text: string; }} options
 * @returns {string}
 */
export function formatChatBlock(options) {
    const { baseMs, timestampMs, role, attempt, text } = options;
    const ts = formatTimestamp(baseMs, timestampMs);
    const ref = `${attempt.nodeId}#${attempt.attempt}${attempt.iteration > 0 ? `.${attempt.iteration}` : ""}`;
    const body = text.replace(/\s+$/, "");
    const prefix = `[${ts}] ${role} ${ref}`;
    if (!body.includes("\n")) {
        return `${prefix}: ${body}`;
    }
    return `${prefix}:\n${indentBlock(body)}`;
}
/**
 * @param {string} text
 */
function indentBlock(text) {
    return text
        .split(/\r?\n/)
        .map((line) => `  ${line}`)
        .join("\n");
}
