import type * as Alchemy from "alchemy"

/** Options for a package site's declarative Alchemy 2 stack. */
export interface DocsSiteStackOptions {
  /** The manifest slug: app smithers-docs-<slug>, hostname <slug>.smithers.sh. */
  readonly slug: string
}

/** The StaticSite props one slug derives: its live Worker name, build, and hostname. */
export interface DocsSiteProps {
  readonly name: string
  readonly command: "pnpm run build"
  readonly outdir: "dist"
  readonly assets: { readonly notFoundHandling: "404-page" }
  readonly workersDev: false
  readonly domain: { readonly name: string; readonly zoneId: string }
}

/** Derives a docs site's physical identity from its slug; reads no environment. */
export declare function docsSiteProps(slug: string): DocsSiteProps

/** Returns an unevaluated stack on the shared Cloudflare state store. The Alchemy CLI owns plan, deploy, and destroy. */
export declare function makeDocsSiteStack(options: DocsSiteStackOptions): ReturnType<typeof Alchemy.Stack>
