// @smithers-type-exports-begin
/** @typedef {import("./TreeRenderOptions.ts").TreeRenderOptions} TreeRenderOptions */
/** @typedef {import("./RunTreeCommandInput.ts").RunTreeCommandInput} RunTreeCommandInput */
/** @typedef {import("./RunTreeCommandResult.ts").RunTreeCommandResult} RunTreeCommandResult */
// @smithers-type-exports-end

import pc from "picocolors";
import { getDevToolsSnapshotRoute, DevToolsRouteError } from "@smithers-orchestrator/server/gatewayRoutes/getDevToolsSnapshot";
import { streamDevToolsRoute } from "@smithers-orchestrator/server/gatewayRoutes/streamDevTools";
import { applyDelta } from "@smithers-orchestrator/devtools";
import { EXIT_OK, EXIT_USER_ERROR, EXIT_SERVER_ERROR, EXIT_SIGINT } from "./util/exitCodes.js";
import { formatCliErrorForStderr, getCliErrorMapping } from "./util/errorMessage.js";

export const TREE_INDENT = "  ";

/** @param {boolean} color */
function colors(color) {
    return color ? pc.createColors(true) : pc.createColors(false);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderAttr(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
    try {
        return JSON.stringify(value);
    } catch {
        return '"[unserializable]"';
    }
}

/**
 * @param {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} node
 * @param {boolean} useColor
 */
function renderOpenTag(node, useColor) {
    const c = colors(useColor);
    const parts = [c.cyan(`<${node.type}`)];
    if (node.name) {
        parts.push(` ${c.yellow("name")}=${c.green(renderAttr(node.name))}`);
    }
    if (node.task?.nodeId) {
        parts.push(` ${c.yellow("nodeId")}=${c.green(renderAttr(node.task.nodeId))}`);
        if (node.task.kind) {
            parts.push(` ${c.yellow("kind")}=${c.green(renderAttr(node.task.kind))}`);
        }
        if (node.task.agent) {
            parts.push(` ${c.yellow("agent")}=${c.green(renderAttr(node.task.agent))}`);
        }
        if (typeof node.task.iteration === "number") {
            parts.push(` ${c.yellow("iter")}=${c.magenta(String(node.task.iteration))}`);
        }
    }
    for (const [key, value] of Object.entries(node.props ?? {})) {
        // Keep props short; skip nested objects to avoid multi-line blowouts.
        if (value === null || value === undefined) continue;
        if (typeof value === "object") continue;
        parts.push(` ${c.yellow(key)}=${c.green(renderAttr(value))}`);
    }
    parts.push(c.cyan(">"));
    return parts.join("");
}

/** @param {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} node @param {boolean} useColor */
function renderCloseTag(node, useColor) {
    const c = colors(useColor);
    return c.cyan(`</${node.type}>`);
}

/** @param {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} node @param {string} id */
function findNode(node, id) {
    if (node.task?.nodeId === id) return node;
    if (typeof node.name === "string" && node.name === id) return node;
    for (const child of node.children ?? []) {
        const hit = findNode(child, id);
        if (hit) return hit;
    }
    return null;
}

/**
 * @param {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} root
 * @param {string} nodeId
 * @returns {import("@smithers-orchestrator/protocol/devtools").DevToolsNode | null}
 */
export function selectSubtree(root, nodeId) {
    return findNode(root, nodeId);
}

/**
 * @param {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot} snapshot
 * @param {TreeRenderOptions} [options]
 * @returns {string}
 */
export function renderDevToolsTree(snapshot, options) {
    const useColor = Boolean(options?.color);
    const depthLimit = options?.depth;
    const selected = options?.nodeId ? selectSubtree(snapshot.root, options.nodeId) : snapshot.root;
    if (!selected) {
        return "";
    }
    /** @type {string[]} */
    const lines = [];
    /**
     * @param {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} node
     * @param {number} indent
     */
    const walk = (node, indent) => {
        const pad = TREE_INDENT.repeat(indent);
        const children = node.children ?? [];
        const atLimit = typeof depthLimit === "number" && indent + 1 >= depthLimit;
        if (children.length === 0 || atLimit) {
            if (children.length > 0 && atLimit) {
                const opened = renderOpenTag(node, useColor);
                const trunc = useColor ? pc.dim(`...${children.length} hidden...`) : `...${children.length} hidden...`;
                lines.push(`${pad}${opened}${trunc}${renderCloseTag(node, useColor)}`);
            } else {
                lines.push(`${pad}${renderOpenTag(node, useColor)}${renderCloseTag(node, useColor)}`);
            }
            return;
        }
        lines.push(`${pad}${renderOpenTag(node, useColor)}`);
        for (const child of children) {
            walk(child, indent + 1);
        }
        lines.push(`${pad}${renderCloseTag(node, useColor)}`);
    };
    walk(selected, 0);
    return lines.join("\n");
}

/**
 * @param {RunTreeCommandInput} input
 * @returns {Promise<RunTreeCommandResult>}
 */
export async function runTreeOnce(input) {
    try {
        const snapshot = await getDevToolsSnapshotRoute({
            adapter: input.adapter,
            runId: input.runId,
            frameNo: input.frameNo,
        });
        if (input.json) {
            input.stdout.write(`${JSON.stringify(snapshot)}\n`);
            return { exitCode: EXIT_OK };
        }
        const rendered = renderDevToolsTree(snapshot, {
            depth: input.depth,
            nodeId: input.node,
            color: input.color,
        });
        if (input.node && rendered.length === 0) {
            input.stderr.write(`${formatCliErrorForStderr("NodeNotFound", `Node not found in tree: ${input.node}`)}\n`);
            return { exitCode: EXIT_USER_ERROR };
        }
        input.stdout.write(`${rendered}\n`);
        return { exitCode: EXIT_OK };
    } catch (err) {
        const code = err instanceof DevToolsRouteError ? err.code : undefined;
        input.stderr.write(`${formatCliErrorForStderr(code, err instanceof Error ? err.message : String(err))}\n`);
        const mapping = getCliErrorMapping(code, err instanceof Error ? err.message : undefined);
        return { exitCode: mapping.exitCode };
    }
}

// Finding #8: fatal codes that should terminate the watch instead of
// triggering a reconnect. InvalidRunId/FrameOutOfRange/Unauthorized won't
// self-heal by reconnecting; BackpressureDisconnect also signals a
// consumer-side problem we should not hammer the server over.
const WATCH_FATAL_CODES = new Set([
    "InvalidRunId",
    "FrameOutOfRange",
    "Unauthorized",
    "BackpressureDisconnect",
]);

// Exponential backoff bounds. Kept small so `--watch` feels responsive
// on transient server restarts but doesn't busy-loop.
const WATCH_RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];

/** @param {number} attempt */
function backoffMs(attempt) {
    const idx = Math.min(attempt, WATCH_RECONNECT_BACKOFF_MS.length - 1);
    return WATCH_RECONNECT_BACKOFF_MS[idx];
}

/** @param {RunTreeCommandInput} input @returns {Promise<RunTreeCommandResult>} */
export async function runTreeWatch(input) {
    const renderOpts = {
        depth: input.depth,
        nodeId: input.node,
        color: input.color,
    };
    /** @type {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot | null} */
    let snapshot = null;
    /** @type {number | undefined} */
    let lastDeliveredSeq;
    /** @param {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot} snap */
    const emit = (snap) => {
        lastDeliveredSeq = snap.seq;
        if (input.json) {
            input.stdout.write(`${JSON.stringify(snap)}\n`);
            return;
        }
        input.stdout.write(`${renderDevToolsTree(snap, renderOpts)}\n`);
    };
    // Internal controller so we can exit cleanly on SIGINT.
    const internalAbort = new AbortController();
    const onAbort = () => internalAbort.abort();
    if (input.abortSignal) {
        if (input.abortSignal.aborted) internalAbort.abort();
        else input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    let attempt = 0;
    try {
        // Finding #8: reconnect loop. On stream error, retry with
        // `fromSeq` so we pick up where we left off. SeqOutOfRange is
        // recoverable (server re-bases from a fresh snapshot), so we
        // treat it as a retryable reconnect, not a fatal error.
        while (!internalAbort.signal.aborted) {
            try {
                const iterator = streamDevToolsRoute({
                    adapter: input.adapter,
                    runId: input.runId,
                    signal: internalAbort.signal,
                    ...(lastDeliveredSeq !== undefined ? { fromSeq: lastDeliveredSeq } : undefined),
                });
                for await (const event of iterator) {
                    if (internalAbort.signal.aborted) break;
                    if (event.kind === "snapshot") {
                        snapshot = event.snapshot;
                        emit(snapshot);
                        attempt = 0;
                    } else if (event.kind === "delta" && snapshot) {
                        try {
                            const nextRoot = applyDelta(snapshot.root, event.delta);
                            snapshot = { ...snapshot, root: nextRoot, seq: event.delta.seq };
                            emit(snapshot);
                            attempt = 0;
                        } catch (err) {
                            input.stderr.write(`${formatCliErrorForStderr("InvalidDelta", err instanceof Error ? err.message : String(err))}\n`);
                            return { exitCode: EXIT_SERVER_ERROR };
                        }
                    }
                }
                // Iterator ended cleanly.
                if (internalAbort.signal.aborted) {
                    return { exitCode: EXIT_SIGINT };
                }
                return { exitCode: EXIT_OK };
            } catch (err) {
                if (internalAbort.signal.aborted) {
                    return { exitCode: EXIT_SIGINT };
                }
                const code = err instanceof DevToolsRouteError ? err.code : undefined;
                if (code && WATCH_FATAL_CODES.has(code)) {
                    input.stderr.write(`${formatCliErrorForStderr(code, err instanceof Error ? err.message : String(err))}\n`);
                    const mapping = getCliErrorMapping(code, err instanceof Error ? err.message : undefined);
                    return { exitCode: mapping.exitCode };
                }
                // SeqOutOfRange → re-subscribe without fromSeq so server
                // re-bases from a fresh snapshot.
                if (code === "SeqOutOfRange") {
                    input.stderr.write(`[watch] server reported SeqOutOfRange; rebasing from latest snapshot\n`);
                    lastDeliveredSeq = undefined;
                }
                attempt += 1;
                const delay = backoffMs(attempt);
                const reason = err instanceof Error ? err.message : String(err);
                input.stderr.write(`[watch] stream error (${code ?? "unknown"}): ${reason}; reconnecting in ${delay}ms (attempt ${attempt})\n`);
                await sleep(delay, internalAbort.signal);
                if (internalAbort.signal.aborted) {
                    return { exitCode: EXIT_SIGINT };
                }
            }
        }
        return { exitCode: EXIT_SIGINT };
    } finally {
        if (input.abortSignal) {
            input.abortSignal.removeEventListener?.("abort", onAbort);
        }
    }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(() => {
            signal.removeEventListener?.("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener?.("abort", onAbort, { once: true });
    });
}
