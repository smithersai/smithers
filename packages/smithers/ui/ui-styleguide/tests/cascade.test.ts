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
import { chromium } from "playwright";
import { workflowUiStyles, workflowUiThemeCss } from "../src/index.ts";

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

// Resolve the exported stylesheet in Chromium: the unit resolver above only
// models button compounds and cannot account for element/attribute specificity,
// border shorthands, theme variables, or the browser's keyboard focus state.
for (const mode of ["light", "dark"] as const) {
  test(`keyboard focus survives component states in ${mode} mode`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ colorScheme: mode, reducedMotion: "reduce" });
      const controls = [
        { name: "selected-row", markup: '<button class="run-row active">Selected</button>', stripe: true },
        { name: "selected-row-alias", markup: '<button class="run-row is-active">Selected</button>', stripe: true },
        { name: "row", markup: '<button class="run-row">Row</button>' },
        { name: "primary", markup: '<button class="button primary">Primary</button>' },
        { name: "bare-primary", markup: '<button class="primary">Primary</button>' },
        { name: "danger", markup: '<button class="button danger">Danger</button>' },
        { name: "bare-danger", markup: '<button class="danger">Danger</button>' },
        { name: "neutral", markup: '<button class="button">Neutral</button>' },
        { name: "secondary", markup: '<button class="secondary">Secondary</button>' },
        { name: "text", markup: '<input type="text" aria-label="Text">' },
        { name: "search", markup: '<input type="search" aria-label="Search">' },
        { name: "number", markup: '<input type="number" aria-label="Number">' },
        { name: "classed-input", markup: '<input class="input" aria-label="Input">' },
        { name: "prompt", markup: '<textarea class="prompt" aria-label="Prompt"></textarea>' },
        { name: "textarea", markup: '<textarea class="textarea" aria-label="Textarea"></textarea>' },
        { name: "select", markup: '<select aria-label="Select"><option>Choice</option></select>' },
        ...["icon-button", "tab", "doc-link", "segmented"].map((name) => ({
          name, markup: `<button class="${name}">${name}</button>`,
        })),
      ];
      await page.setContent(`<!doctype html><html data-theme="${mode}"><head>
        <style>${workflowUiStyles}</style></head><body>
        <div id="ring" style="border:1px solid var(--ring-border);box-shadow:0 0 0 3px var(--ring)"></div>
        <div id="stripe" style="box-shadow:inset 2px 0 0 var(--brand)"></div>
        ${controls.map(({ name, markup }) => `<div id="${name}">${markup}</div>`).join("")}
        </body></html>`);
      const read = (selector: string) => page.locator(selector).evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(element);
        return {
          border: style.borderTopColor,
          shadow: style.boxShadow,
          focused: element.matches(":focus-visible"),
          hovered: element.matches(":hover"),
          pressed: element.matches(":active"),
        };
      });
      const ring = await read("#ring");
      const stripe = await read("#stripe");
      for (const control of controls) {
        const selector = `#${control.name} > :first-child`;
        await page.mouse.move(1200, 0);
        const resting = await read(selector);
        await page.keyboard.press("Tab");
        for (const [hovered, pressed] of [[false, false], [true, false], [false, true], [true, true]]) {
          const button = control.markup.startsWith("<button");
          if (pressed && !button) continue;
          if (hovered) await page.locator(selector).hover();
          else await page.mouse.move(1200, 0);
          if (pressed) await page.keyboard.down("Space");
          try {
            const focused = await read(selector);
            const context = `${control.name}: hover=${hovered}, press=${pressed}`;
            expect(focused.focused, context).toBe(true);
            expect(focused.hovered, context).toBe(hovered);
            expect(focused.pressed, context).toBe(pressed);
            expect(focused.border, context).toBe(ring.border);
            expect(focused.shadow, context).toContain(ring.shadow);
            expect(focused.shadow, context).not.toBe(resting.shadow);
            if ("stripe" in control) expect(focused.shadow, context).toContain(stripe.shadow);
          } finally {
            if (pressed) await page.keyboard.up("Space");
          }
        }
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
}
