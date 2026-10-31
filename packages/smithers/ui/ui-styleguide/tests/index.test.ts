import { describe, expect, test } from "bun:test";
import {
  reducedMotionCss,
  themeCss,
  themeRegistry,
  workflowUiLayoutCss,
  workflowUiPrimitiveCss,
  workflowUiStyles,
  workflowUiThemeCss,
} from "../src/index.ts";



describe("ui styleguide", () => {
  test("exports the combined theme and layout styles", () => {
    expect(workflowUiThemeCss).toContain(":root {");
    expect(workflowUiLayoutCss).toContain(".workflow-shell {");
    expect(workflowUiStyles).toBe(`${workflowUiThemeCss}\n${workflowUiLayoutCss}`);
  });

  test("styles bare links as the brand at zero specificity, underlined on hover, with a keyboard ring", () => {
    const rules = workflowUiPrimitiveCss.split("\n");
    expect(rules).toContain(":where(a) { color:var(--brand); text-decoration:none; text-underline-offset:2px; }");
    expect(rules).toContain(":where(a):hover { text-decoration:underline; }");
    expect(rules.find((rule) => rule.startsWith(":where(a):focus-visible"))).toContain("outline:2px solid var(--ring-border)");
    // No bare `a` selector: it would outrank a component's own `:where()` link rules.
    expect(rules.some((rule) => /(^|[\s,}])a(\s|,|\{|:)/.test(rule.split("{")[0]!))).toBe(false);
  });

  test("defines and consumes one shared soft-tint recipe per semantic", () => {
    for (const semantic of ["brand", "success", "danger", "warning", "info"]) {
      expect(workflowUiThemeCss).toContain(`--${semantic}-soft:color-mix(in srgb, var(--${semantic}) 10%`);
      expect(workflowUiThemeCss).toContain(`--${semantic}-border:color-mix(in srgb, var(--${semantic})`);
    }
    expect(workflowUiThemeCss).toContain("--me:var(--brand-soft)");
    expect(workflowUiThemeCss).toContain(".pill { border-color:var(--brand-border); background:var(--brand-soft);");
  });

  test("badges are sentence case at --fs-2 and weight 650, matching @smthrs/ui's .sui-badge", () => {
    const rule = workflowUiPrimitiveCss.match(/\.badge \{[^}]+\}/)?.[0] ?? "";
    expect(rule).toContain("font-size:var(--fs-2)");
    expect(rule).toContain("font-weight:650");
    expect(rule).not.toContain("text-transform");
  });

  test("routes every tinted fill through a named recipe, never an inline color-mix", () => {
    // The two states that used to hard-code `color-mix(in srgb, var(--brand)
    // 22%, ...)` and `var(--danger) 16%` bypassed the audited recipe list and
    // put semantic text on tints that miss AA in most palettes.
    const rules = workflowUiThemeCss.split("\n").filter((rule) => !rule.startsWith(":root") && !rule.startsWith("@media"));
    for (const rule of rules) {
      const fills = rule.match(/background(?:-color)?:\s*color-mix\([^)]*var\(--(?:brand|success|danger|warning|info)\)[^;}]*/g);
      expect(fills, rule).toBeNull();
    }
  });

  test("keeps the topbar backdrop filter tied to the saturation the audit models", () => {
    // `tests/paintedPairs.ts` composites the topbar over a backdrop saturated
    // by exactly this amount. A change here without a change there would audit
    // a background the browser does not paint.
    const rule = workflowUiThemeCss.split("\n").find((line) => line.startsWith(".top,.topbar {"));
    expect(rule).toBeDefined();
    expect(rule).toContain("background:var(--surface-glass-strong)");
    expect(rule?.match(/backdrop-filter:blur\(18px\) saturate\(180%\)/g)).toHaveLength(2);
  });

  test("sets an explicit foreground on every surface that is not the page background", () => {
    // `.livelog` painted `--code-bg` while letting its text inherit `--text`,
    // an unaudited pair that is not an alias of `--code-text` in every palette.
    for (const selector of [".livelog {", ".code,.source,pre.code {"]) {
      const rule = workflowUiThemeCss.split("\n").find((line) => line.startsWith(selector));
      expect(rule, selector).toBeDefined();
      expect(rule, selector).toContain("color:var(--code-text)");
    }
  });

  test("ships one global reduced-motion policy after primitive transitions", () => {
    expect(workflowUiThemeCss.endsWith(reducedMotionCss)).toBe(true);
    expect(workflowUiThemeCss.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    expect(workflowUiThemeCss.indexOf(".run-row {")).toBeLessThan(workflowUiThemeCss.indexOf(reducedMotionCss));
  });

  test("reduced motion drops every delay except a hold an element names, which no child inherits", () => {
    expect(reducedMotionCss).toContain("@property --motion-hold { syntax:'<time>'; inherits:false; initial-value:0ms; }");
    expect(reducedMotionCss).toContain("animation-delay:var(--motion-hold, 0ms) !important;");
    expect(reducedMotionCss).toContain("transition-delay:var(--motion-hold, 0ms) !important;");
    expect(reducedMotionCss).not.toContain("animation-delay:0ms");
    expect(reducedMotionCss).not.toContain("transition-delay:0ms");
  });

  test("declares the theme-invariant font block exactly once", () => {
    // Every palette's light variant reports `colorScheme: "light"`, so keying
    // the font block off that field emitted it in all eight `:root` rules. The
    // palette rules are (0,2,0), which beat a consumer's own bare `:root`
    // overrides on the host application's own root.
    expect(workflowUiThemeCss.match(/--font-sans:Inter/g)).toHaveLength(1);
    expect(workflowUiThemeCss.match(/font-family:var\(--font-sans\)/g)).toHaveLength(1);
    expect(workflowUiThemeCss.match(/--font-mono:ui-monospace/g)).toHaveLength(1);

  });

  test("emits Paper light and both dark selection strategies without palette overrides", () => {
    expect(workflowUiThemeCss.split("\n")[0]).toStartWith(":root { color-scheme:light;")
    expect(workflowUiThemeCss).toContain(":root[data-theme='dark']")
    expect(workflowUiThemeCss).toContain("@media (prefers-color-scheme: dark) { :root:not([data-theme='light'])")
    expect(workflowUiThemeCss).not.toContain("data-palette")
  })

});

describe("themeCss", () => {
  test("defaults to the whole registry and opens workflowUiThemeCss", () => {
    expect(workflowUiThemeCss.startsWith(`${themeCss()}\n`)).toBe(true);
    expect(themeCss()).toBe(themeCss({ palettes: Object.keys(themeRegistry) }));
  });

  test("a pinned Paper host emits the same complete light/dark rules", () => {
    expect(themeCss({ palettes: ["paper"] })).toBe(themeCss());
    expect(themeCss()).not.toContain("data-palette");
  });

  test("names an unregistered palette instead of emitting nothing", () => {
    expect(() => themeCss({ palettes: ["dracula"] })).toThrow(/unknown palette "dracula"/);
    expect(() => themeCss({ palettes: ["paper", "dracula"] })).toThrow(/registered: paper/);
  });

  test("emits registry order for any request order, and each palette once", () => {
    const forward = themeCss({ palettes: ["paper"] });
    expect(themeCss({ palettes: ["paper"] })).toBe(forward);
    expect(themeCss({ palettes: ["paper", "paper"] })).toBe(forward);
    expect(forward.match(/:root \{/g)).toHaveLength(1);
  });
});

describe("workflowUiPrimitiveCss", () => {
  test("is the half of workflowUiThemeCss that carries no tokens", () => {
    expect(workflowUiThemeCss).toBe(`${themeCss()}\n${workflowUiPrimitiveCss}`);
    expect(workflowUiPrimitiveCss).toContain("* { box-sizing:border-box; }");
    expect(workflowUiPrimitiveCss).not.toContain(":root {");
    expect(workflowUiPrimitiveCss).not.toContain("data-palette");
  });

  test("pins a palette without slicing the combined sheet", () => {
    // The recipe `docs/guides/pin-a-palette.md` used to document: derive the
    // primitives from a character offset into the combined sheet. The export
    // has to reproduce it byte for byte, or a host that follows the old guide
    // and a host that follows the new one ship different CSS.
    const palettes = ["paper"];
    const sliced = [
      themeCss({ palettes }),
      workflowUiThemeCss.slice(themeCss().length + 1),
      workflowUiLayoutCss,
    ].join("\n");
    expect([themeCss({ palettes }), workflowUiPrimitiveCss, workflowUiLayoutCss].join("\n")).toBe(sliced);
  });
});
