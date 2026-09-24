import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { RepositoryChoicePayload } from "../state/controller/tutorialRepository"
import { RepositoryChoiceCard } from "./RepositoryChoiceCard"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const payload: RepositoryChoicePayload = {
  cutoff: "2026-06-01T00:00:00.000Z", partial: false, error: null, selected: null, created: null,
  repositories: [{ fullName: "example/repo", count: 3, latest: "2026-09-01T00:00:00.000Z", coverage: "default-branch", error: null }]
}

test("the button that creates a repository names the repository it creates, never Skip", () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<RepositoryChoiceCard payload={payload} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map(button => button.textContent)).not.toContain("Skip")
    const create = buttons.find(button => button.dataset.flow === "repo.create")!
    create.click()
    expect(calls).toEqual([["repo.create", "smithers-playground"]])
    expect(create.textContent).toBe("Create smithers-playground")
  } finally { flushSync(() => root.unmount()); host.remove() }
})
