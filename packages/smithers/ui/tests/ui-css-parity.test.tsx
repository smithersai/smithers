/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { smithersUiCss, uiCss, SMITHERS_UI_STYLE_ATTR, REDUCED_MOTION_MEDIA_QUERY } from "@smthrs/ui-css";
import { workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { SmithersUiStyles, composeSmithersUiStyles, smithersUiCss as legacyCss } from "../src/styles";

test("framework-free CSS equals the stylesheet SmithersUiStyles renders", () => {
  const html = renderToStaticMarkup(<SmithersUiStyles />);
  const content = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</style>"));
  expect(content).toBe(smithersUiCss());
  expect(legacyCss).toBe(uiCss);
  expect(composeSmithersUiStyles()).toBe(uiCss);
});

test("framework-free style markers and motion query retain their React exports", async () => {
  const styles = await import("../src/styles");
  expect(styles.SMITHERS_UI_STYLE_ATTR).toBe(SMITHERS_UI_STYLE_ATTR);
  expect(styles.REDUCED_MOTION_MEDIA_QUERY).toBe(REDUCED_MOTION_MEDIA_QUERY);
  expect(renderToStaticMarkup(<SmithersUiStyles />)).toStartWith('<style data-smithers-ui="">');
});

test("React theme and extra options preserve stylesheet order", () => {
  const extra = ".host { display: grid; }";
  expect(composeSmithersUiStyles({ withTheme: true, extra })).toBe([workflowUiThemeCss, smithersUiCss(), extra].join("\n"));
});
