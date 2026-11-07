import { describe, expect, test } from "bun:test";
import { workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { SANDBOX_CSS_ID, sandboxCss } from "../src/sandbox/sandboxCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("sandbox-previews css contract", () => {
  test("uses the lane id as the fragment id", () => {
    expect(SANDBOX_CSS_ID).toBe("sandbox-previews");
  });

  test("never emits a :root token block", () => {
    expect(sandboxCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(sandboxCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(sandboxCss);
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = sandboxCss.match(/color-mix\([^,]+/g) ?? [];
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = sandboxCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("var() fallbacks are byte-equal to the styleguide light values", () => {
    const rootBlock = workflowUiThemeCss.split("\n")[0] ?? "";
    const lightValues = new Map<string, string>();
    for (const m of rootBlock.matchAll(/(--[\w-]+):([^;]+);/g)) {
      lightValues.set(m[1]!, m[2]!.trim());
    }
    let checked = 0;
    for (const m of sandboxCss.matchAll(/var\((--[\w-]+),\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\d\s]+)\)/g)) {
      const houseValue = lightValues.get(m[1]!);
      if (houseValue === undefined) continue;
      if (houseValue.startsWith("var(") || houseValue.startsWith("color-mix(")) continue;
      expect(`${m[1]}=${m[2]!.trim()}`).toBe(`${m[1]}=${houseValue}`);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
