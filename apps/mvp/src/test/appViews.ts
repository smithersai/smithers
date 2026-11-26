import { Effect } from "effect"
import type { AppViews } from "../AppProviders"
import { Attention } from "../features/attention/attention"
import { Auth } from "../features/auth/auth"
import { Branch } from "../features/branch/branch.vibe"
import { Chat } from "../features/chat/chat"
import { CodeIntel } from "../features/code-intel/codeIntel.vibe"
import { Commands } from "../features/commands/commands"
import { Docs } from "../features/docs/docs.vibe"
import { Domains } from "../features/domains/domains.vibe"
import { Files } from "../features/files/files.vibe"
import { FirstRun } from "../features/first-run/firstRun.vibe"
import { FlowsUi } from "../features/flows-ui/flowsUi.vibe"
import { Home } from "../features/home/home.vibe"
import { Issues } from "../features/issues/issues.vibe"
import { PersonalModel } from "../features/personal-model/personalModel.vibe"
import { Pulls } from "../features/pulls/pulls"
import { Repo } from "../features/repo/repo"
import { Runs } from "../features/runs/runs.vibe"
import { Secrets } from "../features/secrets/secrets.vibe"
import { Spend } from "../features/spend/spend.vibe"
import { Status } from "../features/status/status"
import { Terminal } from "../features/terminal/terminal.vibe"
import { Theme } from "../features/theme/theme.vibe"
import { Todos } from "../features/todos/todos.vibe"
import { Transcript } from "../features/transcript/transcript.vibe"
import { Views } from "../features/views/views"
import { Web } from "../features/web/web.vibe"
import { PluginsUi } from "../plugins/ui"
import { Mcp } from "../features/mcp/store.vibe"
import { Profile } from "../features/profile/profile.vibe"

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
  mcp: Effect.service(Mcp),
  profile: Effect.service(Profile),
}) satisfies Effect.Effect<AppViews, never, any>
