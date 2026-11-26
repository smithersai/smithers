import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"

export const admissionToken = Effect.sync(() => crypto.randomUUID())

export const forwardedRequest = (url: string, init: RequestInit): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(new Request(url, init))
