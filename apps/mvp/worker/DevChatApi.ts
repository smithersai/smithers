import * as Cloudflare from "alchemy/Cloudflare"
import type * as Actor from "./Actor.ts"
import { program, props } from "./ChatApi.ts"
import type { Signed } from "./SignIn.ts"

// ChatApi under `alchemy dev` (alchemy.run.ts picks it only then): the same program with real sign-in once the GitHub
// App's client id and secret are in the environment, and until then a local developer signed in as an Admin, so the
// browser's agent can call the model endpoint on a laptop (docs/features/sign-in.md#local-development). It keeps
// `/web … tab` links to the dev machine's own `http://localhost` pages (docs/features/web-pages.md), and turns spend
// alerts off, since a laptop's runs and the end-to-end tests spend all day (`MODEL_SPEND_ALERTS=true` turns them back
// on; docs/features/spend-alerts.md), and lets an alert provider pointed at a local fake (`ALERT_EMAIL_API_URL`,
// `ALERT_TELEGRAM_API_URL`) send without its key (docs/features/spend-alerts.md#channels). The deployment's own model
// answers here unless `HOSTED_MODEL_ENABLED=false` (decision 0099), so a laptop and the scripted end-to-end tests
// answer without a key of their own. Production bundles worker/ChatApi.ts, which never imports this file.

/** The local developer: a person with the Admin role. */
export const localDeveloper: Actor.Actor = {
  subject: { kind: "person", id: "local-developer" },
  role: "admin",
  login: "local-developer",
}

const fallback: Signed = { actor: localDeveloper, login: "local-developer" }

/**
 * Local development's second person, a Member: a browser with the cookie `smithers_dev_person=teammate` is them, so
 * the end-to-end tests run two people on one laptop (docs/features/notifications.md#tests).
 */
export const localTeammate: Actor.Actor = {
  subject: { kind: "person", id: "local-teammate" },
  role: "member",
  login: "local-teammate",
}

/**
 * Local development's Guest (GitHub read): `smithers_dev_person=guest`. A branch opens to them only when it is shared
 * with them by name, and only to view (docs/features/branch-workspace.md#sharing).
 */
export const localGuest: Actor.Actor = {
  subject: { kind: "person", id: "local-guest" },
  role: "guest",
  login: "local-guest",
}

/**
 * Local development's Maintainer: `smithers_dev_person=maintainer`. The home of the dev server's `GITHUB_REPOSITORY`,
 * the one repository local development's people hold their roles on, shows them the Maintainers' sections
 * (docs/features/home.md#who-sees-what).
 */
export const localMaintainer: Actor.Actor = {
  subject: { kind: "person", id: "local-maintainer" },
  role: "maintainer",
  login: "local-maintainer",
}

const teammates: Readonly<Record<string, Signed>> = {
  teammate: { actor: localTeammate, login: "local-teammate" },
  guest: { actor: localGuest, login: "local-guest" },
  maintainer: { actor: localMaintainer, login: "local-maintainer" },
}

export default class DevChatApi extends Cloudflare.Worker<DevChatApi>()(
  "ChatApi",
  { ...props, main: "worker/DevChatApi.ts" },
  program({ fallback, teammates, localHttp: true, spendAlerts: false, dev: true, hostedModel: true }),
) {}
