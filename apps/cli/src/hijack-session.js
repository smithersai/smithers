import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmithersCtx } from "@smithers/driver";
import { loadInput, loadOutputs } from "@smithers/db/snapshot";
import { renderFrame, resolveSchema } from "@smithers/engine";
import { mdxPlugin } from "smithers-orchestrator/mdx-plugin";
import { SmithersError } from "@smithers/errors";
import { Effect } from "effect";
/** @typedef {import("./HijackCandidate.ts").HijackCandidate} HijackCandidate */
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * @template T
 * @param {T} value
 * @returns {T | undefined}
 */
function cloneJsonValue(value) {
    if (value === undefined)
        return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return undefined;
    }
}
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
 * @param {string} workflowPath
 * @returns {Promise<SmithersWorkflow<any>>}
 */
async function loadWorkflow(workflowPath) {
    const abs = resolve(process.cwd(), workflowPath);
    mdxPlugin();
    const mod = await import(pathToFileURL(abs).href);
    if (!mod.default) {
        throw new SmithersError("WORKFLOW_MISSING_DEFAULT", `Workflow ${workflowPath} must export default`);
    }
    return mod.default;
}
/**
 * @param {SmithersDb} adapter
 * @param {HijackCandidate & { mode: "conversation"; messages: unknown[] }} candidate
 */
async function resolveConversationAgent(adapter, candidate) {
    const run = await adapter.getRun(candidate.runId);
    const workflowPath = run?.workflowPath;
    if (!workflowPath) {
        throw new SmithersError("HIJACK_WORKFLOW_PATH", `Run ${candidate.runId} does not have a workflowPath; cannot reconstruct agent`);
    }
    const workflow = await loadWorkflow(workflowPath);
    const schema = resolveSchema(workflow.db);
    const inputTable = schema.input;
    const inputRow = inputTable
        ? ((await loadInput(workflow.db, inputTable, candidate.runId)) ?? {})
        : {};
    const outputs = await loadOutputs(workflow.db, schema, candidate.runId);
    const ctx = new SmithersCtx({
        runId: candidate.runId,
        iteration: candidate.iteration,
        input: inputRow ?? {},
        outputs,
        zodToKeyName: workflow.zodToKeyName,
    });
    const baseRootDir = dirname(resolve(workflowPath));
    const snap = await Effect.runPromise(renderFrame(workflow, ctx, {
        baseRootDir,
        workflowPath,
    }));
    const task = snap.tasks.find((entry) => entry.nodeId === candidate.nodeId &&
        (entry.iteration ?? 0) === candidate.iteration) ?? snap.tasks.find((entry) => entry.nodeId === candidate.nodeId);
    if (!task?.agent) {
        throw new SmithersError("HIJACK_AGENT_NOT_FOUND", `Could not find agent-backed task ${candidate.nodeId} in ${workflowPath}`);
    }
    const allAgents = Array.isArray(task.agent) ? task.agent : [task.agent];
    const effectiveAgent = allAgents[Math.min(candidate.attempt - 1, allAgents.length - 1)];
    if (!effectiveAgent) {
        throw new SmithersError("HIJACK_AGENT_EMPTY", `Task ${candidate.nodeId} does not have a usable agent to hijack`);
    }
    return {
        workflowPath,
        agent: effectiveAgent,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {HijackCandidate} candidate
 * @param {unknown[]} messages
 */
export async function persistConversationHijackHandoff(adapter, candidate, messages) {
    const attempt = await adapter.getAttempt(candidate.runId, candidate.nodeId, candidate.iteration, candidate.attempt);
    if (!attempt) {
        throw new SmithersError("HIJACK_ATTEMPT_NOT_FOUND", `Attempt ${candidate.nodeId}#${candidate.attempt} no longer exists`);
    }
    const clonedMessages = cloneJsonValue(messages) ?? messages;
    const meta = parseAttemptMeta(attempt.metaJson);
    meta.agentConversation = clonedMessages;
    meta.hijackHandoff = {
        engine: candidate.engine,
        mode: "conversation",
        messages: clonedMessages,
        requestedAtMs: Date.now(),
        cwd: candidate.cwd,
        nodeId: candidate.nodeId,
        iteration: candidate.iteration,
        attempt: candidate.attempt,
    };
    await adapter.updateAttempt(candidate.runId, candidate.nodeId, candidate.iteration, candidate.attempt, {
        metaJson: JSON.stringify(meta),
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {HijackCandidate & { mode: "conversation"; messages: unknown[] }} candidate
 * @returns {Promise<{ code: number; messages: unknown[] }>}
 */
export async function launchConversationHijackSession(adapter, candidate) {
    const { agent } = await resolveConversationAgent(adapter, candidate);
    const rl = createInterface({
        input: stdin,
        output: stdout,
        terminal: true,
    });
    let messages = cloneJsonValue(candidate.messages) ?? candidate.messages;
    stderr.write(`[smithers] hijacking ${candidate.engine} conversation from ${candidate.nodeId}#${candidate.attempt}\n`);
    stderr.write("[smithers] enter /exit to return control to Smithers\n");
    try {
        while (true) {
            const line = (await rl.question("> ")).trim();
            if (!line)
                continue;
            if (line === "/exit" || line === "/quit") {
                break;
            }
            if (line === "/help") {
                stdout.write("/exit  return control to Smithers\n/help  show this message\n");
                continue;
            }
            const nextMessages = [
                ...messages,
                { role: "user", content: line },
            ];
            try {
                const stepMessages = [];
                let streamedAny = false;
                const result = await agent.generate({
                    options: undefined,
                    messages: nextMessages,
                    onStdout: (chunk) => {
                        streamedAny = true;
                        stdout.write(chunk);
                    },
                    onStderr: (chunk) => stderr.write(chunk),
                    onStepFinish: (step) => {
                        const responseMessages = Array.isArray(step?.response?.messages)
                            ? (cloneJsonValue(step.response.messages) ?? step.response.messages)
                            : [];
                        if (responseMessages.length > 0) {
                            stepMessages.push(...responseMessages);
                        }
                    },
                });
                if (!streamedAny && typeof result?.text === "string" && result.text) {
                    stdout.write(result.text);
                }
                stdout.write("\n");
                const responseMessages = stepMessages.length > 0
                    ? stepMessages
                    : Array.isArray(result?.response?.messages)
                        ? (cloneJsonValue(result.response.messages) ?? result.response.messages)
                        : [{ role: "assistant", content: result?.text ?? "" }];
                messages = [
                    ...nextMessages,
                    ...responseMessages,
                ];
            }
            catch (err) {
                stderr.write(`[smithers] hijack agent error: ${err instanceof Error ? err.message : String(err)}\n`);
            }
        }
    }
    finally {
        rl.close();
    }
    return {
        code: 0,
        messages,
    };
}
