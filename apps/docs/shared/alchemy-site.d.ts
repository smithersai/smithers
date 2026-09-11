import type * as Alchemy from "alchemy"

/** Options for a package site's declarative Alchemy 2 stack. */
export interface DocsSiteStackOptions {
  /** The app name is smithers-docs-<slug>; the default domain is <slug>.smithers.sh. */
  readonly slug: string
  /** Site directory scanned for Alchemy 1 env-bearing state. Defaults to the working directory. */
  readonly dir?: string
}

/** An Alchemy 1 state file that embeds a process environment. */
export interface LegacyEnvState {
  /** Path relative to the scanned site directory. */
  readonly file: string
  /** Distinct variable names across props.env and output.env. */
  readonly variables: number
}

/** Lists `<dir>/.alchemy/**\/*.json` files carrying props.env or output.env. Never reads out values. */
export declare function findLegacyEnvState(dir: string): ReadonlyArray<LegacyEnvState>

/** Returns an unevaluated stack. Throws when the site still holds Alchemy 1 env-bearing state. The Alchemy CLI owns plan, deploy, and destroy. */
export declare function makeDocsSiteStack(options: DocsSiteStackOptions): ReturnType<typeof Alchemy.Stack>
