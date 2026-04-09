import { describe, expect, test } from "bun:test";
import {
  SmithersError,
  isSmithersError,
  errorToJson,
  smithersErrorDefinitions,
  knownSmithersErrorCodes,
  ERROR_REFERENCE_URL,
  type SmithersErrorCategory,
} from "../src/utils/errors";

describe("smithersErrorDefinitions", () => {
  test("all definitions have a category", () => {
    for (const [code, def] of Object.entries(smithersErrorDefinitions)) {
      expect(def.category).toBeDefined();
      expect(typeof def.category).toBe("string");
    }
  });

  test("all definitions have a 'when' description", () => {
    for (const [code, def] of Object.entries(smithersErrorDefinitions)) {
      expect(def.when).toBeDefined();
      expect(typeof def.when).toBe("string");
      expect(def.when.length).toBeGreaterThan(0);
    }
  });

  test("categories are valid SmithersErrorCategory values", () => {
    const validCategories: SmithersErrorCategory[] = [
      "engine", "components", "tools", "agents",
      "database", "effect", "hot", "scorers", "cli", "integrations",
    ];
    for (const [code, def] of Object.entries(smithersErrorDefinitions)) {
      expect(validCategories).toContain(def.category);
    }
  });

  test("error codes are uppercase with underscores", () => {
    for (const code of Object.keys(smithersErrorDefinitions)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("key engine error codes exist", () => {
    const codes = Object.keys(smithersErrorDefinitions);
    expect(codes).toContain("INVALID_INPUT");
    expect(codes).toContain("MISSING_INPUT");
    expect(codes).toContain("TASK_TIMEOUT");
    expect(codes).toContain("TASK_ABORTED");
  });

  test("key component error codes exist", () => {
    const codes = Object.keys(smithersErrorDefinitions);
    expect(codes).toContain("TASK_ID_REQUIRED");
    expect(codes).toContain("DUPLICATE_ID");
    expect(codes).toContain("NESTED_LOOP");
    expect(codes).toContain("MISSING_OUTPUT");
  });

  test("key tool error codes exist", () => {
    const codes = Object.keys(smithersErrorDefinitions);
    expect(codes).toContain("TOOL_PATH_ESCAPE");
    expect(codes).toContain("TOOL_NETWORK_DISABLED");
  });

  test("key agent error codes exist", () => {
    const codes = Object.keys(smithersErrorDefinitions);
    expect(codes).toContain("AGENT_CLI_ERROR");
    expect(codes).toContain("AGENT_DIAGNOSTIC_TIMEOUT");
  });
});

describe("knownSmithersErrorCodes", () => {
  test("is an array of strings", () => {
    expect(Array.isArray(knownSmithersErrorCodes)).toBe(true);
    for (const code of knownSmithersErrorCodes) {
      expect(typeof code).toBe("string");
    }
  });

  test("contains all definition keys", () => {
    for (const code of Object.keys(smithersErrorDefinitions)) {
      expect(knownSmithersErrorCodes.includes(code as any)).toBe(true);
    }
  });
});

describe("SmithersError", () => {
  test("includes docsUrl in message", () => {
    const err = new SmithersError("INVALID_INPUT", "bad");
    expect(err.message).toContain(ERROR_REFERENCE_URL);
  });

  test("preserves cause", () => {
    const cause = new Error("root cause");
    const err = new SmithersError("INVALID_INPUT", "bad", undefined, { cause });
    expect(err.cause).toBe(cause);
  });

  test("is instanceof Error", () => {
    const err = new SmithersError("INVALID_INPUT", "bad");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("errorToJson", () => {
  test("serializes SmithersError", () => {
    const err = new SmithersError("INVALID_INPUT", "bad", { field: "name" });
    const json = errorToJson(err);
    expect(json.code).toBe("INVALID_INPUT");
    expect(json.message).toContain("bad");
    expect(json.details).toEqual({ field: "name" });
  });

  test("serializes plain Error", () => {
    const err = new Error("test");
    const json = errorToJson(err);
    expect(json.name).toBe("Error");
    expect(json.message).toBe("test");
  });

  test("serializes string error", () => {
    const json = errorToJson("oops");
    expect(json.message).toBe("oops");
  });

  test("serializes null", () => {
    const json = errorToJson(null);
    expect(json).toBeDefined();
  });

  test("serializes undefined", () => {
    const json = errorToJson(undefined);
    expect(json).toBeDefined();
  });
});
