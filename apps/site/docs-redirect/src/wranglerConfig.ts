/*
 * The checked-in wrangler.jsonc, read so src/docsRedirect.test.ts can hold the
 * config `wrangler deploy` reads to the generated map. The file carries
 * full-line `//` comments and nothing else JSON cannot parse, so the reader
 * strips those lines and parses the rest; a comment style this cannot handle
 * fails loudly in JSON.parse instead of reading as an empty config.
 *
 * Nothing in the Worker imports this module: it is a test seam, not runtime.
 */
export interface WranglerConfig {
  readonly name: string
  readonly main: string
  readonly compatibility_date: string
  readonly compatibility_flags: ReadonlyArray<string>
  readonly routes: ReadonlyArray<{ readonly pattern: string; readonly zone_name?: string }>
  readonly vars: Readonly<Record<string, string>>
  readonly observability?: { readonly enabled: boolean }
}

export const parseWranglerConfig = (source: string): WranglerConfig =>
  JSON.parse(source.replace(/^\s*\/\/.*$/gm, "")) as WranglerConfig
