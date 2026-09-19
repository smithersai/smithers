import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@fontsource/inter/latin-400.css"
import "@fontsource/inter/latin-500.css"
import "@fontsource/inter/latin-600.css"
import "@fontsource/ibm-plex-mono/latin-400.css"
import "@fontsource/ibm-plex-mono/latin-500.css"
import "@xyflow/react/dist/style.css"

import "./styles/tokens.css"
import "./styles/app.css"
import "./styles/canvas.css"

import { App } from "./App.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
