import { useEffect, useState } from "react"
import { RouterProvider } from "react-router-dom"

import { DESKTOP_STARTUP_ERROR_EVENT } from "@burns/shared"

import {
  type DesktopStartupBlockedError,
  readDesktopStartupBlockedErrorFromWindow,
} from "@/app/errors/desktop-startup-blocked-error"
import { QueryProvider } from "@/app/providers/query-provider"
import { router } from "@/app/router"
import { TooltipProvider } from "@/components/ui/tooltip"

export function App() {
  const [startupError, setStartupError] = useState<DesktopStartupBlockedError | null>(() => {
    if (typeof window === "undefined") {
      return null
    }

    return readDesktopStartupBlockedErrorFromWindow(window)
  })

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    const syncStartupError = () => {
      setStartupError(readDesktopStartupBlockedErrorFromWindow(window))
    }

    window.addEventListener(DESKTOP_STARTUP_ERROR_EVENT, syncStartupError)
    syncStartupError()

    return () => {
      window.removeEventListener(DESKTOP_STARTUP_ERROR_EVENT, syncStartupError)
    }
  }, [])

  if (startupError) {
    throw startupError
  }

  return (
    <QueryProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryProvider>
  )
}
