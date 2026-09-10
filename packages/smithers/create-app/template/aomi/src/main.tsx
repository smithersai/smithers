/**
 * Browser entry point.
 *
 * The generated `routes.ui.gen.ts` is the only route table: `pages` maps a
 * path to a component, `panes` is the pane registry the agent renders into,
 * `flowSummaries` names each flow and whether it is a chat, and `layout` wraps
 * everything. Nothing here hard-codes a path, and nothing here imports
 * `routes.gen.ts`: that is the Worker's table, and it reaches every layer
 * file, every tool module, and the harness.
 */
import "virtual:smthrs-app/brand.css"
import "./styles.css"

import { SmithersUiStyles } from "@smthrs/ui"
import type { ReactNode } from "react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { flowSummaries, layout, pages, panes } from "../routes.ui.gen.ts"
import { startShortcuts } from "./shell/keys.ts"
import type { AppRegistry } from "./shell/registry.ts"
import { RegistryContext } from "./shell/registry.ts"
import { redirect, startRouter } from "./shell/router.ts"
import { actions, useRoute } from "./shell/store.ts"
import { readToken } from "./shell/token.ts"

// Claim the bootstrap credential before routing can replace the URL.
readToken()

/** Where `/` sends the browser. The root page renders Build either way. */
const HOME = "/build"

const registry: AppRegistry = { panes, flows: flowSummaries }

const Layout = layout ?? (({ children }: { children: ReactNode }) => <>{children}</>)

function NotFound({ route }: { readonly route: string }) {
  return (
    <main className="aomi-page">
      <h1 className="aomi-heading">Not found</h1>
      <p className="aomi-tagline">{`No page is routed at ${route}.`}</p>
    </main>
  )
}

function Router() {
  const route = useRoute()
  const match = pages.find((page) => page.route === route)
  const Page = match?.component
  return (
    <RegistryContext value={registry}>
      <Layout>{Page === undefined ? <NotFound route={route} /> : <Page />}</Layout>
    </RegistryContext>
  )
}

function App() {
  return (
    <>
      <SmithersUiStyles withTheme />
      <Router />
    </>
  )
}

startRouter()
startShortcuts()
if (window.location.pathname === "/" && !window.location.hash.startsWith("#/")) redirect(HOME)
void actions.refreshSessions()

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing #root")
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
