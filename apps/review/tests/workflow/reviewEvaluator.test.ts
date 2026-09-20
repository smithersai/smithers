import { expect, test } from "bun:test";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import { layerMemory, layerNode, scriptedEvaluator } from "../../src/workflow/reviewLayer.ts";

const seats = SeatResolver.layerNoop();

test("review hosts refuse a missing judge while assembling layers", () => {
  expect(() => layerMemory(seats, {})).toThrow("smithers-review needs AI_GATEWAY_API_KEY,");
  expect(() => layerNode({ filename: "/unused/review.db", seats, environment: {} }))
    .toThrow("smithers-review needs AI_GATEWAY_API_KEY,");
});

test("an offline review explicitly supplies its judge", () => {
  expect(() => layerNode({ filename: "/unused/review.db", seats, environment: {}, evaluator: scriptedEvaluator() }))
    .not.toThrow();
});

test("a walkthrough-only composition registers no agents and needs no judge", () => {
  expect(() => layerNode({ filename: "/unused/review.db", seats, environment: {}, agents: false }))
    .not.toThrow();
});
