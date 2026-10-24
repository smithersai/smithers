import { FilesProvider } from "../../features/files/components/FilesContext"
import { createElement, type ComponentProps, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RouterProvider } from "@tanstack/react-router"
import { ChatProvider } from "../../AppContext"
import { AttentionProvider } from "../../features/attention/components/AttentionContext"
import { AuthProvider } from "../../features/auth/components/AuthContext"
import { BranchProvider } from "../../features/branch/components/BranchContext"
import { BranchHeader } from "../../features/branch/components/BranchHeader"
import { CodeIntelProvider } from "../../features/code-intel/components/CodeIntelContext"
import { CommandsProvider } from "../../features/commands/components/CommandsContext"
import { PersonalModelProvider } from "../../features/personal-model/components/PersonalModelContext"
import { RepoProvider } from "../../features/repo/components/RepoContext"
import { SpendProvider } from "../../features/spend/components/SpendContext"
import { StatusProvider } from "../../features/status/components/StatusContext"
import { TerminalProvider } from "../../features/terminal/components/TerminalContext"
import { ThemeProvider } from "../../features/theme/components/ThemeButton"
import { TodosProvider } from "../../features/todos/components/TodosContext"

type Services = {
  files: ComponentProps<typeof FilesProvider>["value"]
  todos: ComponentProps<typeof TodosProvider>["value"]
  chat: ComponentProps<typeof ChatProvider>["value"]
  auth: ComponentProps<typeof AuthProvider>["value"]
  repo: ComponentProps<typeof RepoProvider>["value"]
  branch: ComponentProps<typeof BranchProvider>["value"]
  intel: ComponentProps<typeof CodeIntelProvider>["value"]
  status: ComponentProps<typeof StatusProvider>["value"]
  commands: ComponentProps<typeof CommandsProvider>["value"]
  theme: ComponentProps<typeof ThemeProvider>["value"]
  terminal: ComponentProps<typeof TerminalProvider>["value"]
  attention: ComponentProps<typeof AttentionProvider>["value"]
  spend: ComponentProps<typeof SpendProvider>["value"]
  personalModel: ComponentProps<typeof PersonalModelProvider>["value"]
}
export const wrapBranch = ({ files, chat, auth, repo, branch, intel, status, commands, theme, terminal, attention, spend, personalModel, todos }: Services) => (child: ReactNode) => createElement(ChatProvider, { value: chat },
    createElement(AuthProvider, { value: auth },
      createElement(RepoProvider, { value: repo },
        createElement(BranchProvider, { value: branch },
          createElement(CodeIntelProvider, { value: intel },
            createElement(StatusProvider, { value: status },
              createElement(CommandsProvider, { value: commands },
                createElement(ThemeProvider, { value: theme },
                  createElement(TerminalProvider, { value: terminal },
                    createElement(AttentionProvider, { value: attention },
                      createElement(SpendProvider, { value: spend }, createElement(PersonalModelProvider, { value: personalModel }, createElement(FilesProvider, { value: files }, createElement(TodosProvider, { value: todos }, child))))))))))))))

export const branchRenderer = (services: Services) => (router: ComponentProps<typeof RouterProvider>["router"]) =>
  renderToStaticMarkup(wrapBranch(services)(createElement(RouterProvider, { router })))
export const DeniedBranchHeader = () => createElement(BranchHeader, { access: "none" })
