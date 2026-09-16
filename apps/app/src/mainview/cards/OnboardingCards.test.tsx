import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { RepoOnboardingCardBody } from "./OnboardingCards"

/* Repository doors remain usable without introductory prose or unavailable activity. */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"

type OnboardingCard = Extract<Card, { kind: "repo-onboarding" }>

const card = (payload: OnboardingCard["payload"]): OnboardingCard => ({
  id: `repo-${payload.stage}-${REPO}`,
  kind: "repo-onboarding",
  title: `${payload.stage} · ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload
})

const render = (payload: OnboardingCard["payload"]) => {
  const ran: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<RepoOnboardingCardBody card={card(payload)} onRunCommand={(name, args) => ran.push([name, args])} />)
  })
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button[data-flow]")]
  return { host, ran, buttons }
}

describe("the welcome card", () => {
  test("omits the curated sentence and offers exactly the three doors, each carrying the repository", () => {
    const { host, ran, buttons } = render({
      stage: "welcome",
      repo: REPO,
      summary: "a durable framework that lets agents plan, run, and review changes to a code repository through flows."
    })
    expect(host.querySelector('[data-testid="onboarding-welcome"]')).toBeNull()
    expect(host.textContent).toContain("I am")
    expect(buttons().map((button) => [button.dataset.flow, button.textContent])).toEqual([
      ["repo.maintain", "maintaining this repo"],
      ["repo.contribute", "contributing to this repo"],
      ["repo.explore", "just exploring"]
    ])
    for (const button of buttons()) button.click()
    expect(ran).toEqual([["repo.maintain", REPO], ["repo.contribute", REPO], ["repo.explore", REPO]])
  })

  test("without a curated sentence it still omits prose", () => {
    const { host } = render({ stage: "welcome", repo: "acme/widgets", summary: null })
    expect(host.querySelector('[data-testid="onboarding-welcome"]')).toBeNull()
  })
})

describe("the maintain card", () => {
  test("says the route's sentence and offers the reads this host registers, in order", () => {
    const { host, ran, buttons } = render({
      stage: "maintain",
      repo: REPO,
      activity: { sentence: "3 commits, 1 pull request, and 2 issues in the last 7 days.", counts: { commits: 3, pullRequests: 1, issues: 2 }, since: "2026-08-31" },
      flows: ["issues.list", "prs.list", "runs.list", "triggers.list"]
    })
    expect(host.querySelector('[data-testid="onboarding-activity"]')?.textContent).toBe("3 commits, 1 pull request, and 2 issues in the last 7 days.")
    expect(buttons().map((button) => button.textContent)).toEqual(["view issues", "view pull requests", "view runs", "view triggers"])
    for (const button of buttons()) button.click()
    expect(ran).toEqual([
      ["issues.list", `open ${REPO}`],
      ["prs.list", REPO],
      ["runs.list", REPO],
      ["triggers.list", REPO]
    ])
  })

  test("without activity it offers only the reads", () => {
    const { host, buttons } = render({
      stage: "maintain",
      repo: REPO,
      activity: null,
      reason: "Recent activity is not available yet.",
      flows: ["issues.list", "prs.list"]
    })
    expect(host.querySelector('[data-testid="onboarding-activity"]')).toBeNull()
    expect(buttons().map((button) => button.dataset.flow)).toEqual(["issues.list", "prs.list"])
  })
})

describe("the contribute card", () => {
  test("offers the issue form, the feature sketch form, and the contributing guide", () => {
    const { ran, buttons } = render({ stage: "contribute", repo: REPO, guide: "CONTRIBUTING.md" })
    expect(buttons().map((button) => [button.dataset.flow, button.textContent])).toEqual([
      ["issues.create", "report an issue"],
      ["feature.prototype", "prototype a new feature request"],
      ["files.read", "learn more about contributing"]
    ])
    for (const button of buttons()) button.click()
    expect(ran).toEqual([["issues.create", undefined], ["feature.prototype", undefined], ["files.read", `CONTRIBUTING.md ${REPO}`]])
  })

  test("without a contributing guide it omits its door and explanatory text", () => {
    const { host, buttons } = render({ stage: "contribute", repo: REPO, guide: null, reason: "This repository has no CONTRIBUTING.md." })
    expect(buttons().map((button) => button.dataset.flow)).toEqual(["issues.create", "feature.prototype"])
    expect(host.querySelector('[data-testid="onboarding-no-guide"]')).toBeNull()
  })
})

describe("the explore card", () => {
  test("lists guide documents without explanatory prose", () => {
    const { host, ran, buttons } = render({
      stage: "explore",
      repo: REPO,
      guides: [{ path: "README.md" }, { path: "CONTRIBUTING.md" }, { path: "docs/README.md" }]
    })
    expect(host.querySelector('[data-testid="onboarding-wiki"]')).toBeNull()
    expect(host.textContent).not.toContain("Smithers has not generated a wiki for smithersai/smithers yet.")
    expect(buttons().map((button) => button.textContent)).toEqual(["README.md", "CONTRIBUTING.md", "docs/README.md"])
    buttons()[2]?.click()
    expect(ran).toEqual([["files.read", `docs/README.md ${REPO}`]])
    expect(host.querySelector('[data-testid="onboarding-ask"]')).toBeNull()
  })

  test("with no guide documents it carries the reason and no rows", () => {
    const { host, buttons } = render({ stage: "explore", repo: REPO, guides: [], reason: "The repository's files could not be listed (HTTP 502)." })
    expect(buttons()).toEqual([])
    expect(host.querySelector('[data-testid="onboarding-no-guides"]')?.textContent).toBe("The repository's files could not be listed (HTTP 502).")
    expect(host.querySelector('[data-testid="onboarding-ask"]')).toBeNull()
  })
})
