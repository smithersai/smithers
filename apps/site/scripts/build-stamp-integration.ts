import { writeFile } from "node:fs/promises"
import type { AstroIntegration } from "astro"
import {
  BUILD_STAMP_ASSET,
  buildStampAssetSource,
  buildStampMetaTags,
  buildStampValues
} from "../../app/scripts/build-stamp.ts"

/*
 * CN-1 for the Astro host: the app page this site prerenders must state which
 * commit it was built from, the same way apps/app's own Vite build does, because
 * apps/server/scripts/canary/build-probe.ts reads the `smithers-build-sha`
 * meta on the served HTML and the `__build.json` asset next to it. The values,
 * the meta names, the asset name and the JSON shape all come from
 * apps/app/scripts/build-stamp.ts, so the two builds cannot disagree on the
 * contract; only the wiring differs. Astro has no `transformIndexHtml`, so the
 * meta tags travel through the `virtual:smithers-build-stamp` module and
 * src/layouts/AppShell.astro renders them into the app page's head. The asset
 * is written once the static build is on disk (`astro:build:done`).
 */
export const BUILD_STAMP_MODULE = "virtual:smithers-build-stamp"

export const buildStamp = (): AstroIntegration => {
  const values = buildStampValues()
  const metaTags = buildStampMetaTags(values)
  const resolvedId = `\0${BUILD_STAMP_MODULE}`
  const virtualModule = {
    name: "smithers-build-stamp-module",
    resolveId: (id: string) => (id === BUILD_STAMP_MODULE ? resolvedId : undefined),
    load: (id: string) => (id === resolvedId ? `export const metaTags = ${JSON.stringify(metaTags)}\n` : undefined)
  }
  return {
    name: "smithers-build-stamp",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [virtualModule] } })
      },
      "astro:build:done": async ({ dir }) => {
        await writeFile(new URL(BUILD_STAMP_ASSET, dir), buildStampAssetSource(values))
      }
    }
  }
}
