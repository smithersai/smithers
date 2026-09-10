// @ts-check
import react from "@astrojs/react"
import starlight from "@astrojs/starlight"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"
import { fileURLToPath } from "node:url"
import { buildStamp } from "./scripts/build-stamp-integration.ts"
import project from "./src/data/project.json" with { type: "json" }

/**
 * smithers.sh: the landing page at `/` (src/pages/index.astro), the demo
 * request page at `/demo`, the Starlight documentation at `/docs/**` with
 * the release changelogs under `/changelogs/**`, and the product app at
 * `/<owner>/<repo>` for every available catalog repository (src/pages/[owner]/[repo].astro).
 *
 * Starlight content is authored under src/content/docs/docs/ so every route
 * carries the /docs prefix and the root stays a plain Astro page. Add a page
 * there and list it in the sidebar below.
 *
 * The app page mounts apps/ui's AppIsland as a `client:only="react"` island,
 * so this build also carries the app's Vite settings: its Tailwind entry
 * (apps/ui/src/mainview/index.css) builds through @tailwindcss/vite and stays
 * inside the island's CSS chunk; react, react-dom and effect are deduped so
 * the app and the site share one copy of each; `electrobun/view` resolves to
 * a web shim because no Electrobun SDK exists here; the Vue flags are the
 * ones apps/ui/vite.config.ts injects for the Milkdown editor.
 *
 * @since 1.0.0
 * @category configuration
 */
export default defineConfig({
  site: "https://smithers.sh",
  output: "static",
  prefetch: { defaultStrategy: "hover" },
  experimental: { clientPrerender: true },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      dedupe: ["react", "react-dom", "effect"],
      alias: {
        "electrobun/view": fileURLToPath(new URL("../ui/src/mainview/native/electrobun-view.web.ts", import.meta.url))
      }
    },
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false"
    },
    build: {
      // Milkdown ships one indivisible 818 kB module behind the World editor's
      // dynamic import; keep the size warning meaningful for every other chunk.
      chunkSizeWarningLimit: 900
    }
  },
  integrations: [
    react(),
    buildStamp(),
    starlight({
      title: "Smithers",
      routeMiddleware: "./scripts/docs-notice.mjs",
      disable404Route: true,
      description: project.description,
      logo: { src: "./src/docs-assets/logo.png", alt: "Smithers" },
      favicon: "/favicon.png",
      customCss: ["./src/styles/starlight.css", "./src/styles/navigation.css"],
      // Inter and IBM Plex Mono are the product UI's pairing. They come from
      // Google Fonts rather than an npm package so the docs add no dependency,
      // and src/styles/starlight.css names a system stack behind each one.
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href:
              "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          }
        }
      ],
      expressiveCode: {
        styleOverrides: {
          codeFontFamily: "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        }
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/smithersai/smithers" }
      ],
      editLink: { baseUrl: "https://github.com/smithersai/smithers/edit/main/apps/site/src/content/docs/" },
      // Every group below autogenerates from a directory under
      // src/content/docs/docs/, so a new page appears as soon as it lands.
      // Order inside a group comes from `sidebar.order` in the page's
      // frontmatter, then the title. Only the root pages are listed by hand.
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Overview", slug: "docs" },
            { slug: "docs/quickstart" },
            { slug: "docs/pricing" },
            { label: "Open Smithers ↗", link: "https://smithers.sh/smithersai/smithers" }
          ]
        },
        { label: "Use the app", items: [{ autogenerate: { directory: "docs/app" } }] },
        { label: "CLI and libraries", collapsed: true, items: [{ slug: "docs/developers" }, { slug: "docs/installation" }, { slug: "docs/cli-quickstart" }] },
        { label: "Developer tutorials", items: [{ autogenerate: { directory: "docs/tutorials" } }], collapsed: true },
        { label: "Developer guides", items: [{ autogenerate: { directory: "docs/guides" } }], collapsed: true },
        { label: "Concepts", items: [{ autogenerate: { directory: "docs/concepts" } }], collapsed: true },
        { label: "Examples", items: [{ autogenerate: { directory: "docs/examples" } }], collapsed: true },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { slug: "docs/reference/support-matrix" },
            { slug: "docs/reference/cli", label: "CLI overview" },
            { label: "CLI verbs", items: [{ autogenerate: { directory: "docs/reference/cli" } }], collapsed: true },
            { slug: "docs/reference/flow-mdx" },
            { slug: "docs/reference/project-layout" },
            { slug: "docs/reference/environment-variables" },
            { slug: "docs/reference/errors" },
            { slug: "docs/reference/mcp-tools" },
            { slug: "docs/reference/http-api" },
            { slug: "docs/reference/cloud-ci" },
            { slug: "docs/reference/triggers" },
            { label: "Packages", items: [{ autogenerate: { directory: "docs/reference/api" } }], collapsed: true },
            { label: "Build rules", items: [{ autogenerate: { directory: "docs/reference/targets" } }], collapsed: true },
            { slug: "docs/reference/glossary" },
            { slug: "docs/reference/subpackages" }
          ]
        },
        { label: "Troubleshooting", items: [{ autogenerate: { directory: "docs/troubleshooting" } }], collapsed: true },
        { label: "Migration", items: [{ autogenerate: { directory: "docs/migration" } }], collapsed: true },
        { label: "Changelogs", items: [{ autogenerate: { directory: "changelogs" } }], collapsed: true }
      ]
    })
  ]
})
