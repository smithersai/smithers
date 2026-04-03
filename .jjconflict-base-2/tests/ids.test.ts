import { describe, expect, test } from "bun:test";
import { newRunId } from "../src/utils/ids";

describe("newRunId", () => {
  test("returns a string", () => {
    const id = newRunId();
    expect(typeof id).toBe("string");
  });

  test("returns unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newRunId());
    }
    expect(ids.size).toBe(100);
  });

  test("looks like a UUID", () => {
    const id = newRunId();
    // crypto.randomUUID produces standard UUID format
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
