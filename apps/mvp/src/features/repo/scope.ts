/** GitHub is the list of record where this deployment does not sync. */
export const githubList = (owner: string, name: string, kind: "issues" | "pulls") => ({
  href: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${kind}`,
  text: kind === "issues" ? "Issues for this repository are on GitHub." : "Pull requests for this repository are on GitHub.",
})
