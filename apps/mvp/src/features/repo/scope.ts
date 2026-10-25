import type { AboutRow } from "./rows"

/** Session roles and synced lists belong only to the deployment's configured repository. Unknown fails closed. */
export const isDeploymentRepository = (owner: string, name: string, about: AboutRow | undefined): boolean =>
  about?.state === "ready" && about.about?.deploymentRepository?.toLowerCase() === `${owner}/${name}`.toLowerCase()

/** GitHub is the list of record where this deployment does not sync. */
export const githubList = (owner: string, name: string, kind: "issues" | "pulls") => ({
  href: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${kind}`,
  text: kind === "issues" ? "Issues for this repository are on GitHub." : "Pull requests for this repository are on GitHub.",
})
