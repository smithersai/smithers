import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatProvider } from "../../AppContext"
import type { ChatView } from "../chat/chat"
import type { StatusView } from "./status"
import { HeaderStatus } from "./components/HeaderStatus"
import { StatusProvider } from "./components/StatusContext"

export const renderHeaderStatus = async (chat: ChatView, status: StatusView) => {
  const root = createRootRoute({ component: HeaderStatus })
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) })
  await router.load()
  return renderToStaticMarkup(<ChatProvider value={chat}><StatusProvider value={status}>
    <RouterProvider router={router} />
  </StatusProvider></ChatProvider>)
}
