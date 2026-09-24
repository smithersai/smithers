import { expect, test } from "bun:test";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import { layerMemory, layerNode } from "../../src/workflow/reviewLayer.ts";

const seats = SeatResolver.layerNoop();

test("review hosts compose from an environment that names no judge credential", () => {
  expect(() => layerMemory(seats, {})).not.toThrow();
  expect(() => layerNode({ filename: "/unused/review.db", seats, environment: {} })).not.toThrow();
});

test("a walkthrough-only composition registers no agents and needs no judge", () => {
  expect(() => layerNode({ filename: "/unused/review.db", seats, environment: {}, agents: false }))
    .not.toThrow();
});
