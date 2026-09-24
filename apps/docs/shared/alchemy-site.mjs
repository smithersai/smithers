// @ts-check
/** Alchemy 2 stack factory shared by every package documentation site. */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"

/**
 * The stage Alchemy 1 baked into every live docs Worker name
 * (`${app}-${id}-${stage}`). Renaming the Workers would move 48 hostnames
 * for no reader-visible change, so new sites take the same suffix.
 */
const ALCHEMY1_STAGE = "williamcory"

/** The smithers.sh zone on the account that serves every docs site. */
const SMITHERS_ZONE_ID = "8ebd98d2f0dc7d8db2e61f31ebc19c14"

/**
 * The StaticSite props of one docs site: a pure function of its manifest
 * slug. A slug the account already serves names its live Worker; a new slug
 * names a Worker the first deploy creates.
 *
 * @param {string} slug
 */
export function docsSiteProps(slug) {
  const app = `smithers-docs-${slug}`
  return {
    name: `${app}-${app}-${ALCHEMY1_STAGE}`,
    command: "pnpm run build",
    outdir: "dist",
    assets: { notFoundHandling: /** @type {const} */ ("404-page") },
    workersDev: false,
    domain: { name: `${slug}.smithers.sh`, zoneId: SMITHERS_ZONE_ID }
  }
}

/**
 * Declare a static site without running its stack or contacting Cloudflare.
 * State lives in the account's `alchemy-state-store`; the package scripts pin
 * stage `prod`, so every machine plans against one record.
 *
 * @param {{ readonly slug: string }} options
 */
export function makeDocsSiteStack({ slug }) {
  const app = `smithers-docs-${slug}`
  return Alchemy.Stack(
    app,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Cloudflare.Website.StaticSite(app, docsSiteProps(slug))
  )
}
