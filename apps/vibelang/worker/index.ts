// The site Worker: serves the Vite build. `/api/health` says which agent the deployment runs, so a smoke test can
// tell a mock deployment from a live one. The Effect-native API and the agent's Durable Object arrive with the live
// agent (wiki/roadmap.md, brick 1b).
interface Env {
  readonly ASSETS: Fetcher
}

export default {
  fetch: (request, env) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ ok: true, agent: "mock" })
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
