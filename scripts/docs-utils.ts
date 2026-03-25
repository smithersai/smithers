import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const DOCS_ROOT = "docs";
export const DOCS_BASE_URL = "https://smithers.sh";

export interface DocsRedirect {
  source: string;
  destination: string;
}

export interface DocsConfig {
  redirects?: DocsRedirect[];
  navigation?: {
    global?: {
      anchors?: unknown[];
    };
    tabs?: unknown[];
  };
}

export interface DocsPage {
  slug: string;
  path: string;
  url: string;
  title: string;
  description: string;
  body: string;
}

export interface DocsTabLink {
  label: string;
  slug: string;
}

export function collectPageSlugs(node: unknown, pages = new Set<string>()) {
  if (typeof node === "string") {
    pages.add(node);
    return pages;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      collectPageSlugs(entry, pages);
    }
    return pages;
  }

  if (!node || typeof node !== "object") {
    return pages;
  }

  const record = node as Record<string, unknown>;
  collectPageSlugs(record.pages, pages);
  collectPageSlugs(record.groups, pages);
  collectPageSlugs(record.tabs, pages);
  collectPageSlugs(record.anchors, pages);
  return pages;
}

export function firstPageInNode(node: unknown): string | undefined {
  if (typeof node === "string") {
    return node;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      const slug = firstPageInNode(entry);
      if (slug) {
        return slug;
      }
    }
    return undefined;
  }

  if (!node || typeof node !== "object") {
    return undefined;
  }

  const record = node as Record<string, unknown>;
  return (
    firstPageInNode(record.pages) ??
    firstPageInNode(record.groups) ??
    firstPageInNode(record.tabs) ??
    firstPageInNode(record.anchors)
  );
}

export function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { title: "", description: "", body: content.trim() };
  }

  const frontmatter = match[1];
  const body = match[2];
  const titleMatch = frontmatter.match(/title:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = frontmatter.match(/description:\s*["']?(.+?)["']?\s*$/m);

  return {
    title: titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    body: body.trim(),
  };
}

export function cleanMdxForLlms(body: string) {
  return body
    .replace(/<Warning>\s*/g, "> **Warning:** ")
    .replace(/<\/Warning>/g, "")
    .replace(/<Tip>\s*/g, "> **Tip:** ")
    .replace(/<\/Tip>/g, "")
    .replace(/<Note>\s*/g, "> **Note:** ")
    .replace(/<\/Note>/g, "");
}

export function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function loadDocsConfig(rootDir = process.cwd()): DocsConfig {
  const path = resolve(rootDir, DOCS_ROOT, "docs.json");
  return JSON.parse(readFileSync(path, "utf-8")) as DocsConfig;
}

export function getDocsPageSlugs(rootDir = process.cwd()) {
  const config = loadDocsConfig(rootDir);
  return Array.from(
    collectPageSlugs([
      config.navigation?.global?.anchors ?? [],
      config.navigation?.tabs ?? [],
    ]),
  );
}

export function loadDocPage(slug: string, rootDir = process.cwd()): DocsPage {
  const path = resolve(rootDir, DOCS_ROOT, `${slug}.mdx`);
  if (!existsSync(path)) {
    throw new Error(`Docs page not found for slug "${slug}" at ${path}`);
  }

  const content = readFileSync(path, "utf-8");
  const { title, description, body } = parseFrontmatter(content);

  return {
    slug,
    path,
    url: `${DOCS_BASE_URL}/${slug}`,
    title,
    description,
    body,
  };
}

export function loadDocsPages(rootDir = process.cwd()) {
  return getDocsPageSlugs(rootDir).map((slug) => loadDocPage(slug, rootDir));
}

export function loadAllDocsPageSlugs(rootDir = process.cwd()) {
  const docsRoot = resolve(rootDir, DOCS_ROOT);
  const slugs: string[] = [];
  const queue = [docsRoot];

  while (queue.length > 0) {
    const currentDir = queue.pop()!;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (!entry.name.endsWith(".mdx")) {
        continue;
      }

      const slug = relative(docsRoot, entryPath).replace(/\.mdx$/, "");
      slugs.push(slug);
    }
  }

  return slugs.sort((left, right) => left.localeCompare(right));
}

export function loadAllDocsPages(rootDir = process.cwd()) {
  return loadAllDocsPageSlugs(rootDir).map((slug) => loadDocPage(slug, rootDir));
}

export function getDocsTabLinks(rootDir = process.cwd()): DocsTabLink[] {
  const config = loadDocsConfig(rootDir);
  const tabs = Array.isArray(config.navigation?.tabs)
    ? config.navigation?.tabs
    : [];

  return tabs
    .map((tab) => {
      const record = tab as Record<string, unknown>;
      const label = typeof record.tab === "string" ? record.tab : "";
      const slug = firstPageInNode(record.groups);
      return label && slug ? { label, slug } : null;
    })
    .filter((entry): entry is DocsTabLink => entry !== null);
}

export function generateLlmsFull(rootDir = process.cwd()) {
  const pages = loadDocsPages(rootDir);

  let output = `# Smithers

> Deterministic, resumable AI workflow orchestration using JSX.
> Source: https://smithers.sh
> GitHub: https://github.com/evmts/smithers
> Package: smithers-orchestrator on npm

This file contains the complete Smithers documentation. Each section below corresponds to a documentation page on smithers.sh.

`;

  for (const page of pages) {
    output += `---

## ${page.title}

`;
    if (page.description) {
      output += `> ${page.description}\n`;
    }
    output += `> Source: ${page.url}

${cleanMdxForLlms(page.body)}

`;
  }

  return output;
}
