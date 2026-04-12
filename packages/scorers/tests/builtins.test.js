import { describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import { schemaAdherenceScorer, latencyScorer, relevancyScorer, toxicityScorer, faithfulnessScorer, } from "../src/builtins.js";
describe("schemaAdherenceScorer", () => {
    const scorer = schemaAdherenceScorer();
    it("returns 1.0 when output matches schema", async () => {
        const schema = z.object({
            summary: z.string(),
            severity: z.enum(["low", "medium", "high"]),
        });
        const result = await scorer.score({
            input: "test",
            output: { summary: "All good", severity: "low" },
            outputSchema: schema,
        });
        expect(result.score).toBe(1);
        expect(result.reason).toBe("Output matches schema");
    });
    it("returns 0.0 when output fails schema validation", async () => {
        const schema = z.object({
            summary: z.string(),
            severity: z.enum(["low", "medium", "high"]),
        });
        const result = await scorer.score({
            input: "test",
            output: { summary: 123, severity: "extreme" },
            outputSchema: schema,
        });
        expect(result.score).toBe(0);
        expect(result.reason).toContain("Schema validation failed");
    });
    it("returns 1.0 with skip note when no schema is defined", async () => {
        const result = await scorer.score({
            input: "test",
            output: "anything",
        });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("No output schema defined");
        expect(result.meta?.skipped).toBe(true);
    });
    it("has correct id and name", () => {
        expect(scorer.id).toBe("schema-adherence");
        expect(scorer.name).toBe("Schema Adherence");
    });
});
describe("latencyScorer", () => {
    const scorer = latencyScorer({ targetMs: 5000, maxMs: 30000 });
    it("returns 1.0 when latency is within target", async () => {
        const result = await scorer.score({
            input: "test",
            output: "result",
            latencyMs: 3000,
        });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("within target");
    });
    it("returns 0.0 when latency exceeds max", async () => {
        const result = await scorer.score({
            input: "test",
            output: "result",
            latencyMs: 35000,
        });
        expect(result.score).toBe(0);
        expect(result.reason).toContain("exceeds max");
    });
    it("returns linear interpolation between target and max", async () => {
        const result = await scorer.score({
            input: "test",
            output: "result",
            latencyMs: 17500, // halfway between 5000 and 30000
        });
        expect(result.score).toBe(0.5);
    });
    it("returns 1.0 with skip note when no latency data", async () => {
        const result = await scorer.score({
            input: "test",
            output: "result",
        });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("No latency data");
        expect(result.meta?.skipped).toBe(true);
    });
    it("returns 1.0 at exactly target", async () => {
        const result = await scorer.score({
            input: "test",
            output: "result",
            latencyMs: 5000,
        });
        expect(result.score).toBe(1);
    });
    it("returns 0.0 at exactly max", async () => {
        const result = await scorer.score({
            input: "test",
            output: "result",
            latencyMs: 30000,
        });
        expect(result.score).toBe(0);
    });
    it("has correct id and description", () => {
        expect(scorer.id).toBe("latency");
        expect(scorer.description).toContain("5000ms");
        expect(scorer.description).toContain("30000ms");
    });
});
describe("relevancyScorer (LLM-based)", () => {
    it("creates a scorer with correct metadata", () => {
        const mockAgent = {
            generate: mock(async () => ({ text: '{ "score": 0.9, "reason": "Relevant" }' })),
        };
        const scorer = relevancyScorer(mockAgent);
        expect(scorer.id).toBe("relevancy");
        expect(scorer.name).toBe("Relevancy");
    });
    it("calls the judge agent and returns parsed score", async () => {
        const mockAgent = {
            generate: mock(async () => ({
                text: '{ "score": 0.9, "reason": "Output addresses the input directly" }',
            })),
        };
        const scorer = relevancyScorer(mockAgent);
        const result = await scorer.score({
            input: "What is TypeScript?",
            output: "TypeScript is a superset of JavaScript with static typing.",
        });
        expect(result.score).toBe(0.9);
        expect(result.reason).toBe("Output addresses the input directly");
        expect(mockAgent.generate).toHaveBeenCalledTimes(1);
    });
});
describe("toxicityScorer (LLM-based)", () => {
    it("creates a scorer with correct metadata", () => {
        const mockAgent = {
            generate: mock(async () => ({ text: '{ "score": 0 }' })),
        };
        const scorer = toxicityScorer(mockAgent);
        expect(scorer.id).toBe("toxicity");
        expect(scorer.name).toBe("Toxicity");
    });
    it("returns low score for clean content", async () => {
        const mockAgent = {
            generate: mock(async () => ({
                text: '{ "score": 0.0, "reason": "No toxic content detected" }',
            })),
        };
        const scorer = toxicityScorer(mockAgent);
        const result = await scorer.score({
            input: "test",
            output: "This is a professional response.",
        });
        expect(result.score).toBe(0);
        expect(result.reason).toBe("No toxic content detected");
    });
});
describe("faithfulnessScorer (LLM-based)", () => {
    it("creates a scorer with correct metadata", () => {
        const mockAgent = {
            generate: mock(async () => ({ text: '{ "score": 1 }' })),
        };
        const scorer = faithfulnessScorer(mockAgent);
        expect(scorer.id).toBe("faithfulness");
        expect(scorer.name).toBe("Faithfulness");
    });
    it("evaluates faithfulness with context", async () => {
        const mockAgent = {
            generate: mock(async () => ({
                text: '{ "score": 0.95, "reason": "All claims supported by context" }',
            })),
        };
        const scorer = faithfulnessScorer(mockAgent);
        const result = await scorer.score({
            input: "Summarize the document",
            output: "The document discusses TypeScript.",
            context: "TypeScript is discussed in the document as a key technology.",
        });
        expect(result.score).toBe(0.95);
        expect(result.reason).toBe("All claims supported by context");
    });
});
