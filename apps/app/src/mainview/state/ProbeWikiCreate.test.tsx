import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { backend, json, memoryStorage, settled, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

GlobalRegistrator.register({ url: "https://smithers.sh/" })

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
  window.history.replaceState(null, "", "/")
})

const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

test("probe: what does the Create Wiki click dispatch", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() }, { seedWiki: false })
  const controller = createAppController(store, unavailableRepositories, silentAgent, { bootstrap: WEB,
    ...backend({ "/api/auth/session": json(401, {}), "/api/auth/scopes": json(200, { scopes: [] }) }) })
  await controller.commands.run("wiki")
  await settled()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
  mounted.push(() => { flushSync(() => root.unmount()); host.remove() })
  const door = host.querySelector<HTMLButtonElement>('.world-card-empty [data-flow="wiki.create"]')
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repository.upserted", actor: "system", repository: { id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "org", head: null, catalog: true } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  console.log("DOOR still connected:", door?.isConnected, "same node:", host.querySelector('.world-card-empty [data-flow="wiki.create"]') === door)
  door?.click()
  await settled()
  console.log("pendingCommand:", JSON.stringify(store.session().pendingCommand))
  expect(true).toBe(true)
})
