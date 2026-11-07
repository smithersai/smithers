/** @jsxImportSource react */
import { DEFAULT_THEME_KEY, standaloneThemeCss, themeRegistry, workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { useInsertionEffect } from "react";
import { uiCss as smithersUiCss, SMITHERS_UI_STYLE_ATTR, REDUCED_MOTION_MEDIA_QUERY } from "@smthrs/ui-css";

export { uiCss as smithersUiCss } from "@smthrs/ui-css";
export { standaloneThemeCss };
export { DEFAULT_THEME_KEY, themeRegistry };

/**
 * Marker attribute carried by injected and rendered style elements. The
 * {@link useInjectUiCss} fallback checks for it and stands down when a rendered
 * sheet is already present. {@link SmithersUiStyles} cannot dedupe across React
 * or server-rendered trees; the host must render `<SmithersUiStyles/>` exactly once.
 */
export { SMITHERS_UI_STYLE_ATTR, REDUCED_MOTION_MEDIA_QUERY };

/** Browser motion preference for imperative behavior CSS cannot control. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches
  );
}

/** Keep canvas/widget motion synchronized when the OS preference changes. */
export function observeReducedMotion(listener: (reduced: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_MOTION_MEDIA_QUERY);
  if (typeof media.addEventListener !== "function") return () => {};
  const handleChange = (event: MediaQueryListEvent) => listener(event.matches);
  media.addEventListener("change", handleChange);
  return () => media.removeEventListener("change", handleChange);
}

export type SmithersUiStylesProps = {
  /**
   * Prepend the ui-styleguide theme token block (`workflowUiThemeCss`).
   * Gateway host pages already inline the theme, so workflow UIs leave this
   * off; standalone hosts (reports, marketing pages, plain HTML shells) turn
   * it on to get the light/dark tokens plus the base element styles.
   */
  withTheme?: boolean;
  /** Extra CSS appended after the component sheet (the consumer escape hatch). */
  extra?: string;
};

/** The composed stylesheet string for {@link SmithersUiStyles}. */
export function composeSmithersUiStyles({ withTheme = false, extra }: SmithersUiStylesProps = {}): string {
  const parts = withTheme ? [workflowUiThemeCss, smithersUiCss] : [smithersUiCss];
  if (extra) parts.push(extra);
  return parts.join("\n");
}

/**
 * Renders the component stylesheet in a `<style>` tag. Render once near the
 * root of a UI. Safe under `renderToStaticMarkup` (server-rendered docs and
 * tests), where effects never run and the injection fallback cannot help.
 */
export function SmithersUiStyles(props: SmithersUiStylesProps = {}) {
  // Literal attribute: JSX attribute names must be static, so this cannot use
  // SMITHERS_UI_STYLE_ATTR; keep the two in sync because useInjectUiCss checks it.
  return <style data-smithers-ui="">{composeSmithersUiStyles(props)}</style>;
}

/**
 * Browser fallback: idempotently append the component sheet to `<head>` if no
 * marker style element exists yet. Every component in this package calls this,
 * so a consumer who forgets `<SmithersUiStyles/>` still gets styled output.
 * No-ops during server rendering (insertion effects never run there).
 */
export function useInjectUiCss(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(SMITHERS_UI_STYLE_ATTR, "");
    el.textContent = smithersUiCss;
    document.head.appendChild(el);
  }, []);
}
