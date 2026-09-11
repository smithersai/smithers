import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { AffectedCardBody } from "./AffectedCard"
import { CiMatrixCardBody } from "./CiMatrixCard"

/*
 * The affected and CI matrix cards over fixture payloads: changed files with
 * their re-keyed labels and reasons, "show in graph" focusing the graph
 * card; workflows/jobs/targets/matrix with the YAML collapsible.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const affectedCard = (
  payload: Partial<Extract<Card, { kind: "affected" }>["payload"]>
): Extract<Card, { kind: "affected" }> => ({
  id: "affected-force",
  kind: "affected",
  title: "force affected",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "force",
    status: "done",
    result: {
      repoId: "force",
      base: "origin/main",
      changedFiles: ["src/App.tsx", "data/schema.graphql"],
      affected: [
        { label: "//src:typeCheck", reason: "src/App.tsx" },
        { label: "//:prePush", reason: "transitive via //src:typeCheck" }
      ],
      durationMs: 12
    },
    ...payload
  }
})

const ciCard = (
  payload: Partial<Extract<Card, { kind: "ci-matrix" }>["payload"]>
): Extract<Card, { kind: "ci-matrix" }> => ({
  id: "ci-force",
  kind: "ci-matrix",
  title: "force CI",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "force",
    status: "done",
    result: {
      repoId: "force",
      workflows: [{
        name: "ci",
        path: ".github/workflows/ci.yml",
        yaml: "name: ci\non: [push]\n",
        jobs: [{ name: "main", targets: ["//.github:ci", "//src:typeCheck"], matrix: { shard: ["1", "2", "3"] } }]
      }],
      durationMs: 4
    },
    ...payload
  }
})

const renderAffected = (
  body: Extract<Card, { kind: "affected" }>,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<AffectedCardBody card={body} onRunCommand={onRunCommand} />)
  })
  return host
}

const renderCi = (body: Extract<Card, { kind: "ci-matrix" }>): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<CiMatrixCardBody card={body} />)
  })
  return host
}

describe("the affected card", () => {
  test("changed files and affected labels render with their reasons", () => {
    const host = renderAffected(affectedCard({}))
    expect(host.textContent).toContain("src/App.tsx")
    expect(host.textContent).toContain("data/schema.graphql")
    const row = host.querySelector("[data-affected-row=\"//src:typeCheck\"]")
    expect(row?.textContent).toContain("src/App.tsx")
    const transitive = host.querySelector("[data-affected-row=\"//:prePush\"]")
    expect(transitive?.textContent).toContain("transitive via //src:typeCheck")
  })

  test("show in graph dispatches the focused graph command", () => {
    const ran: Array<string> = []
    const host = renderAffected(affectedCard({}), (name, args) => ran.push(`${name} ${args ?? ""}`))
    const button = host.querySelector("[data-affected-row=\"//src:typeCheck\"] [data-flow=\"target.graph\"]") as
      | HTMLElement
      | null
    flushSync(() => button?.click())
    expect(ran).toEqual(["target.graph force //src:typeCheck"])
  })

  test("pending, failed and clean-tree states stay honest", () => {
    expect(renderAffected(affectedCard({ status: "pending", result: undefined })).textContent).toContain(
      "Computing the affected set…"
    )
    expect(
      renderAffected(affectedCard({ status: "failed", result: undefined, error: "git diff refused" })).textContent
    ).toContain("git diff refused")
    const clean = renderAffected(
      affectedCard({
        result: { repoId: "force", base: "origin/main", changedFiles: [], affected: [], durationMs: 3 }
      })
    )
    expect(clean.textContent).toContain("nothing re-keys")
  })
})

describe("the CI matrix card", () => {
  test("workflows, jobs, targets and the matrix render; the YAML is collapsible monospace", () => {
    const host = renderCi(ciCard({}))
    const workflow = host.querySelector("[data-workflow=\"ci\"]")
    expect(workflow?.querySelector(".ci-matrix-workflow-name")?.textContent).toContain("pipeline ci")
    expect(workflow?.textContent).toContain(".github/workflows/ci.yml")
    expect(host.querySelector("table.ci-matrix-jobs")?.getAttribute("aria-label")).toBe("CI jobs")
    const job = host.querySelector("[data-job-row=\"main\"]")
    expect(job?.textContent).toContain("//.github:ci")
    expect(job?.textContent).toContain("//src:typeCheck")
    expect(job?.textContent).toContain("shard: 1, 2, 3")
    const yaml = host.querySelector(".ci-matrix-yaml")
    expect(yaml?.tagName).toBe("DETAILS")
    expect(yaml?.querySelector("pre")?.textContent).toContain("name: ci")
  })

  test("product copy never says workflow: empty state, headings, and the jobs table", () => {
    const empty = renderCi(ciCard({ result: { repoId: "force", workflows: [], durationMs: 1 } }))
    expect(empty.textContent).toContain("The graph implies no CI pipelines.")
    const host = renderCi(ciCard({}))
    for (const el of [empty, host]) {
      expect(el.textContent?.toLowerCase()).not.toContain("workflow jobs")
      expect(el.textContent).not.toContain("CI workflows")
      for (const table of el.querySelectorAll("table")) {
        expect(table.getAttribute("aria-label")?.toLowerCase()).not.toContain("workflow")
      }
    }
  })

  test("pending and failed stay honest", () => {
    expect(renderCi(ciCard({ status: "pending", result: undefined })).textContent).toContain(
      "Generating the CI matrix…"
    )
    expect(renderCi(ciCard({ status: "failed", result: undefined, error: "no pipelines" })).textContent).toContain(
      "no pipelines"
    )
  })
})
