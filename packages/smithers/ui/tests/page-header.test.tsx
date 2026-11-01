import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { composeSmithersUiStyles, PageBody, PageHeader } from "../src/index";

describe("PageHeader", () => {
  test("renders back, the title as the page's h1, a labelled nav and actions in order", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        back={<a href="/app">Back</a>}
        title="Runs"
        nav={<a href="/a" aria-current="page">All</a>}
        navLabel="Flows"
        actions={<button type="button">Bell</button>}
      />,
    );
    expect(html).toContain('<h1 class="sui-page-header-title">Runs</h1>');
    expect(html).toContain('aria-label="Flows"');
    expect(html.indexOf("Back")).toBeLessThan(html.indexOf("Runs"));
    expect(html.indexOf("Runs")).toBeLessThan(html.indexOf("All"));
    expect(html.indexOf("All")).toBeLessThan(html.indexOf("Bell"));
  });

  test("omits the slots it is not given", () => {
    expect(renderToStaticMarkup(<PageHeader back={<a href="/app/runs">Runs</a>} />)).not.toContain("<h1");
    const html = renderToStaticMarkup(<PageHeader title="Settings" />);
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("sui-page-header-back");
    expect(html).not.toContain("sui-page-header-actions");
  });

  test("marks the active section with the brand tint and keeps the bar on the page background", () => {
    const css = composeSmithersUiStyles().split("\n");
    expect(css.find((rule) => rule.startsWith(".sui-page-header-nav > a[aria-current='page']"))).toContain("background:");
    expect(css.find((rule) => rule.startsWith(".sui-page-header {"))).toContain("position:sticky");
  });
});

describe("PageHeader width", () => {
  test("lines its content up with the PageBody of the same width", () => {
    expect(renderToStaticMarkup(<PageHeader title="a" />)).toContain('data-width="default"');
    expect(renderToStaticMarkup(<PageHeader title="a" width="wide" />)).toContain('data-width="wide"');
    const css = composeSmithersUiStyles();
    expect(css).toContain(".sui-page-header-inner { box-sizing:border-box; max-width:1040px;");
    expect(css).toContain(".sui-page-header[data-width='narrow'] .sui-page-header-inner { max-width:760px; }");
    expect(css).toContain(".sui-page-header[data-width='wide'] .sui-page-header-inner { max-width:1280px; }");
  });
});

describe("PageBody", () => {
  test("defaults to the 1040px column and takes narrow and wide", () => {
    expect(renderToStaticMarkup(<PageBody />)).toContain('data-width="default"');
    expect(renderToStaticMarkup(<PageBody width="narrow" />)).toContain('data-width="narrow"');
    const css = composeSmithersUiStyles();
    expect(css).toContain(".sui-page-body { box-sizing:border-box; width:100%; max-width:1040px;");
    expect(css).toContain(".sui-page-body[data-width='narrow'] { max-width:760px; }");
  });
});
