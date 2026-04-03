import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { schemaAdherenceScorer, latencyScorer } from "../src/scorers";

describe("schemaAdherenceScorer", () => {
  const scorer = schemaAdherenceScorer();

  test("returns id and name", () => {
    expect(scorer.id).toBe("schema-adherence");
    expect(scorer.name).toBe("Schema Adherence");
  });

  test("returns 1.0 when output matches schema", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await scorer.score({
      input: "test",
      output: { name: "Alice", age: 30 },
      outputSchema: schema as any,
    });
    expect(result.score).toBe(1);
    expect(result.reason).toBe("Output matches schema");
  });

  test("returns 0.0 when output fails validation", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await scorer.score({
      input: "test",
      output: { name: 123, age: "not a number" },
      outputSchema: schema as any,
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("Schema validation failed");
    expect(result.meta?.issues).toBeDefined();
  });

  test("returns 1.0 with skipped when no schema provided", async () => {
    const result = await scorer.score({
      input: "test",
      output: { anything: true },
    });
    expect(result.score).toBe(1);
    expect(result.meta?.skipped).toBe(true);
  });

  test("includes validation error paths in meta", async () => {
    const schema = z.object({
      nested: z.object({ value: z.string() }),
    });
    const result = await scorer.score({
      input: "test",
      output: { nested: { value: 42 } },
      outputSchema: schema as any,
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("nested");
  });
});

describe("latencyScorer", () => {
  const scorer = latencyScorer({ targetMs: 5000, maxMs: 30000 });

  test("returns id and name", () => {
    expect(scorer.id).toBe("latency");
    expect(scorer.name).toBe("Latency");
  });

  test("returns 1.0 at or below target", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 3000 });
    expect(result.score).toBe(1);
  });

  test("returns 1.0 exactly at target", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 5000 });
    expect(result.score).toBe(1);
  });

  test("returns 0.0 at or above max", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 30000 });
    expect(result.score).toBe(0);
  });

  test("returns 0.0 above max", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 50000 });
    expect(result.score).toBe(0);
  });

  test("linear interpolation at midpoint", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 17500 });
    expect(result.score).toBe(0.5);
  });

  test("linear interpolation at quarter point", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 11250 });
    expect(result.score).toBe(0.75);
  });

  test("returns 1.0 with skipped when no latency data", async () => {
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(1);
    expect(result.meta?.skipped).toBe(true);
  });

  test("score is clamped to [0, 1]", async () => {
    const result = await scorer.score({ input: "", output: "", latencyMs: 100000 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
