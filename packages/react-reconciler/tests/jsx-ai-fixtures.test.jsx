/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runWorkflow } from "@smithers/engine";
import workflow from "../../smithers/tests/fixtures/jsx-ai-release-notes.jsx";
describe("JSX AI fixtures", () => {
    test("release notes agent summarizes changelog", async () => {
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            rootDir: process.cwd(),
        }));
        expect(result.status).toBe("finished");
        const rows = result.output;
        expect(rows[0]?.latestVersion).toBe("1.2.0");
        expect(rows[0]?.changeCount).toBe(2);
        expect(rows[0]?.highlights).toEqual([
            "Add caching for workflow runs",
            "Fix resume input handling",
        ]);
    });
});
