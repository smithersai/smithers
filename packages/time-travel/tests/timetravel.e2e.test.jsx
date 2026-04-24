/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
const END_TO_END_TIMEOUT_MS = 15_000;
const jjTimeTravelTest = hasJjBinary() ? test : test.skip;
function hasJjBinary() {
    try {
        execFileSync("jj", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function createTempJjRepo() {
    const repoDir = mkdtempSync(join(tmpdir(), "smithers-time-travel-jj-"));
    try {
        execFileSync("jj", ["git", "init", "--colocate"], {
            cwd: repoDir,
            stdio: "ignore",
        });
        return repoDir;
    }
    catch (error) {
        rmSync(repoDir, { recursive: true, force: true });
        throw error;
    }
}
/**
 * @param {any} smithers
 * @param {any} outputs
 * @param {{ analyze?: () => any; implement?: () => any; testTask?: () => any; }} [fns]
 */
function buildThreeTaskWorkflow(smithers, outputs, fns) {
    return smithers(() => (<Workflow name="timetravel-e2e">
      <Task id="analyze" output={outputs.outputA}>
        {fns?.analyze ?? (() => ({ value: 1 }))}
      </Task>
      <Task id="implement" output={outputs.outputB} dependsOn={["analyze"]}>
        {fns?.implement ?? (() => ({ value: 2 }))}
      </Task>
      <Task id="test" output={outputs.outputC} dependsOn={["implement"]}>
        {fns?.testTask ?? (() => ({ value: 3 }))}
      </Task>
    </Workflow>));
}
describe("timeTravel e2e", () => {
    test("timetravel resets node state and deletes later frames", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const { timeTravel } = await import("../src/timetravel.js");
        try {
            const workflow = buildThreeTaskWorkflow(smithers, outputs);
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "timetravel-reset" }));
            expect(result.status).toBe("finished");
            const implementAttempts = await adapter.listAttempts(result.runId, "implement", 0);
            const targetAttempt = implementAttempts[0];
            const framesBefore = await adapter.listFrames(result.runId, 1_000);
            const travel = await timeTravel(adapter, {
                runId: result.runId,
                nodeId: "implement",
                restoreVcs: false,
            });
            expect(travel.success).toBe(true);
            expect(travel.vcsRestored).toBe(false);
            expect(travel.resetNodes).toEqual(["implement", "test"]);
            const analyzeNode = await adapter.getNode(result.runId, "analyze", 0);
            const implementNode = await adapter.getNode(result.runId, "implement", 0);
            const testNode = await adapter.getNode(result.runId, "test", 0);
            expect(analyzeNode?.state).toBe("finished");
            expect(implementNode?.state).toBe("pending");
            expect(testNode?.state).toBe("pending");
            const framesAfter = await adapter.listFrames(result.runId, 1_000);
            expect(framesAfter.length).toBeLessThan(framesBefore.length);
            for (const frame of framesAfter) {
                expect(frame.createdAtMs).toBeLessThanOrEqual(targetAttempt.startedAtMs);
            }
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
    jjTimeTravelTest("timetravel with VCS restore uses jj pointer", async () => {
        const rootDir = createTempJjRepo();
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const { timeTravel } = await import("../src/timetravel.js");
        try {
            const workflow = buildThreeTaskWorkflow(smithers, outputs);
            const result = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: "timetravel-vcs",
                rootDir,
            }));
            expect(result.status).toBe("finished");
            const implementAttempts = await adapter.listAttempts(result.runId, "implement", 0);
            expect(implementAttempts[0]?.jjPointer).toBeTruthy();
            const travel = await timeTravel(adapter, {
                runId: result.runId,
                nodeId: "implement",
                restoreVcs: true,
            });
            expect(travel.jjPointer ?? null).toBe(implementAttempts[0]?.jjPointer ?? null);
            expect(typeof travel.vcsRestored).toBe("boolean");
            expect(typeof travel.success).toBe("boolean");
        }
        finally {
            cleanup();
            rmSync(rootDir, { recursive: true, force: true });
        }
    }, END_TO_END_TIMEOUT_MS);
    test("timetravel + resume completes the workflow", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const { timeTravel } = await import("../src/timetravel.js");
        let analyzeCalls = 0;
        let implementCalls = 0;
        let testCalls = 0;
        let shouldFailImplement = true;
        try {
            const workflow = smithers(() => (<Workflow name="timetravel-resume">
            <Task id="analyze" output={outputs.outputA}>
              {() => {
                    analyzeCalls += 1;
                    return { value: 1 };
                }}
            </Task>
            <Task id="implement" output={outputs.outputB} dependsOn={["analyze"]} noRetry>
              {() => {
                    implementCalls += 1;
                    if (shouldFailImplement) {
                        shouldFailImplement = false;
                        throw new Error("implement failed first time");
                    }
                    return { value: 2 };
                }}
            </Task>
            <Task id="test" output={outputs.outputC} dependsOn={["implement"]}>
              {() => {
                    testCalls += 1;
                    return { value: 3 };
                }}
            </Task>
          </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: "timetravel-resume",
            }));
            expect(first.status).toBe("failed");
            expect(analyzeCalls).toBe(1);
            expect(implementCalls).toBe(1);
            expect(testCalls).toBe(0);
            const travel = await timeTravel(adapter, {
                runId: first.runId,
                nodeId: "implement",
                restoreVcs: false,
            });
            expect(travel.success).toBe(true);
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(analyzeCalls).toBe(1);
            expect(implementCalls).toBe(2);
            expect(testCalls).toBe(1);
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
    test("timetravel with noDeps only resets target node", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const { timeTravel } = await import("../src/timetravel.js");
        try {
            const workflow = smithers(() => (<Workflow name="timetravel-node-only">
            <Task id="A" output={outputs.outputA}>
              {{ value: 1 }}
            </Task>
            <Task id="B" output={outputs.outputB}>
              {{ value: 2 }}
            </Task>
            <Task id="C" output={outputs.outputC}>
              {{ value: 3 }}
            </Task>
          </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "timetravel-node-only" }));
            expect(result.status).toBe("finished");
            const travel = await timeTravel(adapter, {
                runId: result.runId,
                nodeId: "B",
                resetDependents: false,
                restoreVcs: false,
            });
            expect(travel.success).toBe(true);
            expect(travel.resetNodes).toEqual(["B"]);
            const nodeA = await adapter.getNode(result.runId, "A", 0);
            const nodeB = await adapter.getNode(result.runId, "B", 0);
            const nodeC = await adapter.getNode(result.runId, "C", 0);
            expect(nodeA?.state).toBe("finished");
            expect(nodeB?.state).toBe("pending");
            expect(nodeC?.state).toBe("finished");
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
    test("timetravel errors on non-existent attempt", async () => {
        const { db, cleanup } = createTestSmithers(outputSchemas);
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        const { timeTravel } = await import("../src/timetravel.js");
        try {
            const travel = await timeTravel(adapter, {
                runId: "missing-run",
                nodeId: "missing-node",
                restoreVcs: false,
            });
            expect(travel.success).toBe(false);
            expect(travel.error).toContain("Attempt not found");
        }
        finally {
            cleanup();
        }
    });
    test("timetravel to specific attempt number", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const { timeTravel } = await import("../src/timetravel.js");
        let calls = 0;
        try {
            const workflow = smithers(() => (<Workflow name="timetravel-attempt-selection">
            <Task id="flaky" output={outputs.outputA} retries={2}>
              {() => {
                    calls += 1;
                    if (calls < 3)
                        throw new Error(`fail ${calls}`);
                    return { value: calls };
                }}
            </Task>
          </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: "timetravel-attempt-selection",
            }));
            expect(result.status).toBe("finished");
            const attempts = await adapter.listAttempts(result.runId, "flaky", 0);
            expect(attempts).toHaveLength(3);
            const travel = await timeTravel(adapter, {
                runId: result.runId,
                nodeId: "flaky",
                attempt: 1,
                restoreVcs: false,
            });
            expect(travel.success).toBe(true);
            expect(travel.resetNodes).toEqual(["flaky"]);
            const node = await adapter.getNode(result.runId, "flaky", 0);
            expect(node?.state).toBe("pending");
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
});
