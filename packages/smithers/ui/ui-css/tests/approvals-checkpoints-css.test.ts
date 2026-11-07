import { describe, expect, test } from "bun:test";
import { APPROVALS_CHECKPOINTS_CSS_ID, approvalsCss } from "../src/approvals/approvalsCss";

/** The four css-contract predicates, scoped to this lane's fragment. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("approvals-checkpoints css contract", () => {
  test("exports the frozen lane id", () => {
    expect(APPROVALS_CHECKPOINTS_CSS_ID).toBe("approvals-checkpoints");
  });

  test("never emits a :root token block", () => {
    expect(approvalsCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    expect(stripVarFallbacks(approvalsCss)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() outside var() fallback position", () => {
    const stripped = stripVarFallbacks(approvalsCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = approvalsCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = approvalsCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("uses the frozen lane prefixes", () => {
    expect(approvalsCss).toContain(".sui-confirm {");
    expect(approvalsCss).toContain(".sui-confirm:focus-visible");
    expect(approvalsCss).toContain(".sui-confirm-action:focus-visible");
    expect(approvalsCss).toContain(".sui-approval-card {");
    expect(approvalsCss).toContain(".sui-checkpoint {");
  });
});
