import { describe, expect, test } from "bun:test";
import { relevancyScorer, toxicityScorer, faithfulnessScorer, } from "../src/index.js";
/**
 * @param {string} responseText
 */
function mockJudge(responseText) {
    return {
        generate: async () => ({ text: responseText }),
    };
}
describe("relevancyScorer", () => {
    test("has correct id and name", () => {
        const scorer = relevancyScorer(mockJudge('{"score": 1}'));
        expect(scorer.id).toBe("relevancy");
        expect(scorer.name).toBe("Relevancy");
    });
    test("passes input and output to judge", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 0.8}' };
            },
        };
        const scorer = relevancyScorer(judge);
        await scorer.score({ input: "What is AI?", output: "AI is artificial intelligence" });
        expect(receivedPrompt).toContain("What is AI?");
        expect(receivedPrompt).toContain("AI is artificial intelligence");
    });
    test("returns parsed score from judge", async () => {
        const scorer = relevancyScorer(mockJudge('{"score": 0.85, "reason": "Relevant"}'));
        const result = await scorer.score({ input: "test", output: "answer" });
        expect(result.score).toBe(0.85);
        expect(result.reason).toBe("Relevant");
    });
});
describe("toxicityScorer", () => {
    test("has correct id and name", () => {
        const scorer = toxicityScorer(mockJudge('{"score": 0}'));
        expect(scorer.id).toBe("toxicity");
        expect(scorer.name).toBe("Toxicity");
    });
    test("uses output in prompt", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 0.0}' };
            },
        };
        const scorer = toxicityScorer(judge);
        await scorer.score({ input: "", output: "Hello, how are you?" });
        expect(receivedPrompt).toContain("Hello, how are you?");
    });
    test("returns clean score for non-toxic content", async () => {
        const scorer = toxicityScorer(mockJudge('{"score": 0.0, "reason": "Clean content"}'));
        const result = await scorer.score({ input: "", output: "Have a nice day" });
        expect(result.score).toBe(0);
    });
    test("returns high score for toxic content", async () => {
        const scorer = toxicityScorer(mockJudge('{"score": 0.9, "reason": "Contains harmful content"}'));
        const result = await scorer.score({ input: "", output: "toxic text" });
        expect(result.score).toBe(0.9);
    });
});
describe("faithfulnessScorer", () => {
    test("has correct id and name", () => {
        const scorer = faithfulnessScorer(mockJudge('{"score": 1}'));
        expect(scorer.id).toBe("faithfulness");
        expect(scorer.name).toBe("Faithfulness");
    });
    test("includes context in prompt when provided", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 1.0}' };
            },
        };
        const scorer = faithfulnessScorer(judge);
        await scorer.score({
            input: "Summarize",
            output: "The capital is Paris",
            context: "France's capital city is Paris",
        });
        expect(receivedPrompt).toContain("France's capital city is Paris");
    });
    test("handles missing context", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 0.5}' };
            },
        };
        const scorer = faithfulnessScorer(judge);
        await scorer.score({
            input: "Summarize",
            output: "Some output",
        });
        expect(receivedPrompt).toContain("No context provided");
    });
    test("returns parsed score", async () => {
        const scorer = faithfulnessScorer(mockJudge('{"score": 0.95, "reason": "Faithful to context"}'));
        const result = await scorer.score({
            input: "test",
            output: "answer",
            context: "source material",
        });
        expect(result.score).toBe(0.95);
        expect(result.reason).toBe("Faithful to context");
    });
});
