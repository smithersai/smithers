import { RouterProvider } from "@tanstack/react-router"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppProviders, type AppViews } from "../../src/AppProviders"

export const renderRepositoryPages = (router: Parameters<typeof RouterProvider>[0]["router"], views: AppViews) =>
  renderToStaticMarkup(createElement(AppProviders, { views }, createElement(RouterProvider, { router })))
