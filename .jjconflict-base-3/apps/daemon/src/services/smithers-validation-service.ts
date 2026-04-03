import { HttpError } from "@/utils/http-error"

type SmithersValidationResult = {
  ok: boolean
  status: number | null
  message: string
}

function normalizeBaseUrl(rawValue: string) {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    throw new HttpError(400, "Smithers URL is required")
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    throw new HttpError(400, "Smithers URL must be a valid absolute URL")
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new HttpError(400, "Smithers URL must use http or https")
  }

  return parsedUrl.origin
}

export async function validateSmithersBaseUrl(rawBaseUrl: string): Promise<SmithersValidationResult> {
  const baseUrl = normalizeBaseUrl(rawBaseUrl)
  const endpointUrl = new URL("/v1/runs?limit=1", baseUrl)

  try {
    const response = await fetch(endpointUrl, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    })

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: `Server responded with HTTP ${response.status}`,
      }
    }

    return {
      ok: true,
      status: response.status,
      message: "Smithers server is reachable.",
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Network request failed"
    return {
      ok: false,
      status: null,
      message: `Unable to reach Smithers server: ${errorMessage}`,
    }
  }
}
