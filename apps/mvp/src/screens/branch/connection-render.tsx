import { SpendProvider } from "../../features/spend/components/SpendContext"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RouterProvider } from "@tanstack/react-router"
import { ChatProvider } from "../../AppContext"
import { AttentionProvider } from "../../features/attention/components/AttentionContext"
import { AuthProvider } from "../../features/auth/components/AuthContext"
import { RepoProvider } from "../../features/repo/components/RepoContext"
import { ViewsProvider } from "../../features/views/components/ViewsContext"
type Services = {
  spend: ComponentProps<typeof SpendProvider>["value"]
  auth: ComponentProps<typeof AuthProvider>["value"]
  chat: ComponentProps<typeof ChatProvider>["value"]
  repo: ComponentProps<typeof RepoProvider>["value"]
  attention: ComponentProps<typeof AttentionProvider>["value"]
  views: ComponentProps<typeof ViewsProvider>["value"]
}
export const renderConnection = (router: ComponentProps<typeof RouterProvider>["router"], { chat, repo, attention, auth, spend, views }: Services) =>
  renderToStaticMarkup(
    createElement(AuthProvider, { value: auth },
      createElement(ChatProvider, { value: chat },
        createElement(RepoProvider, { value: repo },
          createElement(AttentionProvider, { value: attention },
            createElement(SpendProvider, { value: spend },
              createElement(ViewsProvider, { value: views }, createElement(RouterProvider, { router }))))))),
  )
