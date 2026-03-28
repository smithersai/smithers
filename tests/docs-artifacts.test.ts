import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  generateLlmsFull,
  loadAllDocsPages,
  loadDocsConfig,
} from "../scripts/docs-utils";

describe("docs artifacts", () => {
  test("every docs source page has content and frontmatter title", () => {
    const pages = loadAllDocsPages();

    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.title.length, `missing title for ${page.slug}`).toBeGreaterThan(0);
      expect(page.body.length, `missing body for ${page.slug}`).toBeGreaterThan(0);
    }
  });

  test("llms-full.txt stays in sync with the docs manifest", () => {
    const committed = readFileSync("docs/llms-full.txt", "utf-8");
    const generated = generateLlmsFull();

    expect(committed).toBe(generated);
  });

  test("exact redirects land on real docs pages", () => {
    const pages = new Set(loadAllDocsPages().map((page) => `/${page.slug}`));
    if (pages.has("/index")) {
      pages.add("/");
    }
    const redirects = loadDocsConfig().redirects ?? [];
    const exactRedirects = redirects.filter(
      (redirect) => !redirect.destination.includes(":slug*"),
    );

    expect(exactRedirects.length).toBeGreaterThan(0);
    for (const redirect of exactRedirects) {
      expect(
        pages.has(redirect.destination),
        `redirect destination missing for ${redirect.source} -> ${redirect.destination}`,
      ).toBe(true);
    }
  });
});
