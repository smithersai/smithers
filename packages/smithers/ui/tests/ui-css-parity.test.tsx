/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { smithersUiCss, uiCss } from "@smthrs/ui-css";
import { workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { SmithersUiStyles, composeSmithersUiStyles, smithersUiCss as legacyCss } from "../src/styles";

test("framework-free CSS equals the stylesheet SmithersUiStyles renders", () => {
  const html = renderToStaticMarkup(<SmithersUiStyles />);
  const content = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</style>"));
  expect(content).toBe(smithersUiCss());
  expect(legacyCss).toBe(uiCss);
  expect(composeSmithersUiStyles()).toBe(uiCss);
});

test("React theme and extra options preserve stylesheet order", () => {
  const extra = ".host { display: grid; }";
  expect(composeSmithersUiStyles({ withTheme: true, extra })).toBe([workflowUiThemeCss, smithersUiCss(), extra].join("\n"));
});
