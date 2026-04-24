import { describe, expect, test } from "bun:test";
import { extractTextFromJsonValue } from "../src/BaseCliAgent/extractTextFromJsonValue.js";

describe("extractTextFromJsonValue", () => {
  test("does not treat arbitrary part.text as assistant output", () => {
    const value = {
      type: "reasoning",
      part: {
        type: "reasoning",
        text: "internal reasoning should not surface",
      },
    };

    expect(extractTextFromJsonValue(value)).toBeUndefined();
  });
});
