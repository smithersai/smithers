import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { MAX_QUESTION_BODY_BYTES } from "../src/features/chat/contract.ts"
import { MAX_ATTENTION_BODY_BYTES } from "../src/features/attention/contract.ts"
import { MAX_GENERATED_BODY_BYTES, MAX_VIEW_BODY_BYTES } from "../src/features/views/contract.ts"
import { MAX_RUN_BODY_BYTES, MAX_CREDENTIAL_BODY_BYTES } from "../src/features/status/contract.ts"
import { MAX_PREVIEW_BODY_BYTES } from "../src/features/web/contract.ts"
import { MAX_ALERT_CHANNEL_BODY_BYTES, MAX_SANDBOX_LIMITS_BODY_BYTES } from "../src/features/spend/contract.ts"
import { MAX_FLOWS_BODY_BYTES } from "../src/features/flows-ui/contract.ts"
import { MAX_TRACK_BODY_BYTES, MAX_SHARE_BODY_BYTES } from "../src/features/branch/contract.ts"
import { MAX_ARCHIVE_BODY_BYTES } from "../src/features/conversations/contract.ts"
import { MAX_TEXT_BODY_BYTES } from "../src/features/coedit/contract.ts"
import { MAX_OPEN_BODY_BYTES } from "../src/features/terminal/contract.ts"
import { MAX_CALL_BODY_BYTES } from "../src/features/sandbox/contract.ts"
import { MAX_REQUEST_BYTES } from "../src/features/repo/contract.ts"
import { MAX_WRITE_BYTES, MAX_WEBHOOK_BYTES, MAX_REVIEW_BYTES } from "../src/features/issues/contract.ts"
import { MAX_POST_BYTES } from "../src/features/issues/work.ts"
import { MAX_STACK_BODY_BYTES } from "../src/features/todos/contract.ts"
import { MAX_PUT_BODY_BYTES as SECRET_BYTES } from "../src/features/secrets/contract.ts"
import { MAX_PUT_BODY_BYTES as MODEL_BYTES, MAX_JEV_BODY_BYTES } from "../src/features/personal-model/contract.ts"
import { MAX_ADMIN_BODY_BYTES, MAX_RUNNER_BODY_BYTES } from "../src/features/runners/contract.ts"
import { MAX_FEED_REQUEST_BYTES, MAX_ANSWER_BODY_BYTES as FEED_ANSWER_BYTES } from "../src/features/feeds/contract.ts"
import { MAX_DOMAIN_BODY_BYTES } from "../src/features/domains/contract.ts"
import { MAX_REPORT_BODY_BYTES } from "../src/features/bugs/contract.ts"
import { MAX_INPUT_BYTES } from "../src/features/actions/contract.ts"
import { MAX_STEER_BODY_BYTES } from "../src/features/runs/contract.ts"
import { MAX_SUMMARY_BODY_BYTES } from "../src/features/timeline/contract.ts"
import { MAX_PLAN_MCP_BYTES } from "./Body.vibe"
import { ATTACH_ROUTE, MCP_MAX_REQUEST_BYTES, MCP_ROUTE } from "../src/features/mcp/contract.ts"
import { TELEMETRY_LIMITS } from "../src/telemetry.ts"
import { WAITLIST_JOIN_ROUTE, WAITLIST_MAX_BODY_BYTES } from "../src/features/waitlist/contract.ts"
import * as BodyLimits from "./BodyLimits.vibe"
import { afterBody } from "./WriteAdmission.vibe"

test.each(["/api/auth/handoff", "/api/auth/handoff?return=%2Fapp"])("%s has the handoff handler's 4 KiB contract", async (path) => {
  expect(await Effect.runPromise(BodyLimits.forRequest(path))).toBe(4096)
})

test("an agent's ask takes the runs routes' 16 KiB; reading one takes no body beyond the aggregate cap", async () => {
  expect(await Effect.runPromise(BodyLimits.forRequest("/api/repos/acme/widgets/asks"))).toBe(16 * 1024)
  expect(await Effect.runPromise(BodyLimits.forRequest("/api/repos/acme/widgets/asks/ask-1"))).toBe(BodyLimits.MAX_BODY_BYTES)
})

test.each(["declared", "streamed"].flatMap((mode) => [4096, 4097].map((size) => [mode, size] as const)))(
  "handoff admission bounds a %s body of %s bytes before resolving authority", async (mode, size) => {
    let admitted = 0
    const handler = HttpEffect.toWebHandler(afterBody(Effect.gen(function* () {
      admitted++
      const request = yield* HttpServerRequest.HttpServerRequest
      return HttpServerResponse.text(yield* request.text.pipe(Effect.orDie))
    })))
    const response = await handler(new Request("http://smithers.test/api/auth/handoff", {
      method: "POST", body: "x".repeat(size),
      ...(mode === "declared" ? { headers: { "content-length": String(size) } } : {}),
    }))
    expect(response.status).toBe(size === 4096 ? 200 : 413)
    expect(admitted).toBe(size === 4096 ? 1 : 0)
    expect(await response.text()).toBe(size === 4096 ? "x".repeat(size) : '{"code":"too_large"}')
  },
)

test("POST /api/hosted-model has a 256-byte body limit", async () => {
  expect(await Effect.runPromise(BodyLimits.forRequest("/api/hosted-model"))).toBe(256)
})

test("a submit to a conversation's messages shard takes 192 KiB; its reads keep the aggregate cap", async () => {
  const base = "/api/conversations/3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d/messages/"
  expect(await Effect.runPromise(BodyLimits.forRequest(base + "submit"))).toBe(196_608)
  expect(await Effect.runPromise(BodyLimits.forRequest(base + "pull?after=0"))).toBe(BodyLimits.MAX_BODY_BYTES)
})

test.each([
  ["/api/telemetry/events", TELEMETRY_LIMITS.maxRequestBytes],
  ["/api/repos/acme/widgets/runners/build", MAX_ADMIN_BODY_BYTES],
  ["/api/runners/start", MAX_RUNNER_BODY_BYTES],
  ["/api/auth/arrive", 1024],
  ["/api/auth/sign-out", 4096],
  ["/api/github/webhook", MAX_WEBHOOK_BYTES],
  ["/api/questions", MAX_QUESTION_BODY_BYTES],
  [WAITLIST_JOIN_ROUTE, WAITLIST_MAX_BODY_BYTES],
  ["/api/message-pin", 512],
  ["/api/message-pin/stamp", 512],
  ["/api/timeline/summaries", MAX_SUMMARY_BODY_BYTES],
  ["/api/views", MAX_GENERATED_BODY_BYTES],
  ["/api/views/build/state", MAX_VIEW_BODY_BYTES],
  ["/api/web/preview", MAX_PREVIEW_BODY_BYTES],
  ["/api/runs/build/credential", MAX_CREDENTIAL_BODY_BYTES],
  ["/api/runs/build/start", MAX_RUN_BODY_BYTES],
  ["/api/watches", MAX_ATTENTION_BODY_BYTES],
  ["/api/notifications/ack", MAX_ATTENTION_BODY_BYTES],
  ["/api/alert-channels", MAX_ALERT_CHANNEL_BODY_BYTES],
  ["/api/sandbox-limits", MAX_SANDBOX_LIMITS_BODY_BYTES],
  ["/api/flows/build", MAX_FLOWS_BODY_BYTES],
  ["/api/flow-drafts/build", MAX_FLOWS_BODY_BYTES],
  ["/api/branches", MAX_TRACK_BODY_BYTES],
  ["/api/branches/main/shares", MAX_SHARE_BODY_BYTES],
  ["/api/conversations/archive", MAX_ARCHIVE_BODY_BYTES],
  ["/api/texts/file", MAX_TEXT_BODY_BYTES],
  ["/api/terminals", MAX_OPEN_BODY_BYTES],
  ["/api/sandbox/calls", MAX_CALL_BODY_BYTES],
  ["/api/repos", MAX_REQUEST_BYTES],
  ["/api/repos/launch", MAX_REQUEST_BYTES],
  ["/api/repos/acme/widgets/writes", MAX_WRITE_BYTES],
  ["/api/repos/acme/widgets/issues/1/links", MAX_POST_BYTES],
  ["/api/repos/acme/widgets/pulls/1/review", MAX_REVIEW_BYTES],
  ["/api/repos/acme/widgets/stack", MAX_STACK_BODY_BYTES],
  ["/api/repos/acme/widgets/secrets/token", SECRET_BYTES],
  ["/api/me/model/jev", MAX_JEV_BODY_BYTES],
  ["/api/me/model", MODEL_BYTES],
  ["/api/me/model/test", 0],
  ["/api/me/model/codex", 0],
  ["/api/bugs", MAX_REPORT_BODY_BYTES],
  ["/api/repos/acme/widgets/feeds/answers", FEED_ANSWER_BYTES],
  ["/api/repos/acme/widgets/feeds", MAX_FEED_REQUEST_BYTES],
  ["/api/repos/acme/widgets/domains", MAX_DOMAIN_BODY_BYTES],
  ["/api/repos/acme/widgets/domains/widgets.test", MAX_DOMAIN_BODY_BYTES],
  ["/api/repos/acme/widgets/runs", MAX_INPUT_BYTES * 2],
  ["/api/remote-runs/build/steers", MAX_STEER_BODY_BYTES],
  ["/api/remote-runs/build/stop", 0],
  ["/api/repos/acme/widgets/plan/mcp", MAX_PLAN_MCP_BYTES],
  [MCP_ROUTE, MCP_MAX_REQUEST_BYTES],
  ["/api/repos/acme/widgets/mcp", MCP_MAX_REQUEST_BYTES],
  [ATTACH_ROUTE + "/build", MCP_MAX_REQUEST_BYTES],
  ["/api/mcp/oauth/token", 16 * 1024],
] as const)("%s uses its write contract", async (path, expected) => {
  expect(await Effect.runPromise(BodyLimits.forRequest(path))).toBe(expected)
})
