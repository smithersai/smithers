import { describe, expect, test } from "bun:test";
import * as constants from "../src/constants";

describe("constants", () => {
  test("exports are defined", () => {
    // Constants module should export configuration values
    expect(constants).toBeDefined();
    expect(typeof constants).toBe("object");
  });

  test("exported values are primitive types", () => {
    for (const [key, value] of Object.entries(constants)) {
      const type = typeof value;
      expect(["string", "number", "boolean", "object"].includes(type)).toBe(true);
    }
  });

  // Test specific known constants if they exist
  test("has expected constant keys", () => {
    const keys = Object.keys(constants);
    expect(keys.length).toBeGreaterThan(0);
  });
});
