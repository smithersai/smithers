import { join } from "node:path"
import react from "@vitejs/plugin-react"
import { ConfigProvider, Effect } from "effect"
import vibelang from "vibelang-vite"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"
import { devHttps } from "./dev/https.ts"
import { commandMaxSeconds } from "./src/features/sandbox/config.ts"
import { DOCS_SITE, FRAME_POLICY, PAGE_HEADERS, shellCaches } from "./src/pwa.ts"

// The app's shell, for the service worker to precache: everything a reload needs before it reaches the network.
const SHELL = ["**/*.{js,css,html,woff2,svg,png}"]

// Never the service worker's: ChatApi, the Electric shape proxy, the telemetry relay and the model endpoint.
const API = /^\/api\//

// The deployment's longest command, from the environment its Worker deploys from and read as the Worker reads it
// (decision 0088): the browser's run tool states it (src/features/sandbox/flows.ts `COMMAND_MAX_SECONDS`). The app and
// ChatApi deploy together from one environment, and a value the Worker would refuse fails the build here.
const COMMAND_MAX_SECONDS = Effect.runSync(commandMaxSeconds.parse(ConfigProvider.fromEnv()))

// Alchemy injects the Cloudflare plugin, which runs worker/index.ts beside the app in dev and build.
export default defineConfig({
  plugins: [
    // A workspace package exports its source, so the app and worker/index.ts can import `.vibe` modules; each compiles
    // with its own package's tsconfig.
    vibelang(),
    // The app's pages refuse to be framed under the dev server too, as public/_headers has Cloudflare serve them
    // (src/pwa.ts PAGE_HEADERS). Cloudflare's Vite plugin skips _headers in dev, so this sets them on every response
    // before any other middleware answers.
    {
      name: "smithers-page-headers",
      enforce: "pre",
      configureServer: (server) => {
        server.middlewares.use((_request, response, next) => {
          for (const [name, value] of Object.entries(PAGE_HEADERS)) response.setHeader(name, value)
          next()
        })
      },
    },
    react(),
    // The dev server over HTTPS and HTTP/2 at https://localhost:1443, as Cloudflare serves the app (dev/https.ts,
    // docs/infrastructure.md#https-and-http2). Its certificate is this machine's, kept beside the dev service worker.
    devHttps(join(import.meta.dirname, "node_modules", ".dev-https")),
    // The app is a PWA (docs/decisions/0011-the-agent-runs-in-the-browser.md §5): installable, and its service worker
    // serves the shell offline after one online visit (0002 §8). The service worker only serves files; it never runs
    // the flow engine, and never caches or answers /api/*.
    VitePWA({
      registerType: "autoUpdate",
      // main.tsx imports the virtual registration module so an activated update reloads open tabs.
      // Keep auto injection: with autoUpdate this also enables skipWaiting and clientsClaim in the generated worker.
      injectRegister: "auto",
      // The shell's glob already lists the icons.
      includeManifestIcons: false,
      manifest: {
        name: "Smithers",
        short_name: "Smithers",
        start_url: "/app",
        scope: "/",
        display: "standalone",
        background_color: "#f7f6f1",
        theme_color: "#3a756b",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        globPatterns: SHELL,
        // The language server's worker and TypeScript's lib files (src/features/code-intel/language.worker.ts) load
        // only when a TypeScript or JavaScript file first shows; the runtime cache below keeps them once they have.
        globIgnores: ["**/language.worker-*.js", "**/lib.*.d-*.js"],
        // The app's bundle and the engine worker are each over Workbox's 2 MiB default (2.7 and 2.3 MB on
        // 2026-10-20), which fails `vite build`; an offline reload needs both precached.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "index.html",
        // The docs site answers its own paths on the app's hostname (infra/DocsSite.ts); the shell never stands in.
        navigateFallbackDenylist: [API, DOCS_SITE],
        cleanupOutdatedCaches: true,
        // A module the precache doesn't list (under the dev server, every one) is kept from the last visit, so an
        // offline reload still has it. The network answers first whenever it can.
        runtimeCaching: [
          {
            // Never an embedded page: another origin's, which this worker never sees (src/pwa.ts).
            urlPattern: shellCaches,
            handler: "NetworkFirst",
            options: { cacheName: "smithers-shell", networkTimeoutSeconds: 3 },
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: "module",
        navigateFallback: "index.html",
        // Every app route falls back to the shell offline, as in production; /api/* and the docs site's paths never do.
        navigateFallbackAllowlist: [new RegExp(`^(?!${API.source.slice(1)}|${DOCS_SITE.source.slice(1)})`)],
        // The dev service worker is generated here, outside the source tree.
        resolveTempFolder: () => join(import.meta.dirname, "node_modules", ".vite-pwa-dev"),
      },
    }),
    // What the app frames: only https: pages (src/pwa.ts FRAME_POLICY), in every build.
    {
      name: "smithers-frame-policy",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: FRAME_POLICY },
          injectTo: "head-prepend",
        },
      ],
    },
  ],
  define: { "globalThis.__SANDBOX_COMMAND_MAX_SECONDS__": JSON.stringify(COMMAND_MAX_SECONDS) },
  worker: { format: "es" },
  // TypeScript is the language server worker's one CommonJS import: bundled up front, so the first TypeScript file the
  // dev server shows doesn't reload every page to optimize it.
  optimizeDeps: { include: ["typescript"] },
  server: { port: 5190, strictPort: true, fs: { strict: false } },
  build: { target: "esnext" },
})
