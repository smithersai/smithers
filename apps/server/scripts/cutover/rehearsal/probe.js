// Reaches the scratch object through a cross-script Durable Object binding, so the
// self-test runs inside whatever version (original, admission, fence) is live.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/selftest") return new Response("probe", { status: 404 })
    const stub = env.TARGET.get(env.TARGET.idFromName("rehearsal"))
    const answer = await stub.fetch("https://scratch.internal/selftest")
    return new Response(await answer.text(), { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "text/plain" } })
  }
}
