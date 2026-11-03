import { afterAll, expect, it } from "@effect/vitest"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Dstack, endpointFromEnv, layer, liveLayer } from "../../../examples/use-cases/dstack.ts"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "dstack-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const code =
  "export function applyDiscount(price, code) {\n  if (code == \"SUMMER10\") return price * 0.9;\n  return price;\n}"

/**
 * A reviewer that finds one issue of each severity in the file it was named,
 * and a fixer that turns the issue lines it was handed into its diff. Every
 * request is recorded in order.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const reviewed = /Review this code snippet from (.+):/.exec(asked)?.[1]
    if (reviewed !== undefined) {
      turns.push(`review ${reviewed}`)
      return {
        summary: `${reviewed} compares loosely`,
        issues: [
          { severity: "low", area: "style", description: "missing semicolon" },
          { severity: "high", area: "equality", description: "use === for the code" },
          { severity: "medium", area: "types", description: "price is untyped" }
        ],
        overallScore: 55
      }
    }
    const listed = /Issues to address \(highest severity first\):\n([\s\S]*?)\n\nReturn a minimal unified diff\./.exec(
      asked
    )
    if (listed !== null) {
      turns.push(`patch ${/Original snippet \((.+)\):/.exec(asked)?.[1]}`)
      return { rationale: listed[1]!, unifiedDiff: "--- a/input.ts\n+++ b/input.ts" }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("reviews the snippet, then patches only the issues above low, in review order", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(Dstack, { code }, {
      filename: join(directory, "scripted.sqlite"),
      executionId: "dstack-scripted",
      script: answer,
      actions: layer
    })

    // With no filename, both agents are told `input.ts`.
    expect(turns).toEqual(["review input.ts", "patch input.ts"])
    expect(output.review.overallScore).toBe(55)
    // The fixer was handed the review's non-low issues, unsorted, as 0.x did.
    expect(output.patch.rationale).toBe(
      "- [high] equality: use === for the code\n- [medium] types: price is untyped"
    )
  }))

/**
 * A Chat Completions server, in process. It records where each request was
 * sent, the bearer it carried and the model it named, and streams back the
 * cell the scripted model would have written, as server-sent events.
 */
const endpointServer = (answer: Kit.Script) => {
  const sent: Array<{ readonly url: string; readonly authorization: string | undefined; readonly model: string }> = []
  const client = HttpClient.make((request) =>
    Effect.gen(function*() {
      const body = JSON.parse(new TextDecoder().decode((request.body as { readonly body: Uint8Array }).body)) as {
        readonly model: string
        readonly messages: ReadonlyArray<{ readonly content: string | ReadonlyArray<{ readonly text?: string }> }>
      }
      sent.push({ url: request.url, authorization: request.headers["authorization"], model: body.model })
      const asked = body.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text ?? "").join("")
        )
        .join("\n")
      const cell = "```cell\nctx.done(" + JSON.stringify(answer(asked)) + ")\n```"
      const events = [
        { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: cell }, finish_reason: null }] },
        { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
      return HttpClientResponse.fromWeb(
        request,
        new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } })
      )
    })
  )
  return { sent, transport: Layer.succeed(KernelHttpClient.HttpClient)(client) }
}

it.effect("sends both agents to the dstack endpoint with the dstack token through the live composition", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const server = endpointServer(answer)
    const endpoint = endpointFromEnv({
      KIMI_BASE_URL: "https://kimi-k2.gateway.example/v1",
      KIMI_API_KEY: "dstack-token"
    })
    // The live host as `main` builds it, with two replacements: requests go to
    // the in-process server, and the offline judge stands in for the seat's.
    const output = yield* Effect.scoped(
      Dstack.execute({ code, filename: "checkout.ts" }, { executionId: "dstack-endpoint" }).pipe(
        Effect.provide(liveLayer(endpoint, join(directory, "endpoint.sqlite"), {
          executor: RequestExecutor.layer.pipe(Layer.provide(server.transport)),
          judge: ScriptedJudge.layer
        }))
      )
    )

    expect(turns).toEqual(["review checkout.ts", "patch checkout.ts"])
    const sent = {
      url: "https://kimi-k2.gateway.example/v1/chat/completions",
      authorization: "Bearer dstack-token",
      model: "kimi-k2"
    }
    expect(server.sent).toEqual([sent, sent])
    expect(output.patch.rationale).toBe(
      "- [high] equality: use === for the code\n- [medium] types: price is untyped"
    )
  }))

it("refuses to start without the endpoint, as 0.x did", () => {
  expect(() => endpointFromEnv({ KIMI_BASE_URL: "https://kimi-k2.gateway.example/v1" })).toThrow(
    "Set KIMI_BASE_URL to the dstack service's /v1 URL and KIMI_API_KEY to a dstack user token"
  )
  expect(() => endpointFromEnv({ KIMI_API_KEY: "dstack-token" })).toThrow("Set KIMI_BASE_URL")
})
