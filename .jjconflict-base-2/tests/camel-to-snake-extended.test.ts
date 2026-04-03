import { describe, expect, test } from "bun:test";
import { camelToSnake } from "../src/utils/camelToSnake";

describe("camelToSnake extended", () => {
  test("converts simple camelCase", () => {
    expect(camelToSnake("firstName")).toBe("first_name");
  });

  test("converts multiple humps", () => {
    expect(camelToSnake("myLongVariableName")).toBe("my_long_variable_name");
  });

  test("handles single word", () => {
    expect(camelToSnake("name")).toBe("name");
  });

  test("handles leading uppercase (PascalCase)", () => {
    expect(camelToSnake("MyComponent")).toBe("_my_component");
  });

  test("handles numbers in middle", () => {
    expect(camelToSnake("column2Name")).toBe("column2_name");
  });

  test("handles empty string", () => {
    expect(camelToSnake("")).toBe("");
  });

  test("handles single char", () => {
    expect(camelToSnake("a")).toBe("a");
  });

  test("handles already snake_case", () => {
    expect(camelToSnake("already_snake")).toBe("already_snake");
  });

  test("handles consecutive uppercase (acronyms)", () => {
    const result = camelToSnake("parseHTML");
    // Each uppercase letter gets a preceding underscore
    expect(result).toContain("_h");
  });
});
