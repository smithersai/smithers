import { defineRouteMiddleware } from "@astrojs/starlight/route-data"
import { onRequest as releaseNotice } from "../../docs/shared/release-notice.mjs"

export const onRequest = defineRouteMiddleware((context, next) => {
  return releaseNotice(context, next)
})
