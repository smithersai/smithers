import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "@/app/app"
import { GlobalErrorBoundary } from "@/app/components/global-error-boundary"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>
)
