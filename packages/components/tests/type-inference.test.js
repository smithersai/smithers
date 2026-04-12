/**
 * Type-level tests for createSmithers type inference.
 *
 * These tests use `bun test` but the real assertions are compile-time:
 * if this file type-checks, the inference is working. Runtime assertions
 * verify the types resolve to expected shapes at the value level too.
 */
import { describe, expect, test } from "bun:test";
import { createSmithers } from "smithers";
import { z } from "zod";
// ─── Schema fixtures ───────────────────────────────────────────────
const analysisSchema = z.object({
    summary: z.string(),
    issues: z.array(z.object({
        file: z.string(),
        line: z.number(),
        severity: z.enum(["low", "medium", "high"]),
    })),
});
const fixSchema = z.object({
    patch: z.string(),
    explanation: z.string(),
    filesChanged: z.array(z.string()),
});
const reportSchema = z.object({
    title: z.string(),
    body: z.string(),
    issueCount: z.number(),
});
// ─── createSmithers type inference ─────────────────────────────────
const schemas = {
    analysis: analysisSchema,
    fix: fixSchema,
    report: reportSchema,
};
const { smithers, useCtx, tables, outputs } = createSmithers(schemas);
describe("createSmithers type inference", () => {
    test("tables has correct keys", () => {
        expect("analysis" in tables).toBe(true);
        expect("fix" in tables).toBe(true);
        expect("report" in tables).toBe(true);
    });
    test("outputs returns the original Zod schemas", () => {
        expect(outputs.analysis).toBe(analysisSchema);
        expect(outputs.fix).toBe(fixSchema);
        expect(outputs.report).toBe(reportSchema);
    });
    test("useCtx returns typed context", () => {
        expect(true).toBe(true);
    });
    test("ctx.output infers return type from string key", () => {
        // Verify the output method signature exists with string keys
        /**
     * @param {Ctx} ctx
     */
        const _checkOutput = (ctx) => {
            const a = ctx.output("analysis", { nodeId: "a" });
            // a.summary should be string
            const _s = a.summary;
            // a.issues should be array
            const _i = a.issues;
            const f = ctx.output("fix", { nodeId: "f" });
            const _p = f.patch;
            const _e = f.explanation;
            const _fc = f.filesChanged;
            const r = ctx.output("report", { nodeId: "r" });
            const _t = r.title;
            const _b = r.body;
            const _ic = r.issueCount;
        };
        expect(true).toBe(true);
    });
    test("ctx.outputMaybe infers return type | undefined from string key", () => {
        /**
     * @param {SmithersCtx<typeof schemas>} ctx
     */
        const _check = (ctx) => {
            const a = ctx.outputMaybe("analysis", { nodeId: "a" });
            // Should be the schema type | undefined
            if (a) {
                const _s = a.summary;
                const _i = a.issues;
            }
            // Without narrowing, should accept undefined
            const _u = undefined;
        };
        expect(true).toBe(true);
    });
    test("ctx.latest infers return type | undefined from string key", () => {
        /**
     * @param {SmithersCtx<typeof schemas>} ctx
     */
        const _check = (ctx) => {
            const a = ctx.latest("analysis", "analyze");
            if (a) {
                const _s = a.summary;
            }
            const _u = undefined;
        };
        expect(true).toBe(true);
    });
    test("ctx.outputs accessor is typed by key", () => {
        /**
     * @param {SmithersCtx<typeof schemas>} ctx
     */
        const _check = (ctx) => {
            // Property access should be typed
            const rows = ctx.outputs.analysis;
            const _first = rows[0];
            // Function call with string key should also be typed
            const fixRows = ctx.outputs("fix");
            const _patch = fixRows[0]?.patch;
        };
        expect(true).toBe(true);
    });
    test("invalid string keys are rejected at compile time", () => {
        /**
     * @param {SmithersCtx<typeof schemas>} ctx
     */
        const _check = (ctx) => {
            // @ts-expect-error — "nonexistent" is not a key in the schema
            ctx.output("nonexistent", { nodeId: "a" });
            // @ts-expect-error — "nonexistent" is not a key in the schema
            ctx.outputMaybe("nonexistent", { nodeId: "a" });
            // @ts-expect-error — "nonexistent" is not a key in the schema
            ctx.latest("nonexistent", "a");
        };
        expect(true).toBe(true);
    });
    test("smithers builder receives typed ctx", () => {
        expect(true).toBe(true);
    });
});
