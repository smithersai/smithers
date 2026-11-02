import { Effect } from "effect"
import type { AppViews } from "../AppProviders"
import { Attention } from "../features/attention/attention"
import { Auth } from "../features/auth/auth"
import { Branch } from "../features/branch/branch"
import { Chat } from "../features/chat/chat"
import { CodeIntel } from "../features/code-intel/codeIntel"
import { Commands } from "../features/commands/commands"
import { Docs } from "../features/docs/docs"
import { Domains } from "../features/domains/domains"
import { Files } from "../features/files/files"
import { FirstRun } from "../features/first-run/firstRun"
import { FlowsUi } from "../features/flows-ui/flowsUi"
import { Home } from "../features/home/home"
import { Issues } from "../features/issues/issues"
import { PersonalModel } from "../features/personal-model/personalModel"
import { Pulls } from "../features/pulls/pulls"
import { Repo } from "../features/repo/repo"
import { Runs } from "../features/runs/runs"
import { Secrets } from "../features/secrets/secrets"
import { Spend } from "../features/spend/spend"
import { Status } from "../features/status/status"
import { Terminal } from "../features/terminal/terminal"
import { Theme } from "../features/theme/theme"
import { Todos } from "../features/todos/todos"
import { Transcript } from "../features/transcript/transcript"
import { Views } from "../features/views/views"
import { Web } from "../features/web/web"
import { PluginsUi } from "../plugins/ui"

/** Every view of a test app, as `AppProviders` takes them. */
export const appViews = Effect.all({
  chat: Effect.service(Chat),
  auth: Effect.service(Auth),
  theme: Effect.service(Theme),
  repo: Effect.service(Repo),
  commands: Effect.service(Commands),
  views: Effect.service(Views),
  web: Effect.service(Web),
  status: Effect.service(Status),
  branch: Effect.service(Branch),
  terminal: Effect.service(Terminal),
  transcript: Effect.service(Transcript),
  issues: Effect.service(Issues),
  runs: Effect.service(Runs),
  flows: Effect.service(FlowsUi),
  home: Effect.service(Home),
  spend: Effect.service(Spend),
  attention: Effect.service(Attention),
  todos: Effect.service(Todos),
  codeIntel: Effect.service(CodeIntel),
  pulls: Effect.service(Pulls),
  plugins: Effect.service(PluginsUi),
  files: Effect.service(Files),
  secrets: Effect.service(Secrets),
  docs: Effect.service(Docs),
  domains: Effect.service(Domains),
  personalModel: Effect.service(PersonalModel),
  firstRun: Effect.service(FirstRun),
}) satisfies Effect.Effect<AppViews, never, any>
