/**
 * Type-level tests for createSmithers type inference.
 *
 * These tests use `bun test` but the real assertions are compile-time:
 * if this file type-checks, the inference is working. Runtime assertions
 * verify the types resolve to expected shapes at the value level too.
 */
import { describe, expect, test } from "bun:test";
import { createSmithers } from "../src/index.ts";
import { z } from "zod";
import type { SmithersCtx, InferDeps, InferOutputEntry } from "../src/index.ts";

// ─── Schema fixtures ───────────────────────────────────────────────

const analysisSchema = z.object({
  summary: z.string(),
  issues: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
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

// ─── Type-level helpers ────────────────────────────────────────────

// Compile-time assertion: T must be assignable to U and vice versa
type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ─── InferOutputEntry tests (compile-time) ─────────────────────────

type AnalysisInferred = InferOutputEntry<typeof analysisSchema>;
type _AssertAnalysis = Expect<
  Equal<
    AnalysisInferred,
    {
      summary: string;
      issues: { file: string; line: number; severity: "low" | "medium" | "high" }[];
    }
  >
>;

type FixInferred = InferOutputEntry<typeof fixSchema>;
type _AssertFix = Expect<
  Equal<
    FixInferred,
    { patch: string; explanation: string; filesChanged: string[] }
  >
>;

type DepsInferred = InferDeps<{
  analysis: typeof analysisSchema;
  fix: typeof fixSchema;
}>;
type _AssertDeps = Expect<
  Equal<
    DepsInferred,
    {
      analysis: {
        summary: string;
        issues: { file: string; line: number; severity: "low" | "medium" | "high" }[];
      };
      fix: { patch: string; explanation: string; filesChanged: string[] };
    }
  >
>;

// ─── createSmithers type inference ─────────────────────────────────

const schemas = {
  analysis: analysisSchema,
  fix: fixSchema,
  report: reportSchema,
};

const { smithers, useCtx, tables, outputs } = createSmithers(schemas);

// Verify `tables` has the correct keys
type TablesKeys = keyof typeof tables;
type _AssertTablesKeys = Expect<Equal<TablesKeys, "analysis" | "fix" | "report">>;

// Verify `outputs` has the correct keys and types (pass-through of schemas)
type OutputsKeys = keyof typeof outputs;
type _AssertOutputsKeys = Expect<Equal<OutputsKeys, "analysis" | "fix" | "report">>;
type _AssertOutputsAnalysis = Expect<Equal<typeof outputs.analysis, typeof analysisSchema>>;
type _AssertOutputsFix = Expect<Equal<typeof outputs.fix, typeof fixSchema>>;
type _AssertOutputsReport = Expect<Equal<typeof outputs.report, typeof reportSchema>>;

// ─── SmithersCtx inference via createSmithers ──────────────────────

// Extract the ctx type from the smithers builder
type CtxType = Parameters<Parameters<typeof smithers>[0]>[0];

// Verify ctx type is properly inferred from the smithers builder
type _AssertCtxIsSmithersCtx = Expect<Equal<CtxType, SmithersCtx<typeof schemas>>>;

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
    // This is a compile-time test: useCtx() should return SmithersCtx<typeof schemas>
    type Ctx = ReturnType<typeof useCtx>;
    type _AssertCtx = Expect<
      Equal<Ctx, SmithersCtx<typeof schemas>>
    >;
    expect(true).toBe(true);
  });

  test("ctx.output infers return type from string key", () => {
    // Build a mock ctx to test inference at value level
    type Ctx = SmithersCtx<typeof schemas>;

    // These are compile-time checks — if the types are wrong, tsc fails
    type AnalysisOutput = ReturnType<{
      // Extract the string-key overload
      <K extends keyof typeof schemas & string>(
        table: K,
        key: { nodeId: string; iteration?: number },
      ): InferOutputEntry<(typeof schemas)[K]>;
    }>;

    // Verify the output method signature exists with string keys
    const _checkOutput = (ctx: Ctx) => {
      const a = ctx.output("analysis", { nodeId: "a" });
      // a.summary should be string
      const _s: string = a.summary;
      // a.issues should be array
      const _i: { file: string; line: number; severity: "low" | "medium" | "high" }[] = a.issues;

      const f = ctx.output("fix", { nodeId: "f" });
      const _p: string = f.patch;
      const _e: string = f.explanation;
      const _fc: string[] = f.filesChanged;

      const r = ctx.output("report", { nodeId: "r" });
      const _t: string = r.title;
      const _b: string = r.body;
      const _ic: number = r.issueCount;
    };

    expect(true).toBe(true);
  });

  test("ctx.outputMaybe infers return type | undefined from string key", () => {
    const _check = (ctx: SmithersCtx<typeof schemas>) => {
      const a = ctx.outputMaybe("analysis", { nodeId: "a" });

      // Should be the schema type | undefined
      if (a) {
        const _s: string = a.summary;
        const _i: { file: string; line: number; severity: "low" | "medium" | "high" }[] = a.issues;
      }

      // Without narrowing, should accept undefined
      const _u: typeof a = undefined;
    };

    expect(true).toBe(true);
  });

  test("ctx.latest infers return type | undefined from string key", () => {
    const _check = (ctx: SmithersCtx<typeof schemas>) => {
      const a = ctx.latest("analysis", "analyze");

      if (a) {
        const _s: string = a.summary;
      }

      const _u: typeof a = undefined;
    };

    expect(true).toBe(true);
  });

  test("ctx.outputs accessor is typed by key", () => {
    const _check = (ctx: SmithersCtx<typeof schemas>) => {
      // Property access should be typed
      const rows = ctx.outputs.analysis;
      const _first: { summary: string; issues: any[] } | undefined = rows[0];

      // Function call with string key should also be typed
      const fixRows = ctx.outputs("fix");
      const _patch: string | undefined = fixRows[0]?.patch;
    };

    expect(true).toBe(true);
  });

  test("invalid string keys are rejected at compile time", () => {
    const _check = (ctx: SmithersCtx<typeof schemas>) => {
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
    // The smithers() function should pass a typed ctx to the builder
    type BuilderParam = Parameters<typeof smithers>[0];
    type BuilderCtx = Parameters<BuilderParam>[0];

    // ctx should have output/outputMaybe that accept our schema keys
    type _AssertHasOutput = BuilderCtx["output"];
    type _AssertHasOutputMaybe = BuilderCtx["outputMaybe"];
    type _AssertHasLatest = BuilderCtx["latest"];

    expect(true).toBe(true);
  });
});
