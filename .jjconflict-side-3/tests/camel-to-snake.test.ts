import { describe, expect, test } from "bun:test";
import { camelToSnake } from "../src/utils/camelToSnake";

describe("camelToSnake", () => {
  test("converts simple camelCase", () => {
    expect(camelToSnake("myField")).toBe("my_field");
  });

  test("converts multiple words", () => {
    expect(camelToSnake("myLongFieldName")).toBe("my_long_field_name");
  });

  test("handles single word (no capitals)", () => {
    expect(camelToSnake("name")).toBe("name");
  });

  test("handles already snake_case", () => {
    expect(camelToSnake("my_field")).toBe("my_field");
  });

  test("handles PascalCase", () => {
    expect(camelToSnake("MyField")).toBe("_my_field");
  });

  test("handles consecutive capitals", () => {
    expect(camelToSnake("myURLField")).toBe("my_u_r_l_field");
  });

  test("handles empty string", () => {
    expect(camelToSnake("")).toBe("");
  });

  test("handles single character", () => {
    expect(camelToSnake("a")).toBe("a");
  });

  test("handles single uppercase character", () => {
    expect(camelToSnake("A")).toBe("_a");
  });
});
