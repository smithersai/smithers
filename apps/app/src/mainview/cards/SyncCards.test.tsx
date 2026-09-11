import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, jest, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { pillStatus } from "./CardRenderers"
import { ControllerTestProvider } from "../ControllerContext"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { IssueCardBody } from "./IssueCards"
import { RepoImportCardBody } from "./RepoImportCard"
import { ConnectorSetupCardBody, endpointLabel, rateLimitHeldUntil, SyncOpsCardBody } from "./SyncCards"

/*
 * The lane-sync cards (ADR 0005): the Linear wizard renders its steps, the
 * team pick, the repository pick, and the Connect act; the SAME card turned
 * connected offers Sync now / Activity / Disconnect; the GitHub card offers
 * the install and reconcile acts; the sync-ops card renders a run's live
 * state and counts, one row per op (with the wire's own status word, the
 * age, the verbatim error and Retry on a failure), the mirror's per-ref
 * rows and its `mirror_status` header word, and the ADR's rate-limit line.
 * Every act rides onRunCommand with a complete invocation.
 *
 * The states below are ADR 0005's own list: authorizing, active, a failed op
 * with Retry, an expired key, importing with counts, a failed import with
 * Retry, and rate-limited with a disabled Retry.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

type SetupPayload = Extract<Card, { kind: "connector-setup" }>["payload"]
type SyncOpsPayload = Extract<Card, { kind: "sync-ops" }>["payload"]

const setupCard = (overrides: Partial<SetupPayload> = {}): Extract<Card, { kind: "connector-setup" }> => ({
  id: "connector-setup-linear-will/smithers",
  kind: "connector-setup",
  title: "Connect Linear · will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    connector: "linear",
    repo: "will/smithers",
    phase: "setup",
    steps: [
      { id: "authorize", label: "Authorize in your browser", state: "done", detail: "authorized as Will" },
      { id: "team", label: "Team", state: "active", detail: null },
      { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
      { id: "confirm", label: "Confirm", state: "pending", detail: null }
    ],
    teams: [
      { id: "team-eng", name: "Engineering", key: "ENG" },
      { id: "team-design", name: "Design", key: "DES" }
    ],
    ...overrides
  }
})

const syncOpsCard = (overrides: Partial<SyncOpsPayload> = {}): Extract<Card, { kind: "sync-ops" }> => ({
  id: "sync-ops-linear-7",
  kind: "sync-ops",
  title: "Sync · Linear ENG ↔ will/smithers",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    subject: "Linear ENG ↔ will/smithers",
    source: "linear",
    integrationId: "7",
    repo: "will/smithers",
    runState: null,
    ops: [],
    ...overrides
  }
})

const render = (node: React.ReactNode) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<>{node}</>)
  })
  return { host, commands }
}

const renderSetup = (
  card: Extract<Card, { kind: "connector-setup" }>,
  controller?: AppController
) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  const body = <ConnectorSetupCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
  flushSync(() => {
    createRoot(host).render(
      controller === undefined ? body : <ControllerTestProvider controller={controller}>{body}</ControllerTestProvider>
    )
  })
  return { host, commands }
}

const buttonNamed = (host: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))
  if (button === undefined) throw new Error(`no button named ${text}`)
  return button
}

const click = (host: HTMLElement, text: string): void => {
  flushSync(() => buttonNamed(host, text).click())
}

/** An ISO stamp a number of minutes from now — the rate-limit line reads against the real clock. */
const minutesFromNow = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()

const renderWith = (controller: AppController, node: React.ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<ControllerTestProvider controller={controller}>{node}</ControllerTestProvider>)
  })
  return host
}

const controllerWithRepositories = async (): Promise<AppController> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null },
      { id: "acme/flows", org: "acme", ownerKind: "org", name: "flows", head: null }
    ]
  })
  return createAppController(store, unavailableRepositories, silentAgent, {
    fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } })
  })
}

describe("ConnectorSetupCardBody — the Linear wizard", () => {
  test("the steps render; the active team step lists the teams one click each", () => {
    const { host, commands } = renderSetup(setupCard())

    expect(host.textContent).toContain("Authorize in your browser")
    expect(host.textContent).toContain("authorized as Will")
    click(host, "ENG · Engineering")
    expect(commands).toEqual([{ name: "linear.connect.team", args: "team-eng will/smithers" }])
  })

  test("the authorize step's Open Linear runs the handoff act", () => {
    const { host, commands } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "active", detail: null },
          { id: "team", label: "Team", state: "pending", detail: null },
          { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ],
        teams: undefined
      })
    )

    click(host, "Open Linear")
    expect(commands).toEqual([{ name: "linear.connect.open", args: "will/smithers" }])
  })

  test("ADR 0005 authorizing: step 1 is the only act, and no later step claims anything", () => {
    const { host, commands } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "active", detail: null },
          { id: "team", label: "Team", state: "pending", detail: null },
          { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ],
        teams: undefined
      })
    )

    /* The card wears the running pill while the browser step is out. */
    expect(pillStatus(setupCard({ phase: "setup" }))).toBe("running")
    expect(host.textContent).toContain("Authorize in your browser")
    /* No team list, no repository pick, no Connect — nothing is offered before its step. */
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      expect.stringContaining("Open Linear")
    ])
    click(host, "Open Linear")
    expect(commands).toEqual([{ name: "linear.connect.open", args: "will/smithers" }])
  })

  test("ADR 0005 expired key: the wording rides step 1 and Open Linear is still the act", () => {
    const { host, commands } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "error", detail: null, error: "authorization expired · Open Linear again" },
          { id: "team", label: "Team", state: "pending", detail: null },
          { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ],
        teams: undefined
      })
    )

    expect(host.textContent).toContain("authorization expired · Open Linear again")
    click(host, "Open Linear")
    expect(commands).toEqual([{ name: "linear.connect.open", args: "will/smithers" }])
  })

  test("a failed step renders the server error verbatim", () => {
    const { host } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "error", detail: null, error: "Reading /linear/setup failed (404)" },
          { id: "team", label: "Team", state: "pending", detail: null },
          { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ]
      })
    )

    expect(host.textContent).toContain("Reading /linear/setup failed (404)")
  })

  test("the repository pick lists the loaded repositories", async () => {
    const controller = await controllerWithRepositories()
    const { host, commands } = renderSetup(
      setupCard({
        steps: [
          { id: "authorize", label: "Authorize in your browser", state: "done", detail: "authorized" },
          { id: "team", label: "Team", state: "done", detail: "ENG · Engineering" },
          { id: "repository", label: "Repository", state: "active", detail: "will/smithers" },
          { id: "confirm", label: "Confirm", state: "pending", detail: null }
        ],
        teamId: "team-eng"
      }),
      controller
    )

    click(host, "acme/flows")
    expect(commands).toEqual([{ name: "linear.connect.repo", args: "will/smithers acme/flows" }])
  })

  test("authorized step and team picked render Connect without a setup handle", () => {
    const { host, commands } = renderSetup(setupCard({ teamId: "team-eng" }))

    click(host, "Connect")
    expect(commands).toEqual([{ name: "linear.connect.confirm", args: "will/smithers" }])
  })

  test("the connected state offers Sync now, Activity, and Disconnect", () => {
    const { host, commands } = renderSetup(
      setupCard({
        phase: "connected",
        integration: { id: 7, teamKey: "ENG", teamName: "Engineering", active: true, lastSyncAt: null }
      })
    )

    expect(host.textContent).toContain("ENG · Engineering → will/smithers")
    click(host, "Sync now")
    click(host, "Activity")
    expect(commands).toEqual([
      { name: "linear.sync", args: "7" },
      { name: "linear.activity", args: "7" }
    ])
  })

  test("the connected state names the Linear account the integration authorized as (plue#491)", () => {
    const { host } = renderSetup(
      setupCard({
        phase: "connected",
        actor: "Will",
        integration: { id: 7, teamKey: "ENG", teamName: "Engineering", active: true, lastSyncAt: null }
      })
    )

    expect(host.textContent).toContain("authorized as Will")
  })

  test("a connected card whose wire named no actor says nothing about one", () => {
    const { host } = renderSetup(
      setupCard({
        phase: "connected",
        actor: null,
        integration: { id: 7, teamKey: "ENG", teamName: "Engineering", active: true, lastSyncAt: null }
      })
    )

    expect(host.textContent).not.toContain("authorized as")
  })

  test("Disconnect arms a confirm row; only its second click runs the flow, with the team key typed back", () => {
    /*
     * Review finding 4: one click on a ghost button deleted the integration.
     * The card-level confirm is the workspace card's rule — the act itself
     * carries the team key as its own input, so a slash cannot skip it either.
     */
    const { host, commands } = renderSetup(
      setupCard({
        phase: "connected",
        integration: { id: 7, teamKey: "ENG", teamName: "Engineering", active: true, lastSyncAt: null }
      })
    )

    expect(host.textContent).not.toContain("Disconnect Linear ENG from will/smithers?")
    click(host, "Disconnect")
    expect(commands).toEqual([])
    expect(host.textContent).toContain("Disconnect Linear ENG from will/smithers?")

    click(host, "Disconnect ENG")
    expect(commands).toEqual([{ name: "linear.disconnect", args: "7 ENG" }])
  })
})

describe("the frame pill of a sync-ops card", () => {
  test("a null run state (nothing has answered yet) is never done, and a wire word is never renamed", () => {
    /* Review finding 3: null fell into "done", so a sync that had just started wore a finished pill. */
    expect(pillStatus(syncOpsCard({ runState: null, trigger: "sync started · run 41" }))).toBe("pending")
    /* Every word below is one of plue's own CHECK values, Linear's and the mirror's. */
    expect(pillStatus(syncOpsCard({ runState: "pending" }))).toBe("pending")
    expect(pillStatus(syncOpsCard({ runState: "running" }))).toBe("running")
    expect(pillStatus(syncOpsCard({ runState: "completed" }))).toBe("completed")
    expect(pillStatus(syncOpsCard({ runState: "queued" }))).toBe("queued")
    expect(pillStatus(syncOpsCard({ runState: "succeeded" }))).toBe("succeeded")
    expect(pillStatus(syncOpsCard({ runState: "failed" }))).toBe("failed")
    expect(pillStatus(syncOpsCard({ runState: null, error: "Starting the sync failed (500)" }))).toBe("failed")
  })
})

describe("IssueCardBody — the Linear link (lane sync)", () => {
  const issueCard = (url: string): Extract<Card, { kind: "issue" }> => ({
    id: "issue-will/smithers-90",
    kind: "issue",
    title: "#90",
    status: "acted",
    createdAt: 0,
    ordinal: 0,
    payload: {
      repo: "will/smithers",
      number: 90,
      title: "Flaky test",
      state: "open",
      author: "ana",
      issueBody: "",
      labels: [],
      comments: [],
      linear: { identifier: "ENG-482", url }
    }
  })

  /** The same issue before anyone linked it: the DTO carries no mapping, so the card offers the act instead. */
  const unlinkedCard = (): Extract<Card, { kind: "issue" }> => {
    const { payload, ...rest } = issueCard("https://linear.app/acme/issue/ENG-482/flaky")
    const { linear: _linear, ...unlinked } = payload
    return { ...rest, payload: unlinked }
  }

  test("an https linear.app URL off the DTO is the link; any other scheme or host renders the identifier as text", async () => {
    /* Review finding 10: the href was rendered straight off the DTO while the install URL was origin-vetted. */
    const controller = await controllerWithRepositories()
    const linked = renderWith(controller, <IssueCardBody card={issueCard("https://linear.app/acme/issue/ENG-482/flaky")} onRunCommand={() => {}} />)
    expect(linked.querySelector("a")?.getAttribute("href")).toBe("https://linear.app/acme/issue/ENG-482/flaky")
    expect(linked.textContent).toContain("Linear ENG-482")

    for (const hostile of ["javascript:alert(1)", "http://linear.app/acme/issue/ENG-482", "https://linear.app.evil.example/x", "not a url"]) {
      const host = renderWith(controller, <IssueCardBody card={issueCard(hostile)} onRunCommand={() => {}} />)
      expect(host.querySelector("a")).toBeNull()
      expect(host.textContent).toContain("Linear ENG-482")
    }
  })

  test("Link to Linear is the button door of issues.link-linear: it rides onRunCommand and the body needs no controller", () => {
    /*
     * Review finding ui-cards-tabs/maintainability/6: the button carried
     * data-flow="issues.link-linear" while calling controller.changeDraft, so
     * the file's own header promise (every act rides onRunCommand) was false
     * and the act never ran the flow it named. Rendered bare here: a reach
     * back for the controller throws out of useController.
     */
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(<IssueCardBody card={unlinkedCard()} onRunCommand={(name, args) => commands.push({ name, args })} />)
    const button = buttonNamed(host, "Link to Linear")
    expect(button.getAttribute("data-flow")).toBe("issues.link-linear")
    flushSync(() => button.click())
    /* Only the number is carried: the identifier is the field THE FORM LAW renders, prefilled with what the button gave. */
    expect(commands).toEqual([{ name: "issues.link-linear", args: "90" }])
  })
})

describe("ConnectorSetupCardBody — the GitHub card", () => {
  test("not installed offers Open GitHub and Re-check; installed offers Reconcile", () => {
    const missing = renderSetup(
      setupCard({
        connector: "github",
        phase: "setup",
        steps: [],
        installUrl: "https://github.com/apps/smithers/installations/new"
      })
    )
    expect(missing.host.textContent).toContain("The Smithers GitHub App is not installed")
    click(missing.host, "Open GitHub")
    click(missing.host, "Re-check")
    expect(missing.commands).toEqual([
      { name: "github.app.open", args: "will/smithers" },
      { name: "github.app", args: "will/smithers" }
    ])

    const installed = renderSetup(
      setupCard({ connector: "github", phase: "connected", steps: [], installationId: 5511, configured: true })
    )
    expect(installed.host.textContent).toContain("installation 5511 · configured")
    click(installed.host, "Reconcile")
    expect(installed.commands).toEqual([{ name: "github.reconcile", args: "will/smithers" }])
  })

  test("the rate-limit line follows the ADR: a reset ahead reads as time ahead, never as an age", () => {
    /* Review finding 2: the age label clamped a future reset to "resets just now". */
    const ahead = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(12) } })
    )
    expect(ahead.host.textContent).toContain("GitHub rate limit reached · 0 of 5,000 · resets in 12 min · Retry after")
    expect(ahead.host.textContent).not.toContain("just now")

    const later = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(90) } })
    )
    expect(later.host.textContent).toMatch(/resets at \d{1,2}:\d{2}/)

    const behind = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(-4) } })
    )
    expect(behind.host.textContent).toContain("reset 4 min ago")
  })

  test("a refused call holds Re-check and Reconcile until the reset, with the time on them", () => {
    /* Review finding 5: every retry stayed clickable through the window, re-posting and re-failing. */
    const resetAt = minutesFromNow(12)
    const held = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt }, error: "GitHub rate limit exhausted" })
    )
    const clock = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const recheck = buttonNamed(held.host, "Re-check")
    const reconcile = buttonNamed(held.host, "Reconcile")
    expect(recheck.disabled).toBe(true)
    expect(reconcile.disabled).toBe(true)
    expect(recheck.textContent).toContain(`Re-check after ${clock}`)
    expect(reconcile.textContent).toContain(`Reconcile after ${clock}`)
    flushSync(() => recheck.click())
    expect(held.commands).toEqual([])

    /* A low-but-positive budget shows the line and holds nothing; a reset behind us holds nothing. */
    const low = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 40, resetAt } })
    )
    expect(buttonNamed(low.host, "Re-check").disabled).toBe(false)
    const passed = renderSetup(
      setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(-1) } })
    )
    expect(buttonNamed(passed.host, "Re-check").disabled).toBe(false)
    expect(rateLimitHeldUntil({ limit: 5000, remaining: 0, resetAt: null })).toBeNull()
  })
})

describe("rate-limit clock subscriptions", () => {
  test.each([180_000, 150_000, 30_000])("releases every mounted retry at a reset %i ms away without a store update", (remaining) => {
    jest.useFakeTimers({ now: Date.parse("2026-09-06T12:00:00Z") })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const rateLimit = { limit: 5000, remaining: 0, resetAt: new Date(Date.now() + remaining).toISOString() }
    try {
      flushSync(() => root.render(
        <>
          <ConnectorSetupCardBody card={setupCard({ connector: "github", steps: [], rateLimit })} onRunCommand={() => {}} />
          <RepoImportCardBody
            card={{
              id: "repo-import-will/flows",
              kind: "repo-import",
              title: "Import · will/flows",
              status: "error",
              createdAt: 0,
              ordinal: 0,
              payload: { repo: "will/flows", jobId: null, phase: "failed", detail: "GitHub rate limit exhausted", rateLimit }
            }}
            onRunCommand={() => {}}
          />
        </>
      ))
      const buttons = ["Re-check", "Reconcile", "Try again"].map((name) => buttonNamed(host, name))
      const expectCountdown = (label: string) => {
        expect([...host.querySelectorAll("p")].filter((line) => line.textContent?.includes(label))).toHaveLength(2)
        expect(buttons.map((button) => button.disabled)).toEqual([true, true, true])
      }
      expectCountdown(remaining < 60_000 ? "resets in under a minute" : `resets in ${Math.ceil(remaining / 60_000)} min`)
      let left = remaining
      while (left > 60_000) {
        const step = left % 60_000 || 60_000
        flushSync(() => jest.advanceTimersByTime(step))
        left -= step
        expectCountdown(`resets in ${left / 60_000} min`)
      }
      flushSync(() => jest.advanceTimersByTime(left - 1))
      expect(buttons.map((button) => button.disabled)).toEqual([true, true, true])
      flushSync(() => jest.advanceTimersByTime(1))
      expect(buttons.map((button) => button.disabled)).toEqual([false, false, false])
      expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Re-check", "Reconcile", "Try again"])
      expect(host.textContent).toContain("reset just now")
      expect(jest.getTimerCount()).toBe(0)
      flushSync(() => jest.advanceTimersByTime(60_000))
      expect(buttons.map((button) => button.disabled)).toEqual([false, false, false])
    } finally {
      flushSync(() => root.unmount())
      host.remove()
      jest.useRealTimers()
    }
  })

  test("unmount cancels the timer re-armed after a countdown tick", () => {
    jest.useFakeTimers({ now: Date.parse("2026-09-06T12:00:00Z") })
    const host = document.createElement("div")
    const root = createRoot(host)
    try {
      flushSync(() => root.render(
        <ConnectorSetupCardBody
          card={setupCard({ connector: "github", steps: [], rateLimit: { limit: 5000, remaining: 0, resetAt: minutesFromNow(3) } })}
          onRunCommand={() => {}}
        />
      ))
      flushSync(() => jest.advanceTimersByTime(60_000))
      expect(host.textContent).toContain("resets in 2 min")
      expect(jest.getTimerCount()).toBeGreaterThan(0)
    } finally {
      flushSync(() => root.unmount())
      const pending = jest.getTimerCount()
      jest.useRealTimers()
      expect(pending).toBe(0)
    }
  })
})

describe("RepoImportCardBody — the job card (ADR 0005 \"Import a GitHub repository\")", () => {
  const importCard = (
    payload: Partial<Extract<Card, { kind: "repo-import" }>["payload"]>
  ): Extract<Card, { kind: "repo-import" }> => ({
    id: "repo-import-acme/web",
    kind: "repo-import",
    title: "Import · acme/web",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: { repo: "acme/web", jobId: "job-1", phase: "running", detail: null, ...payload }
  })

  test("ADR 0005 importing: the counts and the raw stage word, with no act while it runs", () => {
    const { host } = render(
      <RepoImportCardBody
        card={importCard({
          phase: "running",
          detail: "Provisioning workspace…",
          stage: "provisioning_workspace",
          counts: {
            refs: { done: 214, total: 214 },
            objects: { done: 88_210, total: 91_004 },
            issues: { done: 0, total: 312 }
          }
        })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("refs 214 of 214 · objects 88210 of 91004 · issues 0 of 312")
    /* plue's own stage word, never translated into one of this app's. */
    expect(host.textContent).toContain("stage · provisioning_workspace")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("ADR 0005 failed import: the job's error verbatim, with Retry naming the job", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={importCard({
          phase: "failed",
          detail: "github: repository acme/web not found or not accessible",
          stage: "cloning_github",
          error: "github: repository acme/web not found or not accessible"
        })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).toContain("github: repository acme/web not found or not accessible")
    const retry = buttonNamed(host, "Try again")
    expect(retry.disabled).toBe(false)
    click(host, "Try again")
    expect(commands).toEqual([{ name: "repos.import.retry", args: "job-1" }])
  })

  test("a done import links the repository and the workspace it created", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={importCard({
          phase: "done",
          detail: null,
          repository: { owner: "acme", name: "web" },
          workspaceId: "ws-9"
        })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).toContain("acme/web")
    click(host, "Open the workspace")
    expect(commands).toEqual([{ name: "workspace.view", args: "ws-9" }])
  })
})

describe("RepoImportCardBody — the rate-limited retry", () => {
  test("a structured 429 holds Try again until the reset, with the time on it", () => {
    const resetAt = minutesFromNow(12)
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <RepoImportCardBody
        card={{
          id: "repo-import-will/flows",
          kind: "repo-import",
          title: "Import · will/flows",
          status: "error",
          createdAt: 0,
          ordinal: 0,
          payload: {
            repo: "will/flows",
            jobId: null,
            phase: "failed",
            detail: "GitHub rate limit exhausted",
            rateLimit: { limit: 5000, remaining: 0, resetAt }
          }
        }}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    const clock = new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const retry = buttonNamed(host, "Try again")
    expect(retry.disabled).toBe(true)
    expect(retry.textContent).toContain(`Try again after ${clock}`)
    expect(host.textContent).toContain("resets in 12 min")
    flushSync(() => retry.click())
    expect(commands).toEqual([])
  })
})

describe("SyncOpsCardBody", () => {
  test("a started run with no run DTO yet claims no state and no counts", () => {
    const { host } = render(
      <SyncOpsCardBody card={syncOpsCard({ runId: "41", trigger: "sync started · run 41" })} onRunCommand={() => {}} />
    )

    expect(host.textContent).toContain("Linear ENG ↔ will/smithers")
    expect(host.textContent).toContain("sync started · run 41")
    /* Nothing has answered yet, so nothing claims a state or a count. */
    expect(host.textContent).not.toContain("of ")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("ADR 0005 active: the live run wears the wire's own state word and its summed counts", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({
          runId: "41",
          runState: "running",
          counts: { total: 12, done: 10, failed: 1 },
          ops: [
            {
              id: "12",
              source: "linear",
              target: "smithers-cloud",
              entity: "issue",
              entityId: "ENG-482",
              action: "create",
              status: "success",
              retryable: false,
              at: new Date(Date.now() - 2_000).toISOString()
            }
          ]
        })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("Running")
    expect(host.textContent).toContain("10 of 12 · 1 failed")
    expect(host.textContent).toContain("linear → Smithers Cloud issue ENG-482 create")
    /* ADR row: "… action, age". */
    expect(host.textContent).toContain("just now")
    /* Nothing succeeded may offer a Retry. */
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("the cloud endpoint reads Smithers Cloud on screen, whichever name the wire used", () => {
    /*
     * The backend's own payloads still say `jjhub`, an internal name. The row
     * renders the product name for it and leaves every other endpoint alone.
     */
    expect(endpointLabel("jjhub")).toBe("Smithers Cloud")
    expect(endpointLabel("smithers-cloud")).toBe("Smithers Cloud")
    expect(endpointLabel("linear")).toBe("linear")
    expect(endpointLabel("github")).toBe("github")

    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({
          runState: "completed",
          ops: [
            {
              id: "77",
              source: "jjhub",
              target: "linear",
              entity: "issue",
              entityId: "77",
              action: "update",
              status: "success",
              retryable: false,
              at: null
            }
          ]
        })}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("Smithers Cloud → linear issue 77 update")
    expect(host.textContent).not.toContain("jjhub")
  })

  test("ADR 0005 failed op: the error is verbatim on the row, with Retry naming the op", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({
          runState: "completed",
          ops: [
            {
              id: "90",
              source: "smithers-cloud",
              target: "linear",
              entity: "issue",
              entityId: "90",
              action: "update",
              status: "failed",
              error: "Linear API: 422 label 'infra' does not exist on team ENG",
              retryable: true,
              at: null
            },
            {
              id: "91",
              source: "linear",
              target: "smithers-cloud",
              entity: "comment",
              entityId: "ENG-480",
              action: "create",
              status: "skipped",
              retryable: false,
              at: null
            }
          ]
        })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).toContain("Smithers Cloud → linear issue 90 update")
    expect(host.textContent).toContain("Linear API: 422 label 'infra' does not exist on team ENG")
    /* The skipped row is a state, not a failure, and it is never filtered out. */
    expect(host.textContent).toContain("Skipped")
    expect(host.querySelectorAll("button")).toHaveLength(1)
    click(host, "Retry")
    expect(commands).toEqual([{ name: "sync.retry", args: "90" }])
  })

  test("a mirror run renders one row per ref and the repository's own mirror_status word", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={{
          ...syncOpsCard(),
          id: "sync-ops-mirror-will/smithers",
          payload: {
            subject: "GitHub → will/smithers mirror",
            source: "github-mirror",
            repo: "will/smithers",
            runId: "88",
            runState: "succeeded",
            mirrorStatus: "unconfigured",
            ops: [
              {
                id: "refs/heads/main",
                source: "b775d9",
                target: "3f2a1b",
                entity: "ref",
                entityId: "refs/heads/main",
                action: "push",
                status: "succeeded",
                retryable: false,
                at: null
              }
            ]
          }
        }}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("GitHub → will/smithers mirror")
    expect(host.textContent).toContain("unconfigured")
    expect(host.textContent).toContain("b775d9 → 3f2a1b ref refs/heads/main push")
    /* plue#491 retries only a FAILED ref, so a succeeded one offers nothing. */
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })

  test("a behind mirror reads plue#491's ref counts, and a failed ref retries through the per-ref route", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const { host } = render(
      <SyncOpsCardBody
        card={{
          ...syncOpsCard(),
          id: "sync-ops-mirror-will/smithers",
          payload: {
            subject: "GitHub → will/smithers mirror",
            source: "github-mirror",
            repo: "will/smithers",
            runId: "88",
            runState: "failed",
            mirrorStatus: "behind",
            behindRefs: 3,
            failedRefs: 1,
            ops: [
              {
                id: "refs/heads/wip",
                source: "—",
                target: "aa11bb",
                entity: "ref",
                entityId: "refs/heads/wip",
                action: "push",
                status: "failed",
                error: "remote rejected: non-fast-forward",
                retryable: true,
                at: null
              }
            ]
          }
        }}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    /* ADR 0005's header line, with the count plue now states. */
    expect(host.textContent).toContain("behind GitHub · 3 refs · 1 failed")
    expect(host.textContent).toContain("remote rejected: non-fast-forward")
    /* A mirror row's Retry is the MIRROR's route, never the Linear op retry. */
    click(host, "Retry")
    expect(commands).toEqual([{ name: "github.mirror.retry-ref", args: "refs/heads/wip will/smithers" }])
  })

  test("a mirror card whose repository stated no counts shows the word alone", () => {
    const { host } = render(
      <SyncOpsCardBody
        card={{
          ...syncOpsCard(),
          id: "sync-ops-mirror-will/smithers",
          payload: {
            subject: "GitHub → will/smithers mirror",
            source: "github-mirror",
            repo: "will/smithers",
            runState: null,
            mirrorStatus: "behind",
            ops: []
          }
        }}
        onRunCommand={() => {}}
      />
    )

    expect(host.textContent).toContain("behind")
    expect(host.textContent).not.toContain("refs")
  })

  test("past the cut, Show more widens the window; older ops offer Load older", () => {
    const commands: Array<{ name: string; args?: string }> = []
    const ops = Array.from({ length: 12 }, (_, index) => ({
      id: `op-${index}`,
      source: "linear",
      target: "smithers-cloud",
      entity: "issue",
      entityId: `ENG-${index}`,
      action: "update",
      status: "success",
      retryable: false,
      at: null
    }))
    const { host } = render(
      <SyncOpsCardBody
        card={syncOpsCard({ ops, window: "24h", hasOlder: true })}
        onRunCommand={(name, args) => commands.push({ name, args })}
      />
    )

    expect(host.textContent).not.toContain("ENG-11")
    click(host, "Show more")
    click(host, "Load older")
    expect(commands).toEqual([
      { name: "sync.ops.show-more", args: "sync-ops-linear-7" },
      { name: "sync.ops.load-older", args: "sync-ops-linear-7" }
    ])
  })
})
