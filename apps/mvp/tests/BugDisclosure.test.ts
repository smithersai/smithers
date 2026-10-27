import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { issueUrl } from "../src/features/bugs/github"

test("GitHub prefill transmits words on opening, so docs never promise secrecy until submission", () => {
  const url = new URL(issueUrl({ id: "report", what: "Report words", repo: null, route: null, build: "dev", traces: [], runs: [], failures: [], errors: [], browser: "Test", viewport: "1280x800" }))
  expect(url.searchParams.get("title")).toBe("Report words")
  expect(url.searchParams.get("body")).toContain("Report words")
  const docs = readFileSync(new URL("../docs/features/bugs.md", import.meta.url), "utf8")
  expect(docs).not.toContain("Nothing reaches GitHub until")
  expect(docs).toContain("Opening the link sends the prefilled content to GitHub")
})
