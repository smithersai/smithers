# Worker and gateway boundaries

`apps/server` serves the browser application through a Cloudflare Worker. Its request router is `handleRequest` in `src/index.ts`; the default export adapts Worker's `fetch` entry through `runRequest` in `src/Boundary.ts`.

## Effect services

The router returns an Effect requiring `RequestServices`. `src/Environment.ts` composes deployment services, while the request's execution context belongs to each request. Keep promise interoperation at the declared platform boundaries.

## Source map

Use `apps/server/docs/EFFECT.md` for the service and Layer architecture, `src/Environment.ts` for composition, and `src/index.ts` for routing. These sources describe implementation; they do not establish deployment health or a successful gateway connection.
