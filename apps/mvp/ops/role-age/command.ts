// What `node` runs to age a role row: e2e/cold-path.spec.ts runs it against production, and ops/deploy-smoke/run.test.ts
// runs the same command before any deploy, so a module it can't load fails a test there and not the smoke on production.
export const roleAgeArgs = (repo: string, personId: string, project: string | undefined): ReadonlyArray<string> =>
  ["ops/role-age/expire.ts", "--repo", repo, "--person", personId, ...(project === undefined ? [] : ["--project", project])]
