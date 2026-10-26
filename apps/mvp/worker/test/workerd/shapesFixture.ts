// What worker/test/workerd/shapes.ts and worker/GitHubShapes.workerd.test.ts share. A Worker's main module may export
// only handlers, so these live here.

/** The deployment's own repository, which the test schema records as public. */
export const REPOSITORY = { owner: "acme", name: "widgets" } as const

/** Sign-in's SESSION_SECRET in this test: a sentinel, long enough. The test signs its Member's cookie with it. */
export const SESSION_SECRET = "workerd-shapes-session-sentinel-".padEnd(64, "7")
