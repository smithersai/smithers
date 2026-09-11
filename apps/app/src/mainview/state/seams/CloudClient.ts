import { isRecord } from "@smthrs/canonical/Record"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { errorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/** A transport failure has no HTTP status; response metadata stays available to domain policy. */
export interface CloudFailure {
  readonly error: string
  readonly code: string | null
  readonly status: number | null
  readonly retryAfterSeconds: number | null
}

export type CloudResult =
  | { readonly body: unknown; readonly status: number; readonly response: Response }
  | CloudFailure

/** Cloud currently supplies delta-seconds, not HTTP dates. */
export const retryAfterSecondsOf = (response: Response): number | null => {
  const header = response.headers.get("retry-after")
  if (header === null) return null
  const seconds = Number(header.trim())
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null
}

export const cloudFailure = async (response: Response, fallback: string): Promise<CloudFailure> => {
  const body: unknown = await response.json().catch(() => null)
  return {
    error: errorMessage(body, fallback),
    code: isRecord(body) && typeof body.code === "string" && body.code !== "" ? body.code : null,
    status: response.status,
    retryAfterSeconds: retryAfterSecondsOf(response)
  }
}

/** Domain seams share transport; authorization, DTOs, and retry decisions remain in the seam. */
export const createCloudClient = (ctx: Pick<SeamContext, "http" | "baseUrl">) => {
  const url = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`
  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
    label = path
  ): Promise<CloudResult> => {
    let response: Response
    try {
      response = await ctx.http(
        url(path),
        method === "GET" ? undefined : {
          method,
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        }
      )
    } catch (error) {
      return {
        error: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`,
        code: null,
        status: null,
        retryAfterSeconds: null
      }
    }
    if (!response.ok) {
      return cloudFailure(
        response,
        method === "GET"
          ? `Reading ${label} failed (${response.status})`
          : `The ${method} to ${label} failed (${response.status})`
      )
    }
    return { body: await response.json().catch(() => null), status: response.status, response }
  }
  return { url, get: (path: string, label?: string) => request("GET", path, undefined, label), send: request }
}
