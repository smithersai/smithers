import { describe, expect, test } from "bun:test";
import { resolveSdkModel } from "../src/agents/sdk-shared";

describe("resolveSdkModel", () => {
  test("returns model instance as-is when not a string", () => {
    const model = { id: "mock-model", provider: "test" };
    const result = resolveSdkModel(model, () => {
      throw new Error("should not be called");
    });
    expect(result).toBe(model);
  });

  test("calls create with string model id", () => {
    let receivedId = "";
    const mockModel = { id: "created" };
    const result = resolveSdkModel("claude-3-sonnet", (id) => {
      receivedId = id;
      return mockModel;
    });
    expect(receivedId).toBe("claude-3-sonnet");
    expect(result).toBe(mockModel);
  });

  test("handles empty string model id", () => {
    const mockModel = { id: "empty" };
    const result = resolveSdkModel("", (id) => mockModel);
    expect(result).toBe(mockModel);
  });

  test("returns exact same reference for object model", () => {
    const model = Object.freeze({ id: "frozen" });
    const result = resolveSdkModel(model, () => ({ id: "different" }));
    expect(result).toBe(model);
  });

  test("passes model id string unchanged to create function", () => {
    const ids: string[] = [];
    const create = (id: string) => {
      ids.push(id);
      return { id };
    };

    resolveSdkModel("gpt-4", create);
    resolveSdkModel("claude-3-opus", create);
    resolveSdkModel("gemini-pro", create);

    expect(ids).toEqual(["gpt-4", "claude-3-opus", "gemini-pro"]);
  });

  test("does not call create for non-string values", () => {
    let called = false;
    const create = () => {
      called = true;
      return {};
    };

    resolveSdkModel(42 as any, create);
    expect(called).toBe(false);

    resolveSdkModel(null as any, create);
    expect(called).toBe(false);

    resolveSdkModel(undefined as any, create);
    expect(called).toBe(false);

    resolveSdkModel({ custom: true } as any, create);
    expect(called).toBe(false);
  });

  test("returns create result for string input", () => {
    const sentinel = Symbol("unique");
    const result = resolveSdkModel("any-model", () => sentinel as any);
    expect(result).toBe(sentinel);
  });
});
