import { spawn } from "node:child_process";
import { SmithersError } from "@smithers/errors";
/** @typedef {import("./hijack.ts").hijack} hijack */

/** @typedef {import("./hijack.ts").HijackCandidate} HijackCandidate */
/** @typedef {import("./hijack.ts").HijackLaunchSpec} HijackLaunchSpec */
/** @typedef {import("./hijack.ts").NativeHijackEngine} NativeHijackEngine */
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
function parseAttemptMeta(metaJson) {
    if (!metaJson)
        return {};
    try {
        const parsed = JSON.parse(metaJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
/**
 * @param {unknown} value
 * @returns {NativeHijackEngine | undefined}
 */
function asNativeHijackEngine(value) {
    return value === "claude-code" ||
        value === "codex" ||
        value === "gemini" ||
        value === "pi" ||
        value === "kimi" ||
        value === "forge" ||
        value === "amp"
        ? value
        : undefined;
}
/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function asConversationMessages(value) {
    return Array.isArray(value) ? value : undefined;
}
/**
 * @param {Record<string, unknown>} meta
 * @returns {| { engine: string; mode: "native-cli"; resume: string } | { engine: string; mode: "conversation"; messages: unknown[] } | null}
 */
function extractContinuationFromMeta(meta) {
    const handoff = meta.hijackHandoff;
    if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
        const engine = typeof handoff.engine === "string"
            ? handoff.engine
            : undefined;
        const mode = handoff.mode === "conversation" ? "conversation" : "native-cli";
        const resume = typeof handoff.resume === "string" ? handoff.resume : undefined;
        const messages = asConversationMessages(handoff.messages);
        if (engine && mode === "native-cli" && resume) {
            return { engine, mode: "native-cli", resume };
        }
        if (engine && mode === "conversation" && messages?.length) {
            return { engine, mode: "conversation", messages };
        }
    }
    const engine = typeof meta.agentEngine === "string" ? meta.agentEngine : undefined;
    const resume = typeof meta.agentResume === "string" ? meta.agentResume : undefined;
    if (engine && resume) {
        return { engine, mode: "native-cli", resume };
    }
    const messages = asConversationMessages(meta.agentConversation);
    if (engine && messages?.length) {
        return { engine, mode: "conversation", messages };
    }
    return null;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} [target]
 * @returns {Promise<HijackCandidate | null>}
 */
export async function resolveHijackCandidate(adapter, runId, target) {
    const attempts = await adapter.listAttemptsForRun(runId);
    const sortedAttempts = [...attempts].sort((a, b) => {
        const aMs = a.startedAtMs ?? 0;
        const bMs = b.startedAtMs ?? 0;
        if (aMs !== bMs)
            return bMs - aMs;
        if ((a.iteration ?? 0) !== (b.iteration ?? 0))
            return (b.iteration ?? 0) - (a.iteration ?? 0);
        return (b.attempt ?? 0) - (a.attempt ?? 0);
    });
    for (const attempt of sortedAttempts) {
        const meta = parseAttemptMeta(attempt.metaJson);
        const extracted = extractContinuationFromMeta(meta);
        if (!extracted)
            continue;
        if (target && target !== extracted.engine && target !== attempt.nodeId)
            continue;
        return {
            runId,
            nodeId: attempt.nodeId,
            iteration: attempt.iteration ?? 0,
            attempt: attempt.attempt,
            engine: extracted.engine,
            mode: extracted.mode,
            resume: extracted.mode === "native-cli" ? extracted.resume : undefined,
            messages: extracted.mode === "conversation" ? extracted.messages : undefined,
            cwd: attempt.jjCwd ?? process.cwd(),
        };
    }
    return null;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ target?: string; timeoutMs?: number }} [options]
 * @returns {Promise<HijackCandidate>}
 */
export async function waitForHijackCandidate(adapter, runId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        const run = await adapter.getRun(runId);
        const candidate = await resolveHijackCandidate(adapter, runId, options.target);
        if (run && run.status !== "running" && candidate) {
            return candidate;
        }
        await Bun.sleep(200);
    }
    throw new SmithersError("HIJACK_TIMEOUT", `Timed out waiting for Smithers to hand off run ${runId}`, { runId, timeoutMs });
}
/**
 * @param {HijackCandidate} candidate
 * @returns {HijackLaunchSpec}
 */
export function buildHijackLaunchSpec(candidate) {
    if (candidate.mode !== "native-cli" || !candidate.resume) {
        throw new SmithersError("HIJACK_LAUNCH_MODE", `Candidate ${candidate.engine} requires the Smithers conversation hijack flow, not a native CLI launch`, candidate);
    }
    const env = { ...process.env };
    if (candidate.engine === "claude-code") {
        if (env.CLAUDE_CODE_ENTRYPOINT)
            env.CLAUDE_CODE_ENTRYPOINT = "";
        if (env.CLAUDECODE)
            env.CLAUDECODE = "";
        return {
            command: "claude",
            args: ["--resume", candidate.resume],
            cwd: candidate.cwd,
            env,
        };
    }
    if (candidate.engine === "gemini") {
        return {
            command: "gemini",
            args: ["--resume", candidate.resume],
            cwd: candidate.cwd,
            env,
        };
    }
    if (candidate.engine === "pi") {
        return {
            command: "pi",
            args: ["--session", candidate.resume],
            cwd: candidate.cwd,
            env,
        };
    }
    if (candidate.engine === "kimi") {
        return {
            command: "kimi",
            args: ["--session", candidate.resume, "--work-dir", candidate.cwd],
            cwd: candidate.cwd,
            env,
        };
    }
    if (candidate.engine === "forge") {
        return {
            command: "forge",
            args: ["--conversation-id", candidate.resume, "-C", candidate.cwd],
            cwd: candidate.cwd,
            env,
        };
    }
    if (candidate.engine === "amp") {
        return {
            command: "amp",
            args: ["threads", "continue", candidate.resume],
            cwd: candidate.cwd,
            env,
        };
    }
    return {
        command: "codex",
        args: ["resume", candidate.resume, "-C", candidate.cwd],
        cwd: candidate.cwd,
        env,
    };
}
/**
 * @param {HijackCandidate} candidate
 * @returns {candidate is HijackCandidate & { mode: "native-cli"; engine: NativeHijackEngine; resume: string }}
 */
export function isNativeHijackCandidate(candidate) {
    return candidate.mode === "native-cli" &&
        typeof candidate.resume === "string" &&
        Boolean(asNativeHijackEngine(candidate.engine));
}
/**
 * @param {HijackLaunchSpec} spec
 * @returns {Promise<number>}
 */
export function launchHijackSession(spec) {
    return new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            stdio: "inherit",
        });
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 0));
    });
}
