import type { ReactNode } from "react"
import { ChatProvider } from "./AppContext"
import type { AttentionView } from "./features/attention/attention"
import { AttentionProvider } from "./features/attention/components/AttentionContext"
import type { AuthView } from "./features/auth/auth"
import { AuthProvider } from "./features/auth/components/AuthContext"
import type { BranchView } from "./features/branch/branch"
import { BranchProvider } from "./features/branch/components/BranchContext"
import type { ChatView } from "./features/chat/chat"
import type { CodeIntelView } from "./features/code-intel/codeIntel"
import { CodeIntelProvider } from "./features/code-intel/components/CodeIntelContext"
import type { CommandsView } from "./features/commands/commands"
import { CommandsProvider } from "./features/commands/components/CommandsContext"
import { DocsProvider } from "./features/docs/components/DocsContext"
import type { DocsView } from "./features/docs/docs"
import { DomainsProvider } from "./features/domains/components/DomainsContext"
import type { DomainsView } from "./features/domains/domains"
import { FilesProvider } from "./features/files/components/FilesContext"
import type { FilesView } from "./features/files/files"
import { FirstRunProvider } from "./features/first-run/components/FirstRunContext"
import type { FirstRunView } from "./features/first-run/firstRun"
import { FlowsUiProvider } from "./features/flows-ui/components/FlowsUiContext"
import type { FlowsUiView } from "./features/flows-ui/flowsUi"
import { HomeProvider } from "./features/home/components/HomeContext"
import type { HomeView } from "./features/home/home"
import { IssuesProvider } from "./features/issues/components/IssuesContext"
import type { IssuesLayer } from "./features/issues/issues"
import { PersonalModelProvider } from "./features/personal-model/components/PersonalModelContext"
import type { PersonalModelView } from "./features/personal-model/personalModel"
import { PullsProvider } from "./features/pulls/components/PullsContext"
import type { PullsLayer } from "./features/pulls/pulls"
import { RepoProvider } from "./features/repo/components/RepoContext"
import type { RepoView } from "./features/repo/repo"
import { RunsProvider } from "./features/runs/components/RunsContext"
import type { RunsView } from "./features/runs/runs"
import { SecretsProvider } from "./features/secrets/components/SecretsContext"
import type { SecretsLayer } from "./features/secrets/secrets"
import { SpendProvider } from "./features/spend/components/SpendContext"
import type { SpendView } from "./features/spend/spend"
import { StatusProvider } from "./features/status/components/StatusContext"
import type { StatusView } from "./features/status/status"
import { TerminalProvider } from "./features/terminal/components/TerminalContext"
import type { TerminalView } from "./features/terminal/terminal"
import { ThemeProvider } from "./features/theme/components/ThemeButton"
import type { ThemeView } from "./features/theme/theme"
import { TodosProvider } from "./features/todos/components/TodosContext"
import type { TodosView } from "./features/todos/todos"
import { TranscriptProvider } from "./features/transcript/components/TranscriptContext"
import type { TranscriptView } from "./features/transcript/transcript"
import { ViewsProvider } from "./features/views/components/ViewsContext"
import type { ViewsView } from "./features/views/views"
import { WebProvider } from "./features/web/components/WebContext"
import type { WebView } from "./features/web/web"
import { PluginsProvider } from "./plugins/components/PluginsContext"
import type { PluginsView } from "./plugins/ui"

/** Every layer the page's React tree reads: what the boot program hands the page (src/boot.ts `render`). */
export interface AppViews {
  readonly chat: ChatView
  readonly auth: AuthView
  readonly theme: ThemeView
  readonly repo: RepoView
  readonly commands: CommandsView
  readonly views: ViewsView
  readonly web: WebView
  readonly status: StatusView
  readonly branch: BranchView
  readonly terminal: TerminalView
  readonly transcript: TranscriptView
  readonly issues: IssuesLayer
  readonly runs: RunsView
  readonly flows: FlowsUiView
  readonly home: HomeView
  readonly spend: SpendView
  readonly attention: AttentionView
  readonly todos: TodosView
  readonly codeIntel: CodeIntelView
  readonly pulls: PullsLayer
  readonly plugins: PluginsView
  readonly files: FilesView
  readonly secrets: SecretsLayer
  readonly docs: DocsView
  readonly domains: DomainsView
  readonly personalModel: PersonalModelView
  readonly firstRun: FirstRunView
}

/**
 * The one provider tree, for the page (src/main.tsx) and for a view test: a test that hand-builds a part of it goes
 * stale when a component reads one more context, and a throw under the router's Suspense renders nothing.
 */
export function AppProviders({ views: app, children }: { readonly views: AppViews; readonly children: ReactNode }) {
  return (
    <ChatProvider value={app.chat}>
      <AuthProvider value={app.auth}>
        <ThemeProvider value={app.theme}>
          <RepoProvider value={app.repo}>
            <FilesProvider value={app.files}>
              <CodeIntelProvider value={app.codeIntel}>
                <CommandsProvider value={app.commands}>
                  <ViewsProvider value={app.views}>
                    <WebProvider value={app.web}>
                      <StatusProvider value={app.status}>
                        <SpendProvider value={app.spend}>
                          <DomainsProvider value={app.domains}>
                            <PersonalModelProvider value={app.personalModel}>
                              <FirstRunProvider value={app.firstRun}>
                                <BranchProvider value={app.branch}>
                                  <TerminalProvider value={app.terminal}>
                                    <IssuesProvider value={app.issues}>
                                      <PullsProvider value={app.pulls}>
                                        <SecretsProvider value={app.secrets}>
                                          <TodosProvider value={app.todos}>
                                            <RunsProvider value={app.runs}>
                                              <TranscriptProvider value={app.transcript}>
                                                <FlowsUiProvider value={app.flows}>
                                                  <HomeProvider value={app.home}>
                                                    <DocsProvider value={app.docs}>
                                                      {/* The one toast stack reads the feed (decision 0009). */}
                                                      <AttentionProvider value={app.attention}>
                                                        {/* The plugin host: its slots in the shell, its views' routes (src/plugins/). */}
                                                        <PluginsProvider value={app.plugins}>{children}</PluginsProvider>
                                                      </AttentionProvider>
                                                    </DocsProvider>
                                                  </HomeProvider>
                                                </FlowsUiProvider>
                                              </TranscriptProvider>
                                            </RunsProvider>
                                          </TodosProvider>
                                        </SecretsProvider>
                                      </PullsProvider>
                                    </IssuesProvider>
                                  </TerminalProvider>
                                </BranchProvider>
                              </FirstRunProvider>
                            </PersonalModelProvider>
                          </DomainsProvider>
                        </SpendProvider>
                      </StatusProvider>
                    </WebProvider>
                  </ViewsProvider>
                </CommandsProvider>
              </CodeIntelProvider>
            </FilesProvider>
          </RepoProvider>
        </ThemeProvider>
      </AuthProvider>
    </ChatProvider>
  )
}
