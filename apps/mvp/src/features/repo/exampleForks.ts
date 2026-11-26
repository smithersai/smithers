export type ExampleForkMeta = {
  readonly forkOrg: string
  readonly upstreamRepo: string
  readonly upstreamHref: string
}

const SMITHERSAI_EXAMPLE_FORKS: Readonly<Record<string, Omit<ExampleForkMeta, "forkOrg">>> = {
  effect: { upstreamRepo: "Effect-TS/effect", upstreamHref: "https://github.com/Effect-TS/effect" },
  alchemy: { upstreamRepo: "alchemy-run/alchemy", upstreamHref: "https://github.com/alchemy-run/alchemy" },
  foldkit: { upstreamRepo: "foldkit/foldkit", upstreamHref: "https://github.com/foldkit/foldkit" },
  t3code: { upstreamRepo: "pingdotgg/t3code", upstreamHref: "https://github.com/pingdotgg/t3code" },
  opencode: { upstreamRepo: "anomalyco/opencode", upstreamHref: "https://github.com/anomalyco/opencode" },
  eliza: { upstreamRepo: "elizaOS/eliza", upstreamHref: "https://github.com/elizaOS/eliza" },
  needlefish: { upstreamRepo: "refcell/needlefish", upstreamHref: "https://github.com/refcell/needlefish" },
}

/**
 * Returns upstream attribution for known example forks under smithersai/.
 * Returns undefined for first-party repos and non-fork repositories.
 */
export function exampleForkOf(owner: string, name: string): ExampleForkMeta | undefined {
  if (owner.toLowerCase() !== "smithersai") return undefined
  const key = name.toLowerCase()
  if (!Object.hasOwn(SMITHERSAI_EXAMPLE_FORKS, key)) return undefined
  const entry = SMITHERSAI_EXAMPLE_FORKS[key]!
  return { forkOrg: "smithersai", ...entry }
}
