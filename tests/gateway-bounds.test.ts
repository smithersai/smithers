import { describe, expect, test } from "bun:test";
import {
  assertGatewayInputDepthWithinBounds,
  getGatewayInputDepth,
  GATEWAY_RPC_INPUT_MAX_DEPTH,
} from "../src/gateway";

function nestedObject(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < levels; index += 1) {
    value = { child: value };
  }
  return value;
}

describe("gateway input depth checker", () => {
  test("measures nested object and array depth", () => {
    expect(
      getGatewayInputDepth({
        items: [
          {
            child: { leaf: true },
          },
        ],
      }),
    ).toBe(4);
  });

  test("accepts input at the configured max depth", () => {
    expect(() =>
      assertGatewayInputDepthWithinBounds(
        nestedObject(GATEWAY_RPC_INPUT_MAX_DEPTH - 1),
      )
    ).not.toThrow();
  });

  test("rejects input that exceeds the configured max depth", () => {
    expect(() =>
      assertGatewayInputDepthWithinBounds(
        nestedObject(GATEWAY_RPC_INPUT_MAX_DEPTH),
      )
    ).toThrow(/maximum nesting depth/i);
  });
});
