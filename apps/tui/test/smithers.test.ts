import { expect, it } from "bun:test"
import * as Panels from "../src/panels.ts"
import * as Smithers from "../src/smithers.ts"

const discovered = new Set(["review", "release"])

it("shows the connection alone in a repository without apps: no issue rows, no TODO row", () => {
  const panel = Smithers.panel([], discovered)
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.id).toBe("smithers")
  expect(panel.summary).toBe("Smithers Cloud")
  expect(panel.rows).toEqual([{ id: "cloud:identity", label: "Connection unknown", details: [] }])
})

it("lists the homepage's apps after the connection, running the ones this directory discovers", () => {
  const apps = [
    { flow: "review", title: "Review a PR", picture: "review" },
    { flow: "issue.implement", title: "Fix an issue", picture: "issue" }
  ]
  const panel = Smithers.panel(apps, discovered, { logged_in: true, username: "will" })
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.rows.map((row) => row.id)).toEqual(["cloud:identity", "app:review", "app:issue.implement"])
  expect(panel.rows[1]).toEqual({
    id: "app:review",
    label: "Review a PR",
    details: [{ kind: "text", text: "review" }],
    action: { label: "Review a PR", action: { kind: "flow", flow: "review" } }
  })
  // A flow the app home names but this directory does not discover is listed, and runs nowhere here.
  expect(panel.rows[2]).toEqual({
    id: "app:issue.implement",
    label: "Fix an issue",
    details: [{ kind: "text", text: "issue.implement" }]
  })
  expect(panel.summary).toBe("2 apps")
})

it("says how to sign in when the person is signed out of Cloud", () => {
  const panel = Smithers.panel([], discovered, { logged_in: false })
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.rows).toEqual([{ id: "cloud:identity", label: "Signed out", details: [] }, {
    id: "cloud:sign-in",
    label: "Sign in: smthrs auth login",
    details: []
  }])
})

it("reads the repository from SMITHERS_REPO only when it names an owner and a name", () => {
  expect(Smithers.repository("/nowhere", { SMITHERS_REPO: " o/r " })).toBe("o/r")
  for (const named of ["../r", "o/..", "o", "o/r/x", "o r/x"]) {
    expect(Smithers.repository("/nowhere", { SMITHERS_REPO: named })).not.toBe(named)
  }
})
