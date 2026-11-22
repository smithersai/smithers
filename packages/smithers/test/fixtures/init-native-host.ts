/** Offline provider transport for the generated starter's real CLI host. */
import { isMainThread } from "node:worker_threads"
import "./scripted-native-host.ts"

const compiler = process.argv[1]?.replaceAll("\\", "/").endsWith("/vibelang/bin/vibelang") === true
if (isMainThread && !compiler) {
  const [{ MockAgent }, { Effect }, { layerRebuildableRequestExecutor, platform }] = await Promise.all([
    import("@effect/platform-node/Undici"),
    import("effect"),
    import("../../src/internal/NodeControlHost.ts")
  ])

  Object.assign(platform, {
    requestExecutor: layerRebuildableRequestExecutor(Effect.acquireRelease(
      Effect.sync(() => {
        const agent = new MockAgent()
        agent.disableNetConnect()
        const answer = "```cell\nctx.done(JSON.stringify({ summary: \"Checked the generated starter.\" }))\n```"
        const stream = [
          { type: "response.output_text.delta", item_id: "msg_1", delta: answer },
          { type: "response.output_text.done", item_id: "msg_1" },
          {
            type: "response.completed",
            response: { id: "init_fixture", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
          }
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
        agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" })
          .reply(200, stream, { headers: { "content-type": "text/event-stream" } }).persist()
        return agent
      }),
      (agent) => Effect.promise(() => agent.close())
    ))
  })
}
