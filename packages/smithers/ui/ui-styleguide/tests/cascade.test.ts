/**
 * What the sheet actually paints on a tinted button, after the cascade.
 *
 * `.button.primary` matches the generic `.button:hover` and
 * `.button:active:not(:disabled)` rules as well as its own, and the generic
 * ones set a neutral fill. When the primary state rules stopped restating
 * `background`, the neutral fill won on specificity and brand-colored 13px text
 * landed on an unaudited surface -- below 4.5:1 in eight variants. Reading the
 * rules in order does not show that; resolving them does.
 */
import { describe, expect, test } from "bun:test";
import { workflowUiThemeCss } from "../src/index.ts";

type Rule = { selector: string; declarations: string; order: number };

/** Top-level rules only: `:root` token blocks and `@media` wrappers carry no component fills. */
function componentRules(css: string): Rule[] {
  return css
    .split("\n")
    .map((line, order) => ({ line, order }))
    .filter(({ line }) => !line.startsWith(":root") && !line.startsWith("@media") && line.includes("{"))
    .flatMap(({ line, order }) => {
      const open = line.indexOf("{");
      const close = line.lastIndexOf("}");
      if (close <= open) return [];
      return [{ selector: line.slice(0, open).trim(), declarations: line.slice(open + 1, close), order }];
    });
}

type Element = { classes: readonly string[]; states: readonly string[] };

/** True when every simple part of one compound selector applies to `element`. */
function matches(compound: string, element: Element): boolean {
  const parts = compound.trim().match(/\.[\w-]+|:not\([^)]*\)|::?[\w-]+|\[[^\]]*\]|^\*$|^[a-z]+/g);
  if (parts === null || compound.includes(" ") || compound.includes(",")) return false;
  return parts.every((part) => {
    if (part.startsWith(".")) return element.classes.includes(part.slice(1));
    if (part.startsWith(":not(")) {
      const inner = part.slice(5, -1);
      return !matches(inner, element);
    }
    if (part.startsWith("::")) return false;
    if (part.startsWith(":")) return element.states.includes(part.slice(1));
    return part === "button";
  });
}

/** CSS specificity of one compound selector as (classes+attributes+pseudo-classes, elements). */
function specificity(compound: string): number {
  const parts = compound.trim().match(/\.[\w-]+|:not\([^)]*\)|::?[\w-]+|\[[^\]]*\]/g) ?? [];
  return parts.reduce((total, part) => {
    if (part.startsWith(":not(")) return total + specificity(part.slice(5, -1));
    if (part.startsWith("::")) return total;
    return total + 1;
  }, 0);
}

/** The declaration that wins for `property` on `element`, by specificity then source order. */
function resolve(property: string, element: Element): string | undefined {
  let winner: { value: string; specificity: number; order: number } | undefined;
  for (const rule of componentRules(workflowUiThemeCss)) {
    for (const compound of rule.selector.split(",")) {
      if (!matches(compound, element)) continue;
      const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule.declarations);
      if (declaration === null) continue;
      const score = specificity(compound);
      if (
        winner === undefined || score > winner.specificity
        || (score === winner.specificity && rule.order >= winner.order)
      ) {
        winner = { value: declaration[1]!.trim(), specificity: score, order: rule.order };
      }
    }
  }
  return winner?.value;
}

describe("the resolved fill on a tinted button", () => {
  const cases = [
    ["button primary", ["button", "primary"], "var(--brand-soft)"],
    ["bare primary", ["primary"], "var(--brand-soft)"],
    ["button danger", ["button", "danger"], "var(--danger-soft)"],
    ["bare danger", ["danger"], "var(--danger-soft)"],
  ] as const;

  for (const [name, classes, expected] of cases) {
    for (const state of ["hover", "active"] as const) {
      test(`${name} on :${state} keeps its audited semantic tint`, () => {
        expect(resolve("background", { classes, states: [state] })).toBe(expected);
      });
    }
  }

  test("danger rests on the neutral control fill and primary on its tint", () => {
    expect(resolve("background", { classes: ["button", "primary"], states: [] })).toBe("var(--brand-soft)");
    expect(resolve("background", { classes: ["button", "danger"], states: [] })).toBe("var(--panel)");
    // Bare and compounded resolve alike. `.danger` used to be missing from the
    // shared control rule, so a bare one had no fill, no border, no min-height,
    // and no focus ring while `.primary` had all four.
    expect(resolve("background", { classes: ["danger"], states: [] })).toBe("var(--panel)");
    expect(resolve("min-height", { classes: ["danger"], states: [] })).toBe("var(--ctl-h)");
    expect(resolve("box-shadow", { classes: ["danger"], states: ["focus-visible"] })).toBe(
      "0 0 0 3px var(--ring)",
    );
  });

  for (const [name, classes] of cases) {
    for (const states of [["hover"], ["active"], ["hover", "active"]]) {
      test(`${name} keeps its focus ring on :${states.join(":")}`, () => {
        const focused = { classes, states: ["focus-visible", ...states] };
        const ring = "0 0 0 3px var(--ring)";
        const shadow = states.includes("active")
          ? `${ring}, inset 0 1px 2px rgb(var(--shadow-rgb) / 0.20)`
          : classes.some((name) => name === "primary") ? `${ring}, var(--shadow-2)` : ring;
        expect(resolve("box-shadow", focused)).toBe(shadow);
        expect(resolve("box-shadow", { classes, states })).not.toContain("var(--ring)");
      });
    }
  }

  test("a plain button still gets the neutral hover and active fills", () => {
    expect(resolve("background", { classes: ["button"], states: ["hover"] })).toBe("var(--hover)");
    expect(resolve("background", { classes: ["button"], states: ["active"] })).toBe(
      "color-mix(in srgb, var(--text) 6%, var(--hover))",
    );
  });

  test(":not(:disabled) actually excludes the disabled element", () => {
    // Asserting the resolved `background` alone would pass vacuously: the base
    // and active primary rules both paint `var(--brand-soft)`. `box-shadow` and
    // `border-color` differ between them, and the matcher itself is checked.
    for (const classes of [["button", "primary"], ["primary"], ["button", "danger"], ["danger"]] as const) {
      const active = { classes, states: ["active"] };
      const disabled = { classes, states: ["active", "disabled"] };
      expect(resolve("box-shadow", disabled), classes.join(".")).not.toBe(resolve("box-shadow", active));
      expect(resolve("border-color", disabled), classes.join(".")).not.toBe(resolve("border-color", active));
      expect(resolve("background", disabled)).toBe(resolve("background", { classes, states: [] }));
    }
    // Every control shape dims, bare or compounded. A disabled bare `.danger`
    // used to stay at full opacity because `.danger` was absent from the
    // disabled rule's selector list.
    for (const classes of [["button", "primary"], ["primary"], ["button", "danger"], ["danger"], ["secondary"]]) {
      expect(resolve("opacity", { classes, states: ["disabled"] }), classes.join(".")).toBe(".45");
    }
    expect(matches(".primary:active:not(:disabled)", { classes: ["primary"], states: ["active", "disabled"] }))
      .toBe(false);
    expect(matches(".button:active:not(:disabled)", { classes: ["button"], states: ["active", "disabled"] }))
      .toBe(false);
  });

  test("the resolver is load bearing: it sees the generic rules that also match", () => {
    // Guards the test itself. If `matches` stopped matching `.button:hover`
    // against `.button.primary`, every assertion above would pass vacuously.
    expect(matches(".button:hover", { classes: ["button", "primary"], states: ["hover"] })).toBe(true);
    expect(matches(".primary:active:not(:disabled)", { classes: ["button", "primary"], states: ["active"] })).toBe(true);
    expect(specificity(".button:active:not(:disabled)")).toBe(3);
    expect(specificity(".button.primary,.primary".split(",")[0]!)).toBe(2);
  });
});
