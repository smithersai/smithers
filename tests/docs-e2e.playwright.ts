import { expect, test } from "@playwright/test";
import {
  getDocsNavigationSections,
  loadAllDocsPages,
  loadDocsConfig,
} from "../scripts/docs-utils";

const docsPages = loadAllDocsPages();
const docsPageBySlug = new Map(docsPages.map((page) => [page.slug, page]));
const navSections = getDocsNavigationSections();
const docsConfig = loadDocsConfig();

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRedirectCases() {
  const cases = new Map<string, string>();

  for (const redirect of docsConfig.redirects ?? []) {
    if (
      redirect.source.includes(":slug*") &&
      redirect.destination.includes(":slug*")
    ) {
      const sourcePrefix = redirect.source.replace(":slug*", "");
      const destinationPrefix = redirect.destination.replace(":slug*", "");
      const target = docsPages.find((page) =>
        `/${page.slug}`.startsWith(destinationPrefix),
      );

      if (!target) {
        continue;
      }

      const suffix = `/${target.slug}`.slice(destinationPrefix.length);
      cases.set(`${sourcePrefix}${suffix}`, `/${target.slug}`);
      continue;
    }

    if (!redirect.destination.includes(":slug*")) {
      cases.set(redirect.source, redirect.destination);
    }
  }

  return Array.from(cases, ([from, to]) => ({ from, to }));
}

function resolveDestinationPage(pathname: string) {
  const slug = pathname.replace(/^\/+/, "");
  if (!slug) {
    return {
      pathname: "/",
      page: docsPageBySlug.get("index"),
    };
  }

  return {
    pathname,
    page: docsPageBySlug.get(slug),
  };
}

test("home keeps the sidebar visible and exposes both CLI and JSX entry points", async ({
  page,
}) => {
  const indexPage = docsPageBySlug.get("index");
  const cliQuickstart = docsPageBySlug.get("cli/quickstart");
  const jsxOverview = docsPageBySlug.get("jsx/overview");

  if (!indexPage || !cliQuickstart || !jsxOverview) {
    throw new Error("Expected index, CLI quickstart, and JSX overview pages");
  }

  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: indexPage.title }),
  ).toBeVisible();

  const aside = page.getByRole("complementary");
  await expect(
    aside.getByRole("link", { name: cliQuickstart.title }),
  ).toBeVisible();
  await expect(
    aside.getByRole("link", { name: jsxOverview.title }),
  ).toBeVisible();

  await aside.getByRole("link", { name: cliQuickstart.title }).click();
  await expect(page).toHaveURL(
    new RegExp(`/${escapeRegExp(cliQuickstart.slug)}$`),
  );
  await expect(
    page.getByRole("heading", { name: cliQuickstart.title }),
  ).toBeVisible();

  await page.goto("/");
  await aside.getByRole("link", { name: jsxOverview.title }).click();
  await expect(page).toHaveURL(
    new RegExp(`/${escapeRegExp(jsxOverview.slug)}$`),
  );
  await expect(
    page.getByRole("heading", { name: jsxOverview.title }),
  ).toBeVisible();
});

test("navigation sections are discoverable from the preview sidebar", async ({
  page,
}) => {
  const sectionLabels = navSections.map((section) => section.label);

  await page.goto("/");
  const aside = page.getByRole("complementary");
  for (const label of sectionLabels) {
    await expect(aside.getByRole("heading", { name: label })).toBeVisible();
  }
});

test("every docs page renders its expected title", async ({
  page,
}) => {
  for (const docPage of docsPages) {
    const pathname = docPage.slug === "index" ? "/" : `/${docPage.slug}`;
    await page.goto(pathname);
    const expected = docPage.slug === "index" ? "/$" : `/${escapeRegExp(docPage.slug)}$`;
    await expect(page).toHaveURL(new RegExp(expected));
    await expect(
      page.getByRole("heading", { name: docPage.title, level: 1 }),
      `missing heading for ${docPage.slug}`,
    ).toBeVisible();
  }
});

test("legacy docs routes redirect to the current destinations", async ({
  page,
}) => {
  const redirectCases = buildRedirectCases();

  for (const redirectCase of redirectCases) {
    const destination = resolveDestinationPage(redirectCase.to);
    const destinationPage = destination.page;

    if (!destinationPage) {
      throw new Error(
        `redirect target ${redirectCase.to} is not a known docs page`,
      );
    }

    await page.goto(redirectCase.from);
    await expect(
      page,
    ).toHaveURL(new RegExp(`${escapeRegExp(destination.pathname)}$`));
    await expect(
      page.getByRole("heading", { name: destinationPage.title, level: 1 }),
      `redirect ${redirectCase.from} did not land on ${redirectCase.to}`,
    ).toBeVisible();
  }
});
