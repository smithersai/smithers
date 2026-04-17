/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers/db/adapter";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
const HIJACK_E2E_TIMEOUT_MS = 15_000;
describe("hijack e2e", () => {
    test("hijack stores handoff metadata and resume continues from hijack point", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const resumeSessions = [];
        const followupExecutions = [];
        let resolveStarted;
        const started = new Promise((resolve) => {
            resolveStarted = resolve;
        });
        let callCount = 0;
        const agent = {
            id: "fake-hijack-e2e-agent",
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
                        resume: "session-e2e-1",
                    });
                    resolveStarted();
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
        const workflow = smithers((_ctx) => (<Workflow name="hijack-e2e-cli">
          <Task id="plan" output={outputs.outputA} agent={agent}>
            produce a value
          </Task>
          <Task id="finish" output={outputs.outputB}>
            {() => {
                followupExecutions.push(Date.now());
                return { value: 8 };
            }}
          </Task>
        </Workflow>));
        try {
            const runId = "run-hijack-e2e-cli";
            const runPromise = Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
            }));
            await started;
            await adapter.requestRunHijack(runId, Date.now(), "claude-code");
            await sleep(300);
            const hijacked = await runPromise;
            expect(hijacked.status).toBe("cancelled");
            expect((await adapter.getRun(runId))?.status).toBe("cancelled");
            expect(followupExecutions).toHaveLength(0);
            const attemptsAfterHijack = await adapter.listAttempts(runId, "plan", 0);
            expect(attemptsAfterHijack).toHaveLength(1);
            const firstAttempt = attemptsAfterHijack[0];
            const firstMeta = JSON.parse(firstAttempt.metaJson);
            expect(firstAttempt.state).toBe("cancelled");
            expect(firstMeta.agentResume).toBe("session-e2e-1");
            expect(firstMeta.hijackHandoff).toMatchObject({
                engine: "claude-code",
                mode: "native-cli",
                resume: "session-e2e-1",
            });
            const followupAttemptsBeforeResume = await adapter.listAttempts(runId, "finish", 0);
            expect(followupAttemptsBeforeResume).toHaveLength(0);
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(resumeSessions).toEqual([undefined, "session-e2e-1"]);
            expect(followupExecutions).toHaveLength(1);
            expect((await adapter.getRun(runId))?.status).toBe("finished");
            const resumedAttempts = await adapter.listAttempts(runId, "plan", 0);
            expect(resumedAttempts).toHaveLength(2);
            const secondAttempt = resumedAttempts[0];
            const secondMeta = JSON.parse(secondAttempt.metaJson);
            expect(secondAttempt.state).toBe("finished");
            expect(secondMeta.resumedFromSession).toBe("session-e2e-1");
            const followupAttempts = await adapter.listAttempts(runId, "finish", 0);
            expect(followupAttempts).toHaveLength(1);
            expect(followupAttempts[0].state).toBe("finished");
        }
        finally {
            cleanup();
        }
    }, HIJACK_E2E_TIMEOUT_MS);
    test("hijack with conversation history (SDK mode)", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const messageHistory = [];
        let resolveStarted;
        const started = new Promise((resolve) => {
            resolveStarted = resolve;
        });
        let releaseStepFinish = () => { };
        const stepFinishGate = new Promise((resolve) => {
            releaseStepFinish = resolve;
        });
        let callCount = 0;
        const agent = {
            id: "fake-sdk-hijack-e2e-agent",
            hijackEngine: "openai-sdk",
            tools: {},
            /**
     * @param {any} args
     */
            async generate(args) {
                callCount += 1;
                messageHistory.push(JSON.parse(JSON.stringify(args.messages ?? [{ role: "user", content: args.prompt ?? "" }])));
                if (callCount === 1) {
                    resolveStarted();
                    await stepFinishGate;
                    await args.onStepFinish?.({
                        response: {
                            messages: [{ role: "assistant", content: "I have inspected the repo." }],
                        },
                    });
                    while (!args.abortSignal?.aborted) {
                        await sleep(25);
                    }
                    const err = new Error("hijacked");
                    err.name = "AbortError";
                    throw err;
                }
                return {
                    text: '{"value":9}',
                    output: { value: 9 },
                    response: {
                        messages: [{ role: "assistant", content: '{"value":9}' }],
                    },
                };
            },
        };
        const workflow = smithers((_ctx) => (<Workflow name="hijack-e2e-sdk">
          <Task id="plan" output={outputs.outputA} agent={agent}>
            produce a value
          </Task>
        </Workflow>));
        try {
            const runId = "run-hijack-e2e-sdk";
            const runPromise = Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
            }));
            await started;
            await adapter.requestRunHijack(runId, Date.now(), "openai-sdk");
            await sleep(300);
            releaseStepFinish();
            const hijacked = await runPromise;
            expect(hijacked.status).toBe("cancelled");
            expect((await adapter.getRun(runId))?.status).toBe("cancelled");
            const attemptsAfterHijack = await adapter.listAttempts(runId, "plan", 0);
            expect(attemptsAfterHijack).toHaveLength(1);
            const firstAttempt = attemptsAfterHijack[0];
            const firstMeta = JSON.parse(firstAttempt.metaJson);
            expect(firstAttempt.state).toBe("cancelled");
            expect(firstMeta.hijackHandoff).toMatchObject({
                engine: "openai-sdk",
                mode: "conversation",
                messages: [
                    expect.objectContaining({ role: "user" }),
                    { role: "assistant", content: "I have inspected the repo." },
                ],
            });
            expect(firstMeta.agentConversation).toEqual([
                expect.objectContaining({ role: "user" }),
                { role: "assistant", content: "I have inspected the repo." },
            ]);
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(messageHistory).toHaveLength(2);
            expect(messageHistory[1]).toEqual([
                expect.objectContaining({ role: "user" }),
                { role: "assistant", content: "I have inspected the repo." },
            ]);
            const resumedAttempts = await adapter.listAttempts(runId, "plan", 0);
            expect(resumedAttempts).toHaveLength(2);
            const secondAttempt = resumedAttempts[0];
            const secondMeta = JSON.parse(secondAttempt.metaJson);
            expect(secondAttempt.state).toBe("finished");
            expect(secondMeta.resumedFromConversation).toBe(true);
        }
        finally {
            releaseStepFinish();
            cleanup();
        }
    }, HIJACK_E2E_TIMEOUT_MS);
    test("hijack request on non-running task is ignored", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const workflow = smithers((_ctx) => (<Workflow name="hijack-e2e-finished-run">
          <Task id="done" output={outputs.outputA}>
            {{ value: 3 }}
          </Task>
        </Workflow>));
        try {
            const runId = "run-hijack-e2e-finished-run";
            const finished = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
            }));
            expect(finished.status).toBe("finished");
            const attemptsBeforeHijack = await adapter.listAttempts(runId, "done", 0);
            expect(attemptsBeforeHijack).toHaveLength(1);
            expect(attemptsBeforeHijack[0].state).toBe("finished");
            expect((await adapter.getRun(runId))?.status).toBe("finished");
            await adapter.requestRunHijack(runId, Date.now(), "claude-code");
            const afterRequest = await adapter.getRun(runId);
            expect(afterRequest?.status).toBe("finished");
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const attemptsAfterResume = await adapter.listAttempts(runId, "done", 0);
            expect(attemptsAfterResume).toHaveLength(1);
            expect(attemptsAfterResume[0].state).toBe("finished");
            const finalRun = await adapter.getRun(runId);
            expect(finalRun?.status).toBe("finished");
            expect(finalRun?.hijackRequestedAtMs).toBeNull();
            expect(finalRun?.hijackTarget).toBeNull();
        }
        finally {
            cleanup();
        }
    }, HIJACK_E2E_TIMEOUT_MS);
});
