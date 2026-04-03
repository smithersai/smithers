import { isRouteErrorResponse, useRouteError } from "react-router-dom"

import { AppCrashScreen } from "@/app/components/app-crash-screen"

function toErrorDetails(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}${error.data ? `\n${String(error.data)}` : ""}`
  }

  if (error instanceof Error) {
    return error.stack ?? error.message
  }

  if (typeof error === "string") {
    return error
  }

  return null
}

export function RouterErrorScreen() {
  const error = useRouteError()

  return (
    <AppCrashScreen
      message="The current route failed to load or render."
      details={toErrorDetails(error)}
    />
  )
}
