/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

test("Task hijack requests a resumable handoff before agent start and resumes from it", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "run-hijack-auto-prop";
    const resumeSessions = [];
    let observedAutoHijackBeforeStart = false;
    let callCount = 0;
    const agent = {
        id: "fake-auto-hijack-agent",
        cliEngine: "claude-code",
        tools: {},
        /**
         * @param {any} args
         */
        async generate(args) {
            callCount += 1;
            resumeSessions.push(args.resumeSession);
            if (callCount === 1) {
                const run = await adapter.getRun(runId);
                const events = await adapter.listEvents(runId, -1, 20);
                observedAutoHijackBeforeStart = Boolean(run?.hijackRequestedAtMs) &&
                    events.some((event) => event.type === "RunHijackRequested" &&
                        JSON.parse(event.payloadJson).target === "claude-code");
                args.onEvent?.({
                    type: "started",
                    engine: "claude-code",
                    title: "Claude Code",
                    resume: "auto-session-1",
                });
                while (!args.abortSignal?.aborted) {
                    await sleep(25);
                }
                const err = new Error("hijacked");
                err.name = "AbortError";
                throw err;
            }
            return {
                text: '{"value":7}',
                output: { value: 7 },
            };
        },
    };
    const workflow = smithers(() => (<Workflow name="hijack-auto-prop">
      <Task id="plan" output={outputs.outputA} agent={agent} hijack>
        produce a value
      </Task>
    </Workflow>));
    try {
        const hijacked = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
        }));
        expect(hijacked.status).toBe("cancelled");
        expect(observedAutoHijackBeforeStart).toBe(true);
        const attemptsAfterHijack = await adapter.listAttempts(runId, "plan", 0);
        const firstAttempt = attemptsAfterHijack[0];
        const firstMeta = JSON.parse(firstAttempt.metaJson);
        expect(firstMeta.agentResume).toBe("auto-session-1");
        expect(firstMeta.hijackHandoff).toMatchObject({
            engine: "claude-code",
            mode: "native-cli",
            resume: "auto-session-1",
        });
        const resumed = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
            resume: true,
        }));
        expect(resumed.status).toBe("finished");
        expect(resumeSessions).toEqual([undefined, "auto-session-1"]);
    }
    finally {
        cleanup();
    }
});

test("Task hijack fails clearly for agents without hijack support", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "run-hijack-auto-prop-error";
    const workflow = smithers(() => (<Workflow name="hijack-auto-prop-error">
      <Task id="plan" output={outputs.outputA} agent={{
            id: "plain-agent",
            tools: {},
            async generate() {
                return {
                    text: '{"value":7}',
                    output: { value: 7 },
                };
            },
        }} hijack noRetry>
        produce a value
      </Task>
    </Workflow>));
    try {
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId,
        }));
        expect(result.status).toBe("failed");
        const attempts = await adapter.listAttempts(runId, "plan", 0);
        const firstError = JSON.parse(attempts[0].errorJson);
        expect(firstError.code).toBe("TASK_HIJACK_UNSUPPORTED");
        expect(firstError.message).toContain("cliEngine or hijackEngine");
    }
    finally {
        cleanup();
    }
});
