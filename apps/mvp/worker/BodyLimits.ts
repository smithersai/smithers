import { Config, Effect, Schema } from "effect"
import { MAX_QUESTION_BODY_BYTES } from "../src/features/chat/contract.ts"
import { MAX_ANSWER_BODY_BYTES } from "../src/features/agent/contract.ts"
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
import { MAX_ADMIN_BODY_BYTES, MAX_RUNNER_BODY_BYTES, parseAdminRoute } from "../src/features/runners/contract.ts"
import { MAX_FEED_REQUEST_BYTES, MAX_ANSWER_BODY_BYTES as FEED_ANSWER_BYTES } from "../src/features/feeds/contract.ts"
import { MAX_DOMAIN_BODY_BYTES } from "../src/features/domains/contract.ts"
import { MAX_REPORT_BODY_BYTES } from "../src/features/bugs/contract.ts"
import { MAX_INPUT_BYTES } from "../src/features/actions/contract.ts"
import { MAX_STEER_BODY_BYTES } from "../src/features/runs/contract.ts"
import { MAX_SUMMARY_BODY_BYTES } from "../src/features/timeline/contract.ts"
import { TELEMETRY_LIMITS } from "../src/telemetry.ts"

export const MAX_BODY_BYTES = 8 * 1024 * 1024
export const DEFAULT_MODEL_BYTES = 192 * 1024
/** The same configurable byte limit used by model admission. */
export const modelBytes = Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "MODEL_MAX_REQUEST_BYTES").pipe(Config.withDefault(DEFAULT_MODEL_BYTES))

/** Match the existing write-route contracts before consuming their streams. Unknown routes retain the aggregate cap. */
export const forRequest = (url: string) => Effect.gen(function* () {
  const path = url.split("?")[0]!
  if (path.startsWith("/api/telemetry/")) return TELEMETRY_LIMITS.maxRequestBytes
  if (parseAdminRoute(path) !== undefined) return MAX_ADMIN_BODY_BYTES
  if (path.startsWith("/api/runners/")) return MAX_RUNNER_BODY_BYTES
  if (path.startsWith("/api/model/")) return Math.min(MAX_BODY_BYTES, yield* modelBytes)
  if (path === "/api/auth/arrive") return 1024
  if (path === "/api/auth/sign-out" || path === "/api/auth/handoff") return 4096
  if (path === "/api/github/webhook") return MAX_WEBHOOK_BYTES
  if (path === "/api/questions") return MAX_QUESTION_BODY_BYTES
  if (path.startsWith("/api/answers/")) return MAX_ANSWER_BODY_BYTES
  if (path === "/api/message-pin" || path === "/api/message-pin/stamp") return 512
  if (path === "/api/timeline/summaries") return MAX_SUMMARY_BODY_BYTES
  if (path === "/api/views") return MAX_GENERATED_BODY_BYTES
  if (/^\/api\/views\/[^/]+\/state$/.test(path)) return MAX_VIEW_BODY_BYTES
  if (path === "/api/web/preview") return MAX_PREVIEW_BODY_BYTES
  if (/^\/api\/runs\/[^/]+\/credential$/.test(path)) return MAX_CREDENTIAL_BODY_BYTES
  if (path.startsWith("/api/runs/")) return MAX_RUN_BODY_BYTES
  if (path === "/api/watches" || path === "/api/notifications/ack") return MAX_ATTENTION_BODY_BYTES
  if (path === "/api/alert-channels") return MAX_ALERT_CHANNEL_BODY_BYTES
  if (path === "/api/sandbox-limits") return MAX_SANDBOX_LIMITS_BODY_BYTES
  if (path.startsWith("/api/flows/") || path.startsWith("/api/flow-drafts/")) return MAX_FLOWS_BODY_BYTES
  if (path === "/api/branches") return MAX_TRACK_BODY_BYTES
  if (/^\/api\/branches\/[^/]+\/shares$/.test(path)) return MAX_SHARE_BODY_BYTES
  if (path === "/api/conversations/archive") return MAX_ARCHIVE_BODY_BYTES
  if (path.startsWith("/api/texts/")) return MAX_TEXT_BODY_BYTES
  if (path === "/api/terminals") return MAX_OPEN_BODY_BYTES
  if (path === "/api/sandbox/calls") return MAX_CALL_BODY_BYTES
  if (path === "/api/repos" || path === "/api/repos/launch") return MAX_REQUEST_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/writes$/.test(path)) return MAX_WRITE_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/asks$/.test(path)) return MAX_RUN_BODY_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/links$/.test(path)) return MAX_POST_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/review$/.test(path)) return MAX_REVIEW_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/stack$/.test(path)) return MAX_STACK_BODY_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/secrets\/[^/]+$/.test(path)) return SECRET_BYTES
  if (path === "/api/me/model/jev") return MAX_JEV_BODY_BYTES
  if (path === "/api/me/model") return MODEL_BYTES
  if (path === "/api/me/model/test" || path === "/api/me/model/codex") return 0
  if (path === "/api/bugs") return MAX_REPORT_BODY_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/feeds\/answers$/.test(path)) return FEED_ANSWER_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/feeds$/.test(path)) return MAX_FEED_REQUEST_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/domains(?:\/[^/]+)?$/.test(path)) return MAX_DOMAIN_BODY_BYTES
  if (/^\/api\/repos\/[^/]+\/[^/]+\/runs$/.test(path)) return MAX_INPUT_BYTES * 2
  if (/^\/api\/remote-runs\/[^/]+\/steers$/.test(path)) return MAX_STEER_BODY_BYTES
  if (/^\/api\/remote-runs\/[^/]+\/stop$/.test(path)) return 0
  return MAX_BODY_BYTES
})
