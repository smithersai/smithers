import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

export const PLAN_ADMISSION_HEADER = "x-smithers-plan-admission"

export interface PlanAdmission {
  readonly subject: string
  readonly session: string
  readonly write: boolean
}

export const admissionToken = Effect.sync(() => crypto.randomUUID())

export const forwardedRequest = (url: string, init: RequestInit): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(new Request(url, init))

export const admittedPlanMcpRequest = (
  admission: PlanAdmission,
  body: string,
): HttpServerRequest.HttpServerRequest =>
  forwardedRequest("https://plan.internal/api/plan/mcp", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      [PLAN_ADMISSION_HEADER]: JSON.stringify(admission),
    },
  })

export const readServerResponseText = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<string, unknown> =>
  Effect.tryPromise(() => HttpServerResponse.toWeb(response).text())
