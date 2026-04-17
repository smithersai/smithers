// @smithers-type-exports-begin
/** @typedef {import("./DiffBundleLike.ts").DiffBundleLike} DiffBundleLike */
/** @typedef {import("./RunDiffCommandInput.ts").RunDiffCommandInput} RunDiffCommandInput */
/** @typedef {import("./RunDiffCommandResult.ts").RunDiffCommandResult} RunDiffCommandResult */
// @smithers-type-exports-end

import pc from "picocolors";
import { getNodeDiffRoute } from "@smithers/server/gatewayRoutes/getNodeDiff";
import { EXIT_OK, EXIT_SERVER_ERROR } from "./util/exitCodes.js";
import { formatCliErrorForStderr, getCliErrorMapping } from "./util/errorMessage.js";

/** @param {boolean} color */
function colors(color) {
    return color ? pc.createColors(true) : pc.createColors(false);
}

// ANSI CSI sequences: `ESC [ ... letter`. Strip covers colors (m), cursor
// moves, etc. Only used when the caller disables color so that existing
// escapes from upstream (jj, git) do not leak into non-TTY pipes.
const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * @param {string} value
 * @returns {string}
 */
function stripAnsi(value) {
    return value.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * @param {string} diffText
 * @param {boolean} useColor
 * @returns {string}
 */
function colorizePatch(diffText, useColor) {
    // Finding #6: when color is disabled (explicit --color never or non-TTY),
    // also strip any ANSI escapes the upstream VCS layer may have embedded
    // in patch text. Without this, piping to `less` or capturing to a file
    // leaks raw CSI codes. Color is only added here when useColor is true.
    if (!useColor) return stripAnsi(diffText);
    const c = colors(true);
    const lines = diffText.split("\n");
    const out = [];
    for (const line of lines) {
        if (line.startsWith("+++") || line.startsWith("---")) {
            out.push(c.bold(line));
        } else if (line.startsWith("+")) {
            out.push(c.green(line));
        } else if (line.startsWith("-")) {
            out.push(c.red(line));
        } else if (line.startsWith("@@")) {
            out.push(c.cyan(line));
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
            out.push(c.dim(line));
        } else {
            out.push(line);
        }
    }
    return out.join("\n");
}

/**
 * @param {DiffBundleLike} bundle
 * @param {{ color?: boolean }} [options]
 * @returns {string}
 */
export function renderUnifiedDiff(bundle, options) {
    const useColor = Boolean(options?.color);
    if (!bundle || !Array.isArray(bundle.patches) || bundle.patches.length === 0) {
        return "(no changes)";
    }
    return bundle.patches
        .map((patch) => colorizePatch(String(patch.diff ?? ""), useColor))
        .join("\n");
}

/**
 * Streaming per-line count of +/- markers in a unified diff. Counts
 * content lines only (skips "+++ "/"--- " file headers). Scans via
 * indexOf to avoid a giant split() allocation on large diffs.
 *
 * @param {string} diffText
 * @returns {{ added: number; removed: number }}
 */
function countDiffLines(diffText) {
    let added = 0;
    let removed = 0;
    let cursor = 0;
    while (cursor < diffText.length) {
        const nl = diffText.indexOf("\n", cursor);
        const end = nl === -1 ? diffText.length : nl;
        const ch = diffText.charCodeAt(cursor);
        if (ch === 43 /* + */ && !(diffText.charCodeAt(cursor + 1) === 43 && diffText.charCodeAt(cursor + 2) === 43)) {
            added++;
        }
        else if (ch === 45 /* - */ && !(diffText.charCodeAt(cursor + 1) === 45 && diffText.charCodeAt(cursor + 2) === 45)) {
            removed++;
        }
        cursor = end + 1;
    }
    return { added, removed };
}

/**
 * Render a stat summary. Accepts either:
 * - a server-side `summary` response ({ filesChanged, added, removed, files })
 * - or a legacy `DiffBundle` (computes summary on the fly, streaming
 *   through patches so no intermediate array of full patch text is held).
 *
 * @param {DiffBundleLike | { summary: { filesChanged: number; added: number; removed: number; files: Array<{ path: string; added: number; removed: number }> } }} input
 * @returns {string}
 */
export function renderDiffStat(input) {
    const summary = summaryFromInput(input);
    if (summary.filesChanged === 0) {
        return " 0 files changed";
    }
    /** @type {string[]} */
    const lines = [];
    for (const file of summary.files) {
        const added = file.added;
        const removed = file.removed;
        lines.push(` ${file.path} | ${added + removed} ${"+".repeat(Math.min(added, 20))}${"-".repeat(Math.min(removed, 20))}`);
    }
    lines.push(` ${summary.filesChanged} file${summary.filesChanged === 1 ? "" : "s"} changed, ${summary.added} insertion${summary.added === 1 ? "" : "s"}(+), ${summary.removed} deletion${summary.removed === 1 ? "" : "s"}(-)`);
    return lines.join("\n");
}

/**
 * @param {any} input
 * @returns {{ filesChanged: number; added: number; removed: number; files: Array<{ path: string; added: number; removed: number }> }}
 */
function summaryFromInput(input) {
    if (input && input.summary && typeof input.summary === "object") {
        const s = input.summary;
        return {
            filesChanged: Number(s.filesChanged ?? 0),
            added: Number(s.added ?? 0),
            removed: Number(s.removed ?? 0),
            files: Array.isArray(s.files) ? s.files : [],
        };
    }
    if (!input || !Array.isArray(input.patches) || input.patches.length === 0) {
        return { filesChanged: 0, added: 0, removed: 0, files: [] };
    }
    const files = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const patch of input.patches) {
        const { added, removed } = countDiffLines(String(patch.diff ?? ""));
        totalAdded += added;
        totalRemoved += removed;
        files.push({ path: String(patch.path ?? ""), added, removed });
    }
    return { filesChanged: files.length, added: totalAdded, removed: totalRemoved, files };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<number | null>}
 */
async function resolveLatestIteration(adapter, runId, nodeId) {
    try {
        const iterations = await adapter.listNodeIterations(runId, nodeId);
        if (!Array.isArray(iterations) || iterations.length === 0) return null;
        return iterations.reduce((max, row) => {
            const it = typeof row?.iteration === "number" ? row.iteration : 0;
            return it > max ? it : max;
        }, 0);
    } catch {
        return null;
    }
}

/**
 * @param {RunDiffCommandInput} input
 * @returns {Promise<RunDiffCommandResult>}
 */
export async function runDiffOnce(input) {
    let iteration = input.iteration;
    if (typeof iteration !== "number") {
        const latest = await resolveLatestIteration(input.adapter, input.runId, input.nodeId);
        iteration = latest ?? 0;
    }
    const result = await getNodeDiffRoute({
        runId: input.runId,
        nodeId: input.nodeId,
        iteration,
        async resolveRun(runId) {
            if (runId !== input.runId) return null;
            const run = await input.adapter.getRun(runId);
            if (!run) return null;
            return { adapter: input.adapter };
        },
        // Finding #5: stat mode asks the route for a summary only so very
        // large diffs (>50MB) still return without hitting DiffTooLarge.
        ...(input.stat ? { stat: true } : undefined),
    });
    if (!result.ok) {
        input.stderr.write(`${formatCliErrorForStderr(result.error.code, result.error.message)}\n`);
        const mapping = getCliErrorMapping(result.error.code, result.error.message);
        return { exitCode: mapping.exitCode };
    }
    const payload = result.payload;
    if (input.json) {
        // Ticket 0014: --json emits the raw bundle (or summary when stat).
        input.stdout.write(`${JSON.stringify(payload)}\n`);
        return { exitCode: EXIT_OK };
    }
    if (input.stat) {
        input.stdout.write(`${renderDiffStat(payload)}\n`);
        return { exitCode: EXIT_OK };
    }
    input.stdout.write(`${renderUnifiedDiff(payload, { color: input.color })}\n`);
    return { exitCode: EXIT_OK };
}

// ensure EXIT_SERVER_ERROR is considered used by linters / tree-shakers.
void EXIT_SERVER_ERROR;
