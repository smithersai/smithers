import { describe, expect, test } from "bun:test";
import * as Seat from "@smthrs/agent/Seat";
import * as DeferredTools from "@smthrs/model/DeferredTools";
import { resolveInferenceEnv } from "../../action/src/resolveInferenceEnv.ts";
import { liveSuiteGate } from "../support/liveSuite.ts";

const session = { anthropicBaseUrl: "https://review.test/api/anthropic", sessionToken: "srs_tok" };

describe("resolveInferenceEnv", () => {
  test("a bring-your-own Anthropic key wins and never sets a base URL", () => {
    const resolved = resolveInferenceEnv({ ...session, anthropicApiKey: "sk-ant-byo" });
    expect(resolved.mode).toBe("byo-anthropic");
    expect(resolved.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-byo" });
  });

  test("a bring-your-own OpenAI key moves both seats onto the openai provider", () => {
    const resolved = resolveInferenceEnv({ ...session, openaiApiKey: "sk-oai-byo" });
    expect(resolved.mode).toBe("byo-openai");
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-oai-byo");
    // A seat's provider is the half ahead of the colon, and it decides which
    // credential is read: an openai key with anthropic: seats resolves nothing.
    expect(resolved.env.SMITHERS_REVIEW_SEAT).toStartWith("openai:");
    expect(resolved.env.SMITHERS_REVIEW_CHEAP_SEAT).toStartWith("openai:");
  });

  test("Anthropic wins over OpenAI when both are set", () => {
    const resolved = resolveInferenceEnv({ ...session, anthropicApiKey: "sk-ant", openaiApiKey: "sk-oai" });
    expect(resolved.mode).toBe("byo-anthropic");
  });

  test("blank keys are treated as unset", () => {
    const resolved = resolveInferenceEnv({ ...session, anthropicApiKey: "  ", openaiApiKey: "" });
    expect(resolved.mode).toBe("proxy");
  });

  test("the default is the metered proxy, pointed at the session's origin", () => {
    const resolved = resolveInferenceEnv(session);
    expect(resolved.mode).toBe("proxy");
    expect(resolved.env).toEqual({
      ANTHROPIC_BASE_URL: "https://review.test/api/anthropic",
      ANTHROPIC_API_KEY: "srs_tok",
    });
  });
});

/** The two model ids the BYO-OpenAI mode puts on the wire. */
const openaiSeatModels = (): ReadonlyArray<string> => {
  const resolved = resolveInferenceEnv({ ...session, openaiApiKey: "sk-oai-byo" });
  return [resolved.env.SMITHERS_REVIEW_SEAT!, resolved.env.SMITHERS_REVIEW_CHEAP_SEAT!].map(Seat.modelIdOf);
};

describe("the BYO-OpenAI seats name models that exist", () => {
  // A seat string is never validated: an unserved model id resolves to a route
  // that 404s on first use, and both steps that run on the cheap seat catch
  // their own failure, so the mode degrades to "no narration, no quiz" with
  // nothing in the log. The pin is what makes a typo loud.
  test("the review seat is GPT-6 Sol and the cheap seat is one @smthrs/model reports wire support for", () => {
    const [review, cheap] = openaiSeatModels();
    expect(review).toBe("gpt-6-sol");
    expect({ modelId: cheap, supported: DeferredTools.supportsDeferred("openai-responses", cheap!) }).toEqual({
      modelId: cheap,
      supported: true,
    });
  });

  test("neither seat is a GPT-5.6 model", () => {
    expect(openaiSeatModels().filter((modelId) => /gpt-5\.6/.test(modelId))).toEqual([]);
  });

  const liveModels = liveSuiteGate({
    tag: "openai seats",
    enabled: Boolean(process.env.OPENAI_API_KEY?.trim()),
    reason: "no OPENAI_API_KEY: the seat model ids were not checked against the live API",
  });

  test.skipIf(!liveModels)("the OpenAI API serves both models", async () => {
    for (const modelId of openaiSeatModels()) {
      const response = await fetch(`https://api.openai.com/v1/models/${modelId}`, {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
      });
      expect({ modelId, status: response.status }).toEqual({ modelId, status: 200 });
    }
  }, 60_000);
});
