import type { FlowsUi } from "../../src/features/flows-ui/flowsUi"
import { FlowsUiProvider } from "../../src/features/flows-ui/components/FlowsUiContext"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RouterProvider } from "@tanstack/react-router"
import type { Auth } from "../../src/features/auth/auth"
import { AuthProvider } from "../../src/features/auth/components/AuthContext"
import type { Repo } from "../../src/features/repo/repo"
import { RepoProvider } from "../../src/features/repo/components/RepoContext"
import type { Home } from "../../src/features/home/home"
import { HomeProvider } from "../../src/features/home/components/HomeContext"
import type { Issues } from "../../src/features/issues/issues"
import { IssuesProvider } from "../../src/features/issues/components/IssuesContext"
import type { Todos } from "../../src/features/todos/todos"
import { TodosProvider } from "../../src/features/todos/components/TodosContext"
import type { Pulls } from "../../src/features/pulls/pulls"
import { PullsProvider } from "../../src/features/pulls/components/PullsContext"
import type { Runs } from "../../src/features/runs/runs"
import { RunsProvider } from "../../src/features/runs/components/RunsContext"
import type { Secrets } from "../../src/features/secrets/secrets"
import { SecretsProvider } from "../../src/features/secrets/components/SecretsContext"
import type { Attention } from "../../src/features/attention/attention"
import { AttentionProvider } from "../../src/features/attention/components/AttentionContext"
import type { Chat } from "../../src/features/chat/chat"
import { ChatProvider } from "../../src/AppContext"
import type { Spend } from "../../src/features/spend/spend"
import { SpendProvider } from "../../src/features/spend/components/SpendContext"
import type { Views } from "../../src/features/views/views"
import { ViewsProvider } from "../../src/features/views/components/ViewsContext"
export type Services = {
  flows: FlowsUi["Service"]
  auth: Auth["Service"]
  repo: Repo["Service"]
  home: Home["Service"]
  issues: Issues["Service"]
  todos: Todos["Service"]
  pulls: Pulls["Service"]
  runs: Runs["Service"]
  secrets: Secrets["Service"]
  attention: Attention["Service"]
  chat: Chat["Service"]
  spend: Spend["Service"]
  views: Views["Service"]
}
export const renderRepositoryPages = (router: Parameters<typeof RouterProvider>[0]["router"], services: Services) => {
  let tree: ReactNode = createElement(RouterProvider, { router })
  tree = createElement(ChatProvider, { value: services.chat }, tree)
  tree = createElement(SpendProvider, { value: services.spend }, tree)
  tree = createElement(ViewsProvider, { value: services.views }, tree)
  tree = createElement(AttentionProvider, { value: services.attention }, tree)
  tree = createElement(SecretsProvider, { value: services.secrets }, tree)
  tree = createElement(RunsProvider, { value: services.runs }, tree)
  tree = createElement(PullsProvider, { value: services.pulls }, tree)
  tree = createElement(TodosProvider, { value: services.todos }, tree)
  tree = createElement(IssuesProvider, { value: services.issues }, tree)
  tree = createElement(HomeProvider, { value: services.home }, tree)
  tree = createElement(RepoProvider, { value: services.repo }, tree)
  tree = createElement(AuthProvider, { value: services.auth }, tree)
  tree = createElement(FlowsUiProvider, { value: services.flows }, tree)
  return renderToStaticMarkup(tree)
}
