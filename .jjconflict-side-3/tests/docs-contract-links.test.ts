import { describe, expect, test } from "bun:test";
import {
  loadAllDocsPages,
  loadAllDocsPageSlugs,
  loadDocsConfig,
  getDocsPageSlugs,
} from "../scripts/docs-utils";
import { posix as pathPosix } from "node:path";

type LinkRef = {
  from: string;
  href: string;
  resolved: string;
};

function stripCodeFences(content: string) {
  return content.replace(/```[\s\S]*?```/g, "");
}

function extractLinks(content: string): Array<{ href: string; index: number }> {
  const links: Array<{ href: string; index: number }> = [];
  const re = /\[[^\]]+\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    links.push({ href: match[1]!, index: match.index });
  }
  return links;
}

function normalizePath(value: string) {
  let next = value.trim();
  if (!next) return "";
  next = next.replace(/^[.\/]+/, (m) => (m === "/" ? "/" : ""));
  next = next.replace(/\.(mdx|md)$/i, "");
  next = next.replace(/\/$/, "");
  return next;
}

function resolveDocPath(pageSlug: string, href: string) {
  const cleaned = href.split("#")[0]!.split("?")[0]!;
  if (!cleaned || cleaned === "#") return "";

  if (cleaned.startsWith("/")) {
    return normalizePath(cleaned.slice(1));
  }

  const baseDir = pathPosix.dirname(pageSlug);
  const joined = pathPosix.normalize(pathPosix.join(baseDir, cleaned));
  return normalizePath(joined);
}

function buildRedirectMatchers() {
  const redirects = loadDocsConfig().redirects ?? [];
  const exact = new Set<string>();
  const wildcardPrefixes: string[] = [];

  for (const redirect of redirects) {
    const source = redirect.source.replace(/^\//, "");
    if (source.includes(":slug*")) {
      wildcardPrefixes.push(source.replace(":slug*", ""));
    } else {
      exact.add(source);
    }
  }

  return {
    exact,
    wildcardPrefixes,
    matches(value: string) {
      if (exact.has(value)) return true;
      return wildcardPrefixes.some((prefix) => value.startsWith(prefix));
    },
  };
}

describe("docs: navigation and links", () => {
  test("navigation slugs all point to existing docs pages", () => {
    const allPages = new Set(loadAllDocsPageSlugs());
    const navSlugs = getDocsPageSlugs();

    const missing = navSlugs.filter((slug) => !allPages.has(slug));
    expect(missing).toEqual([]);
  });

  test("internal markdown links resolve to docs pages or redirects", () => {
    const pages = loadAllDocsPages();
    const docsSlugs = new Set(loadAllDocsPageSlugs());
    const redirectMatchers = buildRedirectMatchers();

    const missing: LinkRef[] = [];

    for (const page of pages) {
      const content = stripCodeFences(page.body);
      const links = extractLinks(content);
      for (const { href, index } of links) {
        if (!href) continue;
        if (content[index - 1] === "!") continue; // image links
        if (
          href.startsWith("http://") ||
          href.startsWith("https://") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:") ||
          href.startsWith("#")
        ) {
          continue;
        }

        const resolved = resolveDocPath(page.slug, href);
        if (!resolved) continue;
        if (docsSlugs.has(resolved)) continue;
        if (redirectMatchers.matches(resolved)) continue;

        missing.push({ from: page.slug, href, resolved });
      }
    }

    expect(missing).toEqual([]);
  });

  test("wildcard redirects map to at least one docs page", () => {
    const docsSlugs = loadAllDocsPageSlugs();
    const redirects = loadDocsConfig().redirects ?? [];

    const failures: Array<{ source: string; destination: string }> = [];

    for (const redirect of redirects) {
      if (!redirect.destination.includes(":slug*")) continue;
      const destPrefix = redirect.destination.replace(":slug*", "").replace(/^\//, "");
      const hasMatch = docsSlugs.some((slug) => slug.startsWith(destPrefix));
      if (!hasMatch) failures.push(redirect);
    }

    expect(failures).toEqual([]);
  });
});
