/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { SmithersDb } from "@smithers/db/adapter";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
test("a hijacked CLI session can be resumed by Smithers on the next attempt", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const resumeSessions = [];
    let resolveToolStarted;
    const toolStarted = new Promise((resolve) => {
        resolveToolStarted = resolve;
    });
    let resolveReleaseTool;
    const releaseTool = new Promise((resolve) => {
        resolveReleaseTool = resolve;
    });
    let callCount = 0;
    const agent = {
        id: "fake-hijack-agent",
        cliEngine: "claude-code",
        tools: {},
        /**
     * @param {any} args
     */
        async generate(args) {
            callCount += 1;
            resumeSessions.push(args.resumeSession);
            if (callCount === 1) {
                args.onEvent?.({
                    type: "started",
                    engine: "claude-code",
                    title: "Claude Code",
                    resume: "session-1",
                });
                args.onEvent?.({
                    type: "action",
                    engine: "claude-code",
                    phase: "started",
                    action: {
                        id: "tool-1",
                        kind: "tool",
                        title: "read",
                    },
                });
                resolveToolStarted();
                await releaseTool;
                args.onEvent?.({
                    type: "action",
                    engine: "claude-code",
                    phase: "completed",
                    action: {
                        id: "tool-1",
                        kind: "tool",
                        title: "read",
                    },
                    ok: true,
                });
                for (let i = 0; i < 10; i++) {
                    await sleep(50);
                    if (args.abortSignal?.aborted) {
                        const err = new Error("hijacked");
                        err.name = "AbortError";
                        throw err;
                    }
                }
            }
            return {
                text: '{"value":7}',
                output: { value: 7 },
            };
        },
    };
    const workflow = smithers((_ctx) => (<Workflow name="hijack-runtime">
      <Task id="plan" output={outputs.outputA} agent={agent}>
        produce a value
      </Task>
    </Workflow>));
    const runPromise = Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "run-hijack-runtime",
    }));
    await toolStarted;
    await adapter.requestRunHijack("run-hijack-runtime", Date.now(), "claude-code");
    await sleep(300);
    resolveReleaseTool();
    const hijacked = await runPromise;
    expect(hijacked.status).toBe("cancelled");
    const attemptsAfterHijack = await adapter.listAttempts("run-hijack-runtime", "plan", 0);
    const firstAttempt = attemptsAfterHijack[0];
    const firstMeta = JSON.parse(firstAttempt.metaJson);
    expect(firstMeta.agentResume).toBe("session-1");
    expect(firstMeta.hijackHandoff).toMatchObject({
        engine: "claude-code",
        resume: "session-1",
    });
    const resumed = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "run-hijack-runtime",
        resume: true,
    }));
    expect(resumed.status).toBe("finished");
    expect(resumeSessions).toEqual([undefined, "session-1"]);
    cleanup();
});
