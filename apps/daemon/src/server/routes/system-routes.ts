import {
  burnsRuntimeContextSchema,
  type BurnsRuntimeContext,
} from "@burns/shared"
import { pickDirectoryWithNativeDialog } from "@/services/native-folder-picker-service"
import { validateSmithersBaseUrl } from "@/services/smithers-validation-service"
import { buildRuntimeContext, isLoopbackHost } from "@/runtime-context"
import { HttpError, toErrorResponse } from "@/utils/http-error"

type HandleSystemRoutesOptions = {
  pickDirectory?: () => string | null
  validateSmithersUrl?: (baseUrl: string) => Promise<{
    ok: boolean
    status: number | null
    message: string
  }>
}

export async function handleSystemRoutes(
  request: Request,
  pathname: string,
  options: HandleSystemRoutesOptions = {}
) {
  try {
    if (pathname === "/api/system/folder-picker" && request.method === "POST") {
      const requestUrl = new URL(request.url)
      if (!isLoopbackHost(requestUrl.hostname)) {
        throw new HttpError(403, "Native folder picker is only available on localhost daemon URLs")
      }

      const pickDirectory = options.pickDirectory ?? pickDirectoryWithNativeDialog
      return Response.json({ path: pickDirectory() })
    }

    if (pathname === "/api/system/validate-smithers-url" && request.method === "POST") {
      const requestBody = (await request.json().catch(() => null)) as { baseUrl?: unknown } | null
      const baseUrl = typeof requestBody?.baseUrl === "string" ? requestBody.baseUrl : ""
      const validateUrl = options.validateSmithersUrl ?? validateSmithersBaseUrl
      const validation = await validateUrl(baseUrl)
      return Response.json(validation)
    }

    if (pathname === "/api/system/runtime-context" && request.method === "GET") {
      const requestUrl = new URL(request.url)
      const runtimeContext: BurnsRuntimeContext = burnsRuntimeContextSchema.parse(
        buildRuntimeContext({
          runtimeMode: process.env.BURNS_RUNTIME_MODE,
          requestHostname: requestUrl.hostname,
        })
      )

      return Response.json(runtimeContext)
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
