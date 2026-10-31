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

  test("renders its children last in its row, which is positioned, so an anchored stack hangs under the bar", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Runs" actions={<button type="button">Bell</button>}>
        <div data-slot="toast-stack" data-placement="anchored" />
      </PageHeader>,
    );
    expect(html.indexOf("Bell")).toBeLessThan(html.indexOf('data-slot="toast-stack"'));
    expect(html).toContain('data-placement="anchored"></div></div></header>');
    const css = composeSmithersUiStyles().split("\n");
    expect(css.find((rule) => rule.startsWith(".sui-page-header-inner {"))).toContain("position:relative");
    // Its end lines up with the actions' end: the row's own padding, at both widths.
    expect(css).toContain(".sui-page-header-inner > .sui-toast-stack[data-placement='anchored'] { left:24px; right:56px; }");
    expect(css).toContain("  .sui-page-header-inner > .sui-toast-stack[data-placement='anchored'] { left:16px; right:52px; }");
  });

  test("marks the active section with the brand tint and keeps the bar on the page background", () => {
    const css = composeSmithersUiStyles().split("\n");
    expect(css.find((rule) => rule.startsWith(".sui-page-header-nav > a[aria-current='page']"))).toContain("background:");
    expect(css.find((rule) => rule.startsWith(".sui-page-header {"))).toContain("position:sticky");
  });
});

describe("PageHeader nav buttons", () => {
  test("a button among the sections reads like a section link: muted, borderless, no underline", () => {
    const rule = composeSmithersUiStyles().split("\n").find((line) => line.startsWith(".sui-page-header-nav :is(.sui-button-link, .sui-button-ghost) {"));
    expect(rule).toContain("background:transparent");
    expect(rule).toContain("border:0");
    expect(rule).toContain("text-decoration:none");
  });
});

describe("PageHeader slots", () => {
  test("a solid button among the sections keeps its own look; only link and ghost buttons read as section links", () => {
    expect(composeSmithersUiStyles()).not.toContain(".sui-page-header-nav .sui-button {");
  });

  test("the back slot lays its items in one row, so a status beside the wordmark never wraps under it", () => {
    const rule = composeSmithersUiStyles().split("\n").find((line) => line.startsWith(".sui-page-header-back {"));
    expect(rule).toContain("display:flex");
    expect(rule).toContain("align-items:center");
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
