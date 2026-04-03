import { expect, test } from "@playwright/test";
import {
  loadAllDocsPages,
  getDocsTabLinks,
  loadDocsConfig,
} from "../scripts/docs-utils";

const docsPages = loadAllDocsPages();
const docsPageBySlug = new Map(docsPages.map((page) => [page.slug, page]));
const tabLinks = getDocsTabLinks();
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
      pathname: "/introduction",
      page: docsPageBySlug.get("introduction"),
    };
  }

  return {
    pathname,
    page: docsPageBySlug.get(slug),
  };
}

test("home redirects to introduction and exposes the CLI and API docs tabs", async ({
  page,
}) => {
  const introduction = docsPageBySlug.get("introduction");
  const cliTab = tabLinks.find((tab) => tab.label === "CLI");
  const apiTab = tabLinks.find((tab) => tab.label === "API");

  if (!introduction || !cliTab || !apiTab) {
    throw new Error("Expected introduction, CLI tab, and API tab");
  }

  await page.goto("/");
  await expect(page).toHaveURL(/\/introduction$/);
  await expect(
    page.getByRole("heading", { name: introduction.title }),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "API tabs" })
    .getByRole("link", { name: cliTab.label })
    .click();
  await expect(page).toHaveURL(new RegExp(`/${escapeRegExp(cliTab.slug)}$`));
  await expect(
    page.getByRole("heading", { name: docsPageBySlug.get(cliTab.slug)!.title }),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "API tabs" })
    .getByRole("link", { name: apiTab.label })
    .click();
  await expect(page).toHaveURL(new RegExp(`/${escapeRegExp(apiTab.slug)}$`));
  await expect(
    page.getByRole("heading", { name: docsPageBySlug.get(apiTab.slug)!.title }),
  ).toBeVisible();
});

test("every docs page renders its expected title", async ({
  page,
}) => {
  for (const docPage of docsPages) {
    await page.goto(`/${docPage.slug}`);
    await expect(page).toHaveURL(new RegExp(`/${escapeRegExp(docPage.slug)}$`));
    await expect(
      page.getByRole("heading", { name: docPage.title }),
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
      page.getByRole("heading", { name: destinationPage.title }),
      `redirect ${redirectCase.from} did not land on ${redirectCase.to}`,
    ).toBeVisible();
  }
});
