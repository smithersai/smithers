import { readFileSync } from "node:fs";
import type { DocsPage } from "../scripts/docs-utils";
import {
  escapeHtml,
  getDocsNavigationSections,
  loadAllDocsPages,
  loadDocsConfig,
} from "../scripts/docs-utils";

const PORT = 4173;
const docsConfig = loadDocsConfig();
const docsPages = loadAllDocsPages();
const pagesBySlug = new Map(docsPages.map((page) => [page.slug, page]));
const navSections = getDocsNavigationSections();

function renderNavSection(title: string, slugs: string[], currentSlug: string) {
  const items = Array.from(new Set(slugs))
    .map((slug) => pagesBySlug.get(slug))
    .filter((page): page is DocsPage => page !== undefined)
    .map((page) => {
      const href = page.slug === "index" ? "/" : `/${page.slug}`;
      const current = page.slug === currentSlug ? ' aria-current="page"' : "";
      return `<li><a href="${href}"${current}>${escapeHtml(page.title)}</a></li>`;
    })
    .join("\n");

  if (!items) {
    return "";
  }

  return `<section><h2>${escapeHtml(title)}</h2><ul>${items}</ul></section>`;
}

function renderPreviewBody(body: string) {
  return body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join("\n");
}

function resolveRedirect(pathname: string) {
  for (const redirect of docsConfig.redirects ?? []) {
    if (redirect.source === pathname) {
      return redirect.destination;
    }

    if (
      redirect.source.includes(":slug*") &&
      redirect.destination.includes(":slug*")
    ) {
      const sourcePrefix = redirect.source.replace(":slug*", "");
      if (!pathname.startsWith(sourcePrefix)) {
        continue;
      }

      const suffix = pathname.slice(sourcePrefix.length);
      return redirect.destination.replace(":slug*", suffix);
    }
  }

  return null;
}

function renderPage(page: DocsPage) {
  const pathname = page.slug === "index" ? "/" : `/${page.slug}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(page.title)} | Smithers Docs Preview</title>
    <meta name="description" content="${escapeHtml(page.description)}" />
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      body {
        margin: 0;
        background: #f8fafc;
        color: #0f172a;
      }
      header {
        border-bottom: 1px solid #cbd5e1;
        background: #ffffff;
        padding: 1rem 1.5rem;
      }
      .brand {
        color: inherit;
        font-size: 1.1rem;
        font-weight: 700;
        text-decoration: none;
      }
      .layout {
        display: grid;
        gap: 1.5rem;
        grid-template-columns: minmax(16rem, 20rem) minmax(0, 1fr);
        padding: 1.5rem;
      }
      aside {
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 0.75rem;
        padding: 1rem;
      }
      aside h2 {
        font-size: 0.9rem;
        margin: 0 0 0.75rem;
      }
      aside ul {
        list-style: none;
        margin: 0 0 1rem;
        padding: 0;
      }
      aside li + li {
        margin-top: 0.45rem;
      }
      aside a {
        color: #0f172a;
        text-decoration: none;
      }
      aside a[aria-current="page"] {
        font-weight: 700;
      }
      main {
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 0.75rem;
        padding: 1.5rem;
      }
      .eyebrow {
        color: #475569;
        font-size: 0.9rem;
        margin: 0 0 0.5rem;
      }
      h1 {
        margin: 0 0 0.75rem;
      }
      article p {
        line-height: 1.6;
        white-space: pre-wrap;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <a class="brand" href="/">Smithers Docs Preview</a>
    </header>
    <div class="layout">
      <aside>
        ${navSections
          .map((section) => renderNavSection(section.label, section.slugs, page.slug))
          .join("\n")}
      </aside>
      <main>
        <p class="eyebrow">${escapeHtml(pathname)}</p>
        <h1>${escapeHtml(page.title)}</h1>
        <p>${escapeHtml(page.description)}</p>
        <article>
          ${renderPreviewBody(page.body)}
        </article>
      </main>
    </div>
  </body>
</html>`;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/favicon.svg") {
      const favicon = readFileSync("docs/favicon.svg", "utf-8");
      return new Response(favicon, {
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
      });
    }

    if (url.pathname === "/") {
      const page = pagesBySlug.get("index");
      if (!page) {
        return new Response("Missing docs index page", { status: 500 });
      }
      return new Response(renderPage(page), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/index") {
      return Response.redirect(new URL("/", url), 302);
    }

    const redirect = resolveRedirect(url.pathname);
    if (redirect) {
      return Response.redirect(new URL(redirect, url), 302);
    }

    const slug = url.pathname.replace(/^\/+/, "");
    const page = pagesBySlug.get(slug);
    if (!page) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(renderPage(page), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Docs preview server running at ${server.url}`);
